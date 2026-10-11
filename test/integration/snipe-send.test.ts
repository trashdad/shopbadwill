// T-101: the idempotent SendStrategy (src/background/jobs/snipe-send.ts),
// PLAN §3.9 and the T-101 rulings R0–R7. The strategy is tested directly over
// a scripted SgwApi: no network, no browser, a FakeClock for the observedAt.
//
// The money rules under test:
// - R1: a BidNotSentError (provably never left) retries ONCE with the same
//   amount and the same idempotencyKey, only with at least 1.5 s left
//   (MIN_TIME_LEFT_TO_SEND_MS). Otherwise: not-sent.
// - R2: an ambiguous failure (timeout, network, 5xx, unreadable reply) makes
//   ONE proof read on lane 'snipe'. Our bid present → result accepted, never a
//   resend. Nothing changed with at least 2 s left → one resend, same amount,
//   same key. Under 2 s, or a failed/inconclusive read → ambiguous, no resend.
// - R3: once a request of the attempt MAY have left, the strategy never
//   returns not-sent for that attempt, even when a later retry throws
//   BidNotSentError.
// - R4: at most two wire sends per attempt; the second only after a
//   BidNotSentError or a no-change proof read; every send carries exactly
//   snipe.maxBid and the same key (the property below).
// - R6: a resolved reply (including 'rejected-unknown') is a result, never a
//   reason to resend.
import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';

import { BidNotSentError } from '../../src/adapters/sgw/bid';
import type { BackgroundContext, BackgroundModule, RuntimePort } from '../../src/background/context';
import { HANDLER_MODULES } from '../../src/background/handlers/index';
import { JOB_MODULES } from '../../src/background/jobs/index';
import { IDEMPOTENT_SEND_STRATEGY, PROOF_RESEND_MIN_TIME_LEFT_MS, register } from '../../src/background/jobs/snipe-send';
import {
  DEFAULT_SEND_STRATEGY,
  MIN_TIME_LEFT_TO_SEND_MS,
  snipeSeams,
  type SendOutcome,
  type SendRequest,
  type SendStrategy,
} from '../../src/background/jobs/snipe-runner';
import { SgwApiAdapter } from '../../src/adapters/sgw/api-adapter';
import { SgwClockAdapter } from '../../src/adapters/sgw/clock-adapter';
import { SGW_API_BASE } from '../../src/adapters/sgw/config';
import { SgwRequestScheduler } from '../../src/adapters/sgw/request-scheduler';
import { startBackground, type BackgroundBrowser, type BackgroundHandle } from '../../src/background/main';
import { defaultSettings } from '../../src/domain/settings/defaults';
import type { Snipe } from '../../src/domain/snipe/types';
import { STORAGE_KEYS } from '../../src/domain/storage/schema';
import { BidResultSchema, type Cents, type ItemDetail, type Lane, type LaneConfig } from '../../src/domain/types';
import { HttpNetworkError, HttpTimeoutError, SgwApiError } from '../../src/ports/errors';
import type { KeepAlive } from '../../src/ports/keep-alive';
import type { SgwApi } from '../../src/ports/sgw-api';
import { loadFixture } from '../contract/sgw/fixtures';
import { FakeAlarms } from '../fakes/ports/fake-alarms';
import { FakeAuditLog } from '../fakes/ports/fake-audit-log';
import { FakeClock } from '../fakes/ports/fake-clock';
import { FakeHttp } from '../fakes/ports/fake-http';
import { FakeKeepAwake } from '../fakes/ports/fake-keepawake';
import { FakeNotifier } from '../fakes/ports/fake-notifier';
import { FakePermissions } from '../fakes/ports/fake-permissions';
import { FakeStorage, FakeStorageAreas } from '../fakes/ports/fake-storage';
import { FakeSwitches } from '../fakes/ports/fake-switches';

// ── Constants ────────────────────────────────────────────────────────────────

const SEC = 1000;
const MIN = 60 * SEC;
const DAY = 24 * 60 * MIN;
const T0 = Date.UTC(2026, 9, 10, 15, 0, 0);
/** The auction end (the snipe's endTime). */
const END = T0 + 2 * 60 * MIN;
const ITEM = 702801256;
const SELLER = 955353;
const MAX = 2000;
const KEY = 's1:test-key';

const NO_BID_CLAIM = /no bid was placed|not bid|no bid sent|no bid was sent/i;

/** A valid sent snipe for the strategy request. */
function sentSnipe(over: Partial<Snipe> = {}): Snipe {
  return {
    id: 's1',
    itemId: ITEM,
    title: 'Pyrex bowl',
    endTime: new Date(END).toISOString(),
    endTimeAtArm: new Date(END).toISOString(),
    maxBid: MAX,
    leadMs: 8000,
    fallback: 'early-proxy',
    dryRun: false,
    state: 'sent',
    armedAt: T0,
    attempt: { sentAt: T0 + 1, idempotencyKey: KEY },
    history: [
      { at: T0, from: 'firing', to: 'sent', why: 'sent' },
    ],
    ...over,
  };
}

function makeRequest(over: Partial<SendRequest> = {}): SendRequest {
  return {
    snipe: sentSnipe(),
    kind: 'placeBid',
    amount: MAX,
    sellerId: SELLER,
    idempotencyKey: KEY,
    timeoutMs: 20_000,
    ...over,
  };
}

