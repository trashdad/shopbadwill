// T-67: CalendarSink over CalendarApi (PLAN §3.8). The sink is the only writer
// of our Google events. It runs the ops the pure reconciler (T-66) decides,
// and adds what the reconciler cannot know:
//
//   - OWNERSHIP GUARD (binding). Before any patch, stamp or delete it reads the
//     event and acts only when `sbwItemId !== ''`, `sbwItemId` is this item and
//     the id equals `eventIdFor(itemId, generation)`, on our dedicated calendar.
//     An event without our private property is never written. Inserts need no
//     guard: a 409 goes to get -> revive | bump (S-5 pending: bump-generation).
//   - OWN LIMITER. Every Calendar call goes through a 1 request/second limiter
//     (lane-less: Google is not SGW). A 403/429 records a persisted cooldown
//     and halts the run.
//   - RESUMABLE. The link is saved after every op. A restart between a write
//     and its link save finds the event already there (409, or a patch that
//     matches) and adopts it: no duplicates, no second write. Before creating
//     a calendar, the sink lists and adopts one that already carries our
//     marker or summary, so a crash after insert does not leave a duplicate.
//   - DRY RUN. With dryRun.calendar on, an op becomes an audit entry
//     (`dryRun: true`) and nothing is sent. Disconnected, the caller queues
//     `pending` links with queuePending and makes no call.
//
// Persisted bookkeeping the frozen CalendarLink has no room for (retries,
// cooldown, the once-a-day notice) lives in `sbw:calendarSync` (SyncStateStore).
import { z } from 'zod';

import type { AuditLog } from '../../domain/audit/types';
import type { CalendarLink, DesiredEvent, EventIdFor, GcalEvent, GcalEventBody } from '../../domain/calendar/types';
import { formatMoney } from '../../domain/money';
import type { CalendarState } from '../../domain/storage/schema';
import type { Cents, EpochMs, IsoUtc, ItemId } from '../../domain/types';
import type { CalendarApi, CalendarSink } from '../../ports/calendar';
import type { Clock } from '../../ports/clock';
import { CalendarApiError } from '../../ports/errors';
import type { GlobalSwitches } from '../../ports/global-switches';
import type { Storage } from '../../ports/storage';

// Adapters may not import the reconciler or the Repo (PLAN §2.1), so the pure
// domain pieces and the link store arrive through `deps` (wired in
// src/background/jobs/calendar-sync.ts). The types below mirror T-66's.
export type Outcome = 'won' | 'lost' | 'ended-early';
export type RecreateStrategy = 'bump-generation' | 'revive';
export interface RetryState {
  count: number;
  lastAttemptAt: EpochMs;
}
export type IsLateAddFn = (item: { itemId: ItemId; endTime: IsoUtc }, now: EpochMs) => boolean;

interface OpBase {
  itemId: ItemId;
  retry?: number;
}
interface WriteOp extends OpBase {
  eventId: string;
  event: DesiredEvent;
  hash: string;
}
/** The ops T-66's reconcile() returns (a structural supertype: its SinkOp is assignable). */
export type SinkOp =
  | (WriteOp & { op: 'insert'; lateAdd: boolean })
  | (WriteOp & { op: 'patch' })
  | (WriteOp & { op: 'stamp'; outcome: Outcome })
  | (OpBase & { op: 'delete'; eventId: string })
  | (WriteOp & { op: 'recreate'; lateAdd: boolean })
  | (OpBase & { op: 'noop'; reason: string });

export interface ReconcileKit {
  eventIdFor: EventIdFor;
  hashDesired(e: DesiredEvent): string;
  reconcile(
    desired: readonly DesiredEvent[],
    links: readonly CalendarLink[],
    now: EpochMs,
    options: {
      calendarId: string;
      isLateAdd: IsLateAddFn;
      strategy: RecreateStrategy;
      retries: Readonly<Record<number, RetryState>>;
    },
  ): { ops: SinkOp[] };
}

/** `sbw:calendar` access, over the Repo. */
export interface CalendarStore {
  load(): Promise<CalendarState>;
  update(fn: (s: CalendarState) => CalendarState): Promise<void>;
  /** dryRun.calendar is on and the kill switch is off: ops become audit entries. */
  dryRun(): Promise<boolean>;
}

export const CALENDAR_SUMMARY = 'ShopGoodwill Auctions';
/**
 * Written into the calendar description. A rename of the summary must not hide
 * the calendar we created, and a crash after insert must not create a second one.
 */
export const CALENDAR_MARKER = 'sbw:dedicated-calendar';
export const CALENDAR_DESCRIPTION = `Auction end times from ShopBadwill. ${CALENDAR_MARKER}`;
/** The calendarId of a link queued before any calendar exists. Re-homed when the calendar is created. */
export const PENDING_CALENDAR_ID = 'pending';
/** At most 1 Google request per second (R4). */
export const MIN_REQUEST_INTERVAL_MS = 1000;
export const COOLDOWN_BASE_MS = 60_000;
export const COOLDOWN_CAP_MS = 60 * 60_000;
export const SYNC_STATE_KEY = 'sbw:calendarSync';
/** Event title prefixes once the outcome is known. */
export const OUTCOME_LABEL: Readonly<Record<Outcome, string>> = { won: 'WON', lost: 'LOST', 'ended-early': 'ENDED' };
const MAX_BUMPS = 3;
const MAX_ERROR_CHARS = 200;

