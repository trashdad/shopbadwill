// T-25: RequestScheduler (PLAN §3.4, §9). Everything runs on FakeClock: no
// real timers and no wall-clock reads. `flush()` only drains pending promise
// callbacks; time moves only through `advance()`.
import { describe, expect, it } from 'vitest';

import {
  BACKOFF_CAP_MS,
  BLOCK_PAUSE_MS,
  BLOCKED_BACKOFF_MS,
  MAX_RESTORED_WAIT_MS,
  PAUSE_NOTIFICATION_ID,
  STATE_READ_RETRY_MS,
  STATE_READ_TIMEOUT_MS,
  SgwRequestScheduler,
  localDay,
  parseRetryAfter,
  type SchedulerEvent,
} from '../../../../src/adapters/sgw/request-scheduler';
import {
  QUARANTINE_KEY_PREFIX,
  QuarantineRecordSchema,
  RequestBudgetSchema,
  RequestSchedulerStateSchema,
  STORAGE_KEYS,
  type RequestSchedulerState,
} from '../../../../src/domain/storage/schema';
import { DEFAULT_LANES, RequestSchedulerStatsSchema, type Lane, type LaneConfig } from '../../../../src/domain/types';
import { HttpNetworkError, SgwApiError } from '../../../../src/ports/errors';
import type { HttpRequest } from '../../../../src/ports/http';
import type { ScheduledRequest } from '../../../../src/ports/request-scheduler';
import { FakeClock } from '../../../fakes/ports/fake-clock';
import { FakeHttp, type HttpStep } from '../../../fakes/ports/fake-http';
import { FakeNotifier } from '../../../fakes/ports/fake-notifier';
import { FakeStorage } from '../../../fakes/ports/fake-storage';

const BASE = 'https://buyerapi.shopgoodwill.com/api/';
/** Local 10:00 on 2026-10-07 (built in local time, so day keys hold in any time zone). */
const T0 = new Date(2026, 9, 7, 10, 0, 0).getTime();
const S = 1000;
const MIN = 60 * S;
const HOUR = 60 * MIN;
const LANES: Lane[] = ['interactive', 'background', 'snipe', 'canary'];

/** Drains pending promise callbacks (not a timer: no time passes). */
const flush = (): Promise<void> =>
  new Promise((resolve) => {
    setImmediate(resolve);
  });

interface Sent {
  at: number;
  /** Requests already in flight (any lane) when this one was sent. */
  othersInFlight: number;
}

interface Opts {
  start?: number;
  random?: () => number;
  considerateMode?: 'normal' | 'tight';
  lanes?: Record<Lane, LaneConfig>;
  storage?: FakeStorage;
  clock?: FakeClock;
}

function setup(opts: Opts = {}) {
  const clock = opts.clock ?? new FakeClock(opts.start ?? T0);
  const http = new FakeHttp(clock);
  const storage = opts.storage ?? new FakeStorage();
  const notifier = new FakeNotifier();
  const sched = new SgwRequestScheduler({
    clock,
    http,
    storage,
    notifier,
    random: opts.random ?? (() => 0),
    ...(opts.considerateMode === undefined ? {} : { considerateMode: opts.considerateMode }),
    ...(opts.lanes === undefined ? {} : { lanes: opts.lanes }),
  });
  const events: SchedulerEvent[] = [];
  sched.onEvent((e) => events.push(e));
  const sent: Sent[] = [];

  /** Scripts SGW's answers in order (the last one repeats) and records every send. */
  const reply = (...steps: HttpStep[]): void => {
    let i = 0;
    http.on(BASE, () => {
      sent.push({ at: clock.now(), othersInFlight: http.pending });
      const step = steps[Math.min(i, steps.length - 1)] ?? { status: 200 };
      i += 1;
      return step;
    });
  };
  reply({ status: 200, bodyText: 'ok' });

  /** Advances the fake clock in `step` slices, draining callbacks after each. */
  const advance = async (ms: number, step = ms): Promise<void> => {
    let left = ms;
    while (left > 0) {
      const s = Math.min(step, left);
      clock.advance(s);
      left -= s;
      await flush();
    }
  };

  return { clock, http, storage, notifier, sched, events, sent, reply, advance };
}

let seq = 0;
function req(lane: Lane, over: Partial<ScheduledRequest<string>> = {}): ScheduledRequest<string> {
  seq += 1;
  const id = seq;
  return {
    lane,
    endpoint: 'test.endpoint',
    build: (): HttpRequest => ({ url: `${BASE}${lane}/${String(id)}`, method: 'GET', timeoutMs: 10 * S, credentials: 'omit' }),
    parse: (res) => res.bodyText,
    ...over,
  };
}

interface Tracked<T> {
  done: boolean;
  value?: T;
  error?: unknown;
}
/** Attaches handlers at once (no unhandled rejections) and exposes the outcome. */
function track<T>(p: Promise<T>): Tracked<T> {
  const t: Tracked<T> = { done: false };
  p.then(
    (v) => {
      t.done = true;
      t.value = v;
    },
    (e: unknown) => {
      t.done = true;
      t.error = e;
    },
  );
  return t;
}

async function failure(p: Promise<unknown>): Promise<SgwApiError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof SgwApiError) return e;
    throw new Error(`expected SgwApiError, got ${String(e)}`, { cause: e });
  }
  throw new Error('expected the request to fail');
}

function nextLocalMidnight(ms: number): number {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
}

// ── Lanes and spacing ────────────────────────────────────────────────────────

describe('RequestScheduler: lane spacing', () => {
  it('two background requests are ≥120 s apart', async () => {
    const h = setup();
    const a = track(h.sched.run(req('background')));
    const b = track(h.sched.run(req('background')));
    await flush();
    expect(h.sent.map((s) => s.at)).toEqual([T0]);
    expect(a.value).toBe('ok');

    await h.advance(120 * S - 1);
    expect(h.sent).toHaveLength(1);
    expect(b.done).toBe(false);

    await h.advance(1);
    expect(h.sent.map((s) => s.at)).toEqual([T0, T0 + 120 * S]);
    expect(b.value).toBe('ok');
  });

  it('adds 0–15 s of jitter on top of the 120 s background gap', async () => {
    const h = setup({ random: () => 0.999 });
    void h.sched.run(req('background'));
    void h.sched.run(req('background'));
    await flush();
    await h.advance(140 * S, S);
    expect(h.sent).toHaveLength(2);
    const gap = (h.sent[1]?.at ?? 0) - (h.sent[0]?.at ?? 0);
    expect(gap).toBeGreaterThanOrEqual(120 * S);
    expect(gap).toBeLessThanOrEqual(135 * S);
    expect(gap).toBeGreaterThan(130 * S);
  });

  it('interactive requests are ≥1 s apart', async () => {
    const h = setup();
    for (let i = 0; i < 3; i++) void h.sched.run(req('interactive'));
    await flush();
    await h.advance(3 * S, 100);
    expect(h.sent.map((s) => s.at)).toEqual([T0, T0 + S, T0 + 2 * S]);
  });

  it('measures the gap from when the previous response arrived', async () => {
    const h = setup();
    h.reply({ status: 200, latencyMs: 400 });
    void h.sched.run(req('interactive'));
    void h.sched.run(req('interactive'));
    await flush();
    await h.advance(2 * S, 100);
    expect(h.sent.map((s) => s.at)).toEqual([T0, T0 + 1400]);
  });

  it('never has two requests in flight on one lane', async () => {
    const h = setup();
    h.reply({ status: 200, latencyMs: 3 * S });
    const all = Array.from({ length: 4 }, () => track(h.sched.run(req('interactive'))));
    await flush();
    await h.advance(20 * S, 100);
    expect(all.every((t) => t.value === '')).toBe(true);
    expect(h.sent.map((s) => s.at - T0)).toEqual([0, 4 * S, 8 * S, 12 * S]);
    expect(h.sent.every((s) => s.othersInFlight === 0)).toBe(true);
  });

  it('keeps lanes independent: a slow background request does not hold up the snipe lane', async () => {
    const h = setup();
    h.reply({ status: 200, bodyText: 'slow', latencyMs: 8 * S }, { status: 200, bodyText: 'fast', latencyMs: 100 });
    const background = track(h.sched.run(req('background')));
    await flush();
    const snipe = track(h.sched.run(req('snipe')));
    await flush();
    expect(h.sent).toHaveLength(2);
    expect(h.sent[1]?.othersInFlight).toBe(1);
    await h.advance(100);
    expect(snipe.value).toBe('fast');
    expect(background.done).toBe(false);
    await h.advance(8 * S);
    expect(background.value).toBe('slow');
  });

  it('a wall-clock jump forward does not shorten the gap', async () => {
    const h = setup();
    await h.sched.run(req('background'));
    h.clock.set(T0 + HOUR);
    const b = track(h.sched.run(req('background')));
    await flush();
    expect(h.sent).toHaveLength(1);
    await h.advance(120 * S - 1);
    expect(b.done).toBe(false);
    await h.advance(1);
    expect(h.sent).toHaveLength(2);
  });

  it('sends higher-priority requests first within a lane', async () => {
    const h = setup();
    const order: string[] = [];
    const tag = (name: string, priority?: number): ScheduledRequest<string> =>
      req('interactive', {
        ...(priority === undefined ? {} : { priority }),
        parse: () => {
          order.push(name);
          return name;
        },
      });
    void h.sched.run(tag('first'));
    void h.sched.run(tag('low'));
    void h.sched.run(tag('high', 5));
    void h.sched.run(tag('low2'));
    await flush();
    await h.advance(5 * S, 100);
    expect(order).toEqual(['first', 'high', 'low', 'low2']);
  });
});