/** A valid open ItemDetail, tuned by the proof script. */
function makeDetail(over: Partial<ItemDetail> = {}): ItemDetail {
  return {
    itemId: ITEM,
    title: 'Pyrex bowl',
    currentPrice: 1000,
    startingMinimumBid: 1000,
    numBids: 0,
    endTime: new Date(END).toISOString(),
    endTimeRaw: '2026-10-10T10:00:00',
    sellerId: SELLER,
    sellerName: 'Goodwill of the Olympics',
    sellerState: 'WA',
    categoryId: 1,
    categoryPath: 'Home > Glass',
    shippingPrice: null,
    pickupOnly: false,
    buyNowPrice: null,
    isFavorite: false,
    relistId: null,
    source: 'api',
    observedAt: T0,
    minimumBid: 1100,
    bidIncrement: 100,
    serverTime: new Date(T0).toISOString(),
    serverTimeRaw: '2026-10-10T08:00:00',
    isClosed: false,
    isHighBidder: false,
    inWatchlist: false,
    bidHistory: [],
    ...over,
  };
}

// ── The scripted SgwApi ──────────────────────────────────────────────────────

type PlaceKind = 'ok' | 'not-sent' | 'ambiguous' | 'paused';
type ProofKind = 'present' | 'no-change' | 'inconclusive' | 'fails' | 'history';

interface WireSend {
  amount: Cents;
  key: string;
  timeoutMs: number;
  quantity: number;
  itemId: number;
  sellerId: number;
}

interface Script {
  /** The placeBid outcomes, in call order; 'ok' also fills in afterwards. */
  place: PlaceKind[];
  proof: ProofKind;
}

const REJECTED_UNKNOWN = {
  kind: 'rejected-unknown' as const,
  rawStatus: null,
  rawResult: 7,
  messageText: 'unrecognised reply',
  isHighBidder: null,
  observedAt: T0,
};

function scriptedApi(
  script: Script,
  log: string[],
  sends: WireSend[],
  clock: FakeClock,
  proofOpts: Array<{ maxAgeMs?: number } | undefined> = [],
): SgwApi {
  const api = {
    itemDetail(itemId: number, lane: string, opts?: { maxAgeMs?: number }): Promise<ItemDetail> {
      log.push('itemDetail');
      proofOpts.push(opts);
      expect(itemId).toBe(ITEM);
      expect(lane).toBe('snipe');
      if (script.proof === 'fails') return Promise.reject(new HttpNetworkError('SGW unreachable'));
      const detail =
        script.proof === 'present'
          ? makeDetail({ isHighBidder: true, numBids: 1 })
          : script.proof === 'no-change'
            ? makeDetail({ isHighBidder: false, numBids: 0 })
            : script.proof === 'history'
              ? makeDetail({
                  isHighBidder: false,
                  numBids: 0,
                  bidHistory: [
                    { amount: 1000, time: new Date(T0).toISOString(), timeRaw: '2026-10-10T08:00:00', bidderMasked: 'b****r' },
                  ],
                })
              : makeDetail({ isHighBidder: false, numBids: 3 });
      return Promise.resolve(detail);
    },
    placeBid(
      req: { itemId: number; sellerId: number; bidAmount: Cents; quantity: 1 },
      opts: { idempotencyKey: string; timeoutMs: number },
    ): ReturnType<SgwApi['placeBid']> {
      log.push('placeBid');
      sends.push({ amount: req.bidAmount, key: opts.idempotencyKey, timeoutMs: opts.timeoutMs, quantity: req.quantity, itemId: req.itemId, sellerId: req.sellerId });
      const next = script.place.shift() ?? 'ok';
      if (next === 'not-sent') return Promise.reject(new BidNotSentError('network', 'placeBid: nothing was sent'));
      if (next === 'paused') return Promise.reject(new SgwApiError('paused', 'kill switch is on'));
      if (next === 'ambiguous') return Promise.reject(new HttpTimeoutError(20_000));
      return Promise.resolve({ ...REJECTED_UNKNOWN, observedAt: clock.now() });
    },
  };
  return api as unknown as SgwApi;
}

function makeDeps(api: SgwApi, clock: FakeClock, serverNow: () => number): { api: SgwApi; clock: FakeClock; serverNow: () => number } {
  return { api, clock, serverNow };
}

// ── The R5 harness: the real background over fakes ───────────────────────────

interface Shared {
  clock: FakeClock;
  areas: FakeStorageAreas;
  alarms: FakeAlarms;
  http: FakeHttp;
  notifier: FakeNotifier;
  keepAwake: FakeKeepAwake;
  permissions: FakePermissions;
}

const EXT_ID = 'test-extension-id';
const EXT_ORIGIN = `chrome-extension://${EXT_ID}/`;
const META = { schemaVersion: 1, installedAt: T0 - DAY, lastMigrationAt: T0 - DAY };

