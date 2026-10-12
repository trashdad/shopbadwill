// T-111: the extension side of T2 (the Windows wake-and-launch companion,
// companion/windows/, docs/COMPANION.md). ArmHooks registered on T-84's
// registry (`snipeSeams(ctx).addArmHooks`, I-12); snipe-runner.ts is not edited.
//
// Tier T2 only (settings.snipe.tier):
// - afterArm: ask the companion to `schedule` a wake at the runner's T-5 min
//   wake minus COMPANION_WAKE_MARGIN_MS, so the browser is up before the runner
//   needs it. A failure notifies the user at once ("the computer will not be
//   woken"), while they are still at the computer.
// - afterTransition into killed / resolved / fallback-applied (a disarm, a
//   resolve, a fallback that replaced the fire): `cancel` the wake, but NEVER
//   once the wake time has passed or is within COMPANION_CANCEL_GUARD_MS (T-110
//   review 3b: deleting a task that already fired may stop the browser it
//   started). A snipe never scheduled (T0/T1, wake already due) sends nothing.
// - preflight (T-15 min): `list`; an unreachable or refusing companion fails the
//   preflight as `keep-awake` (PreflightHookFailure) with a clear reason. A task
//   the host lost (or a stale wake time) is re-scheduled first. A preflight that
//   runs after the wake time has nothing left for the companion: it passes.
//
// The hooks never hold the runner: afterArm and afterTransition only queue the
// work (per snipe, in order, so a quick disarm's cancel follows its schedule).
// Every op goes through the CompanionPort adapter, which never throws and has a
// short timeout. Only the snipe id, the wake time, the browser and the profile
// from settings are sent; never the title, the bid or account data.
//
// Bookkeeping: `sbw:companionWakes` (T-111 contract addition). An entry is
// written before a `schedule` leaves; `asked` (no usable answer: the task may
// exist), `confirmed` or `none`. A restarted worker cancels the wakes of snipes
// that ended meanwhile and (re)schedules armed T2 snipes that have no confirmed
// wake, each at most every COMPANION_RETRY_MS. Entries stay 15 days after the
// wake: the awake history leaves out the runs those wakes caused
// (`withoutCompanionWakes`, used by `timing.awake`).
import {
  BrowserCompanion,
  validCompanionProfile,
  validCompanionSnipeId,
  type CompanionBrowser,
  type CompanionPort,
  type NativeSend,
} from '../../adapters/browser/companion';
import { isFirefox } from '../../adapters/browser/env';
import type { AuditLog } from '../../domain/audit/types';
import type { Settings } from '../../domain/settings/schema';
import { AWAKE_RETENTION_MS } from '../../domain/snipe/awake-history';
import { isoMs } from '../../domain/snipe/preflight';
import { WAKE_BEFORE_FIRE_MS } from '../../domain/snipe/state-machine';
import { assessClock, computeFireAt } from '../../domain/snipe/timing';
import type { Snipe } from '../../domain/snipe/types';
import type { Repo } from '../../domain/storage/repo';
import { parseCompanionWakes, STORAGE_KEYS, type CompanionWakesRecord } from '../../domain/storage/schema';
import type { EpochMs } from '../../domain/types';
import type { Clock } from '../../ports/clock';
import type { Notifier } from '../../ports/notifier';
import type { BackgroundContext } from '../context';
import { truncateTitle } from './notify';
import { snipeSeams, type ArmHooks, type PreflightHookFailure } from './snipe-runner';

const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;

/** `sbw:companionWakes`. */
export const COMPANION_WAKES_KEY = STORAGE_KEYS.companionWakes;
/**
 * The companion wakes the computer this long before the runner's own T-5 min
 * wake: resume (S3 or hibernate), the browser launch, network-up and the
 * worker start all fit, and the runner's wake alarm then fires on time.
 */