// ── Daily budget ─────────────────────────────────────────────────────────────

describe('RequestScheduler: daily budget', () => {
  it('budget exhaustion throws `budget` without touching the network', async () => {
    const h = setup();
    for (let i = 0; i < 4; i++) {
      await h.sched.run(req('canary'));
      await h.advance(120 * S);
    }
    expect(h.sent).toHaveLength(4);
    const err = await failure(h.sched.run(req('canary')));
    expect(err.kind).toBe('budget');
    expect(err.retryAfterMs).toBe(nextLocalMidnight(h.clock.now()) - h.clock.now());
    expect(h.sent).toHaveLength(4);

    const canary = h.sched.stats().lanes.canary;
    expect(canary).toMatchObject({ usedToday: 4, budget: 4 });
    expect(canary.nextAllowedAt).toBe(nextLocalMidnight(T0));
    expect(h.events).toContainEqual({ type: 'budget-exhausted', lane: 'canary', day: '2026-10-07', budget: 4 });
    // Other lanes keep their own budgets.
    await expect(h.sched.run(req('interactive'))).resolves.toBe('ok');
  });

  it('refuses queued requests past the budget instead of sending them', async () => {
    const h = setup();
    const all = Array.from({ length: 6 }, () => track(h.sched.run(req('canary'))));
    await flush();
    await h.advance(10 * MIN, 10 * S);
    expect(h.sent).toHaveLength(4);
    expect(all.filter((t) => t.value === 'ok')).toHaveLength(4);
    expect(all.slice(4).map((t) => (t.error as SgwApiError).kind)).toEqual(['budget', 'budget']);
  });

  it('persists the count in sbw:requestBudget, keyed by the local day', async () => {
    const h = setup();
    await h.sched.run(req('interactive'));
    await h.sched.run(req('background'));
    await h.advance(S);
    await h.sched.run(req('interactive'));
    await h.sched.flush();
    const stored = h.storage.dump()[STORAGE_KEYS.requestBudget];
    expect(stored).toEqual({ day: '2026-10-07', used: { interactive: 2, background: 1 } });
    expect(RequestBudgetSchema.safeParse(stored).success).toBe(true);
    expect(localDay(T0)).toBe('2026-10-07');
  });

  it("a new instance (service-worker restart) continues today's count", async () => {
    const storage = new FakeStorage();
    storage.seed({ [STORAGE_KEYS.requestBudget]: { day: '2026-10-07', used: { canary: 4, interactive: 7 } } });
    const h = setup({ storage });
    await h.sched.load();
    expect(h.sched.stats().lanes.interactive.usedToday).toBe(7);
    expect((await failure(h.sched.run(req('canary')))).kind).toBe('budget');
    expect(h.sent).toHaveLength(0);
  });

  it("ignores a stored record from another day, and an invalid one", async () => {
    for (const seeded of [{ day: '2026-10-06', used: { canary: 4 } }, { day: 'yesterday', used: { canary: -1 } }]) {
      const storage = new FakeStorage();
      storage.seed({ [STORAGE_KEYS.requestBudget]: seeded });
      const h = setup({ storage });
      await expect(h.sched.run(req('canary'))).resolves.toBe('ok');
      await h.sched.flush();
      expect(storage.dump()[STORAGE_KEYS.requestBudget]).toEqual({ day: '2026-10-07', used: { canary: 1 } });
    }
  });

  it('day rollover resets the budget at local midnight', async () => {
    const start = new Date(2026, 9, 7, 23, 50, 0).getTime();
    const h = setup({ start });
    for (let i = 0; i < 4; i++) {
      await h.sched.run(req('canary'));
      await h.advance(120 * S);
    }
    expect((await failure(h.sched.run(req('canary')))).kind).toBe('budget');

    const midnight = new Date(2026, 9, 8, 0, 0, 0).getTime();
    await h.advance(midnight - 1 - h.clock.now());
    expect(h.sched.stats().lanes.canary.usedToday).toBe(4);
    expect((await failure(h.sched.run(req('canary')))).kind).toBe('budget');

    await h.advance(1);
    expect(h.sched.stats().lanes.canary.usedToday).toBe(0);
    await expect(h.sched.run(req('canary'))).resolves.toBe('ok');
    expect(h.sched.stats().lanes.canary.usedToday).toBe(1);
    await h.sched.flush();
    expect(h.storage.dump()[STORAGE_KEYS.requestBudget]).toEqual({ day: '2026-10-08', used: { canary: 1 } });
  });
});

// ── Backoff and blocks ───────────────────────────────────────────────────────

