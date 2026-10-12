// T-112: bid groups, "win at most N of these items". The rules are pure, in
// src/domain/snipe/groups.ts; this module enforces them through T-84's
// ArmHooks registry (`snipeSeams(ctx).addArmHooks`, I-12) and the runner's
// public `disarm`. snipe-runner.ts, handlers/snipe.ts, state-machine.ts and
// main.ts are not edited: this file registers itself (I-01).
//
// - beforeArm: a snipe armed with a `groupId` joins that group only if the
//   group exists, the mode matches (all dry run or all live), N is not reached,
//   the group is not frozen (from T-2 min before its next end) and the item
//   ends at least 2 min from every other member. Otherwise the arm is vetoed
//   with the reason. Arms in progress hold a short reservation, so two arms
//   at once cannot both pass the spacing check.
// - afterTransition into `resolved` / `killed`: the member's result. A member
//   that may have been won gets a confirming read of its item after the end
//   (`checking`): T-87's classifier must say `won` and `final` (the domain's
//   judgeWin). Bounded retries. The lane (confirmLane): the snipe lane (the
//   session's bearer: SGW says who leads; until the PlaceBid codes are
//   catalogued that is the ONLY read that can confirm a live win) whenever no
//   other snipe needs it soon (snipeLaneFree: a 429/5xx backs off the lane it
//   came on, and must never make another snipe's verify, fire or outcome read
//   wait), else the interactive lane (fast attempts) or the background lane
//   (slow ones). Leading, Unconfirmed, ambiguous or unreadable never count:
//   the group keeps going and says it risks winning more than N.
// - Once a mode's confirmed wins reach N, every other open member of that mode
//   is disarmed through `SnipeRunner.disarm(id, 'user', why)`. The reducer may
//   refuse (a bid already sent cannot be stopped): that is recorded and told.
//   A group never touches caps or exposure; every member counts on its own.
// - `groups.list` / `groups.save` / `groups.delete` (T-112 contract change).
//   Save and delete are refused while the group is frozen; delete also while
//   it has open snipes. Lowering N to the confirmed wins stops the rest.
//
// Bookkeeping: `sbw:snipeGroups` (T-112 contract addition), written under its
// own lock. A restarted worker re-judges finished members with no result, runs
// due checks and re-applies a reached N. The check alarm (`sbw:groups:check`)
// survives a dead worker; a timer gives the precise time while it lives.
import { errorText, type BackgroundContext } from '../context';
import type { AuditLog } from '../../domain/audit/types';
import type { Settings } from '../../domain/settings/schema';
import {
  armProblem,
  cancelTargets,
  confirmedWins,
  confirmLane,
  deleteProblem,
  editProblem,
  GROUP_CONFIRM_FAST_ATTEMPTS,
  isOpenSnipe,
  judgeWin,
  memberEnded,
  membersOf,
  nextResult,
  SNIPE_LANE_GUARD_FIRST_MS,
  SNIPE_LANE_GUARD_RETRY_MS,
  snipeLaneFree,
} from '../../domain/snipe/groups';
import { assessClock } from '../../domain/snipe/timing';
import type { Snipe } from '../../domain/snipe/types';
import type { Repo } from '../../domain/storage/repo';
import {
  SNIPE_GROUP_LIMITS,
  STORAGE_KEYS,
  type SnipeGroup,
  type SnipeGroupResult,
  type SnipeGroupsRecord,
} from '../../domain/storage/schema';
import type { EpochMs, ItemDetail, ItemId, Lane } from '../../domain/types';
import type { MsgPayload } from '../../messaging/protocol';
import type { Alarms } from '../../ports/alarms';
import type { Clock } from '../../ports/clock';
import type { Notifier } from '../../ports/notifier';
import { truncateTitle } from './notify';
import { getSnipeRunner, snipeSeams, type ArmHooks } from './snipe-runner';

const SEC = 1000;
const MIN = 60 * SEC;

export const GROUPS_KEY = STORAGE_KEYS.snipeGroups;
/** One alarm for every due confirming read (the soonest). */
export const GROUPS_ALARM = 'sbw:groups:check';
/** A passed arm reserves its end for the spacing check this long (the arm stores within seconds). */
export const GROUP_RESERVATION_MS = MIN;
/** A due check this close also gets a timer (an alarm may fire up to 60 s late). */
const TIMER_MAX_MS = 10 * MIN;
/** The runner was not registered yet: try the cancellation again this much later. */
const RUNNER_RETRY_MS = 30 * SEC;