function makeShared(opts: { snipes?: Record<string, Snipe> } = {}): Shared {
  const clock = new FakeClock(T0);
  const areas = new FakeStorageAreas();
  areas.local.seed({
    [STORAGE_KEYS.meta]: META,
    [STORAGE_KEYS.settings]: defaultSettings(),
    ...(opts.snipes === undefined ? {} : { [STORAGE_KEYS.snipes]: opts.snipes }),
  });
  return {
    clock,
    areas,
    alarms: new FakeAlarms(clock),
    http: new FakeHttp(clock),
    notifier: new FakeNotifier(),
    keepAwake: new FakeKeepAwake({ available: true }),
    permissions: new FakePermissions(),
  };
}

function stored(shared: Shared, id: string): Snipe {
  const all = shared.areas.local.dump()[STORAGE_KEYS.snipes] as Record<string, Snipe> | undefined;
  const s = all?.[id];
  if (s === undefined) throw new Error(`no stored snipe ${id}`);
  return s;
}

interface FakeEvent<L extends (...args: never[]) => unknown> {
  readonly listeners: L[];
  addListener(l: L): void;
  removeListener(l: L): void;
}
function fakeEvent<L extends (...args: never[]) => unknown>(): FakeEvent<L> {
  const listeners: L[] = [];
  return {
    listeners,
    addListener: (l) => {
      listeners.push(l);
    },
    removeListener: (l) => {
      const i = listeners.indexOf(l);
      if (i >= 0) listeners.splice(i, 1);
    },
  };
}
type MessageListener = (raw: unknown, sender: { id: string; url: string }, sendResponse: (r: unknown) => void) => boolean | undefined;

class LightWorker {
  readonly onMessage = fakeEvent<MessageListener>();
  readonly onConnect = fakeEvent<(port: RuntimePort) => void>();
  readonly onCommand = fakeEvent<(command: string) => void>();
  readonly handle: BackgroundHandle;
  readonly ready: Promise<BackgroundContext>;

  constructor(shared: Shared, jobModules?: Record<string, BackgroundModule>) {
    const keepAlive: KeepAlive = { start: () => undefined, stop: () => undefined };
    const browser = {
      runtime: {
        id: EXT_ID,
        getURL: (p: string) => EXT_ORIGIN + p.replace(/^\//, ''),
        sendMessage: () => Promise.reject(new Error('Receiving end does not exist.')),
        onMessage: this.onMessage,
        onConnect: this.onConnect,
        onStartup: fakeEvent<() => void>(),
        onInstalled: fakeEvent<(d: { reason: string; previousVersion?: string }) => void>(),
      },
      commands: { onCommand: this.onCommand },
      tabs: { query: () => Promise.resolve([]), sendMessage: () => Promise.resolve(undefined) },
      storage: fakeBrowser.storage,
      alarms: fakeBrowser.alarms,
    } satisfies BackgroundBrowser;
    this.handle = startBackground({
      browser,
      ports: {
        clock: shared.clock,
        storage: shared.areas,
        http: shared.http,
        alarms: shared.alarms,
        notifier: shared.notifier,
        permissions: shared.permissions,
        keepAwake: shared.keepAwake,
        keepAlive,
        random: () => 0,
      },
      log: () => undefined,
      handlerModules: HANDLER_MODULES,
      jobModules: jobModules ?? JOB_MODULES,
    });
    this.ready = this.handle.ready;
  }
}

const flush = async (rounds = 3): Promise<void> => {
  for (let i = 0; i < rounds; i++) {
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }
};

async function waitUntil(cond: () => boolean | Promise<boolean>, rounds = 400): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    if (await cond()) return;
    await flush(1);
  }
  throw new Error('waitUntil: the condition was not reached');
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

// ── T-101 brief: tests first ─────────────────────────────────────────────────