describe('RequestScheduler: backoff and blocks', () => {
  it('429 doubles the lane backoff up to the 30 min cap, and never retries hot', async () => {
    const h = setup();
    h.reply({ status: 429 });
    const expected = [30, 60, 120, 240, 480, 960, 1800, 1800].map((s) => s * S);
    for (const backoff of expected) {
      const before = h.sent.length;
      const err = await failure(h.sched.run(req('interactive')));
      expect(err).toMatchObject({ kind: 'rate-limited', status: 429, retryAfterMs: backoff });
      expect(h.sent).toHaveLength(before + 1);
      expect(h.sched.stats().lanes.interactive.backoffUntil).toBe(h.clock.now() + backoff);

      // An immediate retry is refused locally: nothing reaches SGW.
      const hot = await failure(h.sched.run(req('interactive')));
      expect(['rate-limited', 'paused']).toContain(hot.kind);
      expect(h.sent).toHaveLength(before + 1);

      await h.advance(backoff);
    }
    expect(BACKOFF_CAP_MS).toBe(30 * MIN);
  });

  it('jitters the backoff within [base, 1.25 × base] and never past the cap', async () => {
    const h = setup({ random: () => 0.999 });
    h.reply({ status: 503 });
    const seen: number[] = [];
    for (let i = 0; i < 8; i++) {
      const err = await failure(h.sched.run(req('background')));
      expect(err.kind).toBe('server');
      seen.push(err.retryAfterMs ?? -1);
      await h.advance(err.retryAfterMs ?? 0);
      await h.advance(120 * S);
    }
    const bases = [30, 60, 120, 240, 480, 960, 1800, 1800].map((s) => s * S);
    seen.forEach((ms, i) => {
      const base = bases[i] ?? 0;
      expect(ms).toBeGreaterThanOrEqual(base);
      expect(ms).toBeLessThanOrEqual(Math.min(base * 1.25, BACKOFF_CAP_MS));
    });
    expect(seen[0]).toBeGreaterThan(30 * S);
    expect(seen[7]).toBe(BACKOFF_CAP_MS);
  });

  it('a successful response resets the backoff exponent', async () => {
    const h = setup();
    h.reply({ status: 429 }, { status: 429 }, { status: 200 }, { status: 429 });
    expect((await failure(h.sched.run(req('interactive')))).retryAfterMs).toBe(30 * S);
    await h.advance(30 * S);
    expect((await failure(h.sched.run(req('interactive')))).retryAfterMs).toBe(60 * S);
    await h.advance(60 * S);
    await expect(h.sched.run(req('interactive'))).resolves.toBe('');
    await h.advance(S);
    expect((await failure(h.sched.run(req('interactive')))).retryAfterMs).toBe(30 * S);
  });

  it('honours Retry-After in seconds and as an HTTP date', async () => {
    const h = setup();
    h.reply({ status: 429, headers: { 'Retry-After': '600' } });
    expect((await failure(h.sched.run(req('interactive')))).retryAfterMs).toBe(600 * S);
    expect(h.sched.stats().lanes.interactive.backoffUntil).toBe(T0 + 600 * S);

    const date = new Date(T0 + 900 * S).toUTCString();
    h.reply({ status: 503, headers: { 'retry-after': date } });
    expect((await failure(h.sched.run(req('background')))).retryAfterMs).toBe(900 * S);
    expect(h.sched.stats().lanes.background.backoffUntil).toBe(T0 + 900 * S);
  });

  it('ignores a malformed or past Retry-After and caps an absurd one at 24 h', async () => {
    const h = setup();
    h.reply({ status: 503, headers: { 'Retry-After': 'soon' } });
    expect((await failure(h.sched.run(req('interactive')))).retryAfterMs).toBe(30 * S);
    h.reply({ status: 503, headers: { 'Retry-After': new Date(T0 - HOUR).toUTCString() } });
    expect((await failure(h.sched.run(req('background')))).retryAfterMs).toBe(30 * S);
    h.reply({ status: 403, headers: { 'Retry-After': '999999999' } });
    expect((await failure(h.sched.run(req('snipe')))).retryAfterMs).toBe(24 * HOUR);
  });

  it('refuses requests queued behind a 429 instead of sending them', async () => {
    const h = setup();
    h.reply({ status: 429 }, { status: 200 });
    const all = Array.from({ length: 3 }, () => track(h.sched.run(req('interactive'))));
    await flush();
    await h.advance(10 * S, S);
    expect(h.sent).toHaveLength(1);
    expect(all.map((t) => (t.error as SgwApiError).kind)).toEqual(['rate-limited', 'rate-limited', 'rate-limited']);
  });

  it('maps network errors and timeouts without retrying or backing off', async () => {
    const h = setup();
    h.reply({ error: new HttpNetworkError('Failed to fetch') });
    const net = await failure(h.sched.run(req('interactive')));
    expect(net.kind).toBe('network');
    expect(net.cause).toBeInstanceOf(HttpNetworkError);

    h.reply({ hang: true });
    const p = track(h.sched.run(req('snipe')));
    await flush();
    await h.advance(10 * S);
    expect((p.error as SgwApiError).kind).toBe('timeout');

    expect(h.sent).toHaveLength(2);
    expect(h.sched.stats().lanes.interactive.backoffUntil).toBeUndefined();
    expect(h.sched.stats().lanes.snipe.backoffUntil).toBeUndefined();
  });

  it('a 403 backs the lane off 1 h and throws `blocked`; other lanes carry on', async () => {
    const h = setup();
    h.reply({ status: 403 }, { status: 200, bodyText: 'ok' });
    const err = await failure(h.sched.run(req('background')));
    expect(err).toMatchObject({ kind: 'blocked', status: 403, retryAfterMs: BLOCKED_BACKOFF_MS });
    expect(BLOCKED_BACKOFF_MS).toBe(HOUR);
    expect(h.sched.stats().lanes.background.backoffUntil).toBe(T0 + HOUR);

    expect((await failure(h.sched.run(req('background')))).kind).toBe('blocked');
    await expect(h.sched.run(req('interactive'))).resolves.toBe('ok');
    expect(h.sent).toHaveLength(2);

    await h.advance(HOUR);
    await expect(h.sched.run(req('background'))).resolves.toBe('ok');
    expect(h.notifier.sent).toHaveLength(0);
  });

  it('three 403s pause all lanes 6 h, notify the user and emit an event', async () => {
    const h = setup();
    h.reply({ status: 403 });
    for (const lane of ['interactive', 'background', 'snipe'] as const) {
      expect((await failure(h.sched.run(req(lane)))).kind).toBe('blocked');
    }
    const until = T0 + 6 * HOUR;
    expect(BLOCK_PAUSE_MS).toBe(6 * HOUR);
    expect(h.events).toContainEqual({
      type: 'paused',
      cause: 'blocked',
      reason: 'SGW is refusing requests; automation paused',
      until,
    });
    expect(h.sched.stats().paused).toEqual({ reason: 'SGW is refusing requests; automation paused', until });
    expect(h.notifier.sent).toHaveLength(1);
    expect(h.notifier.sent[0]?.id).toBe(PAUSE_NOTIFICATION_ID);
    expect(h.notifier.sent[0]?.notification).toMatchObject({ id: PAUSE_NOTIFICATION_ID, message: 'SGW is refusing requests; automation paused' });

    h.reply({ status: 200, bodyText: 'ok' });
    for (const lane of LANES) {
      const err = await failure(h.sched.run(req(lane)));
      expect(err.kind).toBe('paused');
      expect(err.retryAfterMs).toBe(6 * HOUR);
      expect(h.sched.stats().lanes[lane].nextAllowedAt).toBeGreaterThanOrEqual(until);
    }
    expect(h.sent).toHaveLength(3);

    await h.advance(6 * HOUR - 1);
    expect((await failure(h.sched.run(req('canary')))).kind).toBe('paused');
    await h.advance(1);
    await expect(h.sched.run(req('canary'))).resolves.toBe('ok');
    expect(h.sched.stats().paused).toBeUndefined();
    expect(h.notifier.sent).toHaveLength(1);
  });

  it('any other response breaks a 403 streak', async () => {
    const h = setup();
    h.reply({ status: 403 }, { status: 403 }, { status: 404 }, { status: 403 });
    for (const lane of ['interactive', 'background', 'snipe', 'canary'] as const) {
      await h.sched.run(req(lane)).catch(() => undefined);
    }
    expect(h.sent).toHaveLength(4);
    expect(h.sched.stats().paused).toBeUndefined();
    expect(h.notifier.sent).toHaveLength(0);
  });

  it('three 429s in a row pause all lanes until the backoff ends', async () => {
    const h = setup();
    h.reply({ status: 429 });
    for (const lane of ['interactive', 'background', 'snipe'] as const) {
      expect((await failure(h.sched.run(req(lane)))).kind).toBe('rate-limited');
    }
    const until = T0 + 30 * S;
    expect(h.sched.stats().paused).toEqual({ reason: 'SGW is rate-limiting requests', until });
    expect(h.events).toContainEqual(expect.objectContaining({ type: 'paused', cause: 'rate-limited', until }));
    expect(h.notifier.sent).toHaveLength(1);

    h.reply({ status: 200, bodyText: 'ok' });
    expect((await failure(h.sched.run(req('canary')))).kind).toBe('paused');
    await h.advance(30 * S);
    await expect(h.sched.run(req('canary'))).resolves.toBe('ok');
  });

  it('emits a backoff event for each throttling response', async () => {
    const h = setup();
    h.reply({ status: 502 });
    await h.sched.run(req('snipe')).catch(() => undefined);
    expect(h.events).toEqual([{ type: 'backoff', lane: 'snipe', kind: 'server', status: 502, until: T0 + 30 * S }]);
  });
});