const ITEM_URL = 'https://shopgoodwill.com/item/';

/** The runner is not there (yet): nothing was disarmed, try again. */
export class RunnerMissingError extends Error {
  constructor() {
    super('the snipe runner is not running');
    this.name = 'RunnerMissingError';
  }
}

export interface SnipeGroupsDeps {
  clock: Pick<Clock, 'now' | 'setTimeout' | 'clearTimeout'>;
  repo: Pick<Repo, 'get' | 'find' | 'set' | 'withLock'>;
  /** A fresh ItemDetail (no cache). */
  readItem: (itemId: ItemId, lane: Lane) => Promise<ItemDetail>;
  alarms: Pick<Alarms, 'create' | 'clear'>;
  notifier: Pick<Notifier, 'notify'>;
  audit: Pick<AuditLog, 'append'>;
  /** The runner's public disarm (`by: 'user'`). Throws the reducer's refusal, or RunnerMissingError. */
  disarm: (id: string, why: string) => Promise<void>;
  settings: () => Promise<Settings>;
  /** server - local (ms), for a member with no measured offset. */
  offsetMs: () => number;
  log: (message: string, error?: unknown) => void;
}

type Details = Record<string, string | number | boolean | null>;

const emptyRecord = (): SnipeGroupsRecord => ({ version: 1, groups: {} });

export class SnipeGroups {
  readonly hooks: ArmHooks;
  private queue: Promise<void> = Promise.resolve();
  private pending = 0;
  private armQueue: Promise<unknown> = Promise.resolve();
  /** Arms that passed the group check and are not stored yet: draft id → draft. */
  private readonly reserved = new Map<string, { snipe: Snipe; until: EpochMs }>();
  private timer: { id: number; at: EpochMs } | undefined;

  constructor(private readonly deps: SnipeGroupsDeps) {
    this.hooks = {
      beforeArm: (draft) => this.beforeArm(draft),
      afterArm: (s) => {
        this.reserved.delete(s.id);
      },
      afterTransition: (next, prev) => {
        if (next.groupId === undefined || !isOpenSnipe(prev) || isOpenSnipe(next)) return;
        this.enqueue(`member ${next.id} ended`, () => this.ended(next.id));
      },
    };
  }

  /** The restart reconcile, queued. */
  start(): void {
    this.enqueue('reconcile', () => this.reconcile());
  }

  /** The check alarm (or timer) fired. */
  wake(): void {
    this.enqueue('due checks', () => this.runDue());
  }

  /** Resolves when no group work is queued or running (tests, diagnostics). */
  async idle(): Promise<void> {
    while (this.pending > 0) await this.queue;
  }

  // ── Messages ──────────────────────────────────────────────────────────

  async list(): Promise<SnipeGroupsRecord> {
    return this.read();
  }

  /** `groups.save`: create, rename or change N. Refused while frozen. */
  async save(input: MsgPayload<'groups.save'>): Promise<void> {
    const name = input.name.trim();
    if (name === '') throw new Error('Give the group a name.');
    const tz = await this.timeZone();
    const changed = await this.deps.repo.withLock(GROUPS_KEY, async () => {
      const rec = await this.read();
      const now = this.deps.clock.now();
      const existing = rec.groups[input.id];
      if (existing === undefined) {
        if (Object.keys(rec.groups).length >= SNIPE_GROUP_LIMITS.groupsMax) {
          throw new Error(`There are already ${String(SNIPE_GROUP_LIMITS.groupsMax)} bid groups. Delete one you no longer need first.`);
        }
        rec.groups[input.id] = { id: input.id, name, maxWins: input.maxWins, createdAt: now, updatedAt: now, results: {}, cancels: {} };
      } else {
        if (existing.name === name && existing.maxWins === input.maxWins) return null;
        const problem = editProblem(existing, await this.members(input.id), now, tz);
        if (problem !== null) throw new Error(problem);
        rec.groups[input.id] = { ...existing, name, maxWins: input.maxWins, updatedAt: now };
      }
      await this.write(rec);
      return { created: existing === undefined, before: existing?.maxWins ?? null };
    });
    if (changed === null) return;
    await this.append({
      actor: 'user',
      kind: 'group.save',
      ref: input.id,
      details: { group: input.id, name, maxWins: input.maxWins, created: changed.created, previousMaxWins: changed.before },
    });
    // Lowering N to the confirmed wins stops the rest (the wins are the proof).
    this.enqueue(`group ${input.id} saved`, () => this.enforce(input.id));
  }

