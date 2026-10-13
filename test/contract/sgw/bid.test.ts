// T-100: the live PlaceBid path (src/adapters/sgw/bid.ts) and its result-code
// map, PLAN §6 T-100.
//
// STAGE 1: every PlaceBid reply in this file is SYNTHETIC and written inline.
// The real replies (test/fixtures/sgw/json/placebid-*.json, USER STEP P5)
// land in stage 2; the "every catalogue fixture" test picks them up from
// manifest.json on its own.
//
// No live network (R7): replies come from FakeHttp on a FakeClock, through the
// real T-25 scheduler and T-26 adapter. MSW (test/setup) fails any request that
// is not answered by a fake.
//
// Controller rulings → tests (the report has the full map):
//   R1 fail-safe classification; sent vs never sent · R2 bidAmount from integer
//   cents · R3 20 s timeout, credentials 'omit' · R4 ShowBidModal first, nothing
//   sent if it fails · R5 messageText is plain text · R7 no live network.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import fc from 'fast-check';
import { describe, expect, expectTypeOf, it } from 'vitest';

import { SgwApiAdapter, type BidContext, type SchemaFailure } from '../../../src/adapters/sgw/api-adapter';
import {
  BidNotSentError,
  PLACE_BID_RESULT_CODES,
  PLACE_BID_TIMEOUT_MS,
  PLACE_BID_UNKNOWN_KIND,
  bidMayHaveBeenSent,
  classifyPlaceBid,
  placeBid as placeBidPath,
  placeBidBody,
  type PlaceBidCode,
} from '../../../src/adapters/sgw/bid';
import { SgwClockAdapter } from '../../../src/adapters/sgw/clock-adapter';
import { SgwRequestScheduler } from '../../../src/adapters/sgw/request-scheduler';
import { parseCents } from '../../../src/domain/money';
import { DEFAULT_CAPS } from '../../../src/domain/settings/defaults';
import {
  BidResultKindSchema,
  BidResultSchema,
  DEFAULT_LANES,
  type BidResult,
  type Lane,
  type LaneConfig,
} from '../../../src/domain/types';
import { HttpNetworkError, HttpTimeoutError, SgwApiError } from '../../../src/ports/errors';
import type { HttpRequest, HttpResponse } from '../../../src/ports/http';
import type { RequestScheduler, ScheduledRequest } from '../../../src/ports/request-scheduler';
import { BID_RESULT } from '../../fakes/fake-sgw-server/bidding/result-codes';
import { FakeAuditLog } from '../../fakes/ports/fake-audit-log';
import { FakeClock } from '../../fakes/ports/fake-clock';
import { FakeHttp, type HttpStep } from '../../fakes/ports/fake-http';
import { FakeStorage } from '../../fakes/ports/fake-storage';
import { FakeSwitches } from '../../fakes/ports/fake-switches';
import { fixtureExists, loadFixture, manifestEntries } from './fixtures';

const BASE = 'https://buyerapi.shopgoodwill.com/api/';
const MODAL = `${BASE}ItemBid/ShowBidModal`;
const PLACE_BID = `${BASE}ItemBid/PlaceBid`;
const S = 1000;
/** 2026-10-08T03:09:16Z. */
const T0 = Date.UTC(2026, 9, 8, 3, 9, 16);
const ITEM = 702801256;
const SELLER = 12;
const BEARER = 'aaaa.bbbb.cccc';
const KEY = 'snipe-1:attempt-1';

const ZERO_GAP: LaneConfig = { minIntervalMs: 0, jitterMs: 0, maxConcurrent: 1, dailyBudget: 1000 };
const FAST_LANES: Record<Lane, LaneConfig> = { interactive: ZERO_GAP, background: ZERO_GAP, snipe: ZERO_GAP, canary: ZERO_GAP };

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Drains pending promise callbacks (not a timer: no time passes). */
const flush = (): Promise<void> =>
  new Promise((resolve) => {
    setImmediate(resolve);
  });

/** Advances the fake clock in slices, draining promises after each. */
async function advance(clock: FakeClock, ms: number, step = 250): Promise<void> {
  await flush();
  let left = ms;
  while (left > 0) {
    const s = Math.min(step, left);
    clock.advance(s);
    left -= s;
    await flush();
  }
}

type Settled<T> = { ok: true; value: T } | { ok: false; error: unknown };

function settle<T>(p: Promise<T>): Promise<Settled<T>> {
  return p.then(
    (value) => ({ ok: true, value }),
    (error: unknown) => ({ ok: false, error }),
  );
}

function errorOf(s: Settled<unknown>): SgwApiError {
  if (s.ok) throw new Error(`expected a rejection, got ${JSON.stringify(s.value)}`);
  expect(s.error).toBeInstanceOf(SgwApiError);
  return s.error as SgwApiError;
}

function valueOf<T>(s: Settled<T>): T {
  if (!s.ok) throw s.error;
  return s.value;
}

const json = (body: unknown, status = 200, latencyMs?: number): HttpStep =>
  latencyMs === undefined ? { status, bodyText: JSON.stringify(body) } : { status, bodyText: JSON.stringify(body), latencyMs };