// ── Pause and resume ─────────────────────────────────────────────────────────

describe('RequestScheduler: pause and resume', () => {
  it('pause() refuses new and queued requests without touching the network; resume() lifts it', async () => {
    const h = setup();
    void h.sched.run(req('background'));
    const queued = track(h.sched.run(req('background')));
    await flush();
    expect(h.sent).toHaveLength(1);

    h.sched.pause('health check failed');
    await flush();
    expect((queued.error as SgwApiError).kind).toBe('paused');
    const err = await failure(h.sched.run(req('interactive')));
    expect(err.kind).toBe('paused');
    expect(err.message).toContain('health check failed');
    expect(h.sched.stats().paused).toEqual({ reason: 'health check failed', until: null });
    expect(h.events).toContainEqual({ type: 'paused', cause: 'manual', reason: 'health check failed', until: null });

    await h.advance(10 * HOUR, HOUR);
    expect((await failure(h.sched.run(req('interactive')))).kind).toBe('paused');

    h.sched.resume();
    expect(h.sched.stats().paused).toBeUndefined();
    await expect(h.sched.run(req('interactive'))).resolves.toBe('ok');
    expect(h.events.map((e) => e.type)).toEqual(['paused', 'resumed']);
    expect(h.notifier.sent).toHaveLength(0);
  });

  it('resume() does not reset lane spacing', async () => {
    const h = setup();
    await h.sched.run(req('background'));
    h.sched.pause('x');
    h.sched.resume();
    const b = track(h.sched.run(req('background')));
    await flush();
    expect(b.done).toBe(false);
    await h.advance(120 * S);
    expect(b.value).toBe('ok');
  });

  it('pause(reason, until) lifts itself at `until`', async () => {
    const h = setup();
    h.sched.pause('considerate mode', T0 + MIN);
    expect((await failure(h.sched.run(req('interactive')))).retryAfterMs).toBe(MIN);
    expect(h.sched.stats().paused).toEqual({ reason: 'considerate mode', until: T0 + MIN });
    expect(h.sched.stats().lanes.interactive.nextAllowedAt).toBe(T0 + MIN);
    expect(h.sched.stats().lanes.interactive.backoffUntil).toBeUndefined();
    await h.advance(MIN);
    await expect(h.sched.run(req('interactive'))).resolves.toBe('ok');
  });

  it('a shorter pause never shortens a longer one', async () => {
    const h = setup();
    h.sched.pause('blocked for a while', T0 + HOUR);
    h.sched.pause('brief', T0 + MIN);
    await h.advance(MIN);
    expect(h.sched.stats().paused).toEqual({ reason: 'blocked for a while', until: T0 + HOUR });
    h.sched.pause('until resumed');
    h.sched.pause('brief again', T0 + 2 * HOUR);
    expect(h.sched.stats().paused).toEqual({ reason: 'until resumed', until: null });
  });

  it('resume() keeps per-lane backoffs that SGW asked for', async () => {
    const h = setup();
    h.reply({ status: 429, headers: { 'retry-after': '120' } });
    await h.sched.run(req('interactive')).catch(() => undefined);
    h.sched.pause('x');
    h.sched.resume();
    expect((await failure(h.sched.run(req('interactive')))).kind).toBe('rate-limited');
  });
});

// ── Cache ────────────────────────────────────────────────────────────────────

describe('RequestScheduler: cache', () => {
  it('a cache hit skips the network and the budget', async () => {
    const h = setup();
    h.reply({ status: 200, bodyText: 'v1' }, { status: 200, bodyText: 'v2' });
    const keyed = (): ScheduledRequest<string> => req('interactive', { key: 'detail:1', cacheTtlMs: MIN });
    await expect(h.sched.run(keyed())).resolves.toBe('v1');
    await expect(h.sched.run(keyed())).resolves.toBe('v1');
    expect(h.sent).toHaveLength(1);
    expect(h.sched.stats().cacheHits).toBe(1);
    expect(h.sched.stats().lanes.interactive.usedToday).toBe(1);

    await h.advance(MIN);
    await expect(h.sched.run(keyed())).resolves.toBe('v2');
    expect(h.sent).toHaveLength(2);
  });

  it('serves cache hits while paused', async () => {
    const h = setup();
    await h.sched.run(req('interactive', { key: 'k', cacheTtlMs: MIN }));
    h.sched.pause('x');
    await expect(h.sched.run(req('interactive', { key: 'k', cacheTtlMs: MIN }))).resolves.toBe('ok');
  });

  it('concurrent requests with the same key share one network call', async () => {
    const h = setup();
    h.reply({ status: 200, bodyText: 'shared', latencyMs: 200 });
    const a = track(h.sched.run(req('interactive', { key: 'quote:1:97201' })));
    const b = track(h.sched.run(req('interactive', { key: 'quote:1:97201' })));
    await flush();
    await h.advance(200);
    expect([a.value, b.value]).toEqual(['shared', 'shared']);
    expect(h.sent).toHaveLength(1);
  });

  it('does not cache failures or unkeyed results', async () => {
    const h = setup();
    h.reply({ status: 500 }, { status: 200, bodyText: 'ok' });
    await h.sched.run(req('interactive', { key: 'k', cacheTtlMs: HOUR })).catch(() => undefined);
    await h.advance(30 * S);
    await expect(h.sched.run(req('interactive', { key: 'k', cacheTtlMs: HOUR }))).resolves.toBe('ok');
    await h.advance(S);
    await h.sched.run(req('interactive', { cacheTtlMs: HOUR }));
    await h.advance(S);
    await h.sched.run(req('interactive', { cacheTtlMs: HOUR }));
    expect(h.sent).toHaveLength(4);
    expect(h.sched.stats().cacheHits).toBe(0);
  });
});

// ── Considerate mode ─────────────────────────────────────────────────────────

describe('RequestScheduler: considerate mode', () => {
  it('considerate `tight` halves budgets', async () => {
    const h = setup({ considerateMode: 'tight' });
    const lanes = h.sched.stats().lanes;
    expect(LANES.map((l) => lanes[l].budget)).toEqual(LANES.map((l) => DEFAULT_LANES[l].dailyBudget / 2));
    await h.sched.run(req('canary'));
    await h.advance(240 * S);
    await h.sched.run(req('canary'));
    await h.advance(240 * S);
    expect((await failure(h.sched.run(req('canary')))).kind).toBe('budget');
  });

  it('considerate `tight` doubles intervals', async () => {
    const h = setup({ considerateMode: 'tight' });
    void h.sched.run(req('background'));
    void h.sched.run(req('background'));
    void h.sched.run(req('interactive'));
    void h.sched.run(req('interactive'));
    await flush();
    await h.advance(240 * S, 100);
    expect(h.sent.map((s) => s.at - T0)).toEqual([0, 0, 2 * S, 240 * S]);
  });

  it('switching mode applies at once, including to a request already waiting', async () => {
    const h = setup();
    await h.sched.run(req('background'));
    const waiting = track(h.sched.run(req('background')));
    await flush();
    h.sched.setConsiderateMode('tight');
    expect(h.sched.stats().lanes.background.budget).toBe(60);
    await h.advance(239 * S);
    expect(waiting.done).toBe(false);
    await h.advance(S);
    expect(waiting.value).toBe('ok');
    h.sched.setConsiderateMode('normal');
    expect(h.sched.stats().lanes.background.budget).toBe(120);
  });
});