// ── Undo ref (audit `undo.kind: 'deleteEvent'`) ─────────────────────────────

/** `undo.ref` of a `calendar.insert` audit entry: `deleteEvent:<itemId>:<eventId>`. */
export const deleteEventRef = (itemId: ItemId, eventId: string): string => `deleteEvent:${String(itemId)}:${eventId}`;
export function parseDeleteEventRef(ref: string): { itemId: ItemId; eventId: string } | undefined {
  const m = /^deleteEvent:(\d+):([a-v0-9]{5,1024})$/.exec(ref);
  const itemId = m?.[1] === undefined ? 0 : Number(m[1]);
  const eventId = m?.[2];
  return Number.isSafeInteger(itemId) && itemId > 0 && eventId !== undefined ? { itemId, eventId } : undefined;
}

// ── Limiter ─────────────────────────────────────────────────────────────────

/**
 * Serializes calls and starts each one at least `minIntervalMs` after the
 * previous one ENDED (monotonic clock). Counting from the end, not the start,
 * keeps the spacing true when one port call holds several HTTP attempts (the
 * adapter's own retries, themselves at least 1 s apart, see GoogleCalendarApi).
 */
export class RequestLimiter {
  private tail: Promise<unknown> = Promise.resolve();
  private lastDone = Number.NEGATIVE_INFINITY;

  constructor(
    private readonly clock: Clock,
    private readonly minIntervalMs: number = MIN_REQUEST_INTERVAL_MS,
  ) {}

  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(async () => {
      const wait = this.lastDone + this.minIntervalMs - this.clock.monotonic();
      if (wait > 0) {
        await new Promise<void>((resolve) => {
          this.clock.setTimeout(resolve, wait);
        });
      }
      try {
        return await fn();
      } finally {
        this.lastDone = this.clock.monotonic();
      }
    });
    this.tail = result.catch(() => undefined);
    return result;
  }
}

/** A CalendarApi whose every call goes through one limiter. */
export function limitCalendarApi(api: CalendarApi, limiter: RequestLimiter): CalendarApi {
  return {
    calendarsInsert: (s, tz, description) => limiter.run(() => api.calendarsInsert(s, tz, description)),
    calendarListGet: (id) => limiter.run(() => api.calendarListGet(id)),
    calendarListList: () => limiter.run(() => api.calendarListList()),
    eventsInsert: (c, b) => limiter.run(() => api.eventsInsert(c, b)),
    eventsGet: (c, e) => limiter.run(() => api.eventsGet(c, e)),
    eventsPatch: (c, e, p) => limiter.run(() => api.eventsPatch(c, e, p)),
    eventsDelete: (c, e) => limiter.run(() => api.eventsDelete(c, e)),
    eventsListByPrivateProp: (c, k, v) => limiter.run(() => api.eventsListByPrivateProp(c, k, v)),
  };
}

// ── Persisted sync bookkeeping ──────────────────────────────────────────────

const SyncStateSchema = z.object({
  /** Failed attempts per item id (feeds the reconciler's retry backoff). */
  retries: z.record(z.string(), z.object({ count: z.number().int().nonnegative(), lastAttemptAt: z.number() })).default({}),
  /** No Google request before this time (after a 403/429). */
  cooldownUntil: z.number().default(0),
  cooldownCount: z.number().int().nonnegative().default(0),
  /** The local day a reconnect notice was last sent for (once per day, not per item). */
  noticeDay: z.string().optional(),
  /** Reminder-sink bookkeeping: item id -> hash last sent. */
  sinkHashes: z.record(z.string(), z.string()).default({}),
  /** Dry-run audit dedupe: item id -> "op:hash" last audited. */
  dryRunSeen: z.record(z.string(), z.string()).default({}),
});
export type SyncState = z.infer<typeof SyncStateSchema>;

/** Read-modify-write of `sbw:calendarSync` in storage.local, serialized in this worker. */
export class SyncStateStore {
  private chain: Promise<unknown> = Promise.resolve();

  constructor(private readonly storage: Storage) {}

  async read(): Promise<SyncState> {
    const raw = await this.storage.get<unknown>(SYNC_STATE_KEY);
    const parsed = SyncStateSchema.safeParse(raw ?? {});
    return parsed.success ? parsed.data : SyncStateSchema.parse({});
  }

  update(fn: (s: SyncState) => SyncState): Promise<SyncState> {
    const next = this.chain.then(async () => {
      const value = fn(await this.read());
      await this.storage.set({ [SYNC_STATE_KEY]: value });
      return value;
    });
    this.chain = next.catch(() => undefined);
    return next;
  }
}

// ── Results ─────────────────────────────────────────────────────────────────

export interface SinkResult {
  itemId: ItemId;
  op: string;
  error?: string;
}

