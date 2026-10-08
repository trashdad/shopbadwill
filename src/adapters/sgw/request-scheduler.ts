// T-25: PLAN §3.4 RequestScheduler, the one door every SGW request goes
// through (PLAN §1.3, §9). It keeps the extension a considerate guest:
//
// - Lanes (DEFAULT_LANES): one request in flight per lane, and a gap of
//   `minIntervalMs` + 0..`jitterMs` between the end of one request and the
//   start of the next. The gap is checked on both the wall clock and the
//   monotonic clock, so moving the system time forward cannot shorten it, and
//   a last-request time in the future (the clock moved back) counts as "now",
//   so moving it back cannot stall a lane.
// - Daily budget per lane, counted when a request is sent and persisted in
//   `sbw:requestBudget` under the local day; it resets at local midnight. A
//   spent lane refuses with SgwApiError('budget') until then. The budget day
//   never goes backwards: if the clock moves back across midnight, the counts
//   of the later day still apply.
// - Backoff: 429 or 5xx → lane backoff min(2^n × 30 s, 30 min) with up to
//   +25 % jitter (never past the cap); 403 → lane backoff 1 h, kind `blocked`.
//   A longer Retry-After always wins. Three consecutive 403s on any lanes
//   pause every lane 6 h; three consecutive 429s pause every lane until the
//   backoff ends. Both notify the user and emit a `paused` event. A 401
//   refuses the lane's queued requests with `auth` instead of sending them.
// - Never retry hot: the scheduler never retries on its own. A request on a
//   paused, backing-off or spent lane is refused locally, so the caller's
//   retry cannot reach SGW until the wait is over. Queued requests are refused
//   the same way instead of being sent once the lane is blocked.
// - Requests go out exactly as `build()` made them: no header, user-agent or
//   credential changes, ever.
// - considerateMode 'tight' halves every budget and doubles every interval.
//
// Persistence (contract change, T-25). Pause, backoff and spacing state lives
// in `sbw:requestSchedulerState`, the budget in `sbw:requestBudget`. Both are
// read at construction and written on every change, so a restarted worker
// never forgets a pause or backoff SGW asked for.
// - Fail closed: until both records have been read, nothing is sent (run()
//   refuses with `paused` and a short retryAfterMs, retrying the read on the
//   next request) and nothing is written, so a storage error can never erase
//   a block or the day's count.
// - Expired entries are ignored, and restored values are clamped to the
//   policy maximums. An invalid record is quarantined (the same
//   `sbw:quarantine:<key>` record as the T-33 Repo), flagged with a
//   `state-invalid` event, and means no pause. A failed write emits
//   `state-write-failed`.
// - A resume() issued before the read finishes wins over the saved pause.
//
// One instance per profile. The background context owns the only scheduler.
// As a safety net against a second instance (a second background page, a
// stale worker), it follows `storage.onChanged`: another writer's pause,
// backoffs and gaps are adopted (stricter wins) and the budget is merged per
// lane (higher count wins), so neither instance can erase the other's block.
//
// All timing goes through the Clock port (no Date.now, no global timers), so
// the whole thing runs deterministically on FakeClock.
import type { z } from 'zod';

