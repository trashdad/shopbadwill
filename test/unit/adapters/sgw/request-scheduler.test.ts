// T-25: RequestScheduler (PLAN §3.4, §9). Everything runs on FakeClock: no
// real timers and no wall-clock reads. `flush()` only drains pending promise
// callbacks; time moves only through `advance()`.
import { describe, expect, it } from 'vitest';

import {
  BACKOFF_CAP_MS,
  BLOCK_PAUSE_MS,
  BLOCKED_BACKOFF_MS,
  PAUSE_NOTIFICATION_ID,
  SgwRequestScheduler,
  localDay,
  type SchedulerEvent,
} from '../../../../src/adapters/sgw/request-scheduler';
import { RequestBudgetSchema, STORAGE_KEYS } from '../../../../src/domain/storage/schema';
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
  stateKey?: string;
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
    ...(opts.stateKey === undefined ? {} : { stateKey: opts.stateKey }),
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
    expect(h.sched.pauseState()).toEqual({ cause: 'blocked', reason: 'SGW is refusing requests; automation paused', until });
    expect(h.notifier.sent).toHaveLength(1);
    expect(h.notifier.sent[0]?.id).toBe(PAUSE_NOTIFICATION_ID);
    expect(h.notifier.sent[0]?.notification).toMatchObject({ id: PAUSE_NOTIFICATION_ID, message: 'SGW is refusing requests; automation paused' });

    h.reply({ status: 200, bodyText: 'ok' });
    for (const lane of LANES) {
      const err = await failure(h.sched.run(req(lane)));
      expect(err.kind).toBe('paused');
      expect(err.retryAfterMs).toBe(6 * HOUR);
      expect(h.sched.stats().lanes[lane].backoffUntil).toBe(until);
      expect(h.sched.stats().lanes[lane].nextAllowedAt).toBeGreaterThanOrEqual(until);
    }
    expect(h.sent).toHaveLength(3);

    await h.advance(6 * HOUR - 1);
    expect((await failure(h.sched.run(req('canary')))).kind).toBe('paused');
    await h.advance(1);
    await expect(h.sched.run(req('canary'))).resolves.toBe('ok');
    expect(h.sched.pauseState()).toBeNull();
    expect(h.notifier.sent).toHaveLength(1);
  });

  it('any other response breaks a 403 streak', async () => {
    const h = setup();
    h.reply({ status: 403 }, { status: 403 }, { status: 404 }, { status: 403 });
    for (const lane of ['interactive', 'background', 'snipe', 'canary'] as const) {
      await h.sched.run(req(lane)).catch(() => undefined);
    }
    expect(h.sent).toHaveLength(4);
    expect(h.sched.pauseState()).toBeNull();
    expect(h.notifier.sent).toHaveLength(0);
  });

  it('three 429s in a row pause all lanes until the backoff ends', async () => {
    const h = setup();
    h.reply({ status: 429 });
    for (const lane of ['interactive', 'background', 'snipe'] as const) {
      expect((await failure(h.sched.run(req(lane)))).kind).toBe('rate-limited');
    }
    const until = T0 + 30 * S;
    expect(h.sched.pauseState()).toMatchObject({ cause: 'rate-limited', until });
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
    expect(h.sched.pauseState()).toEqual({ cause: 'manual', reason: 'health check failed', until: null });

    await h.advance(10 * HOUR, HOUR);
    expect((await failure(h.sched.run(req('interactive')))).kind).toBe('paused');

    h.sched.resume();
    expect(h.sched.pauseState()).toBeNull();
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
    expect(h.sched.stats().lanes.interactive.backoffUntil).toBe(T0 + MIN);
    await h.advance(MIN);
    await expect(h.sched.run(req('interactive'))).resolves.toBe('ok');
  });

  it('a shorter pause never shortens a longer one', async () => {
    const h = setup();
    h.sched.pause('blocked for a while', T0 + HOUR);
    h.sched.pause('brief', T0 + MIN);
    await h.advance(MIN);
    expect(h.sched.pauseState()).toMatchObject({ reason: 'blocked for a while', until: T0 + HOUR });
    h.sched.pause('until resumed');
    h.sched.pause('brief again', T0 + 2 * HOUR);
    expect(h.sched.pauseState()).toMatchObject({ reason: 'until resumed', until: null });
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
    expect(h.sched.pauseState()?.cause).toBe('blocked');
  });
});

// ── Opt-in state persistence (service-worker restarts) ───────────────────────

describe('RequestScheduler: state persistence (stateKey)', () => {
  const stateKey = 'sbw:requestSchedulerState';

  it('a restarted scheduler honours a 6 h block pause and lane backoffs', async () => {
    const storage = new FakeStorage();
    const clock = new FakeClock(T0);
    const a = setup({ storage, clock, stateKey });
    a.reply({ status: 403 });
    for (const lane of ['interactive', 'background', 'snipe'] as const) await a.sched.run(req(lane)).catch(() => undefined);
    await a.sched.flush();

    clock.advance(10 * MIN);
    const b = setup({ storage, clock, stateKey });
    const err = await failure(b.sched.run(req('canary')));
    expect(err.kind).toBe('paused');
    expect(b.sched.pauseState()).toMatchObject({ cause: 'blocked', until: T0 + 6 * HOUR });
    expect(b.sched.stats().lanes.background.backoffUntil).toBe(T0 + 6 * HOUR);
    expect(b.sent).toHaveLength(0);
    expect(b.notifier.sent).toHaveLength(0);

    b.sched.resume();
    expect((await failure(b.sched.run(req('background')))).kind).toBe('blocked');
    expect(b.sent).toHaveLength(0);
  });

  it('a restarted scheduler keeps the background gap', async () => {
    const storage = new FakeStorage();
    const clock = new FakeClock(T0);
    const a = setup({ storage, clock, stateKey });
    await a.sched.run(req('background'));
    await a.sched.flush();

    clock.advance(10 * S);
    const b = setup({ storage, clock, stateKey });
    const next = track(b.sched.run(req('background')));
    await flush();
    expect(b.sent).toHaveLength(0);
    await b.advance(110 * S - 1);
    expect(next.done).toBe(false);
    await b.advance(1);
    expect(next.value).toBe('ok');
  });

  it('ignores an invalid saved state', async () => {
    const storage = new FakeStorage();
    storage.seed({ [stateKey]: { pause: 'yes', lanes: 7 } });
    const h = setup({ storage, stateKey });
    await expect(h.sched.run(req('interactive'))).resolves.toBe('ok');
  });

  it('without a stateKey, only sbw:requestBudget is written', async () => {
    const h = setup();
    h.reply({ status: 403 });
    for (const lane of ['interactive', 'background', 'snipe'] as const) await h.sched.run(req(lane)).catch(() => undefined);
    await h.sched.flush();
    expect(Object.keys(h.storage.dump())).toEqual([STORAGE_KEYS.requestBudget]);
  });
});