const MODAL_OK = json({ sellerId: SELLER, minimumBid: 68.01 });

function header(req: HttpRequest | undefined, name: string): string | undefined {
  for (const [k, v] of Object.entries(req?.headers ?? {})) if (k.toLowerCase() === name.toLowerCase()) return v;
  return undefined;
}

interface SetupOpts {
  lanes?: Record<Lane, LaneConfig>;
  session?: { bearer: string; expiresAt: number; buyerId: string } | null;
}

/** The real T-26 adapter over the real T-25 scheduler, with FakeHttp. */
function setup(opts: SetupOpts = {}) {
  const clock = new FakeClock(T0);
  const http = new FakeHttp(clock);
  const inner = new SgwRequestScheduler({ clock, http, storage: new FakeStorage(), random: () => 0, lanes: opts.lanes ?? FAST_LANES });
  const runs: Array<{ endpoint: string; lane: Lane }> = [];
  const scheduler: RequestScheduler = {
    run<T>(r: ScheduledRequest<T>): Promise<T> {
      runs.push({ endpoint: r.endpoint, lane: r.lane });
      return inner.run(r);
    },
    stats: () => inner.stats(),
    pause: (reason, untilMs) => {
      inner.pause(reason, untilMs);
    },
    resume: () => {
      inner.resume();
    },
  };
  const audit = new FakeAuditLog(clock);
  const switches = new FakeSwitches();
  const failures: SchemaFailure[] = [];
  const session = opts.session === undefined ? { bearer: BEARER, expiresAt: T0 + 24 * 3600 * S, buyerId: '42' } : opts.session;
  const api = new SgwApiAdapter({
    scheduler,
    clock,
    session: { current: () => Promise.resolve(session), reportRejected: () => Promise.resolve() },
    switches,
    audit,
    health: {
      flagSchemaFailure: (f) => {
        failures.push(f);
      },
    },
    sgwClock: new SgwClockAdapter(clock),
  });
  return { clock, http, runs, audit, switches, failures, api };
}
type Setup = ReturnType<typeof setup>;

function bid(t: Setup, cents = 7000, opts: { timeoutMs?: number; sellerId?: number } = {}): Promise<Settled<BidResult>> {
  return settle(
    t.api.placeBid(
      { itemId: ITEM, sellerId: opts.sellerId ?? SELLER, bidAmount: cents, quantity: 1 },
      { idempotencyKey: KEY, timeoutMs: opts.timeoutMs ?? 20 * S },
    ),
  );
}

const placeBidRequests = (t: Setup): HttpRequest[] => t.http.requests.filter((r) => r.url === PLACE_BID);

/** A BidContext that is not the adapter: proves what bid.ts does with the context it is handed. */
function fakeContext(reply: unknown, modal: { sellerId: number; minimumBid: number } = { sellerId: SELLER, minimumBid: 6801 }) {
  const order: string[] = [];
  const sends: Array<{ endpoint: string; body: unknown; timeoutMs: number | undefined }> = [];
  const ctx: BidContext = {
    clock: new FakeClock(T0),
    prepare: () => Promise.reject(new Error('bid.ts must not prepare requests itself')),
    showBidModal: (itemId) => {
      order.push(`showBidModal:${String(itemId)}`);
      return Promise.resolve(modal);
    },
    sendWrite: (endpoint, init, parse) => {
      order.push(`sendWrite:${endpoint}`);
      sends.push({ endpoint, body: init.body, timeoutMs: init.timeoutMs });
      const res: HttpResponse = { status: 200, headers: {}, bodyText: JSON.stringify(reply), startedAt: T0, endedAt: T0 + 42 };
      try {
        return Promise.resolve(parse(res, reply));
      } catch (e) {
        return Promise.reject(e instanceof Error ? e : new Error(String(e)));
      }
    },
    flagSchemaFailure: () => {
      throw new Error('bid.ts must not flag schema failures itself (sendWrite does)');
    },
  };
  return { ctx, order, sends };
}

const REQ = { itemId: ITEM, sellerId: SELLER, bidAmount: 7000, quantity: 1 as const };
const OPTS = { idempotencyKey: KEY, timeoutMs: 20 * S };

/** A synthetic catalogue (stage 1 has no real one): one success code, one outbid code, one rejection. */
const SYNTHETIC_CATALOGUE: readonly PlaceBidCode[] = [
  { status: true, result: 7, kind: 'accepted', evidence: 'catalogue', source: 'placebid-synthetic-accepted.json' },
  { status: true, result: 8, kind: 'outbid', evidence: 'catalogue', source: 'placebid-synthetic-outbid.json' },
  { status: false, result: -9, kind: 'below-minimum', evidence: 'catalogue', source: 'placebid-synthetic-too-low.json' },
];

// ── Arbitraries and the source under test ───────────────────────────────────