describe('T-101 brief', () => {
  it('a timeout followed by a proof read showing our bid present → accepted, no resend', async () => {
    const clock = new FakeClock(T0);
    const log: string[] = [];
    const sends: WireSend[] = [];
    const api = scriptedApi({ place: ['ambiguous'], proof: 'present' }, log, sends, clock);
    const deps = makeDeps(api, clock, () => END - 5 * SEC);

    const outcome = await IDEMPOTENT_SEND_STRATEGY.send(makeRequest(), deps);

    expect(outcome).toMatchObject({ kind: 'result', result: { kind: 'accepted', isHighBidder: true } });
    expect(BidResultSchema.safeParse(outcome.kind === 'result' ? outcome.result : null).success).toBe(true);
    // No resend: exactly one wire send and one proof read.
    expect(sends).toHaveLength(1);
    expect(log.filter((x) => x === 'placeBid')).toHaveLength(1);
    expect(log.filter((x) => x === 'itemDetail')).toHaveLength(1);
  });

  it('a proof read showing nothing changed with 2 s left → one resend, same amount, same key', async () => {
    const clock = new FakeClock(T0);
    const log: string[] = [];
    const sends: WireSend[] = [];
    const proofOpts: Array<{ maxAgeMs?: number } | undefined> = [];
    const api = scriptedApi({ place: ['ambiguous', 'ok'], proof: 'no-change' }, log, sends, clock, proofOpts);
    const deps = makeDeps(api, clock, () => END - PROOF_RESEND_MIN_TIME_LEFT_MS);

    const outcome = await IDEMPOTENT_SEND_STRATEGY.send(makeRequest(), deps);

    expect(outcome.kind).toBe('result');
    expect(sends).toHaveLength(2);
    // Both sends carry exactly the max and the same idempotency key.
    expect(sends[0]).toEqual(sends[1]);
    expect(sends[0]).toMatchObject({ amount: MAX, key: KEY, itemId: ITEM, sellerId: SELLER, quantity: 1 });
    // The second wire send came only after the proof read.
    expect(log.indexOf('itemDetail')).toBeGreaterThan(-1);
    expect(log.indexOf('itemDetail')).toBeLessThan(log.lastIndexOf('placeBid'));
    // Fresh: the caller forbids a cached detail. Lane snipe is asserted in the script.
    expect(proofOpts).toEqual([{ maxAgeMs: 0 }]);
  });

  it('with 1 s left → no resend, ambiguous (the runner resolves it as network / Unconfirmed)', async () => {
    const clock = new FakeClock(T0);
    const log: string[] = [];
    const sends: WireSend[] = [];
    const api = scriptedApi({ place: ['ambiguous', 'ok'], proof: 'no-change' }, log, sends, clock);
    const deps = makeDeps(api, clock, () => END - 1 * SEC);

    const outcome = await IDEMPOTENT_SEND_STRATEGY.send(makeRequest(), deps);

    expect(outcome.kind).toBe('ambiguous');
    expect(sends).toHaveLength(1);
    expect(log.filter((x) => x === 'itemDetail')).toHaveLength(1);
  });

  it('worker death between persist and send: the restart never resends (the runner resolves `sent` as ambiguous without calling the strategy)', async () => {
    // The on-disk state of a worker that died right after `sent {key}` was
    // persisted and before any request left: sent, its key stored, no reply,
    // the money effect consumed (nothing in the outbox).
    const died: Snipe = sentSnipe({
      attempt: { sentAt: T0 - MIN, idempotencyKey: KEY },
      history: [
        { at: T0 - 2 * MIN, from: 'draft', to: 'armed', why: 'arm' },
        { at: T0 - MIN, from: 'firing', to: 'sent', why: 'sent' },
      ],
    });
    const shared = makeShared({ snipes: { s1: died } });
    const strategyCalls: number[] = [];
    const probe: BackgroundModule = {
      register: (ctx) => {
        snipeSeams(ctx).setSendStrategy({
          send: async (req, deps) => {
            strategyCalls.push(1);
            return DEFAULT_SEND_STRATEGY.send(req, deps);
          },
        });
      },
    };
    const w = new LightWorker(shared, { ...JOB_MODULES, './zz-probe.ts': probe });
    await w.ready;
    await waitUntil(() => stored(shared, 's1').attempt.ambiguous === true);

    // The restart path settles through the runner's own ambiguous/post-read
    // route: the strategy is never called, and nothing ever hits the wire.
    expect(strategyCalls).toEqual([]);
    expect(shared.http.requests.filter((r) => r.url.includes('ItemBid'))).toEqual([]);
    const s = stored(shared, 's1');
    expect(s.state).toBe('sent');
    expect(s.attempt.ambiguous).toBe(true);
    expect(s.attempt.notSent).not.toBe(true);
    expect(shared.notifier.sent.some((n) => NO_BID_CLAIM.test(n.notification.message))).toBe(false);
  });
});

// ── Rulings R1, R2, R3, R6 ───────────────────────────────────────────────────