import {
  QUARANTINE_KEY_PREFIX,
  REQUEST_SCHEDULER_STATE_VERSION,
  RequestBudgetSchema,
  RequestSchedulerStateSchema,
  STORAGE_KEYS,
  type QuarantineRecord,
  type RequestBudget,
  type RequestSchedulerState,
} from '../../domain/storage/schema';
import {
  DEFAULT_LANES,
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
/** The furthest a restored backoff or timed pause may reach (the longest wait any rule sets). */
export const MAX_RESTORED_WAIT_MS = Math.max(BLOCK_PAUSE_MS, BLOCKED_BACKOFF_MS, BACKOFF_CAP_MS, RETRY_AFTER_CAP_MS);
/** How a request is refused while the saved state cannot be read: retry this soon. */
export const STATE_READ_RETRY_MS = 30_000;
/** A stored budget day this far ahead of the local day is a bogus clock, not a backward jump. */
export const MAX_BUDGET_DAY_AHEAD_MS = 48 * 60 * 60_000;
/** In-memory result cache size; the oldest entry goes first. */
export const CACHE_MAX_ENTRIES = 500;
/** One notification id, so a new pause replaces the old notice instead of stacking. */
export const PAUSE_NOTIFICATION_ID = 'sbw:scheduler-paused';

export const BLOCKED_MESSAGE = 'SGW is refusing requests; automation paused';

const LANES: readonly Lane[] = LaneSchema.options;
const BUDGET_KEY = STORAGE_KEYS.requestBudget;
const STATE_KEY = STORAGE_KEYS.requestSchedulerState;

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
  | { type: 'budget-exhausted'; lane: Lane; day: string; budget: number }
  /** A stored record failed its schema: it was quarantined and treated as absent. */
  | { type: 'state-invalid'; key: string; error: string }
  /** The saved state could not be read: nothing is sent or written until it can. */
  | { type: 'state-read-failed'; error: string }
  /** A storage write failed (for the health panel). */
  | { type: 'state-write-failed'; error: string };

export interface RequestSchedulerDeps {
  clock: Clock;
  http: Http;
  /** `storage.local`; holds `sbw:requestBudget` and `sbw:requestSchedulerState`. */
  storage: Storage;
  /** Tells the user when SGW's answers pause every lane. */
  notifier?: Notifier;
  /** Uniform in [0, 1), for jitter. Defaults to Math.random. */
  random?: () => number;
  /** Defaults to DEFAULT_LANES (§3.4). */
  lanes?: Readonly<Record<Lane, Readonly<LaneConfig>>>;
  /** Defaults to 'normal'; change it later with setConsiderateMode(). */
  considerateMode?: ConsiderateMode;
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

/** The local midnight that ends `day` ('YYYY-MM-DD'). */
function endOfLocalDay(day: string): EpochMs {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y ?? 1970, (m ?? 1) - 1, (d ?? 1) + 1).getTime();
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

// ── Retry-After ─────────────────────────────────────────────────────────────

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
/** IMF-fixdate: `Sun, 06 Nov 1994 08:49:37 GMT`. */
const IMF_FIXDATE = /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), (\d{2}) ([A-Z][a-z]{2}) (\d{4}) (\d{2}):(\d{2}):(\d{2}) GMT$/;
/** Obsolete RFC 850: `Sunday, 06-Nov-94 08:49:37 GMT`. */
const RFC850_DATE =
  /^(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), (\d{2})-([A-Z][a-z]{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2}) GMT$/;
/** Obsolete asctime: `Sun Nov  6 08:49:37 1994`. */
const ASCTIME_DATE = /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) ([A-Z][a-z]{2}) ([ \d]\d) (\d{2}):(\d{2}):(\d{2}) (\d{4})$/;

/** A parsed HTTP-date as epoch ms, or undefined. */
function httpDate(raw: string, now: EpochMs): number | undefined {
  let parts: { day: string; month: string; year: number; h: string; m: string; s: string } | undefined;
  let m = IMF_FIXDATE.exec(raw);
  if (m !== null) {
    parts = { day: m[1] ?? '', month: m[2] ?? '', year: Number(m[3]), h: m[4] ?? '', m: m[5] ?? '', s: m[6] ?? '' };
  } else if ((m = RFC850_DATE.exec(raw)) !== null) {
    // RFC 9110 §5.6.7: a two-digit year more than 50 years ahead is in the past century.
    const thisYear = new Date(now).getUTCFullYear();
    let year = Math.floor(thisYear / 100) * 100 + Number(m[3]);
    if (year > thisYear + 50) year -= 100;
    parts = { day: m[1] ?? '', month: m[2] ?? '', year, h: m[4] ?? '', m: m[5] ?? '', s: m[6] ?? '' };
  } else if ((m = ASCTIME_DATE.exec(raw)) !== null) {
    parts = { day: m[2] ?? '', month: m[1] ?? '', year: Number(m[6]), h: m[3] ?? '', m: m[4] ?? '', s: m[5] ?? '' };
  }
  if (parts === undefined) return undefined;
  const month = MONTHS.indexOf(parts.month);
  if (month < 0) return undefined;
  const at = Date.UTC(parts.year, month, Number(parts.day), Number(parts.h), Number(parts.m), Number(parts.s));
  return Number.isFinite(at) ? at : undefined;
}