// ── Contract details ─────────────────────────────────────────────────────────

describe('RequestScheduler: contract', () => {
  it('stats() always matches RequestSchedulerStatsSchema', async () => {
    const h = setup();
    expect(RequestSchedulerStatsSchema.parse(h.sched.stats())).toEqual(h.sched.stats());
    h.reply({ status: 429 });
    await h.sched.run(req('interactive')).catch(() => undefined);
    h.sched.pause('x', T0 + HOUR);
    const s = h.sched.stats();
    expect(RequestSchedulerStatsSchema.parse(s)).toEqual(s);
    expect(Object.keys(s.lanes).sort()).toEqual([...LANES].sort());
    h.sched.pause('indefinite');
    expect(RequestSchedulerStatsSchema.safeParse(h.sched.stats()).success).toBe(true);
  });

  it('sends exactly the built request: no header, user-agent or credential changes', async () => {
    const h = setup();
    const built: HttpRequest = {
      url: `${BASE}ItemDetail?itemId=1`,
      method: 'POST',
      headers: { Authorization: 'Bearer abc', 'Content-Type': 'application/json' },
      body: '{"a":1}',
      timeoutMs: 5000,
      credentials: 'omit',
    };
    await h.sched.run(req('interactive', { build: () => structuredClone(built) }));
    expect(h.http.requests).toEqual([built]);
  });

  it('builds each request when it is sent, not when it is queued', async () => {
    const h = setup();
    const builtAt: number[] = [];
    const r = (): ScheduledRequest<string> => {
      const base = req('interactive');
      return {
        ...base,
        build: () => {
          builtAt.push(h.clock.now());
          return base.build();
        },
      };
    };
    void h.sched.run(r());
    void h.sched.run(r());
    await flush();
    await h.advance(S);
    expect(builtAt).toEqual([T0, T0 + S]);
  });

  it('parse failures surface as `schema` errors', async () => {
    const h = setup();
    const own = new SgwApiError('schema', 'bad field');
    expect(await failure(h.sched.run(req('interactive', { parse: () => { throw own; } })))).toBe(own);
    await h.advance(S);
    const wrapped = await failure(
      h.sched.run(
        req('interactive', {
          parse: () => {
            throw new TypeError('x is undefined');
          },
        }),
      ),
    );
    expect(wrapped.kind).toBe('schema');
    expect(wrapped.cause).toBeInstanceOf(TypeError);
  });

  it('a 401 throws `auth` and does not back off', async () => {
    const h = setup();
    h.reply({ status: 401 });
    expect(await failure(h.sched.run(req('interactive')))).toMatchObject({ kind: 'auth', status: 401 });
    expect(h.sched.stats().lanes.interactive.backoffUntil).toBeUndefined();
  });

  it('other statuses go to parse(), which decides', async () => {
    const h = setup();
    h.reply({ status: 404, bodyText: 'gone' });
    await expect(h.sched.run(req('interactive', { parse: (res) => `${String(res.status)}:${res.bodyText}` }))).resolves.toBe('404:gone');
  });

  it('a build() error sends nothing and costs no budget', async () => {
    const h = setup();
    const boom = new Error('no session');
    await expect(h.sched.run(req('snipe', { build: () => { throw boom; } }))).rejects.toBe(boom);
    expect(h.sent).toHaveLength(0);
    expect(h.sched.stats().lanes.snipe.usedToday).toBe(0);
    await expect(h.sched.run(req('snipe'))).resolves.toBe('ok');
  });

  it('a throwing event listener or notifier does not break the scheduler', async () => {
    const h = setup();
    h.sched.onEvent(() => {
      throw new Error('listener bug');
    });
    h.notifier.notify = () => Promise.reject(new Error('notifications blocked'));
    h.reply({ status: 403 });
    for (const lane of ['interactive', 'background', 'snipe'] as const) await h.sched.run(req(lane)).catch(() => undefined);
    await flush();
    expect(h.sched.stats().paused?.reason).toBe('SGW is refusing requests; automation paused');
  });
});

// ── Persisted state (service-worker restarts) ───────────────────────────────