export type HaltReason = 'blocked' | 'rate-limited' | 'auth' | 'offline' | 'error';
export interface SinkRun {
  results: SinkResult[];
  halted?: { reason: HaltReason; message: string };
}

export interface CalendarSinkDeps {
  api: CalendarApi;
  store: CalendarStore;
  kit: ReconcileKit;
  /** storage.local, for `sbw:calendarSync`. */
  storage: Storage;
  audit: Pick<AuditLog, 'append'>;
  switches: GlobalSwitches;
  clock: Clock;
  isLateAdd: IsLateAddFn;
  /** Default `bump-generation` (S-5 pending). */
  strategy?: RecreateStrategy;
  /** Called after an insert of an event that ends soon (I-18). Never throws into the sink. */
  onLateAdd?: (event: DesiredEvent) => Promise<void> | void;
  /** Spacing between Calendar requests. Default 1000 ms; tests pass 0. */
  minIntervalMs?: number;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function errorText(e: unknown): string {
  return (e instanceof Error ? e.message : String(e)).replace(/\s+/g, ' ').slice(0, MAX_ERROR_CHARS);
}

/** The Calendar body of a desired event. */
export function toGcalBody(e: DesiredEvent): GcalEventBody {
  const start = new Date(e.startUtc).getTime();
  return {
    summary: e.title,
    description: e.description,
    start: { dateTime: e.startUtc, timeZone: 'UTC' },
    end: { dateTime: new Date(start + e.durationMin * 60_000).toISOString(), timeZone: 'UTC' },
    reminders: { useDefault: false, overrides: e.reminders },
    extendedProperties: { private: e.privateProps },
    source: { title: 'ShopGoodwill', url: e.sourceUrl },
  };
}

/** The same event one generation up (a fresh id, a fresh hash). */
function withGeneration(e: DesiredEvent, generation: number): DesiredEvent {
  return { ...e, generation, privateProps: { ...e.privateProps, sbwGen: String(generation) } };
}

function sameInstant(a: string, b: string): boolean {
  return new Date(a).getTime() === new Date(b).getTime();
}

/** Does the stored event already carry what we would write? (Skips a redundant PATCH after a restart.) */
function alreadyMatches(ev: GcalEvent, body: GcalEventBody): boolean {
  return (
    ev.status !== 'cancelled' &&
    ev.summary === body.summary &&
    ev.description === body.description &&
    sameInstant(ev.start.dateTime, body.start.dateTime) &&
    sameInstant(ev.end.dateTime, body.end.dateTime) &&
    JSON.stringify(ev.reminders.overrides) === JSON.stringify(body.reminders.overrides) &&
    ev.extendedProperties.private.sbwState === body.extendedProperties.private.sbwState
  );
}

function stripLabel(summary: string): string {
  return summary.replace(/^(WON|LOST|ENDED): /, '');
}

/** The patch that stamps an outcome: retitle, clear reminders, set sbwState. */
function stampBody(base: { title: string; description: string }, privateProps: DesiredEvent['privateProps'], outcome: Outcome, finalPrice?: Cents): Partial<GcalEventBody> {
  const price = finalPrice === undefined ? '' : `\nFinal price: ${formatMoney(finalPrice)}`;
  return {
    summary: `${OUTCOME_LABEL[outcome]}: ${stripLabel(base.title)}`,
    description: base.description.replace(/\nFinal price: .*$/m, '') + price,
    reminders: { useDefault: false, overrides: [] },
    extendedProperties: { private: { ...privateProps, sbwState: outcome } },
  };
}

function isStamped(ev: GcalEvent, outcome: Outcome, finalPrice?: Cents): boolean {
  return (
    ev.extendedProperties.private.sbwState === outcome &&
    ev.summary.startsWith(`${OUTCOME_LABEL[outcome]}: `) &&
    (finalPrice === undefined || ev.description.includes(`Final price: ${formatMoney(finalPrice)}`))
  );
}

type Classified =
  | { kind: 'halt'; reason: HaltReason; message: string; cooldown: boolean }
  | { kind: 'item'; message: string };

function classify(e: unknown): Classified {
  const message = errorText(e);
  if (e instanceof CalendarApiError) {
    if (e.code === 'rate-limited' || e.status === 429 || (e.status === 403 && e.code !== 'insufficient-scope')) {
      return { kind: 'halt', reason: 'rate-limited', message, cooldown: true };
    }
    if (e.code === 'auth' || e.code === 'insufficient-scope') return { kind: 'halt', reason: 'auth', message, cooldown: false };
    if (e.code === 'offline') return { kind: 'halt', reason: 'offline', message, cooldown: false };
  }
  return { kind: 'item', message };
}

class Halt extends Error {
  constructor(
    readonly reason: HaltReason,
    message: string,
    /** True when the halt IS the recorded cooldown (do not extend it). */
    readonly cooling = false,
  ) {
    super(message);
  }
}

export interface CalendarSinkRunOptions {
  /** Used when the Calendar calendar must be created. */
  timeZone?: string;
}

// ── The sink ────────────────────────────────────────────────────────────────

export class GoogleCalendarSink implements CalendarSink {
  readonly state: SyncStateStore;
  private readonly strategy: RecreateStrategy;
  private queue: Promise<unknown> = Promise.resolve();
  private ensuring: Promise<string> | undefined;
  /** The stored calendar was confirmed to exist in this worker's life. */
  private verified: string | undefined;
  private timeZone = 'UTC';

