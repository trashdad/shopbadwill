// T-25: PLAN §3.4 RequestScheduler, the one door every SGW request goes
// through (PLAN §1.3, §9). It keeps the extension a considerate guest:
//
// - Lanes (DEFAULT_LANES): one request in flight per lane, and a gap of
//   `minIntervalMs` + 0..`jitterMs` between the end of one request and the
//   start of the next. The gap is checked on both the wall clock and the
//   monotonic clock, so moving the system time forward cannot shorten it.
// - Daily budget per lane, counted when a request is sent and persisted in
//   `sbw:requestBudget` under the local day; it resets at local midnight. A
//   spent lane refuses with SgwApiError('budget') until then.
// - Backoff: 429 or 5xx → lane backoff min(2^n × 30 s, 30 min) with up to
//   +25 % jitter (never past the cap); 403 → lane backoff 1 h, kind `blocked`.
//   A longer Retry-After always wins. Three consecutive 403s on any lanes
//   pause every lane 6 h; three consecutive 429s pause every lane until the
//   backoff ends. Both notify the user and emit a `paused` event.
// - Never retry hot: the scheduler never retries on its own. A request on a
//   paused, backing-off or spent lane is refused locally, so the caller's
//   retry cannot reach SGW until the wait is over. Queued requests are refused
//   the same way instead of being sent once the lane is blocked.
// - Requests go out exactly as `build()` made them: no header, user-agent or
//   credential changes, ever.
// - considerateMode 'tight' halves every budget and doubles every interval.
//
// All timing goes through the Clock port (no Date.now, no global timers), so
// the whole thing runs deterministically on FakeClock.
import { z } from 'zod';

import { RequestBudgetSchema, STORAGE_KEYS, type RequestBudget } from '../../domain/storage/schema';
import {
  DEFAULT_LANES,
  EpochMsSchema,
  LaneSchema,
  type EpochMs,
  type Lane,
  type LaneConfig,
  type RequestSchedulerStats,
} from '../../domain/types';
import type { Clock } from '../../ports/clock';
import { HttpTimeoutError, SgwApiError } from '../../ports/errors';
import type { Http, HttpRequest, HttpResponse } from '../../ports/http';
import type { Notifier } from '../../ports/notifier';
import type { RequestScheduler, ScheduledRequest } from '../../ports/request-scheduler';
import type { Storage } from '../../ports/storage';

// ── Policy constants (PLAN §3.4) ────────────────────────────────────────────

/** First 429/5xx backoff; doubles per consecutive failure on the lane. */
export const BACKOFF_BASE_MS = 30_000;
/** Ceiling of the 429/5xx backoff (a longer Retry-After still wins). */
export const BACKOFF_CAP_MS = 30 * 60_000;
/** The 429/5xx backoff is stretched by up to this fraction, never past the cap. */
export const BACKOFF_JITTER_FRACTION = 0.25;
/** Lane backoff after a 403. */
export const BLOCKED_BACKOFF_MS = 60 * 60_000;
/** All-lane pause after BURST_THRESHOLD consecutive 403s. */
export const BLOCK_PAUSE_MS = 6 * 60 * 60_000;
/** Consecutive 403s (or 429s), on any lanes, that pause every lane. */
export const BURST_THRESHOLD = 3;
/** A Retry-After longer than this is treated as this long. */
export const RETRY_AFTER_CAP_MS = 24 * 60 * 60_000;
/** In-memory result cache size; the oldest entry goes first. */
export const CACHE_MAX_ENTRIES = 500;
/** One notification id, so a new pause replaces the old notice instead of stacking. */
export const PAUSE_NOTIFICATION_ID = 'sbw:scheduler-paused';

export const BLOCKED_MESSAGE = 'SGW is refusing requests; automation paused';

const LANES: readonly Lane[] = LaneSchema.options;

// ── Public types ────────────────────────────────────────────────────────────

export type ConsiderateMode = 'normal' | 'tight';
export type BackoffKind = 'rate-limited' | 'blocked' | 'server';
export type PauseCause = 'manual' | 'blocked' | 'rate-limited';

/** `until: null` = until `resume()`. */
export interface PauseState {
  cause: PauseCause;
  reason: string;
  until: EpochMs | null;
}