  /** `groups.delete`. Refused while frozen or while the group has open snipes. */
  async remove(id: string): Promise<void> {
    const tz = await this.timeZone();
    const removed = await this.deps.repo.withLock(GROUPS_KEY, async () => {
      const rec = await this.read();
      const g = rec.groups[id];
      if (g === undefined) return false;
      const problem = deleteProblem(g, await this.members(id), this.deps.clock.now(), tz);
      if (problem !== null) throw new Error(problem);
      Reflect.deleteProperty(rec.groups, id);
      await this.write(rec);
      return true;
    });
    if (removed) await this.append({ actor: 'user', kind: 'group.delete', ref: id, details: { group: id } });
  }

  // ── Arm ───────────────────────────────────────────────────────────────

  /** Serialised, so the reservation of one arm is seen by the next one's spacing check. */
  private beforeArm(draft: Snipe): Promise<{ veto: string } | undefined> {
    const groupId = draft.groupId;
    if (groupId === undefined) return Promise.resolve(undefined);
    const run = this.armQueue.then(async () => {
      const [rec, all, tz] = await Promise.all([this.read(), this.deps.repo.get(STORAGE_KEYS.snipes), this.timeZone()]);
      const now = this.deps.clock.now();
      for (const [id, r] of this.reserved) if (r.until <= now) this.reserved.delete(id);
      const reserved = [...this.reserved.values()].map((r) => r.snipe).filter((s) => s.groupId === groupId);
      const problem = armProblem({
        groupId,
        group: rec.groups[groupId],
        draft,
        members: membersOf(groupId, Object.values(all)),
        reserved,
        now,
        userTz: tz,
      });
      if (problem !== null) return { veto: problem };
      this.reserved.set(draft.id, { snipe: draft, until: now + GROUP_RESERVATION_MS });
      return undefined;
    });
    this.armQueue = run.catch(() => undefined);
    return run;
  }

  // ── Results ───────────────────────────────────────────────────────────

  private async reconcile(): Promise<void> {
    const rec = await this.read();
    const all = Object.values(await this.deps.repo.get(STORAGE_KEYS.snipes));
    for (const g of Object.values(rec.groups)) {
      for (const m of membersOf(g.id, all)) {
        if (!isOpenSnipe(m) && g.results[m.id] === undefined) await this.ended(m.id);
      }
    }
    for (const g of Object.values(rec.groups)) await this.enforce(g.id);
    await this.runDue();
  }

  /** A member reached `resolved` or `killed`: record its result, or schedule the confirming read. */
  private async ended(id: string): Promise<void> {
    const s = (await this.deps.repo.get(STORAGE_KEYS.snipes))[id];
    const groupId = s?.groupId;
    if (s === undefined || groupId === undefined || isOpenSnipe(s)) return;
    const now = this.deps.clock.now();
    const end = memberEnded(s, now, this.deps.offsetMs());
    if (end.kind === 'pending') return;
    const result: SnipeGroupResult =
      end.kind === 'confirm'
        ? { verdict: 'checking', dryRun: s.dryRun, at: end.at, attempts: 0, nextAt: end.at, why: 'waiting for a read after the end' }
        : { verdict: end.kind, dryRun: s.dryRun, at: now, attempts: 0, why: end.why };
    const stored = await this.update(groupId, (g) => {
      if (g.results[id] !== undefined) return false;
      g.results[id] = result;
      return true;
    });
    if (!stored) return;
    await this.append({
      actor: 'snipe',
      kind: 'group.member-ended',
      itemId: s.itemId,
      ref: s.id,
      dryRun: s.dryRun,
      details: { group: groupId, outcome: s.outcome ?? null, verdict: result.verdict, why: result.why },
    });
    if (result.verdict === 'unconfirmed') await this.warnUnconfirmed(groupId, s, result);
    if (result.verdict === 'checking') await this.runDue();
  }