describe('T-101 rulings', () => {
  it('R1: a BidNotSentError with at least 1.5 s left retries once with the same amount and key, and needs no proof read', async () => {
    const clock = new FakeClock(T0);
    const log: string[] = [];
    const sends: WireSend[] = [];
    const api = scriptedApi({ place: ['not-sent', 'ok'], proof: 'fails' }, log, sends, clock);
    const deps = makeDeps(api, clock, () => END - MIN_TIME_LEFT_TO_SEND_MS);

    const outcome = await IDEMPOTENT_SEND_STRATEGY.send(makeRequest(), deps);

    expect(outcome.kind).toBe('result');
    expect(sends).toHaveLength(2);
    expect(sends[0]).toEqual(sends[1]);
    expect(sends[0]).toMatchObject({ amount: MAX, key: KEY });
    expect(log.filter((x) => x === 'itemDetail')).toHaveLength(0);
  });

  it('R1: under 1.5 s left a BidNotSentError is not retried → not-sent', async () => {
    const clock = new FakeClock(T0);
    const log: string[] = [];
    const sends: WireSend[] = [];
    const api = scriptedApi({ place: ['not-sent', 'ok'], proof: 'fails' }, log, sends, clock);
    const deps = makeDeps(api, clock, () => END - (MIN_TIME_LEFT_TO_SEND_MS - 1));

    const outcome = await IDEMPOTENT_SEND_STRATEGY.send(makeRequest(), deps);

    expect(outcome.kind).toBe('not-sent');
    expect(sends).toHaveLength(1);
  });

  it('R1: two BidNotSentErrors → not-sent (nothing ever left)', async () => {
    const clock = new FakeClock(T0);
    const log: string[] = [];
    const sends: WireSend[] = [];
    const api = scriptedApi({ place: ['not-sent', 'not-sent'], proof: 'fails' }, log, sends, clock);
    const deps = makeDeps(api, clock, () => END - 5 * SEC);

    const outcome = await IDEMPOTENT_SEND_STRATEGY.send(makeRequest(), deps);

    expect(outcome.kind).toBe('not-sent');
    expect(sends).toHaveLength(2);
    expect(log.filter((x) => x === 'itemDetail')).toHaveLength(0);
  });

  it('R1: a write-gate `paused` is also provably never sent, so it retries once', async () => {
    const clock = new FakeClock(T0);
    const log: string[] = [];
    const sends: WireSend[] = [];
    // A plain paused: bidMayHaveBeenSent is false for it too (bid.ts contract).
    const api = scriptedApi({ place: ['paused', 'ok'], proof: 'fails' }, log, sends, clock);
    const deps = makeDeps(api, clock, () => END - 5 * SEC);

    const outcome = await IDEMPOTENT_SEND_STRATEGY.send(makeRequest(), deps);

    expect(outcome.kind).toBe('result');
    expect(sends).toHaveLength(2);
    expect(sends[0]).toEqual(sends[1]);
    expect(log.filter((x) => x === 'itemDetail')).toHaveLength(0);
  });

  it('R2: a failed proof read → ambiguous, no resend, never not-sent', async () => {
    const clock = new FakeClock(T0);
    const log: string[] = [];
    const sends: WireSend[] = [];
    const api = scriptedApi({ place: ['ambiguous', 'ok'], proof: 'fails' }, log, sends, clock);
    const deps = makeDeps(api, clock, () => END - 10 * SEC);

    const outcome = await IDEMPOTENT_SEND_STRATEGY.send(makeRequest(), deps);

    expect(outcome.kind).toBe('ambiguous');
    expect(sends).toHaveLength(1);
    expect(log.filter((x) => x === 'itemDetail')).toHaveLength(1);
  });

  it('R2: an inconclusive proof read (bids exist, not the high bidder) → ambiguous, no resend', async () => {
    const clock = new FakeClock(T0);
    const sends: WireSend[] = [];
    const api = scriptedApi({ place: ['ambiguous', 'ok'], proof: 'inconclusive' }, [], sends, clock);
    const deps = makeDeps(api, clock, () => END - 10 * SEC);

    const outcome = await IDEMPOTENT_SEND_STRATEGY.send(makeRequest(), deps);

    expect(outcome.kind).toBe('ambiguous');
    expect(sends).toHaveLength(1);
  });

  it('R3: ambiguous → proof read shows nothing changed → the resend throws BidNotSentError → ambiguous, never not-sent', async () => {
    const clock = new FakeClock(T0);
    const log: string[] = [];
    const sends: WireSend[] = [];
    const api = scriptedApi({ place: ['ambiguous', 'not-sent'], proof: 'no-change' }, log, sends, clock);
    const deps = makeDeps(api, clock, () => END - 5 * SEC);

    const outcome = await IDEMPOTENT_SEND_STRATEGY.send(makeRequest(), deps);

    expect(outcome.kind).toBe('ambiguous');
    expect(sends).toHaveLength(2);
  });

  it('R6: a resolved `rejected-unknown` reply is a result: never resent, no proof read', async () => {
    const clock = new FakeClock(T0);
    const log: string[] = [];
    const sends: WireSend[] = [];
    const api = scriptedApi({ place: ['ok'], proof: 'fails' }, log, sends, clock);
    const deps = makeDeps(api, clock, () => END - 10 * SEC);

    const outcome = await IDEMPOTENT_SEND_STRATEGY.send(makeRequest(), deps);

    expect(outcome).toMatchObject({ kind: 'result', result: { kind: 'rejected-unknown' } });
    expect(sends).toHaveLength(1);
    expect(log.filter((x) => x === 'itemDetail')).toHaveLength(0);
  });

  it('the early proxy kind gets the same idempotent guarantees', async () => {
    const clock = new FakeClock(T0);
    const sends: WireSend[] = [];
    const api = scriptedApi({ place: ['not-sent', 'ok'], proof: 'fails' }, [], sends, clock);
    const deps = makeDeps(api, clock, () => END - 5 * SEC);

    const outcome = await IDEMPOTENT_SEND_STRATEGY.send(makeRequest({ kind: 'applyFallbackProxy' }), deps);

    expect(outcome.kind).toBe('result');
    expect(sends).toHaveLength(2);
    expect(sends[0]).toEqual(sends[1]);
  });

  it('R0: the module registers itself through the jobs glob', () => {
    expect(Object.keys(JOB_MODULES)).toContain('./snipe-send.ts');
  });

  it('R0: register(ctx) installs this strategy on the runner seams', () => {
    const ctx = {} as BackgroundContext;
    const seams = snipeSeams(ctx);
    let installed: SendStrategy | undefined;
    const real = seams.setSendStrategy.bind(seams);
    seams.setSendStrategy = (s) => {
      installed = s;
      real(s);
    };
    register(ctx);
    expect(installed).toBe(IDEMPOTENT_SEND_STRATEGY);
  });

  it('refuses the send when amount is not snipe.maxBid: nothing is placed', async () => {
    const clock = new FakeClock(T0);
    const sends: WireSend[] = [];
    const api = scriptedApi({ place: ['ok'], proof: 'fails' }, [], sends, clock);
    const deps = makeDeps(api, clock, () => END - 10 * SEC);

    const outcome = await IDEMPOTENT_SEND_STRATEGY.send(makeRequest({ amount: MAX + 50 }), deps);

    expect(outcome.kind).toBe('not-sent');
    expect(sends).toHaveLength(0);
  });

  it('R1: the 1.5 s check reads serverNow() after the first send returns, not a value captured before it', async () => {
    const clock = new FakeClock(END - 10 * SEC); // local clock still has 10 s; the decision must not use it
    let left = 10 * SEC;
    let calls = 0;
    const api = {
      itemDetail: () => Promise.reject(new Error('a provably unsent bid has no proof read')),
      placeBid: () => {
        calls += 1;
        // The first attempt is over. Server time has moved inside the 1.5 s floor.
        left = MIN_TIME_LEFT_TO_SEND_MS - 1;
        return Promise.reject(new BidNotSentError('network', 'placeBid: nothing was sent'));
      },
    } as unknown as SgwApi;

    const outcome = await IDEMPOTENT_SEND_STRATEGY.send(makeRequest(), makeDeps(api, clock, () => END - left));

    expect(outcome.kind).toBe('not-sent');
    expect(calls).toBe(1);
  });

  it('R2: the 2 s check reads serverNow() after the proof read, immediately before a resend', async () => {
    const clock = new FakeClock(T0); // two hours on the local clock
    let left = 10 * SEC;
    let calls = 0;
    const api = {
      itemDetail: () => {
        left = PROOF_RESEND_MIN_TIME_LEFT_MS - 1;
        return Promise.resolve(makeDetail({ isHighBidder: false, numBids: 0, bidHistory: [] }));
      },
      placeBid: () => {
        calls += 1;
        if (calls === 1) return Promise.reject(new HttpTimeoutError(1000));
        return Promise.resolve({ ...REJECTED_UNKNOWN, observedAt: clock.now() });
      },
    } as unknown as SgwApi;

    const outcome = await IDEMPOTENT_SEND_STRATEGY.send(makeRequest(), makeDeps(api, clock, () => END - left));

    expect(outcome.kind).toBe('ambiguous');
    expect(calls).toBe(1);
  });

  it('R2: numBids 0 beside a visible bid is not "nothing changed": no resend', async () => {
    const clock = new FakeClock(T0);
    const log: string[] = [];
    const sends: WireSend[] = [];
    const proofOpts: Array<{ maxAgeMs?: number } | undefined> = [];
    const api = scriptedApi({ place: ['ambiguous', 'ok'], proof: 'history' }, log, sends, clock, proofOpts);
    const deps = makeDeps(api, clock, () => END - 10 * SEC);

    const outcome = await IDEMPOTENT_SEND_STRATEGY.send(makeRequest(), deps);

    expect(outcome.kind).toBe('ambiguous');
    expect(sends).toHaveLength(1);
    expect(log.filter((x) => x === 'itemDetail')).toHaveLength(1);
    expect(proofOpts).toEqual([{ maxAgeMs: 0 }]);
  });

  it('R2: isHighBidder true is present even when numBids is 0: accepted, no resend', async () => {
    const clock = new FakeClock(T0);
    let calls = 0;
    const api = {
      itemDetail: () => Promise.resolve(makeDetail({ isHighBidder: true, numBids: 0, bidHistory: [] })),
      placeBid: () => {
        calls += 1;
        return Promise.reject(new HttpTimeoutError(1000));
      },
    } as unknown as SgwApi;

    const outcome = await IDEMPOTENT_SEND_STRATEGY.send(makeRequest(), makeDeps(api, clock, () => END - 10 * SEC));

    expect(outcome).toMatchObject({ kind: 'result', result: { kind: 'accepted', isHighBidder: true } });
    expect(calls).toBe(1);
  });
});