export const COMPANION_WAKE_MARGIN_MS = 3 * MIN;
/** No cancel from this long before the wake on (T-110 3b: never cancel a fired task, nor race one). */
export const COMPANION_CANCEL_GUARD_MS = 2 * MIN;
/** A restarted worker retries a failed schedule or cancel at most this often. */
export const COMPANION_RETRY_MS = 10 * MIN;
/** A listed task this close to the wanted wake needs no re-schedule. */
export const COMPANION_RESCHEDULE_TOLERANCE_MS = MIN;
/** At most this many entries are kept (newest wakes first). */
export const COMPANION_WAKES_CAP = 500;

// Awake-history filter (heuristic; the stored ring keeps one heartbeat per 15-minute slot).
/** A heartbeat this long before the wake means the browser was already running: not companion-caused. */
export const COMPANION_PRE_WAKE_MS = 30 * MIN;
/** The woken browser's first heartbeat falls within this (the task's 1 h start window, plus slack). */
export const COMPANION_LAUNCH_WINDOW_MS = 70 * MIN;
/** A gap this long ends the woken run (the computer slept again). */
export const COMPANION_RUN_GAP_MS = 30 * MIN;
/** A woken run is never counted out for longer than this after the wake. */
export const COMPANION_RUN_CAP_MS = 8 * HOUR;

/** States where the wake is no longer wanted: a disarm, a resolve, a fallback that replaced the fire. */
const WAKE_CLOSED: ReadonlySet<Snipe['state']> = new Set(['killed', 'resolved', 'fallback-applied']);

type WakeEntry = CompanionWakesRecord['wakes'][string];
type Trigger = 'arm' | 'restart' | 'preflight';
type Outcome = { kind: 'ok' } | { kind: 'skipped' } | { kind: 'failed'; error: string; detail: string };

/**
 * The companion's wake (local epoch ms) for a snipe: the runner's T-5 min wake
 * (`fireAt`, or the planned fire before the verify, minus the clock offset)
 * minus the margin. Null when the snipe's times are unusable.
 */
export function companionWakeAt(s: Snipe, fallbackOffsetMs: number): EpochMs | null {
  try {
    const fireServer = s.fireAt ?? computeFireAt(isoMs(s.endTime), s.leadMs, 0);
    const offset = s.measured?.offsetMs ?? fallbackOffsetMs;
    const at = fireServer - offset - WAKE_BEFORE_FIRE_MS - COMPANION_WAKE_MARGIN_MS;
    return Number.isFinite(at) ? at : null;
  } catch {
    return null;
  }
}

/**
 * The awake history without the runs companion wakes caused, for advice. A
 * wake at W caused a run when no heartbeat falls in the 30 min before W (the
 * browser was not running). The run starts at the first heartbeat within 70 min
 * after W and ends at the first gap of 30 min or more (the computer slept
 * again), at most 8 h after W. Wakes still in the future are ignored. Pessimistic
 * on purpose: counting a woken run as "usually awake" is the dangerous
 * direction. Pure; never mutates.
 */
export function withoutCompanionWakes(history: readonly EpochMs[], wakes: readonly EpochMs[], now: EpochMs): EpochMs[] {
  if (wakes.length === 0 || history.length === 0) return [...history];
  const sorted = [...history].filter(Number.isFinite).sort((a, b) => a - b);
  const drop = new Set<EpochMs>();
  for (const w of wakes) {
    if (!(w <= now)) continue;
    if (sorted.some((t) => t >= w - COMPANION_PRE_WAKE_MS && t < w)) continue;
    let i = sorted.findIndex((t) => t >= w);
    const first = i < 0 ? undefined : sorted[i];
    if (first === undefined || first > w + COMPANION_LAUNCH_WINDOW_MS) continue;
    let prev = first;
    for (; i < sorted.length; i++) {
      const t = sorted[i];
      if (t === undefined || t - prev >= COMPANION_RUN_GAP_MS || t > w + COMPANION_RUN_CAP_MS) break;
      drop.add(t);
      prev = t;
    }
  }
  return drop.size === 0 ? [...history] : history.filter((t) => !drop.has(t));
}

/** The wakes (epoch ms) that may have happened: `confirmed` and `asked` entries. */
export function companionWakeTimes(record: CompanionWakesRecord): EpochMs[] {
  return Object.values(record.wakes)
    .filter((e) => e.state !== 'none')
    .map((e) => e.wakeAt);
}