describe('RequestScheduler: persisted state (sbw:requestSchedulerState)', () => {
  const KEY = STORAGE_KEYS.requestSchedulerState;
  const state = (over: Partial<RequestSchedulerState> = {}): RequestSchedulerState => ({
    version: 1,
    pause: null,
    consecutive403: 0,
    consecutive429: 0,
    lanes: {},
    ...over,
  });
  const stored = (storage: FakeStorage): RequestSchedulerState =>
    RequestSchedulerStateSchema.parse(storage.dump()[KEY]);

  it('writes pause and backoff state on every change, by default', async () => {
    const h = setup();
    h.reply({ status: 429 });
    await h.sched.run(req('interactive')).catch(() => undefined);
    await h.sched.flush();
    expect(stored(h.storage)).toEqual(
      state({
        consecutive429: 1,
        lanes: {
          interactive: { lastEndAt: T0, gapJitterMs: 0, backoffUntil: T0 + 30 * S, backoffKind: 'rate-limited', failures: 1 },
        },
      }),
    );

    h.reply({ status: 403 });
    for (const lane of ['background', 'snipe', 'canary'] as const) await h.sched.run(req(lane)).catch(() => undefined);
    await h.sched.flush();
    expect(stored(h.storage).pause).toEqual({ cause: 'blocked', reason: 'SGW is refusing requests; automation paused', until: T0 + 6 * HOUR });

    h.sched.resume();
    await h.sched.flush();
    expect(stored(h.storage).pause).toBeNull();
  });

  it('a new instance over the same storage honours an active pause, with the right retryAfterMs', async () => {
    const storage = new FakeStorage();
    const clock = new FakeClock(T0);
    const a = setup({ storage, clock });
    a.reply({ status: 403 });
    for (const lane of ['interactive', 'background', 'snipe'] as const) await a.sched.run(req(lane)).catch(() => undefined);
    await a.sched.flush();

    clock.advance(10 * MIN);
    const b = setup({ storage, clock });
    const err = await failure(b.sched.run(req('canary')));
    expect(err.kind).toBe('paused');
    expect(err.retryAfterMs).toBe(6 * HOUR - 10 * MIN);
    expect(b.sched.stats().paused).toEqual({ reason: 'SGW is refusing requests; automation paused', until: T0 + 6 * HOUR });
    expect(b.sent).toHaveLength(0);
    expect(b.notifier.sent).toHaveLength(0);

    // The per-lane 403 backoff survived too.
    b.sched.resume();
    const blocked = await failure(b.sched.run(req('background')));
    expect(blocked.kind).toBe('blocked');
    expect(blocked.retryAfterMs).toBe(HOUR - 10 * MIN);
    expect(b.sched.stats().lanes.background.backoffUntil).toBe(T0 + HOUR);
    expect(b.sent).toHaveLength(0);
  });

  it('a new instance honours a 429 backoff and keeps counting consecutive 429s', async () => {
    const storage = new FakeStorage();
    const clock = new FakeClock(T0);
    const a = setup({ storage, clock });
    a.reply({ status: 429, headers: { 'retry-after': '600' } });
    await a.sched.run(req('interactive')).catch(() => undefined);
    await a.sched.flush();

    clock.advance(100 * S);
    const b = setup({ storage, clock });
    const err = await failure(b.sched.run(req('interactive')));
    expect(err).toMatchObject({ kind: 'rate-limited', retryAfterMs: 500 * S });
    expect(b.sent).toHaveLength(0);

    // Two more 429s complete the burst begun before the restart.
    b.reply({ status: 429 });
    await b.sched.run(req('background')).catch(() => undefined);
    expect(b.sched.stats().paused).toBeUndefined();
    await b.sched.run(req('snipe')).catch(() => undefined);
    expect(b.sched.stats().paused).toMatchObject({ reason: 'SGW is rate-limiting requests' });
  });

  it('reads the state at construction: paused before anything is sent', async () => {
    const storage = new FakeStorage();
    storage.seed({ [KEY]: state({ pause: { cause: 'manual', reason: 'health check failed', until: null } }) });
    const h = setup({ storage });
    await flush();
    expect(h.sched.stats().paused).toEqual({ reason: 'health check failed', until: null });
  });

  it('a new instance keeps the background gap', async () => {
    const storage = new FakeStorage();
    const clock = new FakeClock(T0);
    const a = setup({ storage, clock });
    await a.sched.run(req('background'));
    await a.sched.flush();

    clock.advance(10 * S);
    const b = setup({ storage, clock });
    const next = track(b.sched.run(req('background')));
    await flush();
    expect(b.sent).toHaveLength(0);
    await b.advance(110 * S - 1);
    expect(next.done).toBe(false);
    await b.advance(1);
    expect(next.value).toBe('ok');
  });

  it('ignores an expired pause and expired backoffs', async () => {
    const storage = new FakeStorage();
    storage.seed({
      [KEY]: state({
        pause: { cause: 'blocked', reason: 'SGW is refusing requests; automation paused', until: T0 - 1 },
        consecutive403: 2,
        lanes: { interactive: { lastEndAt: T0 - HOUR, gapJitterMs: 0, backoffUntil: T0 - 1, backoffKind: 'blocked', failures: 0 } },
      }),
    });
    const h = setup({ storage });
    await expect(h.sched.run(req('interactive'))).resolves.toBe('ok');
    const s = h.sched.stats();
    expect(s.paused).toBeUndefined();
    expect(s.lanes.interactive.backoffUntil).toBeUndefined();
    await h.sched.flush();
    expect(stored(storage).pause).toBeNull();
  });

  it('an expired pause from a previous worker is ignored after a restart', async () => {
    const storage = new FakeStorage();
    const clock = new FakeClock(T0);
    const a = setup({ storage, clock });
    a.reply({ status: 403 });
    for (const lane of ['interactive', 'background', 'snipe'] as const) await a.sched.run(req(lane)).catch(() => undefined);
    await a.sched.flush();

    clock.advance(6 * HOUR);
    const b = setup({ storage, clock });
    await expect(b.sched.run(req('canary'))).resolves.toBe('ok');
    await expect(b.sched.run(req('interactive'))).resolves.toBe('ok');
    expect(b.sched.stats().paused).toBeUndefined();
  });

  it('corrupt state does not wedge the scheduler: it is quarantined, flagged, and means no pause', async () => {
    for (const corrupt of [{ pause: 'yes', lanes: 7 }, { ...state({ pause: { cause: 'manual', reason: 'x', until: null } }), version: 2 }]) {
      const storage = new FakeStorage();
      storage.seed({ [KEY]: corrupt });
      const h = setup({ storage });
      await expect(h.sched.run(req('interactive'))).resolves.toBe('ok');
      expect(h.sched.stats().paused).toBeUndefined();
      expect(h.events).toContainEqual(expect.objectContaining({ type: 'state-invalid', key: KEY }) as SchedulerEvent);

      await h.sched.flush();
      const quarantined = QuarantineRecordSchema.parse(storage.dump()[QUARANTINE_KEY_PREFIX + KEY]);
      expect(quarantined.value).toEqual(corrupt);
      expect(quarantined.at).toBe(T0);
      expect(stored(storage).lanes.interactive?.lastEndAt).toBe(T0);
    }
  });

  it('a corrupt budget record is quarantined and flagged as well', async () => {
    const storage = new FakeStorage();
    storage.seed({ [STORAGE_KEYS.requestBudget]: { day: 'yesterday', used: { canary: -1 } } });
    const h = setup({ storage });
    await expect(h.sched.run(req('canary'))).resolves.toBe('ok');
    expect(h.events).toContainEqual(expect.objectContaining({ type: 'state-invalid', key: STORAGE_KEYS.requestBudget }) as SchedulerEvent);
    await h.sched.flush();
    expect(QuarantineRecordSchema.safeParse(storage.dump()[QUARANTINE_KEY_PREFIX + STORAGE_KEYS.requestBudget]).success).toBe(true);
  });

  it('writes only its two contract records, both valid', async () => {
    const h = setup();
    h.reply({ status: 403 });
    for (const lane of ['interactive', 'background', 'snipe'] as const) await h.sched.run(req(lane)).catch(() => undefined);
    await h.sched.flush();
    const dump = h.storage.dump();
    expect(Object.keys(dump).sort()).toEqual([STORAGE_KEYS.requestBudget, STORAGE_KEYS.requestSchedulerState].sort());
    expect(RequestBudgetSchema.safeParse(dump[STORAGE_KEYS.requestBudget]).success).toBe(true);
    expect(RequestSchedulerStateSchema.safeParse(dump[STORAGE_KEYS.requestSchedulerState]).success).toBe(true);
  });
});

// ── Review fix round 1: nothing may erase a block or the day's budget ────────