  constructor(private readonly deps: CalendarSinkDeps) {
    this.state = new SyncStateStore(deps.storage);
    this.strategy = deps.strategy ?? 'bump-generation';
  }

  setTimeZone(tz: string): void {
    this.timeZone = tz;
  }

  /** Ownership: our private property, this item, and exactly our id format for this generation. */
  private own(ev: GcalEvent, itemId: ItemId, generation: number): boolean {
    const p = ev.extendedProperties.private;
    return p.sbwItemId !== '' && p.sbwItemId === String(itemId) && ev.id === this.deps.kit.eventIdFor(itemId, generation);
  }

  // ── port ──────────────────────────────────────────────────────────────────

  async ensureCalendar(): Promise<string> {
    const verdict = await this.deps.switches.writesAllowed('calendar');
    if (!verdict.ok) throw new Error(`calendar writes are off: ${verdict.why ?? 'blocked'}`);
    return this.exclusive(() => this.ensureCalendarInner());
  }

  async upsert(e: DesiredEvent): Promise<{ op: 'insert' | 'patch' | 'noop' | 'recreated'; link: CalendarLink }> {
    const link = (await this.deps.store.load()).links[e.itemId];
    const run = await this.run([e], link === undefined ? [] : [link]);
    const first = run.results.find((r) => r.itemId === e.itemId);
    if (run.halted !== undefined) throw new Error(run.halted.message);
    const after = (await this.deps.store.load()).links[e.itemId];
    if (first === undefined || after === undefined) throw new Error('calendar upsert: no result for the item');
    if (first.error !== undefined) throw new Error(first.error);
    const op = first.op === 'recreate' ? 'recreated' : first.op === 'stamp' ? 'patch' : first.op;
    return { op: op === 'insert' || op === 'patch' || op === 'recreated' ? op : 'noop', link: after };
  }

  async remove(itemId: ItemId): Promise<{ op: 'delete' | 'noop' }> {
    const link = (await this.deps.store.load()).links[itemId];
    if (link === undefined) return { op: 'noop' };
    const run = await this.run([], [link]);
    if (run.halted !== undefined) throw new Error(run.halted.message);
    const r = run.results.find((x) => x.itemId === itemId);
    if (r?.error !== undefined) throw new Error(r.error);
    return { op: r?.op === 'delete' ? 'delete' : 'noop' };
  }

  async stamp(itemId: ItemId, outcome: Outcome, finalPrice?: Cents): Promise<void> {
    const verdict = await this.deps.switches.writesAllowed('calendar');
    if (!verdict.ok) throw new Error(`calendar writes are off: ${verdict.why ?? 'blocked'}`);
    await this.exclusive(async () => {
      const { cooldownUntil } = await this.state.read();
      if (cooldownUntil > this.deps.clock.now()) throw new Error(`cooling down until ${new Date(cooldownUntil).toISOString()}`);
      const state = await this.deps.store.load();
      const link = state.links[itemId];
      if (link === undefined || link.status === 'deleted' || link.status === 'pending' || state.calendarId === undefined) return;
      if (link.calendarId !== state.calendarId || link.eventId !== this.deps.kit.eventIdFor(itemId, link.generation)) return;
      const ev = await this.deps.api.eventsGet(link.calendarId, link.eventId);
      if (ev === null || ev.status === 'cancelled' || !this.own(ev, itemId, link.generation)) return;
      if (!isStamped(ev, outcome, finalPrice)) {
        const patch = stampBody({ title: ev.summary, description: ev.description }, ev.extendedProperties.private, outcome, finalPrice);
        await this.deps.api.eventsPatch(link.calendarId, link.eventId, patch);
        await this.deps.audit.append({
          actor: 'calendar',
          kind: 'calendar.stamp',
          itemId,
          ref: link.eventId,
          details: { outcome },
        });
      }
      // Marked so the next sync re-checks (a GET, no write) and settles on the desired hash.
      await this.saveLink({ ...link, lastSyncedHash: `stamped:${outcome}`, status: 'synced' });
      await this.clearRetry(itemId);
    });
  }

  async reconcile(desired: DesiredEvent[], links: CalendarLink[]): Promise<SinkResult[]> {
    return (await this.run(desired, links)).results;
  }

  // ── queueing while disconnected ───────────────────────────────────────────