  /** Runs every confirming read that is due, then re-arms the alarm for the next one. */
  private async runDue(): Promise<void> {
    const rec = await this.read();
    const now = this.deps.clock.now();
    const due: Array<{ groupId: string; snipeId: string; at: EpochMs }> = [];
    for (const g of Object.values(rec.groups)) {
      for (const [snipeId, r] of Object.entries(g.results)) {
        if (r.verdict === 'checking' && (r.nextAt ?? r.at) <= now) due.push({ groupId: g.id, snipeId, at: r.nextAt ?? r.at });
      }
    }
    due.sort((a, b) => a.at - b.at);
    for (const d of due) await this.attempt(d.groupId, d.snipeId);
    await this.schedule();
  }

  /** One confirming read of a member's item, judged by T-87's classifier (judgeWin). */
  private async attempt(groupId: string, snipeId: string): Promise<void> {
    const all = await this.deps.repo.get(STORAGE_KEYS.snipes);
    const s = all[snipeId];
    const prev = (await this.read()).groups[groupId]?.results[snipeId];
    if (prev?.verdict !== 'checking') return;
    let detail: ItemDetail | null = null;
    const guard = prev.attempts === 0 ? SNIPE_LANE_GUARD_FIRST_MS : SNIPE_LANE_GUARD_RETRY_MS;
    const free = snipeLaneFree(snipeId, Object.values(all), this.deps.clock.now(), this.deps.offsetMs(), guard);
    const lane: Lane = confirmLane(prev.attempts, free);
    if (s !== undefined) {
      try {
        detail = await this.deps.readItem(s.itemId, lane);
      } catch (e) {
        this.deps.log(`bid group ${groupId}: the confirming read of snipe ${snipeId} failed`, e);
      }
    }
    const judged =
      s === undefined ? ({ verdict: 'unconfirmed', why: 'the snipe record is gone', retry: false } as const) : judgeWin(s, detail, await this.timeZone());
    const next = nextResult(prev, judged, this.deps.clock.now());
    const stored = await this.update(groupId, (g) => {
      const cur = g.results[snipeId];
      // Compare-and-set: another attempt (a second worker, a duplicate alarm) already moved it.
      if (cur?.verdict !== 'checking' || cur.attempts !== prev.attempts) return false;
      g.results[snipeId] = next;
      return true;
    });
    if (!stored) return;
    await this.append({
      actor: 'snipe',
      kind: 'group.check',
      ...(s === undefined ? {} : { itemId: s.itemId, dryRun: s.dryRun }),
      ref: snipeId,
      details: { group: groupId, attempt: next.attempts, lane, read: detail !== null, verdict: next.verdict, why: next.why },
    });
    if (s === undefined) return;
    if (next.verdict === 'confirmed') {
      await this.enforce(groupId);
      return;
    }
    // Tell the user once the fast checks are spent (or the checks are over) without proof.
    if (next.verdict === 'unconfirmed' || (next.verdict === 'checking' && next.attempts >= GROUP_CONFIRM_FAST_ATTEMPTS)) {
      await this.warnUnconfirmed(groupId, s, next);
    }
  }

  // ── Cancellation (only after a confirmed win) ─────────────────────────