describe('RequestScheduler: hardening (review fix round 1)', () => {
  const KEY = STORAGE_KEYS.requestSchedulerState;
  const BUDGET = STORAGE_KEYS.requestBudget;
  const BLOCK = { cause: 'blocked' as const, reason: 'SGW is refusing requests; automation paused', until: T0 + 6 * HOUR };
  const state = (over: Partial<RequestSchedulerState> = {}): RequestSchedulerState => ({
    version: 1,
    pause: null,
    consecutive403: 0,
    consecutive429: 0,
    lanes: {},
    ...over,
  });
  const stored = (storage: FakeStorage): RequestSchedulerState => RequestSchedulerStateSchema.parse(storage.dump()[KEY]);
  const failingGet = (): Promise<never> => Promise.reject(new Error('storage I/O error'));

  // 1. Storage read failures fail closed.
  it('a storage read failure fails closed: nothing is sent, nothing is written, the read is retried', async () => {
    const storage = new FakeStorage();
    storage.seed({ [KEY]: state({ pause: BLOCK }), [BUDGET]: { day: '2026-10-07', used: { canary: 3 } } });
    const before = storage.dump();
    const realGet = storage.get.bind(storage);
    storage.get = failingGet;

    const h = setup({ storage });
    expect(await h.sched.load()).toBe(false);
    const err = await failure(h.sched.run(req('canary')));
    expect(err.kind).toBe('paused');
    expect(err.retryAfterMs).toBe(STATE_READ_RETRY_MS);
    expect(h.sent).toHaveLength(0);
    expect(h.events).toContainEqual({ type: 'state-read-failed', error: 'storage I/O error' });
    await h.sched.flush();
    expect(storage.dump()).toEqual(before);

    // Storage recovers: the next request re-reads it, and the saved block holds.
    storage.get = realGet;
    const blocked = await failure(h.sched.run(req('canary')));
    expect(blocked.kind).toBe('paused');
    expect(blocked.retryAfterMs).toBe(6 * HOUR);
    expect(h.sched.stats().lanes.canary.usedToday).toBe(3);
    expect(h.sent).toHaveLength(0);
    await h.sched.flush();
    expect(storage.dump()).toEqual(before);
  });

  it('a pause set while storage is unreadable is saved once it can be read', async () => {
    const storage = new FakeStorage();
    const realGet = storage.get.bind(storage);
    storage.get = failingGet;
    const h = setup({ storage });
    h.sched.pause('health check failed');
    await h.sched.flush();
    expect(storage.dump()).toEqual({});

    storage.get = realGet;
    expect(await h.sched.load()).toBe(true);
    await h.sched.flush();
    expect(stored(storage).pause).toEqual({ cause: 'manual', reason: 'health check failed', until: null });
  });

  it('a failed write is reported as state-write-failed', async () => {
    const h = setup();
    await h.sched.load();
    h.storage.set = () => Promise.reject(new Error('QUOTA_BYTES quota exceeded'));
    await expect(h.sched.run(req('interactive'))).resolves.toBe('ok');
    await h.sched.flush();
    expect(h.events).toContainEqual({ type: 'state-write-failed', error: 'QUOTA_BYTES quota exceeded' });
  });

  // 2. resume() on a cold worker.
  it('resume() on a cold worker wins over the saved pause, clears it and emits `resumed`', async () => {
    const storage = new FakeStorage();
    storage.seed({
      [KEY]: state({
        pause: BLOCK,
        consecutive403: 2,
        lanes: { interactive: { gapJitterMs: 0, backoffUntil: T0 + HOUR, backoffKind: 'blocked', failures: 0 } },
      }),
    });
    const h = setup({ storage });
    h.sched.resume(); // before the saved state has been read
    expect(await h.sched.load()).toBe(true);
    expect(h.sched.stats().paused).toBeUndefined();
    expect(h.events.filter((e) => e.type === 'resumed')).toHaveLength(1);
    await h.sched.flush();
    expect(stored(storage).pause).toBeNull();
    expect(stored(storage).consecutive403).toBe(0);

    await expect(h.sched.run(req('canary'))).resolves.toBe('ok');
    // The per-lane backoff SGW asked for still holds.
    expect((await failure(h.sched.run(req('interactive')))).kind).toBe('blocked');
  });

  // 3. Two instances on one storage.
  it('a second instance adopts the first one’s pause, and its own writes keep it', async () => {
    const storage = new FakeStorage();
    const clock = new FakeClock(T0);
    const a = setup({ storage, clock });
    const b = setup({ storage, clock });
    await Promise.all([a.sched.load(), b.sched.load()]);

    b.reply({ status: 200, bodyText: 'slow', latencyMs: 5 * S });
    const inFlight = track(b.sched.run(req('interactive')));
    await flush();

    a.reply({ status: 403 });
    for (const lane of ['interactive', 'background', 'snipe'] as const) await a.sched.run(req(lane)).catch(() => undefined);
    await a.sched.flush();
    expect(stored(storage).pause).toEqual(BLOCK);

    // B follows A's write and refuses.
    expect(b.sched.stats().paused).toEqual({ reason: BLOCK.reason, until: BLOCK.until });
    expect((await failure(b.sched.run(req('canary')))).kind).toBe('paused');

    // B's in-flight request settles and B writes its state: A's pause survives.
    await b.advance(5 * S);
    expect(inFlight.value).toBe('slow');
    await b.sched.flush();
    expect(stored(storage).pause).toEqual(BLOCK);
  });

  it('its own late onChanged echoes do not undo a resume()', async () => {
    /** Delivers change events only when told to, as chrome.storage may deliver them late. */
    class LateEventsStorage extends FakeStorage {
      readonly queued: Array<() => void> = [];
      override onChanged(cb: (changes: Record<string, { oldValue?: unknown; newValue?: unknown }>) => void): () => void {
        return super.onChanged((changes) => {
          this.queued.push(() => {
            cb(changes);
          });
        });
      }
      deliver(): void {
        for (const fn of this.queued.splice(0)) fn();
      }
    }
    const storage = new LateEventsStorage();
    const h = setup({ storage });
    await h.sched.load();
    h.reply({ status: 403 });
    for (const lane of ['interactive', 'background', 'snipe'] as const) await h.sched.run(req(lane)).catch(() => undefined);
    await h.sched.flush();
    expect(stored(storage).pause).toEqual(BLOCK);

    h.sched.resume();
    await h.sched.flush();
    storage.deliver(); // the echoes of the paused snapshots arrive after the resume
    expect(h.sched.stats().paused).toBeUndefined();
    await h.sched.flush();
    expect(stored(storage).pause).toBeNull();
  });

  it('two instances add up the day’s budget instead of overwriting it', async () => {
    const storage = new FakeStorage();
    const clock = new FakeClock(T0);
    const a = setup({ storage, clock });
    const b = setup({ storage, clock });
    await Promise.all([a.sched.load(), b.sched.load()]);
    await a.sched.run(req('canary'));
    await a.advance(120 * S);
    await b.sched.run(req('canary'));
    await b.advance(120 * S);
    await a.sched.run(req('canary'));
    await Promise.all([a.sched.flush(), b.sched.flush()]);
    expect(storage.dump()[BUDGET]).toEqual({ day: '2026-10-07', used: { canary: 3 } });
    expect(a.sched.stats().lanes.canary.usedToday).toBe(3);
    expect(b.sched.stats().lanes.canary.usedToday).toBe(3);
  });

  it('a second instance respects the first one’s lane gap', async () => {
    const storage = new FakeStorage();
    const clock = new FakeClock(T0);
    const a = setup({ storage, clock });
    const b = setup({ storage, clock });
    await Promise.all([a.sched.load(), b.sched.load()]);
    await a.sched.run(req('background'));
    await a.sched.flush();
    const next = track(b.sched.run(req('background')));
    await flush();
    expect(b.sent).toHaveLength(0);
    await b.advance(120 * S - 1);
    expect(next.done).toBe(false);
    await b.advance(1);
    expect(next.value).toBe('ok');
  });

  // 4. The wall clock moving backwards.
  it('the budget day never goes backwards: spent at 00:30, clock back to 23:00 the day before → still refused', async () => {
    const h = setup({ start: new Date(2026, 9, 8, 0, 30, 0).getTime() });
    for (let i = 0; i < 4; i++) {
      await h.sched.run(req('canary'));
      await h.advance(120 * S);
    }
    await h.sched.flush();
    const spent = h.storage.dump()[BUDGET];
    expect(spent).toEqual({ day: '2026-10-08', used: { canary: 4 } });

    const back = new Date(2026, 9, 7, 23, 0, 0).getTime();
    h.clock.set(back);
    const err = await failure(h.sched.run(req('canary')));
    expect(err.kind).toBe('budget');
    expect(err.retryAfterMs).toBe(new Date(2026, 9, 9, 0, 0, 0).getTime() - back);
    expect(h.sched.stats().lanes.canary.usedToday).toBe(4);
    await h.sched.flush();
    expect(h.storage.dump()[BUDGET]).toEqual(spent);

    // Other lanes keep counting against the later day.
    await h.sched.run(req('interactive'));
    await h.sched.flush();
    expect(h.storage.dump()[BUDGET]).toEqual({ day: '2026-10-08', used: { canary: 4, interactive: 1 } });
  });

  it('a 1 h backward jump does not stall the snipe lane (live or after a restart)', async () => {
    const storage = new FakeStorage();
    const clock = new FakeClock(T0);
    const a = setup({ storage, clock });
    await a.sched.run(req('snipe'));
    await a.sched.flush();

    clock.set(T0 - HOUR);
    const live = track(a.sched.run(req('snipe')));
    await flush();
    expect(live.done).toBe(false);
    await a.advance(S);
    expect(live.value).toBe('ok');
    await a.sched.flush();
    a.sched.dispose();

    const b = setup({ storage, clock });
    const restarted = track(b.sched.run(req('snipe')));
    await flush();
    await b.advance(S);
    expect(restarted.value).toBe('ok');
  });

  // 5. Restored values are clamped.
  it('clamps restored times to the policy maximums', async () => {
    const YEAR = 365 * 24 * HOUR;
    const storage = new FakeStorage();
    storage.seed({
      [KEY]: state({
        pause: { cause: 'manual', reason: 'far future', until: T0 + YEAR },
        lanes: {
          interactive: { gapJitterMs: 0, backoffUntil: T0 + YEAR, backoffKind: 'blocked', failures: 1000 },
          background: { lastEndAt: T0 + YEAR, gapJitterMs: 999_999_999, failures: 0 },
        },
      }),
    });
    const h = setup({ storage });
    await h.sched.load();
    expect(MAX_RESTORED_WAIT_MS).toBe(24 * HOUR);
    expect(h.sched.stats().paused).toEqual({ reason: 'far future', until: T0 + 24 * HOUR });
    expect(h.sched.stats().lanes.interactive.backoffUntil).toBe(T0 + 24 * HOUR);

    h.sched.resume();
    const bg = track(h.sched.run(req('background')));
    await flush();
    await h.advance(135 * S, S);
    expect(bg.value).toBe('ok');
    expect(h.sent[0]?.at).toBeLessThanOrEqual(T0 + 135 * S);
  });

  // 6. Retry-After date forms.
  const RETRY_AFTER_CAP = 24 * HOUR; // '-70' is only 44 years ahead of 2026: 2070, capped
  it('parses Retry-After as IMF-fixdate, RFC 850 and asctime (RFC 9110 examples)', () => {
    const now = Date.UTC(1994, 10, 6, 8, 49, 0);
    for (const value of ['Sun, 06 Nov 1994 08:49:37 GMT', 'Sunday, 06-Nov-94 08:49:37 GMT', 'Sun Nov  6 08:49:37 1994']) {
      expect(parseRetryAfter({ 'Retry-After': value }, now), value).toBe(37 * S);
    }
    // A two-digit year more than 50 years ahead belongs to the previous century.
    expect(parseRetryAfter({ 'retry-after': 'Saturday, 01-Jan-94 00:00:00 GMT' }, Date.UTC(2026, 0, 1))).toBe(0);
    expect(parseRetryAfter({ 'retry-after': 'Monday, 01-Jan-70 00:00:00 GMT' }, Date.UTC(2026, 0, 1))).toBe(RETRY_AFTER_CAP);
    expect(parseRetryAfter({ 'retry-after': 'Friday, 01-Jan-27 00:00:00 GMT' }, Date.UTC(2026, 11, 31, 23, 59, 0))).toBe(60 * S);
    expect(parseRetryAfter({ 'retry-after': 'Sun Nov 6 08:49:37 1994' }, now)).toBeUndefined();
  });

  // 7. 401s.
  it('a 401 refuses the requests queued on its lane with `auth` instead of sending each', async () => {
    const h = setup();
    h.reply({ status: 401 }, { status: 200, bodyText: 'ok' });
    const all = Array.from({ length: 3 }, () => track(h.sched.run(req('interactive'))));
    await flush();
    await h.advance(5 * S, S);
    expect(h.sent).toHaveLength(1);
    expect(all.map((t) => (t.error as SgwApiError).kind)).toEqual(['auth', 'auth', 'auth']);
    expect(all.map((t) => (t.error as SgwApiError).status)).toEqual([401, 401, 401]);
    await expect(h.sched.run(req('interactive'))).resolves.toBe('ok');
  });

  // 8. budget-exhausted on every crossing.
  it('emits budget-exhausted when switching to tight crosses the budget mid-day', async () => {
    const h = setup();
    for (let i = 0; i < 3; i++) {
      await h.sched.run(req('canary'));
      await h.advance(120 * S);
    }
    const exhausted = (): SchedulerEvent[] => h.events.filter((e) => e.type === 'budget-exhausted');
    expect(exhausted()).toHaveLength(0);

    h.sched.setConsiderateMode('tight');
    expect(exhausted()).toEqual([{ type: 'budget-exhausted', lane: 'canary', day: '2026-10-07', budget: 2 }]);
    h.sched.setConsiderateMode('normal');
    expect(exhausted()).toHaveLength(1);
    await h.sched.run(req('canary'));
    expect(exhausted()).toEqual([
      { type: 'budget-exhausted', lane: 'canary', day: '2026-10-07', budget: 2 },
      { type: 'budget-exhausted', lane: 'canary', day: '2026-10-07', budget: 4 },
    ]);
  });
});