  /**
   * Disconnected: record `pending` links for desired events that have none,
   * so the dashboard can show them and a later connect inserts them. Local
   * only: makes no Google call. Returns the number of items waiting.
   */
  async queuePending(desired: readonly DesiredEvent[]): Promise<number> {
    const state = await this.deps.store.load();
    const calendarId = state.calendarId ?? PENDING_CALENDAR_ID;
    const adds: CalendarLink[] = [];
    let waiting = 0;
    for (const d of desired) {
      if (d.privateProps.sbwState !== 'open') continue; // already decided: nothing to put on a calendar
      const link = state.links[d.itemId];
      if (link === undefined) {
        adds.push({
          itemId: d.itemId,
          eventId: this.deps.kit.eventIdFor(d.itemId, d.generation),
          generation: d.generation,
          calendarId,
          lastSyncedHash: '',
          status: 'pending',
        });
        waiting += 1;
      } else if (link.status === 'pending') {
        waiting += 1;
      }
    }
    if (adds.length > 0) {
      await this.deps.store.update((cur) => {
        const links = { ...cur.links };
        for (const l of adds) links[l.itemId] ??= l;
        return { ...cur, links };
      });
    }
    return waiting;
  }

  // ── the engine ────────────────────────────────────────────────────────────

  async run(desired: readonly DesiredEvent[], links: readonly CalendarLink[]): Promise<SinkRun> {
    return this.exclusive(() => this.runInner(desired, links));
  }

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async runInner(desired: readonly DesiredEvent[], links: readonly CalendarLink[]): Promise<SinkRun> {
    const { store, clock } = this.deps;
    const verdict = await this.deps.switches.writesAllowed('calendar');
    const dry = !verdict.ok && (await store.dryRun());
    if (!verdict.ok && !dry) return { results: [], halted: { reason: 'blocked', message: verdict.why ?? 'calendar writes are blocked' } };

    const stored = await store.load();
    let calendarId = stored.calendarId ?? PENDING_CALENDAR_ID;
    const sync0 = await this.state.read();
    const plan = (id: string, s: SyncState, from: readonly CalendarLink[] = links) =>
      this.deps.kit.reconcile(desired, rehome(from, id), clock.now(), {
        calendarId: id,
        isLateAdd: this.deps.isLateAdd,
        strategy: this.strategy,
        retries: retriesOf(s),
      });
    let ops = plan(calendarId, sync0).ops;
    const actionable = ops.filter((o) => o.op !== 'noop');
    const results: SinkResult[] = ops.filter((o) => o.op === 'noop').map((o) => ({ itemId: o.itemId, op: 'noop' }));
    if (actionable.length === 0) return { results };

    if (dry) {
      await this.auditDryRun(actionable, sync0);
      return { results: [...results, ...actionable.map((o) => ({ itemId: o.itemId, op: o.op }))] };
    }

    try {
      const sync = await this.state.read();
      if (sync.cooldownUntil > clock.now()) {
        throw new Halt('rate-limited', `cooling down until ${new Date(sync.cooldownUntil).toISOString()}`, true);
      }
      const ensured = await this.ensureCalendarInner();
      if (ensured !== calendarId) {
        // The calendar was created (or re-created): links queued before it now belong to it.
        calendarId = ensured;
        const fresh = (await store.load()).links;
        ops = plan(calendarId, await this.state.read(), links.map((l) => fresh[l.itemId] ?? l)).ops.filter((o) => o.op !== 'noop');
      } else {
        ops = actionable;
      }
      for (const op of ops) {
        try {
          results.push({ itemId: op.itemId, op: await this.execute(calendarId, op) });
        } catch (e) {
          const c = e instanceof Halt ? undefined : classify(e);
          if (c?.kind === 'halt') throw new Halt(c.reason, c.message);
          if (e instanceof Halt) throw e;
          const message = c?.message ?? errorText(e);
          await this.recordItemError(calendarId, op, message);
          results.push({ itemId: op.itemId, op: op.op, error: message });
        }
      }
      await this.state.update((s) => (s.cooldownCount === 0 ? s : { ...s, cooldownCount: 0 }));
      return { results };
    } catch (e) {
      let halt: Halt;
      if (e instanceof Halt) {
        halt = e;
      } else {
        const c = classify(e);
        halt = new Halt(c.kind === 'halt' ? c.reason : 'error', c.message);
      }
      if (halt.reason === 'rate-limited' && !halt.cooling) await this.recordCooldown(halt.message);
      // What was not done stays pending: items without a link get one so the dashboard shows them.
      const todo = new Set(ops.filter((o) => o.op === 'insert' || o.op === 'recreate').map((o) => o.itemId));
      await this.queuePending(desired.filter((d) => todo.has(d.itemId)));
      return { results, halted: { reason: halt.reason, message: halt.message } };
    }
  }

  private async recordCooldown(message: string): Promise<void> {
    const now = this.deps.clock.now();
    const s = await this.state.update((cur) => ({
      ...cur,
      cooldownCount: cur.cooldownCount + 1,
      cooldownUntil: now + Math.min(COOLDOWN_BASE_MS * 2 ** cur.cooldownCount, COOLDOWN_CAP_MS),
    }));
    await this.deps.audit.append({
      actor: 'calendar',
      kind: 'calendar.cooldown',
      details: { until: s.cooldownUntil, count: s.cooldownCount, error: message },
    });
  }