/** Arbitrary PlaceBid replies that pass the schema: either status shape, any code. */
function replyArb() {
  return fc.record(
    {
      status: fc.oneof(fc.boolean(), fc.integer({ min: -5, max: 5 })),
      result: fc.option(fc.oneof(fc.integer({ min: -200, max: 200 }), fc.constantFrom(-3, -4, -5, -110, 0, 1, 7, 8, -9)), { nil: null }),
      message: fc.option(fc.string(), { nil: null }),
      isHighBidder: fc.option(fc.boolean(), { nil: null }),
      isUnauthorized: fc.boolean(),
    },
    { requiredKeys: ['status'] },
  );
}

/** bid.ts with comments removed, for the source checks. */
const BID_CODE = readFileSync(path.resolve(import.meta.dirname, '../../../src/adapters/sgw/bid.ts'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')
  .replace(/\s\/\/.*$/gm, '');

// ── R1: the result-code map and classification (pure) ──────────────────────

describe('R1: classification fails safe (synthetic replies)', () => {
  it("the default for anything not in the map is 'rejected-unknown'", () => {
    expect(PLACE_BID_UNKNOWN_KIND).toBe('rejected-unknown');
  });

  it.each([
    ['status false, unknown code', { status: false, result: -999, message: 'Nope' }],
    ['status true, unknown code', { status: true, result: 12345, message: 'Thanks' }],
    ['status true alone (no result)', { status: true, message: 'Your bid was placed' }],
    ['status true, result null', { status: true, result: null, message: '' }],
    ['status true, isHighBidder true, no code', { status: true, isHighBidder: true }],
    ['status true, enveloped data without a result', { status: true, message: 'Ok', data: { isHighBidder: true } }],
    ['numeric status 1 (statusFlag null)', { status: 1, result: 0 }],
    ['numeric status 0 (statusFlag null)', { status: 0, result: -3 }],
  ])("%s → 'rejected-unknown', never 'accepted'", (_name, reply) => {
    const r = classifyPlaceBid(reply, T0);
    expect(r.kind).toBe('rejected-unknown');
    expect(BidResultSchema.parse(r)).toEqual(r);
  });

  it('stage 1: the PLAN placeholder codes (-3, -4, -5, -110) are inert until the catalogue confirms them', () => {
    const placeholders = PLACE_BID_RESULT_CODES.filter((c) => c.evidence === 'placeholder');
    expect(placeholders.map((c) => c.result).sort((a, b) => a - b)).toEqual([-110, -5, -4, -3]);
    for (const c of placeholders) {
      expect(classifyPlaceBid({ status: c.status, result: c.result, message: 'x' }, T0).kind).toBe('rejected-unknown');
    }
  });

  it("stage 1: no code is known yet, so no live reply is ever 'accepted' or 'outbid'", () => {
    expect(PLACE_BID_RESULT_CODES.filter((c) => c.evidence === 'catalogue')).toEqual([]);
    fc.assert(
      fc.property(replyArb(), (reply) => {
        const kind = classifyPlaceBid(reply, T0).kind;
        expect(kind).not.toBe('accepted');
        expect(kind).not.toBe('outbid');
      }),
      { numRuns: 500 },
    );
  });

  it("the fake server's UNVERIFIED codes (T-88) are never 'accepted' or 'outbid' here", () => {
    for (const [name, c] of Object.entries(BID_RESULT)) {
      if (!c.unverified) continue;
      const kind = classifyPlaceBid({ status: c.status, result: c.result, message: name }, T0).kind;
      expect(['accepted', 'outbid'], name).not.toContain(kind);
    }
  });

  it("a catalogue success code is 'accepted', but only with its own status flag", () => {
    const c = SYNTHETIC_CATALOGUE;
    expect(classifyPlaceBid({ status: true, result: 7, message: 'ok' }, T0, c).kind).toBe('accepted');
    expect(classifyPlaceBid({ status: false, result: 7 }, T0, c).kind).toBe('rejected-unknown');
    expect(classifyPlaceBid({ status: 1, result: 7 }, T0, c).kind).toBe('rejected-unknown');
    expect(classifyPlaceBid({ status: true }, T0, c).kind).toBe('rejected-unknown');
    expect(classifyPlaceBid({ status: true, result: 8 }, T0, c).kind).toBe('outbid');
    expect(classifyPlaceBid({ status: false, result: -9 }, T0, c).kind).toBe('below-minimum');
    expect(classifyPlaceBid({ status: true, result: -9 }, T0, c).kind).toBe('rejected-unknown');
  });

  it("an enveloped reply (result and isHighBidder under data) classifies the same way", () => {
    const r = classifyPlaceBid({ status: true, message: 'Ok', data: { result: 7, isHighBidder: true } }, T0, SYNTHETIC_CATALOGUE);
    expect(r).toMatchObject({ kind: 'accepted', rawResult: 7, isHighBidder: true });
  });

  it('a placeholder entry never decides the kind, even one that claims success', () => {
    const careless: PlaceBidCode[] = [{ status: true, result: 0, kind: 'accepted', evidence: 'placeholder', source: 'a guess' }];
    expect(classifyPlaceBid({ status: true, result: 0 }, T0, careless).kind).toBe('rejected-unknown');
  });

  it("isUnauthorized → 'auth', even next to a success code", () => {
    expect(classifyPlaceBid({ status: false, isUnauthorized: true, message: 'Unauthorized' }, T0).kind).toBe('auth');
    expect(classifyPlaceBid({ status: true, result: 7, isUnauthorized: true }, T0, SYNTHETIC_CATALOGUE).kind).toBe('auth');
  });

  it("property: 'accepted' only for an exact (status, result) catalogue match; every result is a valid BidResult", () => {
    for (const codes of [PLACE_BID_RESULT_CODES, SYNTHETIC_CATALOGUE]) {
      fc.assert(
        fc.property(replyArb(), (reply) => {
          const r = classifyPlaceBid(reply, T0, codes);
          BidResultSchema.parse(r);
          const status = reply.status;
          const result = reply.result ?? null;
          const known = codes.find((c) => c.evidence === 'catalogue' && c.status === status && c.result === result);
          if (reply.isUnauthorized === true) expect(r.kind).toBe('auth');
          else expect(r.kind).toBe(known?.kind ?? 'rejected-unknown');
        }),
        { numRuns: 1000 },
      );
    }
  });

  it('a reply that fails the PlaceBid schema throws SgwApiError(schema), never a result', () => {
    for (const bad of [null, 'ok', [], {}, { message: 'no status' }, { status: 'true' }, { status: true, result: 1.5 }]) {
      expect(() => classifyPlaceBid(bad, T0)).toThrow(SgwApiError);
    }
  });

  it('copies SGW’s raw signals and the observation time', () => {
    const r = classifyPlaceBid({ status: 3, result: -42, message: 'm', isHighBidder: false }, T0 + 5);
    expect(r).toEqual({ kind: 'rejected-unknown', rawStatus: 3, rawResult: -42, messageText: 'm', isHighBidder: false, observedAt: T0 + 5 });
  });
});

describe('the result-code map', () => {
  it('every entry has a valid kind, a known evidence level and a source; no (status, result) appears twice', () => {
    const seen = new Set<string>();
    for (const c of PLACE_BID_RESULT_CODES) {
      expect(BidResultKindSchema.options).toContain(c.kind);
      expect(['catalogue', 'placeholder']).toContain(c.evidence);
      expect(c.source.length).toBeGreaterThan(0);
      expect(Number.isInteger(c.result)).toBe(true);
      const key = `${String(c.status)}:${String(c.result)}`;
      expect(seen.has(key), key).toBe(false);
      seen.add(key);
    }
  });

  it("no placeholder claims 'accepted' or 'outbid' (a guessed success is never written down as one)", () => {
    for (const c of PLACE_BID_RESULT_CODES.filter((x) => x.evidence === 'placeholder')) {
      expect(['accepted', 'outbid']).not.toContain(c.kind);
    }
  });

  it('every catalogue code cites a placebid-*.json fixture that exists (stage 2)', () => {
    for (const c of PLACE_BID_RESULT_CODES.filter((x) => x.evidence === 'catalogue')) {
      expect(c.source).toMatch(/^placebid-[a-z0-9-]+\.json$/);
      expect(fixtureExists(`json/${c.source}`), c.source).toBe(true);
    }
  });

  it('every catalogue fixture maps to a BidResultKind (stage 2 adds the placebid-*.json fixtures)', () => {
    const entries = manifestEntries().filter((e) => e.endpoint === 'placeBid' || /\/placebid-/.test(e.file));
    for (const e of entries) {
      const name = path.basename(e.file, '.json');
      const r = classifyPlaceBid(loadFixture(name), T0);
      expect(BidResultKindSchema.options, e.file).toContain(r.kind);
      if (r.kind === 'accepted' || r.kind === 'outbid') {
        const cited = PLACE_BID_RESULT_CODES.some((c) => c.evidence === 'catalogue' && c.source === path.basename(e.file));
        expect(cited, `${e.file} classifies as ${r.kind} without a catalogue entry citing it`).toBe(true);
      }
    }
  });
});

// ── R5: messageText is plain text ───────────────────────────────────────────

describe('R5: messageText is SGW’s message stripped to plain text', () => {
  it('tags, scripts and handlers are gone; entities are decoded', () => {
    const r = classifyPlaceBid(
      {
        status: false,
        result: -4,
        message: '<p>Your bid must be at least <b>$68.01</b> &amp; higher.</p><script>alert(1)</script><img src=x onerror="alert(2)">',
      },
      T0,
    );
    expect(r.messageText).toBe('Your bid must be at least $68.01 & higher.');
    expect(r.messageText).not.toMatch(/<[a-z/!]/i);
  });

  it('escaped markup stays literal text (it is never turned back into a tag)', () => {
    const r = classifyPlaceBid({ status: false, message: '&lt;b&gt;hi&lt;/b&gt;' }, T0);
    expect(r.messageText).toBe('<b>hi</b>');
  });

  it('a missing or null message is the empty string', () => {
    expect(classifyPlaceBid({ status: true }, T0).messageText).toBe('');
    expect(classifyPlaceBid({ status: true, message: null }, T0).messageText).toBe('');
  });
});

// ── R2: bidAmount is a two-decimal string from integer cents ────────────────

describe('R2: bidAmount is a two-decimal string made from integer cents (domain/money)', () => {
  const CASES: Array<[number, string]> = [
    [1, '0.01'],
    [99, '0.99'],
    [100, '1.00'],
    [12345, '123.45'],
    [DEFAULT_CAPS.perItemMax, '50.00'],
    [DEFAULT_CAPS.openExposureMax, '200.00'],
  ];

  it.each(CASES)('%i cents → "%s" on the wire, in the site’s field order', async (cents, text) => {
    const t = setup();
    t.http.on(MODAL, MODAL_OK);
    t.http.on(PLACE_BID, json({ status: false, result: -999, message: 'x' }));
    valueOf(await bid(t, cents));
    const sent = placeBidRequests(t);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.body).toBe(`{"itemId":${String(ITEM)},"bidAmount":"${text}","sellerId":${String(SELLER)},"quantity":1}`);
  });

  it('property: placeBidBody round-trips any positive cents exactly, always two decimals', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: Number.MAX_SAFE_INTEGER }), (cents) => {
        const body = placeBidBody({ ...REQ, bidAmount: cents });
        expect(body.bidAmount).toMatch(/^\d+\.\d{2}$/);
        expect(parseCents(body.bidAmount)).toBe(cents);
        expect(body).toEqual({ itemId: ITEM, bidAmount: body.bidAmount, sellerId: SELLER, quantity: 1 });
      }),
      { numRuns: 2000 },
    );
  });

  it('bid.ts does no float math on money (it formats through domain/money only)', () => {
    expect(BID_CODE).toMatch(/import \{[^}]*\bbidAmount\b[^}]*\} from '\.\.\/\.\.\/domain\/money'/);
    expect(BID_CODE).not.toMatch(/toFixed|parseFloat|Math\.round|\/\s*100\b|\*\s*100\b/);
  });
});