  /** When a mode's confirmed wins reached N: disarm the other open members through the runner. */
  private async enforce(groupId: string): Promise<void> {
    const g = (await this.read()).groups[groupId];
    if (g === undefined) return;
    const members = await this.members(groupId);
    const targets = cancelTargets(g, members);
    if (targets.length === 0) return;
    const stopped: Snipe[] = [];
    const refused: Array<{ s: Snipe; why: string }> = [];
    for (const t of targets) {
      const wins = confirmedWins(g, t.dryRun);
      const why = `bid group "${g.name}" already won ${String(wins)} of ${String(g.maxWins)}`;
      let ok = true;
      let reason = 'stopped by the group';
      try {
        await this.deps.disarm(t.id, why);
      } catch (e) {
        if (e instanceof RunnerMissingError) {
          this.deps.log(`bid group ${groupId}: the runner is not running yet; the cancellation is retried`, e);
          this.retryLater();
          return;
        }
        ok = false;
        reason = errorText(e);
      }
      if (!ok) {
        // Refused because it finished meanwhile: its own end is judged (afterTransition). Not a refusal to report.
        const now = (await this.deps.repo.get(STORAGE_KEYS.snipes))[t.id];
        if (now === undefined || !isOpenSnipe(now)) continue;
      }
      await this.update(groupId, (cur) => {
        if (cur.cancels[t.id] !== undefined) return false;
        cur.cancels[t.id] = { at: this.deps.clock.now(), ok, why: reason };
        return true;
      });
      await this.append({
        actor: 'snipe',
        kind: ok ? 'group.cancel' : 'group.cancel-refused',
        itemId: t.itemId,
        ref: t.id,
        dryRun: t.dryRun,
        details: { group: groupId, why: ok ? why : reason },
      });
      if (ok) stopped.push(t);
      else refused.push({ s: t, why: reason });
    }
    if (stopped.length === 0 && refused.length === 0) return;
    const n = String(g.maxWins);
    const parts: string[] = [];
    if (stopped.length > 0) parts.push(`Stopped ${stopped.map((s) => `"${truncateTitle(s.title, 40)}"`).join(', ')}.`);
    if (refused.length > 0) {
      parts.push(
        `Could not stop ${refused.map((r) => `"${truncateTitle(r.s.title, 40)}"`).join(', ')}: a bid already sent cannot be stopped, so you could win more than ${n}.`,
      );
    }
    await this.notify({
      id: `sbw:group:${groupId}:cancel:${[...stopped.map((s) => s.id), ...refused.map((r) => r.s.id)].join(',')}`,
      title: `Bid group "${truncateTitle(g.name, 40)}": won ${n} of ${n}`,
      message: parts.join(' '),
    });
  }

  private async warnUnconfirmed(groupId: string, s: Snipe, r: SnipeGroupResult): Promise<void> {
    if (r.warned === true) return;
    const g = (await this.read()).groups[groupId];
    if (g === undefined || confirmedWins(g, s.dryRun) >= g.maxWins) return;
    // Only worth saying while another member of the group can still bid.
    const others = (await this.members(groupId)).filter((m) => m.id !== s.id && m.dryRun === s.dryRun && isOpenSnipe(m));
    const marked = await this.update(groupId, (cur) => {
      const now = cur.results[s.id];
      if (now === undefined || now.warned === true) return false;
      cur.results[s.id] = { ...now, warned: true };
      return true;
    });
    if (!marked || others.length === 0) return;
    await this.notify({
      id: `sbw:group:${groupId}:unconfirmed:${s.id}`,
      title: `Bid group "${truncateTitle(g.name, 40)}": win not confirmed`,
      message: `"${truncateTitle(s.title, 40)}" may have been won, but the win is not confirmed (${r.why}). The group keeps bidding on its other ${others.length === 1 ? 'item' : 'items'}, so you could win more than ${String(g.maxWins)}.`,
      url: `${ITEM_URL}${String(s.itemId)}`,
    });
  }

  // ── Scheduling ────────────────────────────────────────────────────────

  /** The alarm (and, when close, a timer) for the soonest due check; cleared when none is pending. */
  private async schedule(): Promise<void> {
    const rec = await this.read();
    let next: EpochMs | undefined;
    for (const g of Object.values(rec.groups)) {
      for (const r of Object.values(g.results)) {
        if (r.verdict !== 'checking') continue;
        const at = r.nextAt ?? r.at;
        if (next === undefined || at < next) next = at;
      }
    }
    if (next === undefined) {
      this.clearTimer();
      await this.safely('clear the check alarm', () => this.deps.alarms.clear(GROUPS_ALARM));
      return;
    }
    const at = next;
    const now = this.deps.clock.now();
    await this.safely('set the check alarm', () => this.deps.alarms.create(GROUPS_ALARM, { when: Math.max(now, at) }));
    if (at - now <= TIMER_MAX_MS && this.timer?.at !== at) {
      this.clearTimer();
      const id = this.deps.clock.setTimeout(
        () => {
          this.timer = undefined;
          this.wake();
        },
        Math.max(0, at - now),
      );
      this.timer = { id, at };
    }
  }

  private retryLater(): void {
    this.deps.clock.setTimeout(() => {
      this.start();
    }, RUNNER_RETRY_MS);
  }

  private clearTimer(): void {
    if (this.timer !== undefined) this.deps.clock.clearTimeout(this.timer.id);
    this.timer = undefined;
  }

  // ── Plumbing ──────────────────────────────────────────────────────────