// T-36 R5 (carried from T-25 review): a storage read that never settles must
// fail closed instead of hanging every lane, and dispose() must settle the queue.
describe('RequestScheduler: T-36 hardening (read timeout, dispose)', () => {
  const never = (): Promise<never> => new Promise<never>(() => undefined);

  it('a storage get() that never settles fails closed after STATE_READ_TIMEOUT_MS: run() refuses `paused`, nothing is sent', async () => {
    const storage = new FakeStorage();
    const realGet = storage.get.bind(storage);
    storage.get = never;
    const h = setup({ storage });

    const loaded = track(h.sched.load());
    const snipe = track(h.sched.run(req('snipe')));
    await flush();
    expect(loaded.done).toBe(false);
    expect(snipe.done).toBe(false);

    await h.advance(STATE_READ_TIMEOUT_MS - 1);
    expect(snipe.done).toBe(false);
    await h.advance(1);
    expect(loaded.value).toBe(false);
    expect(snipe.error).toBeInstanceOf(SgwApiError);
    expect((snipe.error as SgwApiError).kind).toBe('paused');
    expect((snipe.error as SgwApiError).retryAfterMs).toBe(STATE_READ_RETRY_MS);
    expect(h.sent).toHaveLength(0);
    expect(h.events).toContainEqual({
      type: 'state-read-failed',
      error: `storage did not answer within ${String(STATE_READ_TIMEOUT_MS)} ms`,
    });

    // Storage recovers: the next request re-reads it and goes out.
    storage.get = realGet;
    await expect(h.sched.run(req('snipe'))).resolves.toBe('ok');
    expect(h.sent).toHaveLength(1);
  });

  it('a read that answers in time leaves no timer behind', async () => {
    const h = setup();
    expect(await h.sched.load()).toBe(true);
    expect(h.clock.pendingTimers).toBe(0);
  });

  it('dispose() rejects every queued request with `paused` and refuses new ones; the in-flight one still settles', async () => {
    const h = setup();
    await h.sched.load();
    h.reply({ status: 200, bodyText: 'ok', latencyMs: 500 });
    const first = track(h.sched.run(req('background')));
    const queued = [track(h.sched.run(req('background'))), track(h.sched.run(req('background')))];
    await flush();
    expect(h.sent).toHaveLength(1);

    h.sched.dispose();
    await flush();
    for (const q of queued) {
      expect(q.error).toBeInstanceOf(SgwApiError);
      expect((q.error as SgwApiError).kind).toBe('paused');
    }
    const late = await failure(h.sched.run(req('interactive')));
    expect(late.kind).toBe('paused');

    await h.advance(500);
    expect(first.value).toBe('ok');
    await h.advance(10 * MIN, MIN);
    expect(h.sent).toHaveLength(1);
    expect(h.clock.pendingTimers).toBe(0);
  });
});