  private async auditDryRun(ops: readonly SinkOp[], sync: SyncState): Promise<void> {
    const seen: Record<string, string> = {};
    for (const o of ops) {
      const hash = 'hash' in o ? o.hash : o.op === 'delete' ? o.eventId : '';
      const key = `${o.op}:${hash}`;
      seen[String(o.itemId)] = key;
      if (sync.dryRunSeen[String(o.itemId)] === key) continue;
      await this.deps.audit.append({
        actor: 'calendar',
        kind: `calendar.${o.op}`,
        itemId: o.itemId,
        ...('eventId' in o ? { ref: o.eventId } : {}),
        details: { dryRun: true },
        dryRun: true,
      });
    }
    await this.state.update((s) => ({ ...s, dryRunSeen: seen }));
  }

  // ── calendar ──────────────────────────────────────────────────────────────

  private ensureCalendarInner(): Promise<string> {
    this.ensuring ??= this.createOrFind().finally(() => {
      this.ensuring = undefined;
    });
    return this.ensuring;
  }

  private async createOrFind(): Promise<string> {
    const { store, api, audit } = this.deps;
    const stored = await store.load();
    if (stored.calendarId !== undefined) {
      if (this.verified === stored.calendarId) return stored.calendarId;
      const found = await api.calendarListGet(stored.calendarId);
      if (found !== null) {
        this.verified = stored.calendarId;
        return stored.calendarId;
      }
      // The user deleted our calendar: its events went with it. Start again, every item pending.
      await this.deps.store.update((cur) => ({
        links: Object.fromEntries(
          Object.entries(cur.links).map(([k, l]) => [
            k,
            l.status === 'deleted' ? l : { ...l, calendarId: PENDING_CALENDAR_ID, status: 'pending' as const, lastSyncedHash: '' },
          ]),
        ),
      }));
      await audit.append({ actor: 'calendar', kind: 'calendar.recreated', details: { lost: stored.calendarId } });
    }
    // A crash after insert leaves the calendar on Google with no saved id.
    // Listing finds it by our marker so we do not insert a second one.
    const existing = await this.findDedicated();
    if (existing !== undefined) {
      await this.persistCalendar(existing);
      await audit.append({ actor: 'calendar', kind: 'calendar.adopted', ref: existing, details: { summary: CALENDAR_SUMMARY } });
      return existing;
    }
    // calendarsInsert is noRetry (a lost response would duplicate); we persist the id at once.
    const created = await api.calendarsInsert(CALENDAR_SUMMARY, this.timeZone, CALENDAR_DESCRIPTION);
    await this.persistCalendar(created.id);
    await audit.append({ actor: 'calendar', kind: 'calendar.create', ref: created.id, details: { summary: CALENDAR_SUMMARY } });
    return created.id;
  }

  /**
   * The id of our dedicated calendar, if a list can see one. Does not create.
   *
   * ACCOUNT SAFETY: whatever is adopted here becomes the calendar the sink
   * writes to, so only a calendar we demonstrably created qualifies: the user
   * OWNS it (a calendar shared by someone else is not ours), it is not the
   * primary calendar, and its description carries CALENDAR_MARKER (written by
   * calendarsInsert below). The summary alone never qualifies: a user calendar
   * may share the name. Every build that creates the calendar writes the
   * marker, so no calendar of ours lacks it.
   *
   * `calendar.app.created` is not on Google's published scope list for
   * calendarList.list (it is allowed for calendarList.get). A 403 there is
   * "we cannot look", not "the user must reconnect": fall through and insert.
   */
  private async findDedicated(): Promise<string | undefined> {
    let listed: Awaited<ReturnType<CalendarApi['calendarListList']>>;
    try {
      listed = await this.deps.api.calendarListList();
    } catch (e) {
      if (e instanceof CalendarApiError && e.code === 'insufficient-scope') return undefined;
      throw e;
    }
    return listed.find(
      (c) => c.id !== '' && c.id !== 'primary' && c.primary !== true && c.accessRole === 'owner' && (c.description ?? '').includes(CALENDAR_MARKER),
    )?.id;
  }

  private async persistCalendar(id: string): Promise<void> {
    await this.deps.store.update((cur) => ({
      calendarId: id,
      links: Object.fromEntries(
        Object.entries(cur.links).map(([k, l]) => [k, l.calendarId === PENDING_CALENDAR_ID ? { ...l, calendarId: id } : l]),
      ),
    }));
    this.verified = id;
  }

  // ── ops ───────────────────────────────────────────────────────────────────

  private async execute(calendarId: string, op: SinkOp): Promise<string> {
    switch (op.op) {
      case 'noop':
        return 'noop';
      case 'insert':
      case 'recreate':
        return this.insert(calendarId, op, op.op === 'recreate');
      case 'patch':
        return this.patch(calendarId, op);
      case 'stamp':
        return this.stampOp(calendarId, op);
      case 'delete':
        return this.delete(calendarId, op);
    }
  }

  private async afterWrite(link: CalendarLink): Promise<void> {
    await this.saveLink(link);
    await this.clearRetry(link.itemId);
  }