export interface CompanionSyncDeps {
  companion: CompanionPort;
  browser: CompanionBrowser;
  clock: Pick<Clock, 'now'>;
  repo: Pick<Repo, 'get' | 'getRaw' | 'set' | 'withLock'>;
  settings: () => Promise<Settings>;
  /** server - local (ms), for a snipe that has no measured offset yet. */
  offsetMs: () => number;
  audit: Pick<AuditLog, 'append'>;
  notifier: Pick<Notifier, 'notify'>;
  log: (message: string, error?: unknown) => void;
}

const NOTHING_WAKES = 'so nothing will wake this computer before the auction ends';

export class CompanionSync {
  readonly hooks: ArmHooks;
  private readonly queues = new Map<string, Promise<void>>();
  private started: Promise<void> = Promise.resolve();

  constructor(private readonly deps: CompanionSyncDeps) {
    this.hooks = {
      afterArm: (s) => {
        void this.enqueue(s.id, () => this.scheduleFor(s, 'arm'));
      },
      afterTransition: (next, prev) => {
        if (WAKE_CLOSED.has(prev.state) || !WAKE_CLOSED.has(next.state)) return;
        void this.enqueue(next.id, () => this.cancelFor(next.id));
      },
      preflight: (s) => this.preflight(s),
    };
  }

  /** The restart reconcile, in the background. */
  start(): void {
    this.started = this.reconcile().catch((e: unknown) => {
      this.deps.log('companion: the restart check failed', e);
    });
  }

  /** Resolves when no op is queued or running (tests, diagnostics). */
  async idle(): Promise<void> {
    await this.started;
    while (this.queues.size > 0) await Promise.all([...this.queues.values()]);
  }

  /**
   * After a restart: cancel the wakes of snipes that ended (or vanished) while
   * no worker could, and, under T2, schedule armed snipes without a confirmed
   * wake. Each at most every COMPANION_RETRY_MS; never a past wake.
   */
  async reconcile(): Promise<void> {
    const now = this.deps.clock.now();
    const record = parseCompanionWakes(await this.deps.repo.getRaw(COMPANION_WAKES_KEY));
    const settings = await this.deps.settings();
    const t2 = settings.snipe.tier === 'T2';
    if (Object.keys(record.wakes).length === 0 && !t2) return;
    const snipes = await this.deps.repo.get(STORAGE_KEYS.snipes);
    let dropNone = false;
    for (const [id, entry] of Object.entries(record.wakes)) {
      const s = snipes[id];
      if (s !== undefined && !WAKE_CLOSED.has(s.state)) continue;
      if (entry.state === 'none') {
        dropNone = true;
        continue;
      }
      if (entry.wakeAt - COMPANION_CANCEL_GUARD_MS <= now) continue;
      if (entry.cancelTriedAt !== undefined && now - entry.cancelTriedAt < COMPANION_RETRY_MS) continue;
      void this.enqueue(id, () => this.cancelFor(id));
    }
    if (dropNone) {
      await this.update((r) => {
        for (const [id, e] of Object.entries(r.wakes)) {
          const s = snipes[id];
          if (e.state === 'none' && (s === undefined || WAKE_CLOSED.has(s.state))) Reflect.deleteProperty(r.wakes, id);
        }
      });
    }
    if (!t2) return;
    for (const s of Object.values(snipes)) {
      if (s.state !== 'armed') continue;
      const entry = record.wakes[s.id];
      if (entry?.state === 'confirmed') continue;
      if (entry !== undefined && now - entry.triedAt < COMPANION_RETRY_MS) continue;
      void this.enqueue(s.id, () => this.scheduleFor(s, 'restart'));
    }
  }

  // ── Ops ─────────────────────────────────────────────────────────────────