// ── The proof read goes through the real adapter (cache, bearer, write gate) ─

const API_BASE = SGW_API_BASE;
const ZERO_GAP: LaneConfig = { minIntervalMs: 0, jitterMs: 0, maxConcurrent: 1, dailyBudget: 1000 };
const FAST_LANES: Record<Lane, LaneConfig> = {
  interactive: ZERO_GAP,
  background: ZERO_GAP,
  snipe: ZERO_GAP,
  canary: ZERO_GAP,
};

function rawDetail(over: { numberOfBids: number; high: boolean; clearBids: boolean }): Record<string, unknown> {
  const raw = loadFixture<Record<string, unknown> & { bidHistory: Record<string, unknown> }>('item-detail-open');
  raw.itemId = ITEM;
  raw.sellerId = SELLER;
  raw.numberOfBids = over.numberOfBids;
  raw.bidHistory.isHighBidderLogIn = over.high;
  raw.bidHistory.auctionClosed = false;
  raw.isItemEndTimeExpire = false;
  if (over.clearBids) raw.bidHistory.bidComplete = [];
  return raw;
}

const httpJson = (body: unknown): { status: number; bodyText: string } => ({ status: 200, bodyText: JSON.stringify(body) });

/** The real SgwApiAdapter over FakeHttp. Lane gaps are zero so the fake clock does not have to move. */
function realStack(): { api: SgwApiAdapter; http: FakeHttp; clock: FakeClock; kill: () => void } {
  const clock = new FakeClock(T0);
  const http = new FakeHttp(clock);
  const switches = new FakeSwitches();
  let killed = false;
  const api = new SgwApiAdapter({
    scheduler: new SgwRequestScheduler({ clock, http, storage: new FakeStorage(), random: () => 0, lanes: FAST_LANES }),
    clock,
    session: {
      current: () => Promise.resolve({ bearer: 'aaaa.bbbb.cccc', expiresAt: T0 + 30 * DAY, buyerId: '42' }),
      reportRejected: () => Promise.resolve(),
    },
    switches,
    writesAllowedNow: () => (killed ? { ok: false, why: 'kill switch' } : { ok: true }),
    audit: new FakeAuditLog(clock),
    health: { flagSchemaFailure: () => undefined, onSchemaOk: () => undefined },
    sgwClock: new SgwClockAdapter(clock),
  });
  return {
    api,
    http,
    clock,
    kill: () => {
      killed = true;
      switches.killAll('kill switch');
    },
  };
}