  private linkFor(calendarId: string, event: DesiredEvent, eventId: string, hash: string): CalendarLink {
    return { itemId: event.itemId, eventId, generation: event.generation, calendarId, lastSyncedHash: hash, status: 'synced' };
  }

  private async insert(
    calendarId: string,
    op: Extract<SinkOp, { op: 'insert' | 'recreate' }>,
    recreated: boolean,
  ): Promise<string> {
    let event = op.event;
    let eventId = op.eventId;
    for (let bump = 0; ; bump++) {
      try {
        await this.deps.api.eventsInsert(calendarId, { ...toGcalBody(event), id: eventId });
        break;
      } catch (e) {
        if (!(e instanceof CalendarApiError) || e.code !== 'conflict') throw e;
        const resolved = await this.onConflict(calendarId, event, eventId);
        if (resolved === 'adopted' || resolved === 'revived') {
          await this.afterWrite(this.linkFor(calendarId, event, eventId, this.deps.kit.hashDesired(event)));
          await this.audit('calendar.adopt', event, eventId, { how: resolved });
          return recreated ? 'recreate' : 'insert';
        }
        if (bump < MAX_BUMPS) {
          event = withGeneration(event, event.generation + 1);
          eventId = this.deps.kit.eventIdFor(event.itemId, event.generation);
          continue;
        }
        throw new CalendarApiError('conflict', `event id ${eventId} is taken and could not be reused`);
      }
    }
    const link = this.linkFor(calendarId, event, eventId, this.deps.kit.hashDesired(event));
    await this.afterWrite(link);
    await this.deps.audit.append({
      actor: 'calendar',
      kind: 'calendar.insert',
      itemId: event.itemId,
      ref: eventId,
      details: { startUtc: event.startUtc, generation: event.generation, recreated },
      undo: { kind: 'deleteEvent', ref: deleteEventRef(event.itemId, eventId) },
    });
    if (op.lateAdd && this.deps.onLateAdd !== undefined) {
      try {
        await this.deps.onLateAdd(event);
      } catch {
        // A notification problem never fails a calendar write.
      }
    }
    return recreated ? 'recreate' : 'insert';
  }

  /** 409 on insert: read what holds the id, then adopt, revive or bump (never touching a foreign event). */
  private async onConflict(calendarId: string, event: DesiredEvent, eventId: string): Promise<'adopted' | 'revived' | 'bump'> {
    const { api } = this.deps;
    const existing = await api.eventsGet(calendarId, eventId);
    if (existing === null || !this.own(existing, event.itemId, event.generation)) return 'bump';
    if (existing.status === 'cancelled') {
      if (this.strategy !== 'revive') return 'bump';
      await api.eventsPatch(calendarId, eventId, { ...toGcalBody(event), status: 'confirmed' });
      return 'revived';
    }
    // Ours and alive: left by a run that died before saving its link. Adopt it.
    if (!alreadyMatches(existing, toGcalBody(event))) await api.eventsPatch(calendarId, eventId, toGcalBody(event));
    return 'adopted';
  }

  private async patch(calendarId: string, op: Extract<SinkOp, { op: 'patch' }>): Promise<string> {
    const ev = await this.deps.api.eventsGet(calendarId, op.eventId);
    if (ev === null || ev.status === 'cancelled') {
      // Deleted by the user: put it back under a fresh id (the old one is reserved).
      return this.insert(
        calendarId,
        { ...op, op: 'insert', event: withGeneration(op.event, op.event.generation + 1), eventId: this.deps.kit.eventIdFor(op.itemId, op.event.generation + 1), lateAdd: false },
        true,
      );
    }
    if (!this.own(ev, op.itemId, op.event.generation)) return this.refuse(calendarId, op, 'patch');
    const body = toGcalBody(op.event);
    let wrote = false;
    if (!alreadyMatches(ev, body)) {
      await this.deps.api.eventsPatch(calendarId, op.eventId, body);
      wrote = true;
    }
    await this.afterWrite(this.linkFor(calendarId, op.event, op.eventId, op.hash));
    if (wrote) await this.audit('calendar.patch', op.event, op.eventId, { startUtc: op.event.startUtc });
    return wrote ? 'patch' : 'noop';
  }

  private async stampOp(calendarId: string, op: Extract<SinkOp, { op: 'stamp' }>): Promise<string> {
    const ev = await this.deps.api.eventsGet(calendarId, op.eventId);
    if (ev === null || ev.status === 'cancelled') {
      await this.afterWrite(this.linkFor(calendarId, op.event, op.eventId, op.hash)); // nothing left to stamp
      return 'noop';
    }
    if (!this.own(ev, op.itemId, op.event.generation)) return this.refuse(calendarId, op, 'stamp');
    let wrote = false;
    if (!isStamped(ev, op.outcome)) {
      await this.deps.api.eventsPatch(
        calendarId,
        op.eventId,
        stampBody({ title: op.event.title, description: op.event.description }, op.event.privateProps, op.outcome),
      );
      wrote = true;
    }
    await this.afterWrite(this.linkFor(calendarId, op.event, op.eventId, op.hash));
    if (wrote) await this.audit('calendar.stamp', op.event, op.eventId, { outcome: op.outcome });
    return wrote ? 'stamp' : 'noop';
  }