  /** Per snipe, in order; a failing op never blocks the next one. */
  private enqueue<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.queues.get(id) ?? Promise.resolve();
    const run = prev.then(fn);
    const tail = run.then(
      () => undefined,
      (e: unknown) => {
        this.deps.log(`companion: an op for snipe ${id} failed`, e);
      },
    );
    this.queues.set(id, tail);
    void tail.then(() => {
      if (this.queues.get(id) === tail) this.queues.delete(id);
    });
    return run;
  }

  private async scheduleFor(queued: Snipe, trigger: Trigger): Promise<Outcome> {
    const settings = await this.deps.settings();
    if (settings.snipe.tier !== 'T2') return { kind: 'skipped' };
    // The snipe as stored now: a disarm that landed before this op ran wants no wake.
    const s = (await this.deps.repo.get(STORAGE_KEYS.snipes))[queued.id];
    if (s?.state !== 'armed') return { kind: 'skipped' };
    const now = this.deps.clock.now();
    const wakeAt = companionWakeAt(s, this.deps.offsetMs());
    // Too late to need a wake: the browser is running now.
    if (wakeAt === null || wakeAt - COMPANION_CANCEL_GUARD_MS <= now) return { kind: 'skipped' };
    const profile = settings.companion?.profile;
    let outcome: Outcome;
    let sent = false;
    if (profile === undefined) {
      outcome = { kind: 'failed', error: 'no-profile', detail: 'the browser profile for the wake companion is not set (Options, Sniping)' };
    } else if (!validCompanionProfile(profile)) {
      outcome = { kind: 'failed', error: 'bad-profile', detail: 'the browser profile for the wake companion is not a valid name or folder (Options, Sniping)' };
    } else if (!validCompanionSnipeId(s.id)) {
      outcome = { kind: 'failed', error: 'bad-id', detail: 'the snipe id is not one the wake companion accepts' };
    } else {
      outcome = await this.send(s.id, wakeAt, profile, now);
      sent = true;
    }
    if (!sent) {
      // Nothing was sent: remember the attempt only (retry spacing).
      await this.update((r) => {
        const e = r.wakes[s.id];
        r.wakes[s.id] = e === undefined || e.state === 'none' ? { wakeAt, state: 'none', triedAt: now } : { ...e, triedAt: now };
      });
    }
    await this.auditOp(s, 'companion.schedule', outcome, { trigger, wakeAt: new Date(wakeAt).toISOString() });
    if (outcome.kind === 'failed' && trigger === 'arm') await this.notifyNotScheduled(s, outcome.detail);
    return outcome;
  }

  /** Persist, then send. A clean refusal restores what was there; no usable answer leaves `asked`. */
  private async send(id: string, wakeAt: EpochMs, profile: string, now: EpochMs): Promise<Outcome> {
    let prior: WakeEntry | undefined;
    await this.update((r) => {
      prior = r.wakes[id];
      r.wakes[id] = { wakeAt, state: 'asked', triedAt: now, ...(prior?.cancelTriedAt === undefined ? {} : { cancelTriedAt: prior.cancelTriedAt }) };
    });
    const r = await this.deps.companion.schedule({ snipeId: id, wakeAt, browser: this.deps.browser, profile });
    if (r.status === 'ok') {
      await this.update((rec) => {
        rec.wakes[id] = { wakeAt, state: 'confirmed', triedAt: now };
      });
      return { kind: 'ok' };
    }
    if (r.status === 'refused' && r.error !== 'internal') {
      // The host validated and changed nothing: whatever was there still is.
      await this.update((rec) => {
        rec.wakes[id] = prior === undefined || prior.state === 'none' ? { wakeAt, state: 'none', triedAt: now } : { ...prior, triedAt: now };
      });
      return { kind: 'failed', error: r.error, detail: r.detail };
    }
    return r.status === 'refused'
      ? { kind: 'failed', error: r.error, detail: r.detail }
      : { kind: 'failed', error: 'unreachable', detail: `the wake companion is not reachable (${r.detail})` };
  }

  private async cancelFor(id: string): Promise<void> {
    const now = this.deps.clock.now();
    const entry = parseCompanionWakes(await this.deps.repo.getRaw(COMPANION_WAKES_KEY)).wakes[id];
    // Never scheduled by us (T0/T1, or the wake was already due at the arm): nothing to send.
    if (entry === undefined) return;
    if (entry.state === 'none') {
      await this.update((r) => {
        if (r.wakes[id]?.state === 'none') Reflect.deleteProperty(r.wakes, id);
      });
      return;
    }
    // T-110 3b: a wake that fired (or is about to) is never cancelled.
    if (entry.wakeAt - COMPANION_CANCEL_GUARD_MS <= now) return;
    await this.update((r) => {
      const e = r.wakes[id];
      if (e !== undefined) r.wakes[id] = { ...e, cancelTriedAt: now };
    });
    const r = await this.deps.companion.cancel(id);
    if (r.status === 'ok') {
      await this.update((rec) => {
        Reflect.deleteProperty(rec.wakes, id);
      });
    }
    const outcome: Outcome =
      r.status === 'ok'
        ? { kind: 'ok' }
        : r.status === 'refused'
          ? { kind: 'failed', error: r.error, detail: r.detail }
          : { kind: 'failed', error: 'unreachable', detail: `the wake companion is not reachable (${r.detail})` };
    const all = await this.deps.repo.get(STORAGE_KEYS.snipes);
    const s = all[id];
    await this.append({
      kind: 'companion.cancel',
      ref: id,
      ...(s === undefined ? {} : { itemId: s.itemId, dryRun: s.dryRun }),
      details: { ok: outcome.kind === 'ok', wakeAt: new Date(entry.wakeAt).toISOString(), ...this.failureDetails(outcome) },
    });
  }

  private async preflight(s: Snipe): Promise<PreflightHookFailure | undefined> {
    try {
      const settings = await this.deps.settings();
      if (settings.snipe.tier !== 'T2') return undefined;
      const now = this.deps.clock.now();
      const wakeAt = companionWakeAt(s, this.deps.offsetMs());
      // The wake is due or done: nothing is left for the companion to do.
      if (wakeAt === null || wakeAt - COMPANION_CANCEL_GUARD_MS <= now) return undefined;
      return await this.enqueue(s.id, () => this.check(s, settings, wakeAt));
    } catch (e) {
      this.deps.log(`companion: the preflight check for snipe ${s.id} failed`, e);
      return fail('the wake companion could not be checked');
    }
  }

  private async check(s: Snipe, settings: Settings, wakeAt: EpochMs): Promise<PreflightHookFailure | undefined> {
    const profile = settings.companion?.profile;
    if (profile === undefined || !validCompanionProfile(profile)) {
      return fail('the browser profile for the wake companion is not set (Options, Sniping)');
    }
    const listed = await this.deps.companion.list();
    if (listed.status === 'unreachable') return fail(`the wake companion is not reachable (${listed.detail})`);
    if (listed.status === 'refused') return fail(`the wake companion refused the check (${listed.detail})`);
    const task = listed.value.tasks.find((t) => t.snipeId === s.id);
    if (
      task !== undefined &&
      task.browser === this.deps.browser &&
      Math.abs(isoMs(task.wakeAtUtc) - wakeAt) <= COMPANION_RESCHEDULE_TOLERANCE_MS
    ) {
      return undefined;
    }
    // The host lost the task, or the wake moved: schedule it now.
    const r = await this.scheduleFor(s, 'preflight');
    if (r.kind === 'ok' || r.kind === 'skipped') return undefined;
    return fail(r.error === 'unreachable' ? r.detail : `the wake companion refused the wake task (${r.detail})`);
  }

  // ── Bookkeeping ─────────────────────────────────────────────────────────

  /** Read-modify-write of `sbw:companionWakes` under its lock; prunes old entries; writes only on change. */
  private update(fn: (r: CompanionWakesRecord) => void): Promise<void> {
    return this.deps.repo.withLock(COMPANION_WAKES_KEY, async () => {
      const raw = await this.deps.repo.getRaw(COMPANION_WAKES_KEY);
      const record = parseCompanionWakes(raw);
      fn(record);
      const now = this.deps.clock.now();
      const kept = Object.entries(record.wakes)
        .filter(([, e]) => e.wakeAt >= now - AWAKE_RETENTION_MS)
        .sort((a, b) => b[1].wakeAt - a[1].wakeAt)
        .slice(0, COMPANION_WAKES_CAP);
      const next: CompanionWakesRecord = { version: 1, wakes: Object.fromEntries(kept) };
      if (JSON.stringify(next) === JSON.stringify(raw)) return;
      await this.deps.repo.set(COMPANION_WAKES_KEY, next);
    });
  }

  private failureDetails(o: Outcome): Record<string, string> {
    return o.kind === 'failed' ? { error: o.error, why: o.detail } : {};
  }

  private async auditOp(s: Snipe, kind: string, o: Outcome, extra: Record<string, string>): Promise<void> {
    if (o.kind === 'skipped') return;
    await this.append({
      kind,
      itemId: s.itemId,
      ref: s.id,
      dryRun: s.dryRun,
      details: { ok: o.kind === 'ok', ...extra, ...this.failureDetails(o) },
    });
  }

  private async append(e: { kind: string; ref: string; itemId?: number; dryRun?: boolean; details: Record<string, string | boolean> }): Promise<void> {
    try {
      await this.deps.audit.append({ actor: 'snipe', ...e });
    } catch (err) {
      this.deps.log('companion: the audit entry failed', err);
    }
  }

  private async notifyNotScheduled(s: Snipe, detail: string): Promise<void> {
    try {
      await this.deps.notifier.notify({
        id: `sbw:companion:${s.id}`,
        title: `Wake not scheduled: ${truncateTitle(s.title, 40)}`,
        message: `T2: ${detail}. The computer will not be woken for this snipe: keep it awake through the end, or fix the companion (Options, Sniping).`,
        priority: 2,
      });
    } catch (e) {
      this.deps.log(`companion: the notification for snipe ${s.id} failed`, e);
    }
  }
}