  private enqueue(what: string, fn: () => Promise<void>): void {
    this.pending += 1;
    const run = this.queue.then(fn).catch((e: unknown) => {
      this.deps.log(`bid groups: ${what} failed`, e);
    });
    this.queue = run.finally(() => {
      this.pending -= 1;
    });
  }

  private async read(): Promise<SnipeGroupsRecord> {
    // Validated: an invalid record is quarantined (shown on the health panel), never silently reused.
    return (await this.deps.repo.find(GROUPS_KEY)) ?? emptyRecord();
  }

  private async write(rec: SnipeGroupsRecord): Promise<void> {
    await this.deps.repo.set(GROUPS_KEY, rec);
  }

  /** Read-modify-write of one group under the record's lock; `fn` returns whether it changed anything. */
  private update(groupId: string, fn: (g: SnipeGroup) => boolean): Promise<boolean> {
    return this.deps.repo.withLock(GROUPS_KEY, async () => {
      const rec = await this.read();
      const g = rec.groups[groupId];
      if (g === undefined || !fn(g)) return false;
      await this.write(rec);
      return true;
    });
  }

  private async members(groupId: string): Promise<Snipe[]> {
    return membersOf(groupId, Object.values(await this.deps.repo.get(STORAGE_KEYS.snipes)));
  }

  private async timeZone(): Promise<string> {
    return (await this.deps.settings()).locale.timeZone;
  }

  private async append(e: { actor: 'snipe' | 'user'; kind: string; ref: string; itemId?: number; dryRun?: boolean; details: Details }): Promise<void> {
    await this.safely('audit', () => this.deps.audit.append(e));
  }

  private async notify(n: { id: string; title: string; message: string; url?: string }): Promise<void> {
    await this.safely('notify', () =>
      this.deps.notifier.notify({ id: n.id, title: n.title, message: n.message, priority: 2, ...(n.url === undefined ? {} : { openUrlOnClick: n.url }) }),
    );
  }

  private async safely(what: string, fn: () => Promise<unknown>): Promise<void> {
    try {
      await fn();
    } catch (e) {
      this.deps.log(`bid groups: ${what} failed`, e);
    }
  }
}

// ── Self-registration (I-01; main.ts is frozen) ─────────────────────────────

const INSTANCES = new WeakMap<BackgroundContext, SnipeGroups>();

/** This background's bid groups (tests, diagnostics). */
export function snipeGroupsFor(ctx: BackgroundContext): SnipeGroups | undefined {
  return INSTANCES.get(ctx);
}

/** Builds the groups over this background, registers its hooks, messages and alarm, and starts the restart check. */
export function registerSnipeGroups(ctx: BackgroundContext): SnipeGroups {
  const groups = new SnipeGroups({
    clock: ctx.clock,
    repo: ctx.repo,
    // The snipe lane never uses the cache; the others are forced fresh.
    readItem: (itemId, lane) => ctx.api.itemDetail(itemId, lane, lane === 'snipe' ? undefined : { maxAgeMs: 0 }),
    alarms: ctx.alarms,
    notifier: ctx.notifier,
    audit: ctx.audit,
    disarm: async (id, why) => {
      const runner = getSnipeRunner(ctx);
      if (runner === undefined) throw new RunnerMissingError();
      await runner.disarm(id, 'user', why);
    },
    settings: async () => ctx.switches.settings() ?? (await ctx.repo.get(STORAGE_KEYS.settings)),
    offsetMs: () => {
      const a = assessClock(ctx.sgwClock.offset());
      return a.ok ? a.offsetMs : 0;
    },
    log: (message, error) => {
      console.warn(`[ShopBadwill] ${message}`, error);
    },
  });
  INSTANCES.set(ctx, groups);
  snipeSeams(ctx).addArmHooks(groups.hooks);
  ctx.alarms.onAlarm((a) => {
    if (a.name === GROUPS_ALARM) groups.wake();
  });
  ctx.router.register('groups.list', () => groups.list());
  ctx.router.register('groups.save', async (p) => {
    await groups.save(p);
    return undefined;
  });
  ctx.router.register('groups.delete', async ({ id }) => {
    await groups.remove(id);
    return undefined;
  });
  groups.start();
  return groups;
}

export function register(ctx: BackgroundContext): void {
  registerSnipeGroups(ctx);
}