  private async delete(calendarId: string, op: Extract<SinkOp, { op: 'delete' }>): Promise<string> {
    const stored = (await this.deps.store.load()).links[op.itemId];
    const generation = generationOfId(op.itemId, op.eventId);
    if (generation === undefined) {
      await this.audit('calendar.refused', { itemId: op.itemId }, op.eventId, { op: 'delete', why: 'not our event id' });
      return 'refused';
    }
    const ev = await this.deps.api.eventsGet(calendarId, op.eventId);
    let wrote = false;
    if (ev !== null && ev.status !== 'cancelled') {
      if (!this.own(ev, op.itemId, generation)) return this.refuseDelete(op, 'event has no ShopBadwill property');
      await this.deps.api.eventsDelete(calendarId, op.eventId);
      wrote = true;
      await this.audit('calendar.delete', { itemId: op.itemId }, op.eventId, {});
    }
    if (stored !== undefined && stored.eventId === op.eventId) {
      await this.afterWrite({ ...stored, status: 'deleted', lastSyncedHash: '' });
    }
    return wrote ? 'delete' : 'noop';
  }

  /** The event under our id is not ours: leave it alone, report, and stop retrying it as ours. */
  private async refuse(calendarId: string, op: Extract<SinkOp, { op: 'patch' | 'stamp' }>, what: string): Promise<string> {
    await this.audit('calendar.refused', op.event, op.eventId, { op: what, why: 'event has no ShopBadwill property' });
    await this.saveLink({
      ...this.linkFor(calendarId, op.event, op.eventId, ''),
      status: 'error',
      lastError: 'refused: the event is not a ShopBadwill event',
    });
    return 'refused';
  }

  private async refuseDelete(op: Extract<SinkOp, { op: 'delete' }>, why: string): Promise<string> {
    await this.audit('calendar.refused', { itemId: op.itemId }, op.eventId, { op: 'delete', why });
    const stored = (await this.deps.store.load()).links[op.itemId];
    if (stored !== undefined && stored.eventId === op.eventId) {
      await this.saveLink({ ...stored, status: 'deleted', lastSyncedHash: '', lastError: `refused: ${why}` });
    }
    return 'refused';
  }

  // ── persistence ───────────────────────────────────────────────────────────

  private async audit(kind: string, event: { itemId: ItemId }, eventId: string, details: Record<string, string | number | boolean>): Promise<void> {
    await this.deps.audit.append({ actor: 'calendar', kind, itemId: event.itemId, ref: eventId, details });
  }

  private async saveLink(link: CalendarLink): Promise<void> {
    const { lastError, ...rest } = link;
    const clean: CalendarLink = link.status === 'synced' || lastError === undefined ? rest : link;
    await this.deps.store.update((cur) => ({ ...cur, links: { ...cur.links, [link.itemId]: clean } }));
  }

  private async clearRetry(itemId: ItemId): Promise<void> {
    const s = await this.state.read();
    if (s.retries[String(itemId)] === undefined) return;
    await this.state.update((cur) => {
      return { ...cur, retries: Object.fromEntries(Object.entries(cur.retries).filter(([k]) => k !== String(itemId))) };
    });
  }

  private async recordItemError(calendarId: string, op: SinkOp, message: string): Promise<void> {
    const now = this.deps.clock.now();
    await this.state.update((cur) => ({
      ...cur,
      retries: { ...cur.retries, [String(op.itemId)]: { count: (cur.retries[String(op.itemId)]?.count ?? 0) + 1, lastAttemptAt: now } },
    }));
    const stored = (await this.deps.store.load()).links[op.itemId];
    const base: CalendarLink | undefined =
      stored ??
      ('event' in op
        ? { itemId: op.itemId, eventId: op.eventId, generation: op.event.generation, calendarId, lastSyncedHash: '', status: 'error' }
        : undefined);
    if (base !== undefined) await this.saveLink({ ...base, status: 'error', lastError: message });
    await this.deps.audit.append({
      actor: 'calendar',
      kind: 'calendar.error',
      itemId: op.itemId,
      details: { op: op.op, error: message },
    });
  }
}

function retriesOf(s: SyncState): Record<number, RetryState> {
  const out: Record<number, RetryState> = {};
  for (const [k, v] of Object.entries(s.retries)) out[Number(k)] = v;
  return out;
}

/** Links queued under the placeholder calendar belong to the real one once it exists. */
function rehome(links: readonly CalendarLink[], calendarId: string): CalendarLink[] {
  return links.map((l) => (l.calendarId === PENDING_CALENDAR_ID && l.status === 'pending' ? { ...l, calendarId } : l));
}

function generationOfId(itemId: ItemId, eventId: string): number | undefined {
  const m = new RegExp(`^sbv${String(itemId)}g(\\d+)$`).exec(eventId);
  const g = m?.[1] === undefined ? undefined : Number(m[1]);
  return g !== undefined && Number.isSafeInteger(g) ? g : undefined;
}