/**
 * Retry-After as a wait in ms from `now`: delta-seconds or an HTTP-date
 * (IMF-fixdate, or the obsolete RFC 850 and asctime forms; RFC 9110 §10.2.3,
 * §5.6.7). Anything else is ignored. Clamped to 0..RETRY_AFTER_CAP_MS.
 */
export function parseRetryAfter(headers: Record<string, string>, now: EpochMs): number | undefined {
  let raw: string | undefined;
  for (const [name, value] of Object.entries(headers)) if (name.toLowerCase() === 'retry-after') raw = value.trim();
  if (raw === undefined || raw === '') return undefined;
  let ms: number;
  if (/^\d+$/.test(raw)) {
    ms = Number(raw) * 1000;
  } else {
    const at = httpDate(raw, now);
    if (at === undefined) return undefined;
    ms = at - now;
  }
  return Math.min(Math.max(0, ms), RETRY_AFTER_CAP_MS);
}

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
/** Own state writes whose onChanged echo is still expected. */
const MAX_ECHOES = 16;

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export class SgwRequestScheduler implements RequestScheduler {
  private readonly clock: Clock;
  private readonly http: Http;
  private readonly storage: Storage;
  private readonly notifier: Notifier | undefined;
  private readonly random: () => number;
  private readonly laneConfigs: Readonly<Record<Lane, Readonly<LaneConfig>>>;
  private mode: ConsiderateMode;

  private readonly lanes: Record<Lane, LaneState>;
  private budget: RequestBudget = { day: '', used: {} };
  /** `${day}|${lane}|${budget}` already reported as exhausted. */
  private readonly exhausted = new Set<string>();
  private pauseInfo: PauseState | undefined;
  private consecutive403 = 0;
  private consecutive429 = 0;

  private readonly cache = new Map<string, { value: unknown; expiresAt: EpochMs }>();
  private readonly shared = new Map<string, Promise<unknown>>();
  private cacheHits = 0;

  private readonly listeners = new Set<(e: SchedulerEvent) => void>();
  /** True once both records have been read; until then nothing is sent or written. */
  private loaded = false;
  private loadAttempt: Promise<boolean> | undefined;
  /** A write was skipped because the state was unreadable; save once it is read. */
  private unsaved = false;
  /** resume() was called before the saved state was read: the saved pause predates it. */
  private resumePending: { emit: boolean } | undefined;
  private readonly echoes: string[] = [];
  private writes: Promise<void> = Promise.resolve();
  private readonly unsubscribe: () => void;

  constructor(deps: RequestSchedulerDeps) {
    this.clock = deps.clock;
    this.http = deps.http;
    this.storage = deps.storage;
    this.notifier = deps.notifier;
    this.random = deps.random ?? Math.random;
    this.laneConfigs = deps.lanes ?? DEFAULT_LANES;
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
    this.unsubscribe = this.storage.onChanged((changes) => {
      this.onStorageChanged(changes);
    });
    // Read the saved budget and state now, so a restarted worker is paused
    // (and stats() is right) before anything asks it to send.
    void this.load();
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
    const p = this.load().then((ok) =>
      ok
        ? this.enqueue(r)
        : Promise.reject(
            new SgwApiError('paused', 'SGW requests are paused: the request scheduler state could not be read', {
              retryAfterMs: STATE_READ_RETRY_MS,
            }),
          ),
    );
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
      const backoffUntil = ls.backoffUntil !== undefined && ls.backoffUntil > now ? ls.backoffUntil : undefined;
      let nextAllowedAt = Math.max(this.gapEndsAt(lane, now), backoffUntil ?? 0);
      if (pause !== undefined && pause.until !== null) nextAllowedAt = Math.max(nextAllowedAt, pause.until);
      if (usedToday >= budget) nextAllowedAt = Math.max(nextAllowedAt, this.budgetResetsAt(now));
      return backoffUntil === undefined ? { usedToday, budget, nextAllowedAt } : { usedToday, budget, nextAllowedAt, backoffUntil };
    };
    const lanes = { interactive: one('interactive'), background: one('background'), snipe: one('snipe'), canary: one('canary') };
    return pause === undefined
      ? { lanes, cacheHits: this.cacheHits }
      : { lanes, cacheHits: this.cacheHits, paused: { until: pause.until, reason: pause.reason } };
  }

  /** Pauses every lane until `untilMs`, or until resume(). A pause never shortens a longer one. */
  pause(reason: string, untilMs?: EpochMs): void {
    this.applyPause({ cause: 'manual', reason, until: untilMs ?? null });
  }

  /**
   * Lifts the all-lane pause, including a saved one not read yet (a resume on
   * a cold worker wins over the pause it saved earlier). Per-lane backoffs SGW
   * asked for keep running out on their own.
   */
  resume(): void {
    const had = this.activePause(this.clock.now()) !== undefined;
    this.pauseInfo = undefined;
    this.consecutive403 = 0;
    this.consecutive429 = 0;
    // Emit `resumed` once: now if a pause was in effect, else when the saved one is dropped.
    if (!this.loaded) this.resumePending = { emit: !had && (this.resumePending?.emit ?? true) };
    this.saveState();
    if (had) this.emit({ type: 'resumed' });
    for (const lane of LANES) this.pump(lane);
  }

  // ── Extras for the composition root (T-36) and the health panel ────────

  /**
   * Reads the saved budget and state (started at construction). Resolves true
   * once they are read, false if storage failed (the next call retries). The
   * composition root MUST await this before serving requests; run() awaits it
   * too and refuses while it is false.
   */
  load(): Promise<boolean> {
    if (this.loaded) return Promise.resolve(true);
    this.loadAttempt ??= this.restore().then(
      () => {
        this.loaded = true;
        this.loadAttempt = undefined;
        this.resumePending = undefined;
        if (this.unsaved) {
          this.unsaved = false;
          this.saveState();
        }
        return true;
      },
      (e: unknown) => {
        this.loadAttempt = undefined;
        this.emit({ type: 'state-read-failed', error: errorText(e) });
        return false;
      },
    );
    return this.loadAttempt;
  }

  /** Resolves once every storage write issued so far has finished. */
  flush(): Promise<void> {
    return this.writes;
  }

  /** Stops following storage changes and drops pending gap timers. */
  dispose(): void {
    this.unsubscribe();
    for (const lane of LANES) {
      const ls = this.lanes[lane];
      if (ls.timer !== undefined) this.clock.clearTimeout(ls.timer);
      ls.timer = undefined;
    }
  }

  setConsiderateMode(mode: ConsiderateMode): void {
    if (mode === this.mode) return;
    this.mode = mode;
    const now = this.clock.now();
    for (const lane of LANES) this.noteExhaustion(lane, now);
    this.repumpAll(); // a waiting request re-checks its gap under the new mode
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

  /** Re-evaluates every lane now: clears gap timers and pumps (refusing whatever may no longer go). */
  private repumpAll(): void {
    for (const lane of LANES) {
      const ls = this.lanes[lane];
      if (ls.timer !== undefined) {
        this.clock.clearTimeout(ls.timer);
        ls.timer = undefined;
      }
      this.pump(lane);
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
        retryAfterMs: this.budgetResetsAt(now) - now,
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

  /**
   * Wall time at which the gap after the last request ends (0 if the lane
   * never sent). A last-request time in the future means the wall clock moved
   * back: it is re-anchored to now, once, so a backward jump cannot stall the
   * lane (the monotonic clock still enforces the full gap).
   */
  private gapEndsAt(lane: Lane, now: EpochMs): EpochMs {
    const ls = this.lanes[lane];
    if (ls.lastEndAt === undefined) return 0;
    if (ls.lastEndAt > now) ls.lastEndAt = now;
    return ls.lastEndAt + this.gapMs(lane);
  }

  /** How long the lane must still wait; both clocks must agree the gap is over. */
  private waitMs(lane: Lane): number {
    const ls = this.lanes[lane];
    if (ls.lastEndAt === undefined) return 0;
    const now = this.clock.now();
    return Math.max(0, this.gapEndsAt(lane, now) - now, ls.lastEndMono + this.gapMs(lane) - this.clock.monotonic());
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
    this.consecutive403 = status === 403 ? this.consecutive403 + 1 : 0;
    this.consecutive429 = status === 429 ? this.consecutive429 + 1 : 0;
    const retryAfter = parseRetryAfter(res.headers, now);

    if (status === 403) {
      const wait = Math.max(BLOCKED_BACKOFF_MS, retryAfter ?? 0);
      this.backOff(lane, 'blocked', status, now + wait);
      item.reject(new SgwApiError('blocked', `${endpoint}: SGW refused the request (403)`, { status, retryAfterMs: wait }));
      if (this.consecutive403 >= BURST_THRESHOLD) {
        this.consecutive403 = 0;
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
      if (status === 429 && this.consecutive429 >= BURST_THRESHOLD) {
        this.consecutive429 = 0;
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
      // The session is gone: refuse what is queued behind it instead of burning a 401 each.
      for (const waiting of ls.queue.splice(0)) {
        waiting.reject(new SgwApiError('auth', `${lane} lane: refused after a 401 from SGW`, { status }));
      }
      return;
    }
    let value: unknown;
    try {
      value = item.req.parse(res);
    } catch (e) {
      item.reject(
        e instanceof SgwApiError ? e : new SgwApiError('schema', `${endpoint}: ${errorText(e)}`, { status, cause: e }),
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
    this.repumpAll(); // refuse everything queued now rather than when its timer fires
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

  /**
   * The day the budget counts against: today, or the stored day if it is
   * later (the clock moved back across midnight). A stored day more than
   * MAX_BUDGET_DAY_AHEAD_MS ahead is a bogus clock and is not honoured.
   */
  private budgetDay(now: EpochMs): string {
    const today = localDay(now);
    const stored = this.budget.day;
    return stored > today && stored <= localDay(now + MAX_BUDGET_DAY_AHEAD_MS) ? stored : today;
  }

  private budgetResetsAt(now: EpochMs): EpochMs {
    return endOfLocalDay(this.budgetDay(now));
  }

  private usedToday(lane: Lane, now: EpochMs): number {
    return this.budget.day === this.budgetDay(now) ? (this.budget.used[lane] ?? 0) : 0;
  }

  /** Counts a request about to be sent and persists the day's tally. */
  private count(lane: Lane): void {
    const now = this.clock.now();
    const day = this.budgetDay(now);
    if (this.budget.day !== day) this.budget = { day, used: {} };
    this.budget.used[lane] = (this.budget.used[lane] ?? 0) + 1;
    this.saveBudget();
    this.noteExhaustion(lane, now);
  }

  /** Emits `budget-exhausted` once per crossing of a lane's budget (per day and budget size). */
  private noteExhaustion(lane: Lane, now: EpochMs): void {
    const budget = this.config(lane).dailyBudget;
    if (this.usedToday(lane, now) < budget) return;
    const day = this.budgetDay(now);
    const mark = `${day}|${lane}|${String(budget)}`;
    if (this.exhausted.has(mark)) return;
    this.exhausted.add(mark);
    this.emit({ type: 'budget-exhausted', lane, day, budget });
  }

  /** Merges another copy of the budget: a later day wins; on the same day, the higher count per lane. */
  private mergeBudget(other: RequestBudget): void {
    if (other.day > this.budget.day) {
      this.budget = { day: other.day, used: { ...other.used } };
      return;
    }
    if (other.day < this.budget.day) return;
    for (const lane of LANES) {
      const theirs = other.used[lane];
      if (theirs !== undefined && theirs > (this.budget.used[lane] ?? 0)) this.budget.used[lane] = theirs;
    }
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

  /** Reads both records; throws if storage cannot be read (nothing is applied then). */
  private async restore(): Promise<void> {
    const budget = await this.readValidated(BUDGET_KEY, RequestBudgetSchema);
    const state = await this.readValidated(STATE_KEY, RequestSchedulerStateSchema);
    if (budget !== undefined) this.mergeBudget(budget);
    if (state !== undefined) this.adopt(state, 'restore');
  }

  /**
   * Reads and validates one record. A failed read throws. Missing: undefined.
   * Invalid: quarantined (copied to `sbw:quarantine:<key>` as a
   * QuarantineRecord, then removed, as the T-33 Repo does), flagged with a
   * `state-invalid` event, and undefined: a corrupt record never wedges the
   * scheduler and never means "paused".
   */
  private async readValidated<S extends z.ZodType>(key: string, schema: S): Promise<z.infer<S> | undefined> {
    const raw = await this.storage.get<unknown>(key);
    if (raw === undefined) return undefined;
    const parsed = schema.safeParse(raw);
    if (parsed.success) return parsed.data;
    const error = parsed.error.message;
    this.emit({ type: 'state-invalid', key, error });
    try {
      const record: QuarantineRecord = { at: this.clock.now(), error, value: raw };
      await this.storage.set({ [QUARANTINE_KEY_PREFIX + key]: record });
      await this.storage.remove([key]);
    } catch (e) {
      this.emit({ type: 'state-write-failed', error: errorText(e) });
    }
    return undefined;
  }

  /**
   * Merges saved state (from storage at start-up, or another instance's write)
   * into this one, keeping whichever is stricter. Expired entries are ignored;
   * restored times are clamped to the policy maximums, so a bad value cannot
   * wedge a lane. A saved pause older than a pending resume() is dropped.
   */
  private adopt(saved: RequestSchedulerState, origin: 'restore' | 'peer'): void {
    const now = this.clock.now();
    const mono = this.clock.monotonic();
    const latest = now + MAX_RESTORED_WAIT_MS;
    let tighter = false;

    const savedPause =
      saved.pause !== null && (saved.pause.until === null || saved.pause.until > now)
        ? { ...saved.pause, until: saved.pause.until === null ? null : Math.min(saved.pause.until, latest) }
        : undefined;
    const resumed = origin === 'restore' ? this.resumePending : undefined;
    if (resumed !== undefined) {
      if (savedPause !== undefined && resumed.emit) this.emit({ type: 'resumed' });
    } else {
      if (savedPause !== undefined) {
        const cur = this.activePause(now);
        if (cur === undefined || (cur.until !== null && (savedPause.until === null || savedPause.until > cur.until))) {
          this.pauseInfo = savedPause;
          tighter = true;
        }
      }
      this.consecutive403 = Math.max(this.consecutive403, saved.consecutive403);
      this.consecutive429 = Math.max(this.consecutive429, saved.consecutive429);
    }

    for (const lane of LANES) {
      const s = saved.lanes[lane];
      if (s === undefined) continue;
      const ls = this.lanes[lane];
      if (s.lastEndAt !== undefined) {
        const lastEndAt = Math.min(s.lastEndAt, now);
        if (ls.lastEndAt === undefined || lastEndAt > ls.lastEndAt) {
          ls.lastEndAt = lastEndAt;
          ls.gapJitterMs = Math.min(s.gapJitterMs, this.laneConfigs[lane].jitterMs);
          // Monotonic time restarts with the worker; map the wall time across.
          ls.lastEndMono = mono - (now - lastEndAt);
          tighter = true;
        }
      }
      if (s.backoffUntil !== undefined) {
        const until = Math.min(s.backoffUntil, latest);
        if (until > now && (ls.backoffUntil === undefined || ls.backoffUntil < until)) {
          ls.backoffUntil = until;
          ls.backoffKind = s.backoffKind;
          tighter = true;
        }
      }
      ls.failures = Math.max(ls.failures, Math.min(s.failures, MAX_FAILURES));
    }
    if (tighter && origin === 'peer') this.repumpAll();
  }

  /** Follows another instance's writes (one instance is the rule; this is the safety net). */
  private onStorageChanged(changes: Record<string, { oldValue?: unknown; newValue?: unknown }>): void {
    const budget = changes[BUDGET_KEY]?.newValue;
    if (budget !== undefined) {
      const parsed = RequestBudgetSchema.safeParse(budget);
      if (parsed.success) this.mergeBudget(parsed.data);
    }
    const state = changes[STATE_KEY]?.newValue;
    if (state !== undefined) {
      const echo = this.echoes.indexOf(JSON.stringify(state));
      if (echo >= 0) {
        this.echoes.splice(0, echo + 1); // our own write coming back
        return;
      }
      const parsed = RequestSchedulerStateSchema.safeParse(state);
      if (parsed.success) this.adopt(parsed.data, 'peer');
    }
  }

  private saveBudget(): void {
    this.write(() => ({ [BUDGET_KEY]: { day: this.budget.day, used: { ...this.budget.used } } }));
  }

  /** Persists pause, backoff and spacing state (evaluated when the write runs: the latest state). */
  private saveState(): void {
    this.write(() => {
      const snapshot = this.snapshot();
      this.echoes.push(JSON.stringify(snapshot));
      if (this.echoes.length > MAX_ECHOES) this.echoes.shift();
      return { [STATE_KEY]: snapshot };
    });
  }

  private snapshot(): RequestSchedulerState {
    const now = this.clock.now();
    const lanes: RequestSchedulerState['lanes'] = {};
    for (const lane of LANES) {
      const ls = this.lanes[lane];
      const backoff = ls.backoffUntil !== undefined && ls.backoffUntil > now;
      if (ls.lastEndAt === undefined && !backoff && ls.failures === 0) continue; // nothing a restart needs
      lanes[lane] = {
        ...(ls.lastEndAt === undefined ? {} : { lastEndAt: ls.lastEndAt }),
        gapJitterMs: ls.gapJitterMs,
        ...(backoff ? { backoffUntil: ls.backoffUntil, backoffKind: ls.backoffKind } : {}),
        failures: ls.failures,
      };
    }
    const pause = this.activePause(now);
    return {
      version: REQUEST_SCHEDULER_STATE_VERSION,
      pause: pause === undefined ? null : { cause: pause.cause, reason: pause.reason, until: pause.until },
      consecutive403: this.consecutive403,
      consecutive429: this.consecutive429,
      lanes,
    };
  }

  /**
   * Queues a storage write. Writes land in the order they were issued and
   * never block a request. A write waits for the saved state to be read and
   * is skipped (saved later) while it cannot be, so it never overwrites a
   * record it has not seen. `entries` is evaluated when the write runs. A
   * failure emits `state-write-failed`.
   */
  private write(entries: () => Record<string, unknown>): void {
    this.writes = this.writes
      .then(async () => {
        if (!(await this.load())) {
          this.unsaved = true;
          return;
        }
        await this.storage.set(entries());
      })
      .catch((e: unknown) => {
        this.emit({ type: 'state-write-failed', error: errorText(e) });
      });
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
  return new SgwApiError(e instanceof HttpTimeoutError ? 'timeout' : 'network', `${endpoint}: ${errorText(e)}`, {
    cause: e,
  });
}