// ── Invalid input: nothing at all is sent ───────────────────────────────────

describe('invalid input is refused before anything is sent (not even ShowBidModal)', () => {
  const BAD: Array<[string, Partial<typeof REQ>, Partial<typeof OPTS>]> = [
    ['bidAmount 0', { bidAmount: 0 }, {}],
    ['a negative bidAmount', { bidAmount: -100 }, {}],
    ['a fractional bidAmount (12.5 cents)', { bidAmount: 12.5 }, {}],
    ['a NaN bidAmount', { bidAmount: Number.NaN }, {}],
    ['an unsafe bidAmount', { bidAmount: Number.MAX_SAFE_INTEGER + 1 }, {}],
    ['sellerId 0', { sellerId: 0 }, {}],
    ['a fractional sellerId', { sellerId: 1.5 }, {}],
    ['quantity 2', { quantity: 2 as unknown as 1 }, {}],
    ['an empty idempotencyKey', {}, { idempotencyKey: '' }],
    ['timeoutMs 0', {}, { timeoutMs: 0 }],
    ['a NaN timeoutMs', {}, { timeoutMs: Number.NaN }],
  ];

  it.each(BAD)('%s: BidNotSentError(schema, invalid-input), zero HTTP', async (_name, req, opts) => {
    const t = setup();
    t.http.on(MODAL, MODAL_OK);
    t.http.on(PLACE_BID, json({ status: true, result: 7 }));
    const err = errorOf(await settle(t.api.placeBid({ ...REQ, ...req }, { ...OPTS, ...opts })));
    expect(err).toBeInstanceOf(BidNotSentError);
    expect(err.kind).toBe('schema');
    expect(err.message).toContain('invalid-input');
    expect(bidMayHaveBeenSent(err)).toBe(false);
    expect(t.http.requests).toHaveLength(0);
    expect(t.failures).toHaveLength(0);
  });
});