export type SchedulerEvent =
  | ({ type: 'paused' } & PauseState)
  | { type: 'resumed' }
  | { type: 'backoff'; lane: Lane; kind: BackoffKind; status: number; until: EpochMs }
  | { type: 'budget-exhausted'; lane: Lane; day: string; budget: number };

export interface RequestSchedulerDeps {
  clock: Clock;
  http: Http;
  /** `storage.local`; holds `sbw:requestBudget` (and `stateKey`, if given). */
  storage: Storage;
  /** Tells the user when SGW's answers pause every lane. */
  notifier?: Notifier;
  /** Uniform in [0, 1), for jitter. Defaults to Math.random. */
  random?: () => number;
  /** Defaults to DEFAULT_LANES (§3.4). */
  lanes?: Readonly<Record<Lane, Readonly<LaneConfig>>>;
  /** Defaults to 'normal'; change it later with setConsiderateMode(). */
  considerateMode?: ConsiderateMode;
  /**
   * Opt-in: a storage key under which pause, backoff and spacing state is
   * saved, so a service-worker restart cannot forget a block. Off by default:
   * the key is not part of the v1 storage contract yet (see the T-25 report).
   */
  stateKey?: string;
}

// ── Local day (budgets reset at local midnight) ─────────────────────────────

/** 'YYYY-MM-DD' of `ms` in the browser's local time zone. */
export function localDay(ms: EpochMs): string {
  const d = new Date(ms);
  return `${String(d.getFullYear()).padStart(4, '0')}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** The next local midnight after `ms`. */
export function nextLocalMidnight(ms: EpochMs): EpochMs {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

// ── Retry-After ─────────────────────────────────────────────────────────────

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const IMF_FIXDATE = /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), (\d{2}) ([A-Z][a-z]{2}) (\d{4}) (\d{2}):(\d{2}):(\d{2}) GMT$/;

/**
 * Retry-After as a wait in ms from `now`: delta-seconds or an IMF-fixdate
 * (RFC 9110 §10.2.3). Anything else is ignored. Clamped to 0..RETRY_AFTER_CAP_MS.
 */
export function parseRetryAfter(headers: Record<string, string>, now: EpochMs): number | undefined {
  let raw: string | undefined;
  for (const [name, value] of Object.entries(headers)) if (name.toLowerCase() === 'retry-after') raw = value.trim();
  if (raw === undefined || raw === '') return undefined;
  let ms: number;
  if (/^\d+$/.test(raw)) {
    ms = Number(raw) * 1000;
  } else {
    const m = IMF_FIXDATE.exec(raw);
    if (m === null) return undefined;
    const month = MONTHS.indexOf(m[2] ?? '');
    if (month < 0) return undefined;
    const at = Date.UTC(Number(m[3]), month, Number(m[1]), Number(m[4]), Number(m[5]), Number(m[6]));
    if (!Number.isFinite(at)) return undefined;
    ms = at - now;
  }
  return Math.min(Math.max(0, ms), RETRY_AFTER_CAP_MS);
}

// ── Saved state (opt-in, `stateKey`) ────────────────────────────────────────

const SavedLaneSchema = z.object({
  lastEndAt: EpochMsSchema.optional(),
  gapJitterMs: z.number().int().nonnegative(),
  backoffUntil: EpochMsSchema.optional(),
  backoffKind: z.enum(['rate-limited', 'blocked', 'server']).optional(),
  failures: z.number().int().nonnegative(),
});

const SavedStateSchema = z.object({
  pause: z
    .object({ cause: z.enum(['manual', 'blocked', 'rate-limited']), reason: z.string(), until: EpochMsSchema.nullable() })
    .nullable(),
  streak403: z.number().int().nonnegative(),
  streak429: z.number().int().nonnegative(),
  lanes: z.partialRecord(LaneSchema, SavedLaneSchema),
});
type SavedState = z.infer<typeof SavedStateSchema>;

// ── Implementation ──────────────────────────────────────────────────────────

interface Waiting {
  req: ScheduledRequest<unknown>;
  priority: number;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
}

interface LaneState {
  queue: Waiting[];
  inFlight: boolean;
  /** Clock timer waiting out the gap, if any. */
  timer: number | undefined;
  /** When the last request on this lane settled (wall and monotonic). */
  lastEndAt: EpochMs | undefined;
  lastEndMono: number;
  /** Jitter drawn for the gap after the last request. */
  gapJitterMs: number;
  backoffUntil: EpochMs | undefined;
  backoffKind: BackoffKind | undefined;
  /** Consecutive 429/5xx on this lane (the n in 2^n × 30 s). */
  failures: number;
}

/** 2^32 × 30 s is far past the cap; stop counting there. */
const MAX_FAILURES = 32;

export class SgwRequestScheduler implements RequestScheduler {
  private readonly clock: Clock;
  private readonly http: Http;
  private readonly storage: Storage;
  private readonly notifier: Notifier | undefined;
  private readonly random: () => number;
  private readonly laneConfigs: Readonly<Record<Lane, Readonly<LaneConfig>>>;
  private readonly stateKey: string | undefined;
  private mode: ConsiderateMode;

  private readonly lanes: Record<Lane, LaneState>;
  private budget: RequestBudget = { day: '', used: {} };
  private pauseInfo: PauseState | undefined;
  private streak403 = 0;
  private streak429 = 0;

  private readonly cache = new Map<string, { value: unknown; expiresAt: EpochMs }>();
  private readonly shared = new Map<string, Promise<unknown>>();
  private cacheHits = 0;

  private readonly listeners = new Set<(e: SchedulerEvent) => void>();
  private loading: Promise<void> | undefined;
  private writes: Promise<void> = Promise.resolve();

  constructor(deps: RequestSchedulerDeps) {
    this.clock = deps.clock;
    this.http = deps.http;
    this.storage = deps.storage;
    this.notifier = deps.notifier;
    this.random = deps.random ?? Math.random;
    this.laneConfigs = deps.lanes ?? DEFAULT_LANES;
    this.stateKey = deps.stateKey;
    this.mode = deps.considerateMode ?? 'normal';
    const fresh = (): LaneState => ({
      queue: [],
      inFlight: false,
      timer: undefined,
      lastEndAt: undefined,
      lastEndMono: 0,
      gapJitterMs: 0,
      backoffUntil: undefined,
      backoffKind: undefined,
      failures: 0,
    });
    this.lanes = { interactive: fresh(), background: fresh(), snipe: fresh(), canary: fresh() };
  }

  // ── RequestScheduler port ──────────────────────────────────────────────

  run<T>(r: ScheduledRequest<T>): Promise<T> {
    const key = r.key;
    if (key !== undefined) {
      const hit = this.cached(key);
      if (hit !== undefined) {
        this.cacheHits += 1;
        return Promise.resolve(hit.value as T);
      }
      const pending = this.shared.get(key);
      if (pending !== undefined) {
        this.cacheHits += 1;
        return pending as Promise<T>;
      }
    }
    const p = this.load().then(() => this.enqueue(r));
    if (key !== undefined) {
      this.shared.set(key, p);
      const drop = (): void => {
        if (this.shared.get(key) === p) this.shared.delete(key);
      };
      p.then(drop, drop);
    }
    return p;
  }

  stats(): RequestSchedulerStats {
    const now = this.clock.now();
    const pause = this.activePause(now);
    const one = (lane: Lane): RequestSchedulerStats['lanes'][Lane] => {
      const ls = this.lanes[lane];
      const usedToday = this.usedToday(lane, now);
      const budget = this.config(lane).dailyBudget;
      let backoffUntil = ls.backoffUntil !== undefined && ls.backoffUntil > now ? ls.backoffUntil : undefined;
      if (pause !== undefined && pause.until !== null) backoffUntil = Math.max(backoffUntil ?? 0, pause.until);
      let nextAllowedAt = Math.max(this.gapEndsAt(lane), backoffUntil ?? 0);
      if (usedToday >= budget) nextAllowedAt = Math.max(nextAllowedAt, nextLocalMidnight(now));
      return backoffUntil === undefined ? { usedToday, budget, nextAllowedAt } : { usedToday, budget, nextAllowedAt, backoffUntil };
    };
    return {
      lanes: { interactive: one('interactive'), background: one('background'), snipe: one('snipe'), canary: one('canary') },
      cacheHits: this.cacheHits,
    };
  }

  /** Pauses every lane until `untilMs`, or until resume(). A pause never shortens a longer one. */
  pause(reason: string, untilMs?: EpochMs): void {
    this.applyPause({ cause: 'manual', reason, until: untilMs ?? null });
  }

  /** Lifts the all-lane pause. Per-lane backoffs SGW asked for keep running out on their own. */
  resume(): void {
    const had = this.pauseInfo !== undefined;
    this.pauseInfo = undefined;
    this.streak403 = 0;
    this.streak429 = 0;
    this.saveState();
    if (had) this.emit({ type: 'resumed' });
    for (const lane of LANES) this.pump(lane);
  }

  // ── Extras for the composition root (T-36) and the health panel ────────

  /** Loads the persisted budget (and saved state). run() awaits it; call it early so stats() is right from the start. */
  load(): Promise<void> {
    this.loading ??= this.restore();
    return this.loading;
  }

  /** Resolves once every storage write issued so far has finished. */
  flush(): Promise<void> {
    return this.writes;
  }

  setConsiderateMode(mode: ConsiderateMode): void {
    if (mode === this.mode) return;
    this.mode = mode;
    // A waiting request re-checks its gap under the new mode.
    for (const lane of LANES) {
      const ls = this.lanes[lane];
      if (ls.timer !== undefined) {
        this.clock.clearTimeout(ls.timer);
        ls.timer = undefined;
      }
      this.pump(lane);
    }
  }

  /** The all-lane pause in effect, or null. stats() cannot express an open-ended pause; this can. */
  pauseState(): PauseState | null {
    const p = this.activePause(this.clock.now());
    return p === undefined ? null : { ...p };
  }

  /** Subscribes to scheduler events. Returns an unsubscribe function. */
  onEvent(cb: (e: SchedulerEvent) => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  // ── Queue ───────────────────────────────────────────────────────────────

  private enqueue<T>(r: ScheduledRequest<T>): Promise<T> {
    const refusal = this.refusal(r.lane);
    if (refusal !== undefined) return Promise.reject(refusal);
    return new Promise<T>((resolve, reject) => {
      const queue = this.lanes[r.lane].queue;
      const item: Waiting = { req: r, priority: r.priority ?? 0, resolve: resolve as (v: unknown) => void, reject };
      // Higher priority first; FIFO among equals.
      const at = queue.findIndex((w) => w.priority < item.priority);
      if (at < 0) queue.push(item);
      else queue.splice(at, 0, item);
      this.pump(r.lane);
    });
  }

  /** Sends the lane's next request if it may go now, waits on a clock timer if not, or refuses it. */
  private pump(lane: Lane): void {
    const ls = this.lanes[lane];
    if (ls.inFlight || ls.timer !== undefined) return;
    for (let head = ls.queue[0]; head !== undefined; head = ls.queue[0]) {
      const refusal = this.refusal(lane);
      if (refusal !== undefined) {
        ls.queue.shift();
        head.reject(refusal);
        continue;
      }
      const wait = this.waitMs(lane);
      if (wait > 0) {
        ls.timer = this.clock.setTimeout(() => {
          ls.timer = undefined;
          this.pump(lane);
        }, wait);
        return;
      }
      ls.queue.shift();
      void this.send(lane, head);
      return;
    }
  }

  /** Why the lane may not send at all right now (pause, backoff, budget), as the error to throw. */
  private refusal(lane: Lane): SgwApiError | undefined {
    const now = this.clock.now();
    const pause = this.activePause(now);
    if (pause !== undefined) {
      return new SgwApiError(
        'paused',
        `SGW requests are paused: ${pause.reason}`,
        pause.until === null ? undefined : { retryAfterMs: pause.until - now },
      );
    }
    const ls = this.lanes[lane];
    if (ls.backoffUntil !== undefined && ls.backoffUntil > now) {
      return new SgwApiError(ls.backoffKind ?? 'rate-limited', `${lane} lane is backing off`, {
        retryAfterMs: ls.backoffUntil - now,
      });
    }
    const budget = this.config(lane).dailyBudget;
    if (this.usedToday(lane, now) >= budget) {
      return new SgwApiError('budget', `${lane} lane has used its daily budget of ${String(budget)} requests`, {
        retryAfterMs: nextLocalMidnight(now) - now,
      });
    }
    return undefined;
  }

  // ── Spacing ─────────────────────────────────────────────────────────────

  private config(lane: Lane): LaneConfig {
    const base = this.laneConfigs[lane];
    if (this.mode === 'normal') return base;
    return { ...base, minIntervalMs: base.minIntervalMs * 2, dailyBudget: Math.floor(base.dailyBudget / 2) };
  }

  private gapMs(lane: Lane): number {
    return this.config(lane).minIntervalMs + this.lanes[lane].gapJitterMs;
  }

  /** Wall time at which the gap after the last request ends (0 if the lane never sent). */
  private gapEndsAt(lane: Lane): EpochMs {
    const ls = this.lanes[lane];
    return ls.lastEndAt === undefined ? 0 : ls.lastEndAt + this.gapMs(lane);
  }

  /** How long the lane must still wait; both clocks must agree the gap is over. */
  private waitMs(lane: Lane): number {
    const ls = this.lanes[lane];
    if (ls.lastEndAt === undefined) return 0;
    const gap = this.gapMs(lane);
    return Math.max(0, ls.lastEndAt + gap - this.clock.now(), ls.lastEndMono + gap - this.clock.monotonic());
  }

  private markEnd(lane: Lane): void {
    const ls = this.lanes[lane];
    ls.lastEndAt = this.clock.now();
    ls.lastEndMono = this.clock.monotonic();
    const jitter = this.config(lane).jitterMs;
    ls.gapJitterMs = jitter > 0 ? Math.floor(this.random() * (jitter + 1)) : 0;
  }

  // ── Sending ─────────────────────────────────────────────────────────────

  private async send(lane: Lane, item: Waiting): Promise<void> {
    const ls = this.lanes[lane];
    ls.inFlight = true;
    try {
      let request: HttpRequest;
      try {
        request = item.req.build();
      } catch (e) {
        item.reject(e); // nothing was sent: no budget, no gap
        return;
      }
      this.count(lane);
      let res: HttpResponse;
      try {
        res = await this.http.send(request);
      } catch (e) {
        this.markEnd(lane);
        item.reject(transportError(e, item.req.endpoint));
        return;
      }
      this.markEnd(lane);
      this.settle(lane, item, res);
    } catch (e) {
      item.reject(e); // a bug here must still settle the caller (no-op if already settled)
    } finally {
      ls.inFlight = false;
      this.saveState();
      this.pump(lane);
    }
  }

  /** Applies SGW's answer to the lane state and settles the caller's promise. */
  private settle(lane: Lane, item: Waiting, res: HttpResponse): void {
    const ls = this.lanes[lane];
    const now = this.clock.now();
    const { status } = res;
    const endpoint = item.req.endpoint;
    this.streak403 = status === 403 ? this.streak403 + 1 : 0;
    this.streak429 = status === 429 ? this.streak429 + 1 : 0;
    const retryAfter = parseRetryAfter(res.headers, now);

    if (status === 403) {
      const wait = Math.max(BLOCKED_BACKOFF_MS, retryAfter ?? 0);
      this.backOff(lane, 'blocked', status, now + wait);
      item.reject(new SgwApiError('blocked', `${endpoint}: SGW refused the request (403)`, { status, retryAfterMs: wait }));
      if (this.streak403 >= BURST_THRESHOLD) {
        this.streak403 = 0;
        this.autoPause('blocked', BLOCKED_MESSAGE, now + Math.max(BLOCK_PAUSE_MS, retryAfter ?? 0), BLOCKED_MESSAGE);
      }
      return;
    }

    if (status === 429 || status >= 500) {
      const kind: BackoffKind = status === 429 ? 'rate-limited' : 'server';
      const base = Math.min(BACKOFF_BASE_MS * 2 ** ls.failures, BACKOFF_CAP_MS);
      const jittered = Math.min(Math.floor(base * (1 + BACKOFF_JITTER_FRACTION * this.random())), BACKOFF_CAP_MS);
      const wait = Math.max(jittered, retryAfter ?? 0);
      ls.failures = Math.min(ls.failures + 1, MAX_FAILURES);
      this.backOff(lane, kind, status, now + wait);
      item.reject(new SgwApiError(kind, `${endpoint}: SGW answered ${String(status)}`, { status, retryAfterMs: wait }));
      if (status === 429 && this.streak429 >= BURST_THRESHOLD) {
        this.streak429 = 0;
        const until = Math.max(...LANES.map((l) => this.lanes[l].backoffUntil ?? 0));
        const minutes = Math.ceil((until - now) / 60_000);
        this.autoPause(
          'rate-limited',
          'SGW is rate-limiting requests',
          until,
          `SGW is rate-limiting requests; automation paused for ${String(minutes)} min`,
        );
      }
      return;
    }

    ls.failures = 0;
    if (status === 401) {
      item.reject(new SgwApiError('auth', `${endpoint}: SGW answered 401`, { status }));
      return;
    }
    let value: unknown;
    try {
      value = item.req.parse(res);
    } catch (e) {
      item.reject(
        e instanceof SgwApiError
          ? e
          : new SgwApiError('schema', `${endpoint}: ${e instanceof Error ? e.message : String(e)}`, { status, cause: e }),
      );
      return;
    }
    const { key, cacheTtlMs } = item.req;
    if (key !== undefined && cacheTtlMs !== undefined && cacheTtlMs > 0) this.remember(key, value, now + cacheTtlMs);
    item.resolve(value);
  }

  private backOff(lane: Lane, kind: BackoffKind, status: number, until: EpochMs): void {
    const ls = this.lanes[lane];
    if (ls.backoffUntil === undefined || until >= ls.backoffUntil || ls.backoffUntil <= this.clock.now()) {
      ls.backoffUntil = until;
      ls.backoffKind = kind;
    }
    this.emit({ type: 'backoff', lane, kind, status, until: ls.backoffUntil });
  }

  // ── Pause ───────────────────────────────────────────────────────────────

  private activePause(now: EpochMs): PauseState | undefined {
    const p = this.pauseInfo;
    if (p === undefined) return undefined;
    if (p.until !== null && p.until <= now) {
      this.pauseInfo = undefined;
      return undefined;
    }
    return p;
  }

  /** Sets the pause unless one already lasts at least as long. Returns whether it changed. */
  private applyPause(next: PauseState): boolean {
    const now = this.clock.now();
    if (next.until !== null && next.until <= now) return false;
    const cur = this.activePause(now);
    if (cur !== undefined && (cur.until === null || (next.until !== null && next.until <= cur.until))) return false;
    this.pauseInfo = { ...next };
    this.saveState();
    this.emit({ type: 'paused', ...next });
    // Refuse everything queued now rather than when its timer fires.
    for (const lane of LANES) {
      const ls = this.lanes[lane];
      if (ls.timer !== undefined) {
        this.clock.clearTimeout(ls.timer);
        ls.timer = undefined;
      }
      this.pump(lane);
    }
    return true;
  }

  private autoPause(cause: PauseCause, reason: string, until: EpochMs, message: string): void {
    if (!this.applyPause({ cause, reason, until })) return;
    if (this.notifier === undefined) return;
    void this.notifier
      .notify({ id: PAUSE_NOTIFICATION_ID, title: 'ShopBadwill paused', message, priority: 2 })
      .catch(() => undefined);
  }

  // ── Budget ──────────────────────────────────────────────────────────────

  private usedToday(lane: Lane, now: EpochMs): number {
    return this.budget.day === localDay(now) ? (this.budget.used[lane] ?? 0) : 0;
  }

  /** Counts a request about to be sent and persists the day's tally. */
  private count(lane: Lane): void {
    const day = localDay(this.clock.now());
    if (this.budget.day !== day) this.budget = { day, used: {} };
    const used = (this.budget.used[lane] ?? 0) + 1;
    this.budget.used[lane] = used;
    this.write(() => ({ [STORAGE_KEYS.requestBudget]: { day: this.budget.day, used: { ...this.budget.used } } }));
    const budget = this.config(lane).dailyBudget;
    if (used === budget) this.emit({ type: 'budget-exhausted', lane, day, budget });
  }

  // ── Cache ───────────────────────────────────────────────────────────────

  private cached(key: string): { value: unknown } | undefined {
    const entry = this.cache.get(key);
    if (entry === undefined) return undefined;
    if (entry.expiresAt > this.clock.now()) return entry;
    this.cache.delete(key);
    return undefined;
  }

  private remember(key: string, value: unknown, expiresAt: EpochMs): void {
    this.cache.delete(key);
    while (this.cache.size >= CACHE_MAX_ENTRIES) {
      const oldest = this.cache.keys().next();
      if (oldest.done === true) break;
      this.cache.delete(oldest.value);
    }
    this.cache.set(key, { value, expiresAt });
  }

  // ── Persistence ─────────────────────────────────────────────────────────

  private async restore(): Promise<void> {
    try {
      const parsed = RequestBudgetSchema.safeParse(await this.storage.get<unknown>(STORAGE_KEYS.requestBudget));
      if (parsed.success) this.budget = parsed.data;
    } catch {
      // Unreadable storage: start the day's count from zero.
    }
    if (this.stateKey === undefined) return;
    try {
      const parsed = SavedStateSchema.safeParse(await this.storage.get<unknown>(this.stateKey));
      if (parsed.success) this.adopt(parsed.data);
    } catch {
      // Unreadable saved state: in-memory state only.
    }
  }

  /** Merges saved state into this (fresh) instance, keeping whichever is stricter. */
  private adopt(saved: SavedState): void {
    const now = this.clock.now();
    const mono = this.clock.monotonic();
    if (saved.pause !== null && (saved.pause.until === null || saved.pause.until > now)) {
      const cur = this.activePause(now);
      if (cur === undefined || (cur.until !== null && (saved.pause.until === null || saved.pause.until > cur.until))) {
        this.pauseInfo = { ...saved.pause };
      }
    }
    this.streak403 = Math.max(this.streak403, saved.streak403);
    this.streak429 = Math.max(this.streak429, saved.streak429);
    for (const lane of LANES) {
      const s = saved.lanes[lane];
      if (s === undefined) continue;
      const ls = this.lanes[lane];
      if (s.lastEndAt !== undefined && (ls.lastEndAt === undefined || s.lastEndAt > ls.lastEndAt)) {
        ls.lastEndAt = s.lastEndAt;
        ls.gapJitterMs = s.gapJitterMs;
        // Monotonic time restarts with the worker; map the wall time across.
        ls.lastEndMono = mono - (now - s.lastEndAt);
      }
      if (s.backoffUntil !== undefined && s.backoffUntil > now && (ls.backoffUntil ?? 0) < s.backoffUntil) {
        ls.backoffUntil = s.backoffUntil;
        ls.backoffKind = s.backoffKind;
      }
      ls.failures = Math.max(ls.failures, s.failures);
    }
  }

  private saveState(): void {
    const key = this.stateKey;
    if (key === undefined) return;
    this.write(() => ({ [key]: this.snapshot() }));
  }

  private snapshot(): SavedState {
    const lanes: SavedState['lanes'] = {};
    for (const lane of LANES) {
      const ls = this.lanes[lane];
      lanes[lane] = {
        ...(ls.lastEndAt === undefined ? {} : { lastEndAt: ls.lastEndAt }),
        gapJitterMs: ls.gapJitterMs,
        ...(ls.backoffUntil === undefined ? {} : { backoffUntil: ls.backoffUntil }),
        ...(ls.backoffKind === undefined ? {} : { backoffKind: ls.backoffKind }),
        failures: ls.failures,
      };
    }
    return {
      pause: this.pauseInfo === undefined ? null : { ...this.pauseInfo },
      streak403: this.streak403,
      streak429: this.streak429,
      lanes,
    };
  }

  /**
   * Queues a storage write. Writes land in the order they were issued, never
   * block a request, and wait for load(), so nothing overwrites saved state
   * before it is read. `entries` is evaluated at write time: the latest state.
   */
  private write(entries: () => Record<string, unknown>): void {
    this.writes = this.writes
      .then(async () => {
        await this.load();
        await this.storage.set(entries());
      })
      .catch(() => undefined);
  }

  // ── Events ──────────────────────────────────────────────────────────────

  private emit(e: SchedulerEvent): void {
    for (const cb of [...this.listeners]) {
      try {
        cb(e);
      } catch {
        // A listener's bug must not break request handling.
      }
    }
  }
}

/** Http.send throws HttpTimeoutError or HttpNetworkError (anything else is treated as a network failure). */
function transportError(e: unknown, endpoint: string): SgwApiError {
  if (e instanceof SgwApiError) return e;
  const detail = e instanceof Error ? e.message : String(e);
  return new SgwApiError(e instanceof HttpTimeoutError ? 'timeout' : 'network', `${endpoint}: ${detail}`, { cause: e });
}