function fail(why: string): PreflightHookFailure {
  return { reason: 'keep-awake', detail: `T2: ${why}, ${NOTHING_WAKES}.` };
}

// ── Self-registration (I-01; main.ts is frozen) ─────────────────────────────

const SYNCS = new WeakMap<BackgroundContext, CompanionSync>();

/** This background's companion sync (tests, diagnostics). */
export function companionSyncFor(ctx: BackgroundContext): CompanionSync | undefined {
  return SYNCS.get(ctx);
}

export interface CompanionSyncOverrides {
  /** Replaces the adapter entirely. */
  companion?: CompanionPort;
  /** The adapter's transport (default: runtime.sendNativeMessage). */
  send?: NativeSend;
  browser?: CompanionBrowser;
}

/** Builds the sync over the real adapter, registers its hooks on T-84's seam and starts the restart check. */
export function registerCompanionSync(ctx: BackgroundContext, overrides: CompanionSyncOverrides = {}): CompanionSync {
  const companion =
    overrides.companion ??
    new BrowserCompanion({
      clock: ctx.clock,
      ...(overrides.send === undefined ? {} : { send: overrides.send }),
      granted: () => ctx.permissions.contains({ permissions: ['nativeMessaging'] }),
    });
  const sync = new CompanionSync({
    companion,
    browser: overrides.browser ?? (isFirefox() ? 'firefox' : 'chrome'),
    clock: ctx.clock,
    repo: ctx.repo,
    settings: async () => ctx.switches.settings() ?? (await ctx.repo.get(STORAGE_KEYS.settings)),
    offsetMs: () => {
      const a = assessClock(ctx.sgwClock.offset());
      return a.ok ? a.offsetMs : 0;
    },
    audit: ctx.audit,
    notifier: ctx.notifier,
    log: (message, error) => {
      console.warn(`[ShopBadwill] ${message}`, error);
    },
  });
  SYNCS.set(ctx, sync);
  snipeSeams(ctx).addArmHooks(sync.hooks);
  sync.start();
  return sync;
}

export function register(ctx: BackgroundContext): void {
  registerCompanionSync(ctx);
}