// ── R3, R4: the request on the wire ─────────────────────────────────────────

describe('R3/R4: ShowBidModal first, then one PlaceBid through the guarded send', () => {
  it('reads ShowBidModal, then sends exactly one PlaceBid; both on the snipe lane', async () => {
    const t = setup();
    t.http.on(MODAL, MODAL_OK);
    t.http.on(PLACE_BID, json({ status: false, result: -999, message: 'x' }));
    valueOf(await bid(t));
    expect(t.http.requests.map((r) => `${r.method} ${r.url}`)).toEqual([`GET ${MODAL}?itemId=${String(ITEM)}`, `POST ${PLACE_BID}`]);
    expect(t.runs).toEqual([
      { endpoint: 'showBidModal', lane: 'snipe' },
      { endpoint: 'placeBid', lane: 'snipe' },
    ]);
    expect(t.switches.checks).toEqual(['bidding', 'bidding']); // the adapter's own check, then sendWrite's
  });

  it("PlaceBid: credentials 'omit', no cookie, the bearer, JSON, a 20 s timeout", async () => {
    const t = setup();
    t.http.on(MODAL, MODAL_OK);
    t.http.on(PLACE_BID, json({ status: false, result: -999 }));
    valueOf(await bid(t));
    const [sent] = placeBidRequests(t);
    expect(sent?.credentials).toBe('omit');
    expect(header(sent, 'cookie')).toBeUndefined();
    expect(header(sent, 'authorization')).toBe(`Bearer ${BEARER}`);
    expect(header(sent, 'content-type')).toBe('application/json');
    expect(sent?.timeoutMs).toBe(PLACE_BID_TIMEOUT_MS);
    expect(PLACE_BID_TIMEOUT_MS).toBe(20_000);
    for (const r of t.http.requests) expect(r.credentials).toBe('omit');
  });

  it.each([
    [60_000, 20_000],
    [20_000, 20_000],
    [5_000, 5_000],
  ])('opts.timeoutMs %i → the request times out after %i ms (never above 20 s)', async (asked, used) => {
    const t = setup();
    t.http.on(MODAL, MODAL_OK);
    t.http.on(PLACE_BID, json({ status: false, result: -999 }));
    valueOf(await bid(t, 7000, { timeoutMs: asked }));
    expect(placeBidRequests(t)[0]?.timeoutMs).toBe(used);
  });

  it('with the real snipe lane, PlaceBid leaves one lane gap (1 s) after the modal reply', async () => {
    const t = setup({ lanes: DEFAULT_LANES });
    t.http.on(MODAL, MODAL_OK);
    t.http.on(PLACE_BID, json({ status: false, result: -999 }));
    const p = bid(t);
    await advance(t.clock, 2 * S, 100);
    valueOf(await p);
    expect(t.http.requests.map((r) => r.url.split('?')[0])).toEqual([MODAL, PLACE_BID]);
    expect(DEFAULT_LANES.snipe.minIntervalMs).toBe(1000);
  });

  it('sends only through ctx.sendWrite, after ctx.showBidModal, with the body and timeout', async () => {
    const { ctx, order, sends } = fakeContext({ status: false, result: -999, message: '<b>No</b>' });
    const r = await placeBidPath(ctx, REQ, { idempotencyKey: KEY, timeoutMs: 90_000 });
    expect(order).toEqual([`showBidModal:${String(ITEM)}`, 'sendWrite:placeBid']);
    expect(sends).toEqual([
      { endpoint: 'placeBid', body: { itemId: ITEM, bidAmount: '70.00', sellerId: SELLER, quantity: 1 }, timeoutMs: 20_000 },
    ]);
    expect(r).toEqual({ kind: 'rejected-unknown', rawStatus: null, rawResult: -999, messageText: 'No', isHighBidder: null, observedAt: T0 + 42 });
  });

  it('BidContext has no scheduler, and bid.ts never reaches for one, prepare(), fetch or run()', () => {
    expectTypeOf<BidContext>().not.toHaveProperty('scheduler');
    expect(BID_CODE).not.toMatch(/\bscheduler\b/);
    expect(BID_CODE).not.toMatch(/\.prepare\s*\(/);
    expect(BID_CODE).not.toMatch(/\bfetch\s*\(/);
    expect(BID_CODE).not.toMatch(/\.run\s*\(/);
    expect(BID_CODE.match(/ctx\.sendWrite\s*\(/g)).toHaveLength(1);
    expect(BID_CODE).toMatch(/ctx\.sendWrite\s*\(\s*'placeBid'/);
  });
});

describe('R4: if ShowBidModal fails, PlaceBid is never sent', () => {
  const FAILURES: Array<[string, HttpStep, SgwApiError['kind']]> = [
    ['a 500', json({ message: 'boom' }, 500), 'server'],
    ['a 401', json({ message: 'Unauthorized' }, 401), 'auth'],
    ['a 403', json({ message: 'Forbidden' }, 403), 'blocked'],
    ['a reply that is not JSON', { status: 200, bodyText: '<html>maintenance</html>' }, 'schema'],
    ['a reply without sellerId', json({ minimumBid: 68.01 }), 'schema'],
    ['an envelope saying status false', json({ status: false, message: 'Item not found', data: null }), 'server'],
    ['a network error', { error: new HttpNetworkError('connection reset') }, 'network'],
  ];

  it.each(FAILURES)('ShowBidModal answers %s: BidNotSentError(%s), zero PlaceBid', async (_name, step, kind) => {
    const t = setup();
    t.http.on(MODAL, step);
    t.http.on(PLACE_BID, json({ status: true, result: 7 }));
    const err = errorOf(await bid(t));
    expect(err).toBeInstanceOf(BidNotSentError);
    expect(err.kind).toBe(kind);
    expect(bidMayHaveBeenSent(err)).toBe(false);
    expect(placeBidRequests(t)).toHaveLength(0);
  });

  it('ShowBidModal times out: BidNotSentError(timeout) — a modal timeout is not a bid timeout', async () => {
    const t = setup();
    t.http.on(MODAL, { hang: true });
    t.http.on(PLACE_BID, json({ status: true, result: 7 }));
    const p = bid(t);
    await advance(t.clock, 21 * S);
    const err = errorOf(await p);
    expect(err).toBeInstanceOf(BidNotSentError);
    expect(err.kind).toBe('timeout');
    expect(bidMayHaveBeenSent(err)).toBe(false);
    expect(placeBidRequests(t)).toHaveLength(0);
  });

  it('no SGW session: BidNotSentError(auth) and zero HTTP', async () => {
    const t = setup({ session: null });
    t.http.on(MODAL, MODAL_OK);
    const err = errorOf(await bid(t));
    expect(err).toBeInstanceOf(BidNotSentError);
    expect(err.kind).toBe('auth');
    expect(t.http.requests).toHaveLength(0);
  });

  it('ShowBidModal names another seller than the bid: refused, zero PlaceBid', async () => {
    const t = setup();
    t.http.on(MODAL, json({ sellerId: 99, minimumBid: 68.01 }));
    t.http.on(PLACE_BID, json({ status: true, result: 7 }));
    const err = errorOf(await bid(t));
    expect(err).toBeInstanceOf(BidNotSentError);
    expect(err.kind).toBe('schema');
    expect(err.message).toContain('invalid-input');
    expect(err.message).toContain('99');
    expect(placeBidRequests(t)).toHaveLength(0);
  });

  it('a modal minimumBid above the bid does not stop it: SGW, not the modal, decides (too low comes back as a reply)', async () => {
    const t = setup();
    t.http.on(MODAL, json({ sellerId: SELLER, minimumBid: 99.0 }));
    t.http.on(PLACE_BID, json({ status: false, result: -999, message: 'too low' }));
    expect(valueOf(await bid(t, 7000)).kind).toBe('rejected-unknown');
    expect(placeBidRequests(t)).toHaveLength(1);
  });
});

// ── R1: sent vs never sent ──────────────────────────────────────────────────

describe('R1: a failure after PlaceBid may have left is distinguishable from "never sent"', () => {
  it('a timeout after the send: SgwApiError(timeout), MAY have been sent, never retried', async () => {
    const t = setup();
    t.http.on(MODAL, MODAL_OK);
    t.http.on(PLACE_BID, { hang: true });
    const p = bid(t);
    await advance(t.clock, 21 * S);
    const err = errorOf(await p);
    expect(err.kind).toBe('timeout');
    expect(err).not.toBeInstanceOf(BidNotSentError);
    expect(bidMayHaveBeenSent(err)).toBe(true);
    await advance(t.clock, 60 * S);
    expect(placeBidRequests(t)).toHaveLength(1);
  });

  it('an abort after the send (connection dropped mid-request): SgwApiError(network), MAY have been sent', async () => {
    const t = setup();
    t.http.on(MODAL, MODAL_OK);
    t.http.on(PLACE_BID, { hang: true });
    const p = bid(t);
    await advance(t.clock, 2 * S);
    expect(t.http.pending).toBe(1);
    t.http.abortAll('worker shutting down');
    const err = errorOf(await p);
    expect(err.kind).toBe('network');
    expect(err).not.toBeInstanceOf(BidNotSentError);
    expect(bidMayHaveBeenSent(err)).toBe(true);
    expect(placeBidRequests(t)).toHaveLength(1);
  });

  const MAYBE_SENT: Array<[string, HttpStep, SgwApiError['kind']]> = [
    ['a network error after the send', { error: new HttpNetworkError('Failed to fetch') }, 'network'],
    ['an Http timeout error', { error: new HttpTimeoutError(20_000) }, 'timeout'],
    ['a 500 (the bid may have been processed first)', json({ message: 'boom' }, 500), 'server'],
    ['a 504 from the gateway', json({ message: 'Gateway Timeout' }, 504), 'server'],
    ['a 200 that is not JSON', { status: 200, bodyText: '<html>error</html>' }, 'schema'],
    ['a 200 that fails the PlaceBid schema', json({ message: 'hello' }), 'schema'],
    ['a 401 (SGW answered, so it reached SGW)', json({ message: 'Unauthorized' }, 401), 'auth'],
    ['a 403', json({ message: 'Forbidden' }, 403), 'blocked'],
  ];

  it.each(MAYBE_SENT)('%s: SgwApiError(%s), MAY have been sent, exactly one PlaceBid', async (_name, step, kind) => {
    const t = setup();
    t.http.on(MODAL, MODAL_OK);
    t.http.on(PLACE_BID, step);
    const err = errorOf(await bid(t));
    expect(err.kind).toBe(kind);
    expect(err).not.toBeInstanceOf(BidNotSentError);
    expect(bidMayHaveBeenSent(err)).toBe(true);
    expect(placeBidRequests(t)).toHaveLength(1);
  });

  it('a reply that fails its schema is flagged to health (so writes fail closed)', async () => {
    const t = setup();
    t.http.on(MODAL, MODAL_OK);
    t.http.on(PLACE_BID, json({ message: 'hello' }));
    errorOf(await bid(t));
    expect(t.failures.map((f) => f.endpoint)).toEqual(['placeBid']);
  });

  it('a network error the Http layer proves happened before any byte left: BidNotSentError(network)', async () => {
    const t = setup();
    t.http.on(MODAL, MODAL_OK);
    t.http.on(PLACE_BID, { error: new HttpNetworkError('offline', { beforeSend: true }) });
    const err = errorOf(await bid(t));
    expect(err).toBeInstanceOf(BidNotSentError);
    expect(err.kind).toBe('network');
    expect(bidMayHaveBeenSent(err)).toBe(false);
  });

  it('the kill switch flips after the modal: sendWrite refuses, BidNotSentError(paused), audited, zero PlaceBid', async () => {
    const t = setup();
    t.http.on(MODAL, () => {
      t.switches.killAll('kill switch');
      return MODAL_OK;
    });
    t.http.on(PLACE_BID, json({ status: true, result: 7 }));
    const err = errorOf(await bid(t));
    expect(err).toBeInstanceOf(BidNotSentError);
    expect(err.kind).toBe('paused');
    expect(err.message).toBe('kill switch');
    expect(bidMayHaveBeenSent(err)).toBe(false);
    expect(placeBidRequests(t)).toHaveLength(0);
    expect(t.audit.entries).toEqual([
      expect.objectContaining({ kind: 'bid.place', itemId: ITEM, details: { action: 'bid', why: 'kill switch' } }),
    ]);
  });

  it("the adapter's own gate refuses first (dry run): plain paused, never sent, zero HTTP", async () => {
    const t = setup();
    t.switches.block('bidding', 'dry run');
    const err = errorOf(await bid(t));
    expect(err.kind).toBe('paused');
    expect(bidMayHaveBeenSent(err)).toBe(false);
    expect(t.http.requests).toHaveLength(0);
  });

  it('the snipe lane is out of budget: BidNotSentError(budget), zero PlaceBid', async () => {
    const tight: LaneConfig = { minIntervalMs: 0, jitterMs: 0, maxConcurrent: 1, dailyBudget: 1 };
    const t = setup({ lanes: { ...FAST_LANES, snipe: tight } });
    t.http.on(MODAL, MODAL_OK);
    t.http.on(PLACE_BID, json({ status: true, result: 7 }));
    const err = errorOf(await bid(t));
    expect(err).toBeInstanceOf(BidNotSentError);
    expect(err.kind).toBe('budget');
    expect(placeBidRequests(t)).toHaveLength(0);
  });
});

describe('R1: definitive replies resolve with a BidResult', () => {
  it("status true with an unknown code: 'rejected-unknown', stamped with the reply's own time, message as text", async () => {
    const t = setup();
    t.http.on(MODAL, MODAL_OK);
    t.http.on(PLACE_BID, json({ status: true, result: 31337, message: '<p>Thanks, <b>bid</b> placed &amp; ok</p>' }, 200, 150));
    const p = bid(t);
    await advance(t.clock, 1 * S, 50);
    expect(valueOf(await p)).toEqual({
      kind: 'rejected-unknown',
      rawStatus: null,
      rawResult: 31337,
      messageText: 'Thanks, bid placed & ok',
      isHighBidder: null,
      observedAt: T0 + 150,
    });
  });

  it("isUnauthorized in a 200 reply: 'auth'", async () => {
    const t = setup();
    t.http.on(MODAL, MODAL_OK);
    t.http.on(PLACE_BID, json({ status: false, isUnauthorized: true, message: 'Unauthorized', data: null }));
    expect(valueOf(await bid(t)).kind).toBe('auth');
  });
});

describe('bidMayHaveBeenSent', () => {
  it('is false only for a proven "never sent"; anything else may have reached SGW', () => {
    expect(bidMayHaveBeenSent(new BidNotSentError('auth', 'x'))).toBe(false);
    expect(bidMayHaveBeenSent(new SgwApiError('paused', 'kill switch'))).toBe(false);
    expect(bidMayHaveBeenSent(new SgwApiError('timeout'))).toBe(true);
    expect(bidMayHaveBeenSent(new SgwApiError('network', 'x', { cause: new HttpNetworkError('x') }))).toBe(true);
    expect(bidMayHaveBeenSent(new SgwApiError('server', 'x', { status: 500 }))).toBe(true);
    expect(bidMayHaveBeenSent(new SgwApiError('schema'))).toBe(true);
    expect(bidMayHaveBeenSent(new Error('a bug'))).toBe(true);
    expect(bidMayHaveBeenSent(undefined)).toBe(true);
  });

  it('a BidNotSentError is still an SgwApiError with the original kind, status and cause', () => {
    const cause = new SgwApiError('blocked', 'showBidModal: SGW refused the request (403)', { status: 403, retryAfterMs: 5 });
    const e = new BidNotSentError('blocked', cause.message, { status: 403, retryAfterMs: 5, cause });
    expect(e).toBeInstanceOf(SgwApiError);
    expect(e).toMatchObject({ kind: 'blocked', status: 403, retryAfterMs: 5, bidSent: false });
    expect(e.cause).toBe(cause);
  });
});