describe('the proof read on the real adapter', () => {
  it('is a fresh authenticated snipe-lane read: a cached anonymous zero-bid detail cannot cause a resend', async () => {
    const live = realStack();
    live.http.on(`${API_BASE}ItemDetail/`, httpJson(rawDetail({ numberOfBids: 0, high: false, clearBids: true })));
    const cached = await live.api.itemDetail(ITEM, 'interactive');
    expect(cached).toMatchObject({ numBids: 0, isHighBidder: null });

    live.http.on(`${API_BASE}ItemDetail/`, httpJson(rawDetail({ numberOfBids: 1, high: true, clearBids: false })));
    let placeCalls = 0;
    const api = {
      itemDetail: (itemId: number, lane: Lane, opts?: { maxAgeMs?: number }) => live.api.itemDetail(itemId, lane, opts),
      placeBid: () => {
        placeCalls += 1;
        return Promise.reject(new HttpTimeoutError(1000));
      },
    } as unknown as SgwApi;

    const outcome = await IDEMPOTENT_SEND_STRATEGY.send(makeRequest(), makeDeps(api, live.clock, () => END - 5 * SEC));

    expect(outcome).toMatchObject({ kind: 'result', result: { kind: 'accepted', isHighBidder: true } });
    expect(placeCalls).toBe(1);
    const details = live.http.requests.filter((r) => r.url.includes('ItemDetail/'));
    expect(details).toHaveLength(2);
    expect(details[0]?.headers?.Authorization).toBeUndefined();
    expect(details[1]?.headers?.Authorization).toBe('Bearer aaaa.bbbb.cccc');
  });

  it('a kill between an ambiguous send and the resend: the write gate throws before any byte, result ambiguous', async () => {
    const live = realStack();
    live.http.on(`${API_BASE}ItemBid/ShowBidModal`, httpJson({ sellerId: SELLER, minimumBid: 11 }));
    live.http.on(`${API_BASE}ItemBid/PlaceBid`, { error: new HttpTimeoutError(20_000) });
    live.http.on(`${API_BASE}ItemDetail/`, () => {
      live.kill();
      return httpJson(rawDetail({ numberOfBids: 0, high: false, clearBids: true }));
    });

    const outcome = await IDEMPOTENT_SEND_STRATEGY.send(makeRequest(), makeDeps(live.api, live.clock, () => END - 5 * SEC));

    expect(outcome.kind).toBe('ambiguous');
    const urls = live.http.requests.map((r) => r.url);
    expect(urls.filter((u) => u.includes('ItemBid/PlaceBid'))).toHaveLength(1);
    expect(urls.filter((u) => u.includes('ItemBid/ShowBidModal'))).toHaveLength(1);
    expect(urls.filter((u) => u.includes('ItemDetail/'))).toHaveLength(1);
  });
});

// ── R4: the invariant as a property ──────────────────────────────────────────
//
// Random timeouts, BidNotSentErrors, proof reads and clock positions. Every
// run checks: at most two wire sends; a second send only after a
// BidNotSentError or a proof read that showed no change; both sends carry
// exactly the max and the same key; an attempt whose first request may have
// left is never reported not-sent.

const PROP_RUNS = Number(process.env.SBW_PROP_RUNS ?? (process.env.SBW_LONG_PROPS !== undefined && process.env.SBW_LONG_PROPS !== '' ? 10_000 : 2_000));
const PROP_SEED = Number(process.env.SBW_PROP_SEED ?? '4242');

interface PropScript {
  first: PlaceKind;
  proof: ProofKind;
  retry: PlaceKind;
  /** serverNow = end - timeLeftMs at every decision point. */
  timeLeftMs: number;
  maxBid: number;
  key: string;
}

const arbScript: fc.Arbitrary<PropScript> = fc.record({
  first: fc.constantFrom<PlaceKind>('ok', 'not-sent', 'ambiguous'),
  proof: fc.constantFrom<ProofKind>('present', 'no-change', 'inconclusive', 'fails', 'history'),
  retry: fc.constantFrom<PlaceKind>('ok', 'not-sent', 'ambiguous'),
  timeLeftMs: fc.integer({ min: 0, max: 4000 }),
  maxBid: fc.integer({ min: 100, max: 5000 }),
  key: fc.string({ minLength: 1, maxLength: 20 }),
});

function oracle(s: PropScript): { kind: SendOutcome['kind']; sends: number } {
  if (s.first === 'ok') return { kind: 'result', sends: 1 };
  if (s.first === 'not-sent') {
    if (s.timeLeftMs >= MIN_TIME_LEFT_TO_SEND_MS) {
      if (s.retry === 'ok') return { kind: 'result', sends: 2 };
      if (s.retry === 'not-sent') return { kind: 'not-sent', sends: 2 };
      return { kind: 'ambiguous', sends: 2 };
    }
    return { kind: 'not-sent', sends: 1 };
  }
  if (s.proof === 'fails') return { kind: 'ambiguous', sends: 1 };
  if (s.proof === 'present') return { kind: 'result', sends: 1 };
  if (s.proof === 'no-change' && s.timeLeftMs >= PROOF_RESEND_MIN_TIME_LEFT_MS) {
    if (s.retry === 'ok') return { kind: 'result', sends: 2 };
    return { kind: 'ambiguous', sends: 2 };
  }
  return { kind: 'ambiguous', sends: 1 };
}

describe('R4: the idempotent-send invariant as a property', () => {
  it(`at most two wire sends; the second only after a BidNotSentError or a no-change proof read; same max, same key (${String(PROP_RUNS)} runs)`, { timeout: 600_000 }, async () => {
    const agg: Record<string, number> = {};
    await fc.assert(
      fc.asyncProperty(arbScript, async (script) => {
        const clock = new FakeClock(T0);
        const log: string[] = [];
        const sends: WireSend[] = [];
        const api = scriptedApi({ place: [script.first, script.retry], proof: script.proof }, log, sends, clock);
        const deps = makeDeps(api, clock, () => END - script.timeLeftMs);
        const req = makeRequest({
          amount: script.maxBid,
          idempotencyKey: script.key,
          snipe: sentSnipe({ maxBid: script.maxBid }),
        });

        const outcome = await IDEMPOTENT_SEND_STRATEGY.send(req, deps);

        // The invariant: at most two wire sends, each exactly the max and the key.
        expect(sends.length).toBeLessThanOrEqual(2);
        for (const send of sends) {
          expect(send.amount).toBe(req.snipe.maxBid);
          expect(send.amount).toBe(script.maxBid);
          expect(send.key).toBe(script.key);
          expect(send.timeoutMs).toBe(req.timeoutMs);
        }
        // The oracle says exactly how many sends each scenario allows.
        expect(sends.length).toBe(oracle(script).sends);
        expect(outcome.kind).toBe(oracle(script).kind);
        // R3: once the first request may have left, never not-sent.
        if (script.first === 'ambiguous') expect(outcome.kind).not.toBe('not-sent');
        // A second wire send happens only after a BidNotSentError first, or a
        // proof read that showed no change; on the ambiguous path the proof
        // read must come before the second send.
        if (sends.length === 2) {
          const viaProof = script.first === 'ambiguous' && script.proof === 'no-change' && script.timeLeftMs >= PROOF_RESEND_MIN_TIME_LEFT_MS;
          const viaNotSent = script.first === 'not-sent' && script.timeLeftMs >= MIN_TIME_LEFT_TO_SEND_MS;
          expect(viaProof || viaNotSent).toBe(true);
          if (script.first === 'ambiguous') {
            const proofAt = log.indexOf('itemDetail');
            const secondAt = log.lastIndexOf('placeBid');
            expect(proofAt).toBeGreaterThan(-1);
            expect(proofAt).toBeLessThan(secondAt);
          } else {
            expect(log).not.toContain('itemDetail');
          }
        }
        if (script.first === 'ok') expect(log).not.toContain('itemDetail');
        if (outcome.kind === 'result') {
          expect(BidResultSchema.safeParse(outcome.result).success).toBe(true);
          if (script.proof === 'present' && script.first === 'ambiguous') {
            expect(outcome.result).toMatchObject({ kind: 'accepted', isHighBidder: true });
          }
        }

        agg.runs = (agg.runs ?? 0) + 1;
        if (sends.length === 2) agg.twoSends = (agg.twoSends ?? 0) + 1;
        if (sends.length === 2 && script.first === 'ambiguous') agg.resendAfterProof = (agg.resendAfterProof ?? 0) + 1;
        if (sends.length === 2 && script.first === 'not-sent') agg.retryAfterNotSent = (agg.retryAfterNotSent ?? 0) + 1;
        if (log.includes('itemDetail')) agg.proofReads = (agg.proofReads ?? 0) + 1;
        if (outcome.kind === 'ambiguous') agg.ambiguous = (agg.ambiguous ?? 0) + 1;
      }),
      { numRuns: PROP_RUNS, seed: PROP_SEED },
    );
    // Every branch of the strategy is exercised.
    expect(agg.runs).toBe(PROP_RUNS);
    expect(agg.twoSends ?? 0).toBeGreaterThan(0);
    expect(agg.resendAfterProof ?? 0).toBeGreaterThan(0);
    expect(agg.retryAfterNotSent ?? 0).toBeGreaterThan(0);
    expect(agg.proofReads ?? 0).toBeGreaterThan(0);
    expect(agg.ambiguous ?? 0).toBeGreaterThan(0);
  });
});
