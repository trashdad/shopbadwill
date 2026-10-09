// T-26: the ApiAdapter (PLAN §3.3) over the real T-25 RequestScheduler, with
// FakeHttp, FakeClock and FakeStorage. No real network: every response is
// scripted. Time moves only through FakeClock; `flush()` drains promises.
//
// Controller rulings covered here (the report maps each to its tests):
//   R1 invalid params never forwarded · R2 quotes stripped, string booleans ·
//   R3 credentials 'omit' + bearer only on auth endpoints · R4 write gate ·
//   R5 lanes, everything through the scheduler · R6 itemDetail cache ·
//   R7 no live network (FakeHttp only; MSW in the integration test).
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import type * as BidModule from '../../../../src/adapters/sgw/bid';

/**
 * The BidContext the adapter hands bid.ts, captured so tests can drive
 * ctx.sendWrite (I2). With `captureOnly`, bid.ts is not run: the call rejects
 * `paused` and sends nothing, as T-26's stub did. Otherwise T-100's live path runs.
 */
const bidCapture = vi.hoisted((): { ctx: unknown; captureOnly: boolean } => ({ ctx: undefined, captureOnly: false }));
vi.mock('../../../../src/adapters/sgw/bid', async (importOriginal) => {
  const real = await importOriginal<typeof BidModule>();
  const placeBid: typeof real.placeBid = (ctx, req, opts) => {
    bidCapture.ctx = ctx;
    if (bidCapture.captureOnly) return Promise.reject(new real.BidNotSentError('paused', 'captured by the test; nothing was sent'));
    return real.placeBid(ctx, req, opts);
  };
  return { ...real, placeBid };
});

import {
  CLOCK_LANE,
  CLOCK_PRIORITY,
  DETAIL_CACHE_TTL_MS,
  DETAIL_NO_CACHE_BEFORE_END_MS,
  FAVORITE_NOTE_MAX_CHARS,
  SgwApiAdapter,
  WRITE_GATE_MAX_AGE_MS,
  WRITE_GATE_MAX_ATTEMPTS,
  WRITE_LANE,
  type BidContext,
  type SchemaFailure,
} from '../../../../src/adapters/sgw/api-adapter';
import { SGW_CONFIG_VERSION, SGW_ENDPOINTS } from '../../../../src/adapters/sgw/config';
import { SgwClockAdapter } from '../../../../src/adapters/sgw/clock-adapter';
import { searchQueryFromUrl } from '../../../../src/adapters/sgw/query-url';
import { SgwRequestScheduler } from '../../../../src/adapters/sgw/request-scheduler';
import type { ClockSample, Lane, LaneConfig, SearchQuery } from '../../../../src/domain/types';
import { SgwApiError } from '../../../../src/ports/errors';
import type { HttpRequest } from '../../../../src/ports/http';
import type { RequestScheduler, ScheduledRequest } from '../../../../src/ports/request-scheduler';
import { SGW_FIXTURES, loadFixture } from '../../../contract/sgw/fixtures';
import { FakeAuditLog } from '../../../fakes/ports/fake-audit-log';
import { FakeClock } from '../../../fakes/ports/fake-clock';
import { FakeHttp, type HttpStep } from '../../../fakes/ports/fake-http';
import { FakeStorage } from '../../../fakes/ports/fake-storage';
import { FakeSwitches, type SwitchFeature } from '../../../fakes/ports/fake-switches';

const BASE = 'https://buyerapi.shopgoodwill.com/api/';
const S = 1000;
const MIN = 60 * S;
/** 2026-10-08T03:09:16Z = 20:09:16 PDT on Oct 7, just after item-detail-open's serverTime. */
const T0 = Date.UTC(2026, 9, 8, 3, 9, 16);
/** item-detail-open (and -closed): item 702801256 ends 2026-10-07T20:39:00 PT = 03:39:00Z. */
const ITEM = 702801256;
const ITEM_END = Date.UTC(2026, 9, 8, 3, 39, 0);
const BEARER = 'aaaa.bbbb.cccc';

const ZERO_GAP: LaneConfig = { minIntervalMs: 0, jitterMs: 0, maxConcurrent: 1, dailyBudget: 1000 };
const FAST_LANES: Record<Lane, LaneConfig> = { interactive: ZERO_GAP, background: ZERO_GAP, snipe: ZERO_GAP, canary: ZERO_GAP };

/** Drains pending promise callbacks (not a timer: no time passes). */
const flush = (): Promise<void> =>
  new Promise((resolve) => {
    setImmediate(resolve);
  });

/** Advances the fake clock in slices, draining promises after each, as real time lets async answers land. */
async function advance(clock: FakeClock, ms: number, step = 250): Promise<void> {
  let left = ms;
  while (left > 0) {
    const s = Math.min(step, left);
    clock.advance(s);
    left -= s;
    await flush();
  }
}

/** FakeSwitches whose answers can arrive late on the fake clock (a refresh that falls behind). State is read when asked. */
class DelayedSwitches extends FakeSwitches {
  delayMs = 0;
  constructor(private readonly clock: FakeClock) {
    super();
  }
  override writesAllowed(feature: SwitchFeature): Promise<{ ok: boolean; why?: string }> {
    const answer = super.writesAllowed(feature);
    if (this.delayMs <= 0) return answer;
    return new Promise((resolve) => {
      this.clock.setTimeout(() => {
        resolve(answer);
      }, this.delayMs);
    });
  }
}

// ── Test doubles ────────────────────────────────────────────────────────────

/** Wraps the real scheduler and records every ScheduledRequest it is given. */
class RecordingScheduler implements RequestScheduler {
  readonly runs: Array<{ lane: Lane; endpoint: string; priority: number | undefined }> = [];
  constructor(private readonly inner: SgwRequestScheduler) {}
  run<T>(r: ScheduledRequest<T>): Promise<T> {
    this.runs.push({ lane: r.lane, endpoint: r.endpoint, priority: r.priority });
    return this.inner.run(r);
  }
  stats(): ReturnType<RequestScheduler['stats']> {
    return this.inner.stats();
  }
  pause(reason: string, untilMs?: number): void {
    this.inner.pause(reason, untilMs);
  }
  resume(): void {
    this.inner.resume();
  }
}

interface SetupOpts {
  start?: number;
  lanes?: Record<Lane, LaneConfig>;
  session?: { bearer: string; expiresAt: number; buyerId: string } | null;
  sgwClock?: Pick<SgwClockAdapter, 'sampleFromServerTime' | 'sampleFromGetCurrentTime'>;
}

function setup(opts: SetupOpts = {}) {
  const clock = new FakeClock(opts.start ?? T0);
  const http = new FakeHttp(clock);
  const inner = new SgwRequestScheduler({
    clock,
    http,
    storage: new FakeStorage(),
    random: () => 0,
    lanes: opts.lanes ?? FAST_LANES,
  });
  const scheduler = new RecordingScheduler(inner);
  const audit = new FakeAuditLog(clock);
  const switches = new DelayedSwitches(clock);
  const failures: SchemaFailure[] = [];
  const rejections = { count: 0 };
  const sessionBox = {
    value: opts.session === undefined ? { bearer: BEARER, expiresAt: T0 + 24 * 60 * MIN, buyerId: '42' } : opts.session,
  };
  const api = new SgwApiAdapter({
    scheduler,
    clock,
    session: {
      current: () => Promise.resolve(sessionBox.value),
      reportRejected: () => {
        rejections.count += 1;
        return Promise.resolve();
      },
    },
    switches,
    audit,
    health: {
      flagSchemaFailure: (f) => {
        failures.push(f);
      },
    },
    sgwClock: opts.sgwClock ?? new SgwClockAdapter(clock),
  });
  return { clock, http, inner, scheduler, audit, switches, failures, rejections, sessionBox, api };
}

type Setup = ReturnType<typeof setup>;

const json = (body: unknown, status = 200): HttpStep => ({ status, bodyText: JSON.stringify(body) });
const ENVELOPE = { message: 'Ok', status: true, type: null, primaryKey: null, isUnauthorized: false };
const ACK = { ...ENVELOPE };

/** Scripts a plausible reply for every endpoint (provisional shapes where no fixture exists yet). */
function scriptAll(http: FakeHttp): void {
  http.on(`${BASE}Search/ItemListing`, json(loadFixture('search-grid-p1')));
  http.on(`${BASE}ItemDetail/GetItemDetailModelByItemId/`, json(loadFixture('item-detail-open')));
  http.on(`${BASE}Dashboard/GetCurrentTime`, json(loadFixture('get-current-time')));
  http.on(`${BASE}ItemDetail/CalculateShipping`, json({ shippingPrice: 12.5, handlingPrice: 5 }));
  http.on(
    `${BASE}Favorite/GetAllFavoriteItemsByType`,
    json({ ...ENVELOPE, data: [{ itemId: ITEM, watchlistId: 55, notes: 'n', endTime: '2026-10-07T20:39:00', sellerId: 12 }] }),
  );
  http.on(`${BASE}Favorite/AddToFavorite`, json(ACK));
  http.on(`${BASE}Favorite/RemoveItemFromFavoriteList`, json(ACK));
  http.on(`${BASE}Favorite/Save`, json(ACK));
  http.on(
    `${BASE}SaveSearches/GetSaveSearches`,
    json({
      ...ENVELOPE,
      data: [
        {
          saveSearchId: 7,
          searchName: 'Pyrex',
          searchText: 'pyrex',
          selectedCategoryIds: '',
          selectedSellerIds: '',
          lowPrice: 0,
          highPrice: 999999,
        },
      ],
    }),
  );
  http.on(`${BASE}ItemBid/ShowBidModal`, json({ sellerId: 12, minimumBid: 68.01 }));
}

const PYREX: SearchQuery = { searchText: 'pyrex', categoryIds: [], sellerIds: [], page: 1 };

/** Asserts the promise rejects with SgwApiError of `kind` and returns the error. */
async function rejectsWith(p: Promise<unknown>, kind: SgwApiError['kind']): Promise<SgwApiError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(SgwApiError);
    expect((e as SgwApiError).kind).toBe(kind);
    return e as SgwApiError;
  }
  throw new Error(`expected a rejection with kind '${kind}'`);
}

function header(req: HttpRequest | undefined, name: string): string | undefined {
  if (req === undefined) return undefined;
  for (const [k, v] of Object.entries(req.headers ?? {})) if (k.toLowerCase() === name.toLowerCase()) return v;
  return undefined;
}

function bodyOf(req: HttpRequest | undefined): Record<string, unknown> {
  expect(req?.body).toBeTypeOf('string');
  return JSON.parse(req?.body ?? 'null') as Record<string, unknown>;
}

interface ManifestFixture {
  fixture: string;
  capturedAt: string;
  requestBody?: Record<string, unknown>;
}
function recordedBody(fixture: string): { body: string; capturedAt: number } {
  const m = JSON.parse(readFileSync(path.join(SGW_FIXTURES, 'manifest.json'), 'utf8')) as { fixtures: ManifestFixture[] };
  const entry = m.fixtures.find((f) => f.fixture === fixture);
  if (entry?.requestBody === undefined) throw new Error(`no recorded request body for ${fixture}`);
  return { body: JSON.stringify(entry.requestBody), capturedAt: new Date(entry.capturedAt).getTime() };
}

// ── search: recorded bodies, quotes, booleans (R2), invalid params (R1) ─────

describe('search request body', () => {
  it.each([
    ['search-grid-p1', { searchText: 'pyrex', categoryIds: [], sellerIds: [], page: 1, layout: 'grid' }],
    ['search-list-p1', { searchText: 'vintage camera', categoryIds: [], sellerIds: [], page: 1, layout: 'list' }],
    ['search-empty', { searchText: 'zqxjvw unicornium plinth', categoryIds: [], sellerIds: [], page: 1 }],
  ] satisfies Array<[string, SearchQuery]>)('matches the body T-07 recorded for %s byte-for-byte', async (fixture, q) => {
    const recorded = recordedBody(fixture);
    const t = setup({ start: recorded.capturedAt });
    scriptAll(t.http);
    await t.api.search(q, 'interactive');
    expect(t.http.requests).toHaveLength(1);
    const sent = t.http.requests[0];
    expect(sent?.method).toBe('POST');
    expect(sent?.url).toBe(`${BASE}Search/ItemListing`);
    expect(header(sent, 'content-type')).toBe('application/json');
    expect(sent?.body).toBe(recorded.body);
  });

  it('strips double quotes from searchText at the edge (R2: they make buyerapi answer 403)', async () => {
    const t = setup();
    scriptAll(t.http);
    await t.api.search({ ...PYREX, searchText: '"pyrex" "butterfly gold"' }, 'interactive');
    const body = bodyOf(t.http.requests[0]);
    expect(body.searchText).toBe('pyrex butterfly gold');
    expect(t.http.requests[0]?.body).not.toContain('\\"');
  });

  it('sends booleans as the strings "true"/"false" and prices as dollar strings (R2)', async () => {
    const t = setup();
    scriptAll(t.http);
    await t.api.search(
      {
        searchText: 'pyrex',
        categoryIds: [12, 34],
        sellerIds: [7],
        lowPrice: 1000,
        highPrice: 1299,
        pickupOnly: true,
        excludePickupOnly: false,
        oneCentShippingOnly: true,
        searchDescriptions: true,
        closedAuctions: false,
        sortColumn: 3,
        sortDescending: true,
        page: 2,
        layout: 'list',
      },
      'interactive',
    );
    const body = bodyOf(t.http.requests[0]);
    expect(body).toMatchObject({
      selectedCategoryIds: '12,34',
      selectedSellerIds: '7',
      lowPrice: '10',
      highPrice: '12.99',
      searchPickupOnly: 'true',
      searchNoPickupOnly: 'false',
      searchOneCentShippingOnly: 'true',
      searchDescriptions: 'true',
      searchClosedAuctions: 'false',
      sortColumn: '3',
      sortDescending: 'true',
      page: '2',
      pageSize: '40',
      layout: 'list',
    });
    // Only the four fields the site itself sends as JSON booleans stay booleans.
    const realBooleans = Object.entries(body)
      .filter(([, v]) => typeof v === 'boolean')
      .map(([k]) => k);
    expect(realBooleans.sort()).toEqual(['isFromHeaderMenuTab', 'isMultipleCategoryIds', 'isSize']);
    expect(body.isWeddingCatagory).toBe('false');
  });

  it('C7: extra.sus = "true" puts searchUSOnlyShipping: "true" in the body, in place; the rest is the recorded body', async () => {
    const recorded = recordedBody('search-grid-p1');
    const t = setup({ start: recorded.capturedAt });
    scriptAll(t.http);
    await t.api.search({ ...PYREX, layout: 'grid', extra: { sus: 'true' } }, 'interactive');
    const expected = JSON.parse(recorded.body) as Record<string, unknown>;
    expect(expected.searchUSOnlyShipping).toBe('false');
    expected.searchUSOnlyShipping = 'true';
    expect(t.http.requests[0]?.body).toBe(JSON.stringify(expected));
  });

  it('C7: forwards every known non-named URL param, coerced the way SGW_SEARCH_BODY_DEFAULTS types its field', async () => {
    const t = setup();
    scriptAll(t.http);
    await t.api.search(
      {
        ...PYREX,
        extra: {
          sus: 'true',
          sis: 'FALSE',
          scs: ' true ',
          sbn: 'true',
          UseBuyerPrefs: 'false',
          wc: 'true',
          mci: 'true',
          hmt: 'false',
          ss: '12',
          cadb: '30',
          cln: '2',
          catIds: '12,34',
          sg: 'grp',
          pn: 'AB-1"2',
        },
      },
      'interactive',
    );
    const body = bodyOf(t.http.requests[0]);
    expect(body).toMatchObject({
      // "true"/"false" strings where the default is one
      searchUSOnlyShipping: 'true',
      searchInternationalShippingOnly: 'false',
      searchCanadaShipping: 'true',
      searchBuyNowOnly: 'true',
      useBuyerPrefs: 'false',
      isWeddingCatagory: 'true',
      // real JSON booleans where the default is one
      isMultipleCategoryIds: true,
      isFromHeaderMenuTab: false,
      // a JSON number where the default is one
      savedSearchId: 12,
      // numeric strings where the default is one
      closedAuctionDaysBack: '30',
      categoryLevelNo: '2',
      // an id list, and free text with the 403-causing quotes stripped
      catIds: '12,34',
      selectedGroup: 'grp',
      partNumber: 'AB-12',
    });
  });

  it('C7: unknown keys, a param with no body default (ihp), pageSize and the closed-auction date are not sent', async () => {
    const t = setup();
    scriptAll(t.http);
    await t.api.search({ ...PYREX, extra: { foo: 'bar', ihp: 'true', ps: '120', caed: '1/1/2020' } }, 'interactive');
    expect(t.http.requests[0]?.body).toBe(recordedBody('search-grid-p1').body);
  });

  it('M3: also strips curly and fullwidth double quotes from searchText, defensively (S-1 verified only ")', async () => {
    const t = setup();
    scriptAll(t.http);
    await t.api.search({ ...PYREX, searchText: '“pyrex” ＂bowl＂ "x"' }, 'interactive');
    expect(bodyOf(t.http.requests[0]).searchText).toBe('pyrex bowl x');
  });

  it('returns normalized listings; pickupOnly comes from the query filter only', async () => {
    const t = setup();
    scriptAll(t.http);
    const plain = await t.api.search(PYREX, 'interactive');
    expect(plain.items).toHaveLength(40);
    expect(plain.total).toBe(1198);
    expect(plain.page).toBe(1);
    expect(plain.items[0]?.pickupOnly).toBeUndefined();
    expect(plain.items[0]?.observedAt).toBe(T0);
    const pickup = await t.api.search({ ...PYREX, pickupOnly: true }, 'interactive');
    expect(pickup.items.every((l) => l.pickupOnly === true)).toBe(true);
    const noPickup = await t.api.search({ ...PYREX, excludePickupOnly: true }, 'interactive');
    expect(noPickup.items.every((l) => l.pickupOnly === false)).toBe(true);
  });
});

describe('R1: invalid search params never reach SGW', () => {
  const invalid: Array<[string, SearchQuery]> = [
    // The two malformed bodies T-07 recorded (400 and silently-unfiltered 200), as the URLs a user could open.
    ['lp=abc (search-malformed-400)', searchQueryFromUrl('https://shopgoodwill.com/categories/listing?st=pyrex&lp=abc&hp=xyz') ?? PYREX],
    ['c=abc (search-malformed-200)', searchQueryFromUrl('https://shopgoodwill.com/categories/listing?st=pyrex&c=abc') ?? PYREX],
    ['p=0 in the URL', searchQueryFromUrl('https://shopgoodwill.com/categories/listing?st=pyrex&p=0') ?? PYREX],
    ['a negative lowPrice', { ...PYREX, lowPrice: -100 }],
    ['a fractional highPrice', { ...PYREX, highPrice: 12.5 }],
    ['a NaN lowPrice', { ...PYREX, lowPrice: Number.NaN }],
    ['an infinite highPrice', { ...PYREX, highPrice: Number.POSITIVE_INFINITY }],
    ['category id 0', { ...PYREX, categoryIds: [0] }],
    ['a negative category id', { ...PYREX, categoryIds: [12, -3] }],
    ['a fractional seller id', { ...PYREX, sellerIds: [1.5] }],
    ['page 0', { ...PYREX, page: 0 }],
    ['a negative sortColumn', { ...PYREX, sortColumn: -1 }],
    // C7: a known non-named param whose value cannot be coerced.
    ['sus=maybe in the URL', searchQueryFromUrl('https://shopgoodwill.com/categories/listing?st=pyrex&sus=maybe') ?? PYREX],
    ['extra.mci = "yes"', { ...PYREX, extra: { mci: 'yes' } }],
    ['extra.sbn = "1"', { ...PYREX, extra: { sbn: '1' } }],
    ['extra.ss = "x"', { ...PYREX, extra: { ss: 'x' } }],
    ['extra.cadb = "-1"', { ...PYREX, extra: { cadb: '-1' } }],
    ['extra.catIds = "abc"', { ...PYREX, extra: { catIds: 'abc' } }],
  ];

  it.each(invalid)('%s: SgwApiError before any HTTP call, health not flagged', async (_name, q) => {
    const t = setup();
    scriptAll(t.http);
    const err = await rejectsWith(t.api.search(q, 'interactive'), 'schema');
    expect(err.message).toContain('invalid-query');
    expect(t.http.requests).toHaveLength(0);
    expect(t.scheduler.runs).toHaveLength(0);
    expect(t.failures).toHaveLength(0);
  });

  it('accepts the same queries once the bad params are fixed', async () => {
    const t = setup();
    scriptAll(t.http);
    await t.api.search({ ...PYREX, lowPrice: 0, highPrice: 2500, categoryIds: [12] }, 'interactive');
    expect(bodyOf(t.http.requests[0])).toMatchObject({ lowPrice: '0', highPrice: '25', selectedCategoryIds: '12' });
  });
});

// ── R3: credentials and the bearer ──────────────────────────────────────────

type Call = (api: SgwApiAdapter) => Promise<unknown>;
const READ_AND_WRITE_CALLS: Array<[string, Call, boolean]> = [
  ['search', (a) => a.search(PYREX, 'interactive'), false],
  ['itemDetail', (a) => a.itemDetail(ITEM, 'interactive'), false],
  ['shippingQuote', (a) => a.shippingQuote(ITEM, '10001', 'interactive'), false],
  ['serverTimeSample (GetCurrentTime)', (a) => a.serverTimeSample(), false],
  ['favorites', (a) => a.favorites('open', 'interactive'), true],
  ['savedSearches', (a) => a.savedSearches('interactive'), true],
  ['showBidModal', (a) => a.showBidModal(ITEM), true],
  ['addFavorite', (a) => a.addFavorite(ITEM), true],
  ['removeFavorite', (a) => a.removeFavorite(ITEM), true],
  ['saveFavoriteNote', (a) => a.saveFavoriteNote(55, 'note'), true],
];

describe("R3: credentials 'omit' on every request, bearer only on auth endpoints", () => {
  it.each(READ_AND_WRITE_CALLS)("%s: credentials 'omit', no cookie, bearer iff the endpoint needs auth", async (_m, call, auth) => {
    const t = setup();
    scriptAll(t.http);
    await call(t.api);
    expect(t.http.requests).toHaveLength(1);
    const sent = t.http.requests[0];
    expect(sent?.credentials).toBe('omit');
    expect(header(sent, 'cookie')).toBeUndefined();
    expect(header(sent, 'authorization')).toBe(auth ? `Bearer ${BEARER}` : undefined);
  });

  it("serverTimeSample on a known item: credentials 'omit' and no bearer on both ItemDetail reads", async () => {
    const t = setup();
    scriptAll(t.http);
    await t.api.itemDetail(ITEM, 'interactive');
    await t.api.serverTimeSample();
    expect(t.http.requests).toHaveLength(2);
    for (const r of t.http.requests) {
      expect(r.credentials).toBe('omit');
      expect(header(r, 'authorization')).toBeUndefined();
    }
  });

  it("placeBid (T-100): ShowBidModal then PlaceBid, both credentials 'omit', no cookie, with the bearer", async () => {
    const t = setup();
    scriptAll(t.http);
    t.http.on(`${BASE}ItemBid/PlaceBid`, json({ status: false, result: -999, message: 'x' }));
    await t.api.placeBid({ itemId: ITEM, sellerId: 12, bidAmount: 7000, quantity: 1 }, { idempotencyKey: 'k1', timeoutMs: 20 * S });
    expect(t.http.requests.map((r) => r.url.split('?')[0])).toEqual([`${BASE}ItemBid/ShowBidModal`, `${BASE}ItemBid/PlaceBid`]);
    for (const r of t.http.requests) {
      expect(r.credentials).toBe('omit');
      expect(header(r, 'cookie')).toBeUndefined();
      expect(header(r, 'authorization')).toBe(`Bearer ${BEARER}`);
    }
  });

  const AUTH_CALLS = READ_AND_WRITE_CALLS.filter(([, , auth]) => auth);

  it.each(AUTH_CALLS)('%s with no session: SgwApiError(auth) and no HTTP call', async (_m, call) => {
    const t = setup({ session: null });
    scriptAll(t.http);
    await rejectsWith(call(t.api), 'auth');
    expect(t.http.requests).toHaveLength(0);
  });

  it.each(AUTH_CALLS)('%s with an expired session: SgwApiError(auth) and no HTTP call', async (_m, call) => {
    const t = setup({ session: { bearer: BEARER, expiresAt: T0 - 1, buyerId: '42' } });
    scriptAll(t.http);
    await rejectsWith(call(t.api), 'auth');
    expect(t.http.requests).toHaveLength(0);
  });

  it('anonymous reads still work with no session', async () => {
    const t = setup({ session: null });
    scriptAll(t.http);
    await t.api.search(PYREX, 'interactive');
    await t.api.itemDetail(ITEM, 'interactive');
    expect(t.http.requests).toHaveLength(2);
  });

  it('an auth reply flagged isUnauthorized is an auth error, not an empty list', async () => {
    const t = setup();
    t.http.on(`${BASE}Favorite/GetAllFavoriteItemsByType`, json({ ...ENVELOPE, status: false, isUnauthorized: true, data: null }));
    await rejectsWith(t.api.favorites('all', 'interactive'), 'auth');
    expect(t.failures).toHaveLength(0);
  });
});

// ── T-28 R2: an unauthorized reply to a bearer-carrying request reports the rejection ─

describe('T-28 R2: session.reportRejected on unauthorized replies', () => {
  it('a 401 on an auth read reports the rejection exactly once', async () => {
    const t = setup();
    t.http.on(`${BASE}Favorite/GetAllFavoriteItemsByType`, { status: 401, bodyText: '' });
    await rejectsWith(t.api.favorites('all', 'interactive'), 'auth');
    expect(t.rejections.count).toBe(1);
  });

  it('isUnauthorized in a read reply reports once', async () => {
    const t = setup();
    t.http.on(`${BASE}Favorite/GetAllFavoriteItemsByType`, json({ ...ENVELOPE, status: false, isUnauthorized: true, data: null }));
    await rejectsWith(t.api.favorites('all', 'interactive'), 'auth');
    expect(t.rejections.count).toBe(1);
  });

  it('isUnauthorized in a write ack reports once', async () => {
    const t = setup();
    t.http.on(`${BASE}Favorite/RemoveItemFromFavoriteList`, json({ ...ACK, status: false, isUnauthorized: true }));
    await rejectsWith(t.api.removeFavorite(ITEM), 'auth');
    expect(t.rejections.count).toBe(1);
  });

  it('no session / expired session: auth error before anything is sent, nothing reported', async () => {
    for (const session of [null, { bearer: BEARER, expiresAt: T0 - 1, buyerId: '42' }]) {
      const t = setup({ session });
      await rejectsWith(t.api.favorites('all', 'interactive'), 'auth');
      expect(t.rejections.count).toBe(0);
    }
  });

  it('an anonymous request that gets a 401 (no bearer sent) does not report', async () => {
    const t = setup();
    t.http.on(`${BASE}ItemDetail/`, { status: 401, bodyText: '' });
    await rejectsWith(t.api.itemDetail(ITEM, 'interactive'), 'auth');
    expect(t.rejections.count).toBe(0);
  });

  it('other failures (500, schema) do not report', async () => {
    const t = setup();
    t.http.on(`${BASE}Favorite/GetAllFavoriteItemsByType`, { status: 400, bodyText: '{}' });
    await rejectsWith(t.api.favorites('all', 'interactive'), 'server');
    expect(t.rejections.count).toBe(0);
  });

  it('a reportRejected that throws does not hide the auth error', async () => {
    const t = setup();
    (t.api as unknown as { deps: { session: { reportRejected: () => Promise<void> } } }).deps.session.reportRejected = () =>
      Promise.reject(new Error('storage down'));
    t.http.on(`${BASE}Favorite/GetAllFavoriteItemsByType`, { status: 401, bodyText: '' });
    await rejectsWith(t.api.favorites('all', 'interactive'), 'auth');
  });
});

// ── R4 (refined by ruling C1): the write gate is GlobalSwitches.writesAllowed ─

const WRITES: Array<[string, Call, { kind: string; feature: SwitchFeature; itemId?: number; ref?: string; action: string }]> = [
  ['addFavorite', (a) => a.addFavorite(ITEM), { kind: 'favorite.add', feature: 'favorites', itemId: ITEM, action: 'add' }],
  ['removeFavorite', (a) => a.removeFavorite(ITEM), { kind: 'favorite.remove', feature: 'favorites', itemId: ITEM, action: 'remove' }],
  [
    'saveFavoriteNote',
    (a) => a.saveFavoriteNote(55, 'secret-ish note text'),
    { kind: 'favorite.note', feature: 'favorites', ref: 'watchlist:55', action: 'note' },
  ],
  [
    'placeBid',
    (a) => a.placeBid({ itemId: ITEM, sellerId: 12, bidAmount: 7000, quantity: 1 }, { idempotencyKey: 'k1', timeoutMs: 20 * S }),
    { kind: 'bid.place', feature: 'bidding', itemId: ITEM, action: 'bid' },
  ],
];

describe('R4/C1: every write asks GlobalSwitches.writesAllowed; a refusal is audited and sends nothing', () => {
  const refusals: Array<[string, (s: FakeSwitches, f: SwitchFeature) => void, string]> = [
    ['dry-run', (s, f) => {
      s.block(f, 'dry run');
    }, 'dry run'],
    ['the kill switch', (s) => {
      s.killAll('kill switch');
    }, 'kill switch'],
    ['a failed health check', (s, f) => {
      s.block(f, 'health check failed');
    }, 'health check failed'],
  ];

  for (const [cause, apply, why] of refusals) {
    it.each(WRITES)(`%s refused by ${cause}: SgwApiError(paused, why), an audit intent (item, action, why), ZERO HTTP`, async (_m, call, w) => {
      const t = setup();
      scriptAll(t.http);
      apply(t.switches, w.feature);
      const err = await rejectsWith(call(t.api), 'paused');
      expect(err.message).toBe(why);
      expect(t.switches.checks).toEqual([w.feature]);
      expect(t.http.requests).toHaveLength(0);
      expect(t.scheduler.runs).toHaveLength(0);
      const entries = t.audit.entries;
      expect(entries).toHaveLength(1);
      const e = entries[0];
      expect(e).toMatchObject({ actor: 'system', kind: w.kind, details: { action: w.action, why } });
      expect(Object.keys(e?.details ?? {}).sort()).toEqual(['action', 'why']);
      expect(e?.itemId).toBe(w.itemId);
      expect(e?.ref).toBe(w.ref);
      expect(JSON.stringify(entries)).not.toContain('secret-ish');
    });
  }

  it('a refusal with no `why` still rejects paused and audits a reason', async () => {
    const t = setup();
    t.switches.writesAllowed = () => Promise.resolve({ ok: false });
    const err = await rejectsWith(t.api.addFavorite(ITEM), 'paused');
    expect(err.message).toBe('writes are not allowed');
    expect(t.audit.entries[0]?.details).toEqual({ action: 'add', why: 'writes are not allowed' });
    expect(t.http.requests).toHaveLength(0);
  });

  it('dry-run without a session still records the intent and sends nothing', async () => {
    const t = setup({ session: null });
    t.switches.block('favorites', 'dry run');
    await rejectsWith(t.api.addFavorite(ITEM), 'paused');
    expect(t.audit.kinds).toEqual(['favorite.add']);
    expect(t.http.requests).toHaveLength(0);
  });

  it('a live favorite write goes out once, on the write lane, with the bearer, unaudited by the adapter', async () => {
    const t = setup();
    scriptAll(t.http);
    await t.api.addFavorite(ITEM);
    await t.api.removeFavorite(ITEM);
    await t.api.saveFavoriteNote(55, 'wrap carefully');
    expect(t.http.requests.map((r) => `${r.method} ${r.url}`)).toEqual([
      `GET ${BASE}Favorite/AddToFavorite?itemId=${String(ITEM)}`,
      `GET ${BASE}Favorite/RemoveItemFromFavoriteList?itemId=${String(ITEM)}`,
      `POST ${BASE}Favorite/Save`,
    ]);
    expect(t.http.requests[0]?.body).toBeUndefined();
    expect(t.http.requests[2]?.body).toBe('{"notes":"wrap carefully","watchlistId":55}');
    expect(t.scheduler.runs.map((r) => r.lane)).toEqual([WRITE_LANE, WRITE_LANE, WRITE_LANE]);
    expect(t.switches.checks).toEqual(['favorites', 'favorites', 'favorites']);
    expect(t.audit.entries).toHaveLength(0);
  });

  it('an audit log that fails never turns a refusal into a send', async () => {
    const t = setup();
    t.audit.append = () => Promise.reject(new Error('storage full'));
    t.switches.block('favorites', 'dry run');
    await rejectsWith(t.api.addFavorite(ITEM), 'paused');
    expect(t.http.requests).toHaveLength(0);
  });

  // I1: a queued write keeps its writesAllowed verdict fresh (asked again every
  // WRITE_GATE_MAX_AGE_MS / 2, a local call) and build() checks the latest
  // verdict right before the send. All on the real T-25 scheduler.
  const GAP: LaneConfig = { minIntervalMs: 120 * S, jitterMs: 0, maxConcurrent: 1, dailyBudget: 100 };
  const BUSY_LANES: Record<Lane, LaneConfig> = { ...FAST_LANES, background: GAP };
  const ADD_URL = `${BASE}Favorite/AddToFavorite?itemId=${String(ITEM)}`;
  const backgroundRead = (t: Setup): Promise<unknown> => t.api.search(PYREX, 'background');

  it('a background read queued behind the write: the write goes out on its first turn (and stops refreshing)', async () => {
    const t = setup({ lanes: BUSY_LANES });
    scriptAll(t.http);
    await backgroundRead(t); // A: starts the 120 s gap on the write lane
    const write = t.api.addFavorite(ITEM);
    await flush();
    const behind = backgroundRead(t); // B: queued behind the write
    await advance(t.clock, 120 * S);
    await write;
    expect(t.http.requests.map((r) => r.url)).toEqual([`${BASE}Search/ItemListing`, ADD_URL]);
    expect(t.switches.checks.length).toBeGreaterThan(2); // refreshed while it waited
    expect(new Set(t.switches.checks)).toEqual(new Set(['favorites']));
    const asked = t.switches.checks.length;
    await advance(t.clock, 5 * S);
    expect(t.switches.checks).toHaveLength(asked); // the refresh timer was cleared when the write settled
    await advance(t.clock, 120 * S);
    await behind;
    expect(t.http.requests).toHaveLength(3);
    expect(t.audit.entries).toHaveLength(0);
  });

  it.each([
    ['the kill switch', (s: FakeSwitches) => {
      s.killAll('kill switch');
    }, 'kill switch'],
    ['dry-run', (s: FakeSwitches) => {
      s.block('favorites', 'dry run');
    }, 'dry run'],
  ])('%s turned on while the write is queued: the refreshed verdict refuses it at its turn, audited, ZERO HTTP for it', async (_c, apply, why) => {
    const t = setup({ lanes: BUSY_LANES });
    scriptAll(t.http);
    await backgroundRead(t);
    const pending = t.api.addFavorite(ITEM).catch((e: unknown) => e);
    await flush();
    apply(t.switches);
    await advance(t.clock, 1 * S); // a refresh lands with ok:false
    // From here on, no answer arrives within the test: the refusal must come from the verdict already held.
    t.switches.delayMs = 60 * MIN;
    await advance(t.clock, 119 * S);
    const err = await pending;
    expect(err).toBeInstanceOf(SgwApiError);
    expect((err as SgwApiError).kind).toBe('paused');
    expect((err as SgwApiError).message).toBe(why);
    expect(t.http.requests.map((r) => r.url)).toEqual([`${BASE}Search/ItemListing`]);
    expect(t.audit.entries).toEqual([
      expect.objectContaining({ kind: 'favorite.add', itemId: ITEM, details: { action: 'add', why } }),
    ]);
    expect(t.inner.stats().lanes.background.usedToday).toBe(1); // the refused turn cost no budget
    expect(t.failures).toHaveLength(0);
  });

  it('M2: when the refreshes fell behind, the write is asked again AND re-prepared before it goes (fresh bearer)', async () => {
    const t = setup({ lanes: BUSY_LANES });
    scriptAll(t.http);
    await backgroundRead(t);
    const write = t.api.addFavorite(ITEM);
    await flush();
    t.switches.delayMs = 5 * S; // every refresh answer is 5 s old when it lands: stale at the write's turn
    t.sessionBox.value = { bearer: 'rotated.bearer.token', expiresAt: T0 + 24 * 60 * MIN, buyerId: '42' };
    await advance(t.clock, 120 * S - 250);
    t.switches.delayMs = 0; // the stale path's own ask is answered at once
    await advance(t.clock, 250);
    await write;
    const sent = t.http.requests[1];
    expect(sent?.url).toBe(ADD_URL);
    expect(header(sent, 'authorization')).toBe('Bearer rotated.bearer.token');
    expect(t.inner.stats().lanes.background.usedToday).toBe(2);
  });

  it('M2: a session that expired while the write was queued is caught by the re-prepare: auth, nothing sent', async () => {
    const t = setup({ lanes: BUSY_LANES });
    scriptAll(t.http);
    await backgroundRead(t);
    const pending = t.api.addFavorite(ITEM).catch((e: unknown) => e);
    await flush();
    t.switches.delayMs = 5 * S;
    t.sessionBox.value = { bearer: BEARER, expiresAt: T0 + 60 * S, buyerId: '42' };
    await advance(t.clock, 120 * S - 250);
    t.switches.delayMs = 0;
    await advance(t.clock, 250);
    const err = await pending;
    expect(err).toBeInstanceOf(SgwApiError);
    expect((err as SgwApiError).kind).toBe('auth');
    expect(t.http.requests.map((r) => r.url)).toEqual([`${BASE}Search/ItemListing`]);
  });

  /** Enqueues a background read every 30 s for `forMs`, while advancing time; returns when `done` settles or time runs out. */
  async function contend(t: Setup, done: Promise<unknown>, forMs: number, limitMs: number): Promise<void> {
    const state = { settled: false };
    void done.finally(() => {
      state.settled = true;
    });
    for (let elapsed = 0; elapsed < limitMs && !state.settled; elapsed += 30 * S) {
      if (elapsed < forMs) void backgroundRead(t).catch(() => undefined);
      await advance(t.clock, 30 * S, 1 * S);
    }
  }

  it('continuous contention with live refreshes: the write is sent on its turn', async () => {
    const t = setup({ lanes: BUSY_LANES });
    scriptAll(t.http);
    await backgroundRead(t);
    void backgroundRead(t); // two reads already queued ahead of the write
    void backgroundRead(t);
    await flush();
    const write = t.api.addFavorite(ITEM);
    await flush(); // the write is queued before the contending reads start
    await contend(t, write, 10 * MIN, 30 * MIN);
    await write;
    const urls = t.http.requests.map((r) => r.url);
    expect(urls.indexOf(ADD_URL)).toBe(3); // A, the two reads ahead, then the write
    expect(urls.filter((u) => u === ADD_URL)).toHaveLength(1);
    expect(t.audit.entries).toHaveLength(0);
  });

  it(`continuous contention with refreshes that fall behind: gives up after ${String(WRITE_GATE_MAX_ATTEMPTS)} attempts, lane-busy audited, never silently`, async () => {
    const t = setup({ lanes: BUSY_LANES });
    scriptAll(t.http);
    await backgroundRead(t);
    const pending = t.api.addFavorite(ITEM).catch((e: unknown) => e);
    await flush();
    t.switches.delayMs = 5 * S; // every verdict is 5 s old when it lands, so every turn finds it stale
    await contend(t, pending, 3 * MIN, 120 * MIN);
    const err = await pending;
    expect(err).toBeInstanceOf(SgwApiError);
    expect((err as SgwApiError).kind).toBe('paused');
    expect((err as SgwApiError).retryAfterMs).toBeGreaterThanOrEqual(0);
    expect(t.http.requests.map((r) => r.url)).not.toContain(ADD_URL);
    expect(t.audit.entries).toEqual([
      expect.objectContaining({ kind: 'write.blocked', itemId: ITEM, details: { action: 'favorite.add', reason: 'lane-busy' } }),
    ]);
  });

  it('a write sent at once (free lane) is asked once: that check is the one right before the send', async () => {
    const t = setup();
    scriptAll(t.http);
    await t.api.removeFavorite(ITEM);
    expect(t.switches.checks).toEqual(['favorites']);
    expect(t.http.requests).toHaveLength(1);
    expect(WRITE_GATE_MAX_AGE_MS).toBeLessThanOrEqual(1000);
  });

  it('a note over 256 characters is refused before the gate and before any HTTP call', async () => {
    const t = setup();
    scriptAll(t.http);
    await rejectsWith(t.api.saveFavoriteNote(55, 'x'.repeat(FAVORITE_NOTE_MAX_CHARS + 1)), 'schema');
    expect(t.http.requests).toHaveLength(0);
    expect(t.audit.entries).toHaveLength(0);
    expect(t.failures).toHaveLength(0);
    await t.api.saveFavoriteNote(55, 'x'.repeat(FAVORITE_NOTE_MAX_CHARS));
    expect(t.http.requests).toHaveLength(1);
  });

  it('an ack with status false is a server error; isUnauthorized is auth', async () => {
    const t = setup();
    t.http.on(`${BASE}Favorite/AddToFavorite`, json({ ...ACK, status: false, message: '<b>Item</b> not found' }));
    const err = await rejectsWith(t.api.addFavorite(ITEM), 'server');
    expect(err.message).toContain('Item not found');
    t.http.on(`${BASE}Favorite/RemoveItemFromFavoriteList`, json({ ...ACK, status: false, isUnauthorized: true }));
    await rejectsWith(t.api.removeFavorite(ITEM), 'auth');
  });

  it('placeBid (T-100) with every switch open: writesAllowed asked by placeBid, then by sendWrite; one PlaceBid sent', async () => {
    const t = setup();
    scriptAll(t.http);
    t.http.on(`${BASE}ItemBid/PlaceBid`, json({ status: false, result: -999, message: 'x' }));
    const r = await t.api.placeBid({ itemId: ITEM, sellerId: 12, bidAmount: 7000, quantity: 1 }, { idempotencyKey: 'k', timeoutMs: 20 * S });
    expect(r.kind).toBe('rejected-unknown');
    expect(t.switches.checks).toEqual(['bidding', 'bidding']);
    expect(t.http.requests.filter((q) => q.url === `${BASE}ItemBid/PlaceBid`)).toHaveLength(1);
  });
});

// ── I2: BidContext.sendWrite, the guarded send T-100's live PlaceBid must use ─

describe('I2: ctx.sendWrite is the same guarded send, on the snipe lane, for bids', () => {
  const PLACE_BID = `${BASE}ItemBid/PlaceBid`;
  const BID_BODY = { itemId: ITEM, bidAmount: '70.00', sellerId: 12, quantity: 1 };

  /** Calls placeBid in capture-only mode (it rejects paused, sends nothing) and returns the BidContext it was handed. */
  async function stubContext(t: Setup): Promise<BidContext> {
    bidCapture.ctx = undefined;
    bidCapture.captureOnly = true;
    try {
      await rejectsWith(
        t.api.placeBid({ itemId: ITEM, sellerId: 12, bidAmount: 7000, quantity: 1 }, { idempotencyKey: 'k', timeoutMs: 20 * S }),
        'paused',
      );
    } finally {
      bidCapture.captureOnly = false;
    }
    expect(bidCapture.ctx).toBeDefined();
    return bidCapture.ctx as BidContext;
  }

  it("sends once on the snipe lane, credentials 'omit', with the bearer, after writesAllowed('bidding')", async () => {
    const t = setup();
    t.http.on(PLACE_BID, json({ status: true, result: 0, message: 'ok' }));
    const ctx = await stubContext(t);
    const raw = await ctx.sendWrite('placeBid', { body: BID_BODY }, (_res, r) => r);
    expect(raw).toEqual({ status: true, result: 0, message: 'ok' });
    expect(t.scheduler.runs.at(-1)).toMatchObject({ endpoint: 'placeBid', lane: 'snipe' });
    expect(t.http.requests).toHaveLength(1);
    expect(t.http.requests[0]).toMatchObject({ method: 'POST', url: PLACE_BID, credentials: 'omit', body: JSON.stringify(BID_BODY) });
    expect(header(t.http.requests[0], 'authorization')).toBe(`Bearer ${BEARER}`);
    expect(t.switches.checks).toEqual(['bidding', 'bidding']); // placeBid's own check, then sendWrite's
  });

  it('refused by writesAllowed: paused(why), audited as bid.place, ZERO HTTP', async () => {
    const t = setup();
    t.http.on(PLACE_BID, json({ status: true, result: 0, message: 'ok' }));
    const ctx = await stubContext(t);
    t.switches.killAll('kill switch');
    const err = await rejectsWith(ctx.sendWrite('placeBid', { body: BID_BODY }, (_res, r) => r), 'paused');
    expect(err.message).toBe('kill switch');
    expect(t.http.requests).toHaveLength(0);
    expect(t.audit.entries).toEqual([
      expect.objectContaining({ kind: 'bid.place', itemId: ITEM, details: { action: 'bid', why: 'kill switch' } }),
    ]);
  });

  it('a bid queued on the snipe lane is refused at its turn when the kill switch flips meanwhile', async () => {
    const snipeGap: LaneConfig = { minIntervalMs: 1 * S, jitterMs: 0, maxConcurrent: 1, dailyBudget: 80 };
    const t = setup({ lanes: { ...FAST_LANES, snipe: snipeGap } });
    scriptAll(t.http);
    t.http.on(PLACE_BID, json({ status: true, result: 0, message: 'ok' }));
    const ctx = await stubContext(t);
    await t.api.showBidModal(ITEM); // the snipe lane's 1 s gap starts
    const pending = ctx.sendWrite('placeBid', { body: BID_BODY }, (_res, r) => r).catch((e: unknown) => e);
    await flush();
    t.switches.killAll('kill switch');
    await advance(t.clock, 2 * S);
    const err = await pending;
    expect(err).toBeInstanceOf(SgwApiError);
    expect((err as SgwApiError).kind).toBe('paused');
    expect(t.http.requests.map((r) => r.url)).toEqual([`${BASE}ItemBid/ShowBidModal?itemId=${String(ITEM)}`]);
  });
});

// ── M1: concurrent itemDetail misses share one read ─────────────────────────

describe('M1: concurrent itemDetail misses share one in-flight read per (lane, item); never on the snipe lane', () => {
  it('two concurrent interactive reads of one item make one request; each caller gets its own copy', async () => {
    const t = setup();
    scriptAll(t.http);
    const [a, b] = await Promise.all([t.api.itemDetail(ITEM, 'interactive'), t.api.itemDetail(ITEM, 'interactive')]);
    expect(t.http.requests).toHaveLength(1);
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
  });

  it('a read queued on the background lane never makes an interactive caller wait behind it', async () => {
    const gap: LaneConfig = { minIntervalMs: 120 * S, jitterMs: 0, maxConcurrent: 1, dailyBudget: 100 };
    const t = setup({ lanes: { ...FAST_LANES, background: gap } });
    scriptAll(t.http);
    await t.api.search(PYREX, 'background');
    let backgroundDone = false;
    const queued = t.api.itemDetail(ITEM, 'background').then(() => {
      backgroundDone = true;
    });
    await flush();
    const now = await t.api.itemDetail(ITEM, 'interactive');
    expect(now.itemId).toBe(ITEM);
    expect(backgroundDone).toBe(false);
    expect(t.http.requests).toHaveLength(2);
    await advance(t.clock, 120 * S);
    await queued;
  });

  it('snipe-lane reads are neither cached nor shared', async () => {
    const t = setup();
    scriptAll(t.http);
    await Promise.all([t.api.itemDetail(ITEM, 'snipe'), t.api.itemDetail(ITEM, 'snipe')]);
    expect(t.http.requests).toHaveLength(2);
  });

  it('a failed shared read rejects every caller and is not remembered', async () => {
    const t = setup();
    t.http.on(`${BASE}ItemDetail/`, { status: 404, bodyText: '' }, json(loadFixture('item-detail-open')));
    const both = await Promise.all([
      t.api.itemDetail(ITEM, 'interactive').catch((e: unknown) => e),
      t.api.itemDetail(ITEM, 'interactive').catch((e: unknown) => e),
    ]);
    expect(both.map((e) => (e instanceof SgwApiError ? e.kind : e))).toEqual(['server', 'server']);
    expect(t.http.requests).toHaveLength(1);
    const d = await t.api.itemDetail(ITEM, 'interactive');
    expect(d.itemId).toBe(ITEM);
    expect(t.http.requests).toHaveLength(2);
  });
});

// ── Schema failures and health ──────────────────────────────────────────────

describe('schema failure → SgwApiError(schema) and health flagged', () => {
  it('a renamed ItemDetail field', async () => {
    const t = setup();
    const raw = loadFixture<Record<string, unknown>>('item-detail-open');
    raw.minimumBidRenamed = raw.minimumBid;
    delete raw.minimumBid;
    t.http.on(`${BASE}ItemDetail/`, json(raw));
    const err = await rejectsWith(t.api.itemDetail(ITEM, 'interactive'), 'schema');
    expect(err.message).toContain('minimumBid');
    expect(t.failures).toEqual([{ endpoint: 'itemDetail', message: err.message, at: T0 }]);
  });

  it('a search reply whose rows changed shape', async () => {
    const t = setup();
    const raw = loadFixture<{ searchResults: { items: Array<Record<string, unknown>> } }>('search-grid-p1');
    const row = raw.searchResults.items[0];
    if (row) row.endTime = 'tomorrow-ish';
    t.http.on(`${BASE}Search/ItemListing`, json(raw));
    await rejectsWith(t.api.search(PYREX, 'interactive'), 'schema');
    expect(t.failures.map((f) => f.endpoint)).toEqual(['search']);
  });

  it('a body that is not JSON', async () => {
    const t = setup();
    t.http.on(`${BASE}Favorite/GetAllFavoriteItemsByType`, { status: 200, bodyText: '<html>maintenance</html>' });
    await rejectsWith(t.api.favorites('open', 'interactive'), 'schema');
    expect(t.failures.map((f) => f.endpoint)).toEqual(['favorites']);
  });

  it('an ack that lost its status field', async () => {
    const t = setup();
    t.http.on(`${BASE}Favorite/AddToFavorite`, json({ ok: 1 }));
    await rejectsWith(t.api.addFavorite(ITEM), 'schema');
    expect(t.failures.map((f) => f.endpoint)).toEqual(['addFavorite']);
  });

  it('a sink that throws never hides the schema error', async () => {
    const clock = new FakeClock(T0);
    const http = new FakeHttp(clock);
    const scheduler = new SgwRequestScheduler({ clock, http, storage: new FakeStorage(), lanes: FAST_LANES });
    const api = new SgwApiAdapter({
      scheduler,
      clock,
      session: { current: () => Promise.resolve(null) },
      switches: new FakeSwitches(),
      audit: new FakeAuditLog(clock),
      health: {
        flagSchemaFailure: () => {
          throw new Error('sink broke');
        },
      },
      sgwClock: new SgwClockAdapter(clock),
    });
    http.on(BASE, json({ nope: true }));
    await rejectsWith(api.itemDetail(ITEM, 'interactive'), 'schema');
  });

  it('server-side and transport errors are not schema failures', async () => {
    const t = setup();
    t.http.on(`${BASE}Search/ItemListing`, json(loadFixture('search-malformed-400'), 400));
    const bad = await rejectsWith(t.api.search(PYREX, 'interactive'), 'server');
    expect(bad.status).toBe(400);
    t.http.on(`${BASE}SaveSearches/`, json({ ...ENVELOPE, status: false, message: 'nope', data: null }));
    await rejectsWith(t.api.savedSearches('interactive'), 'server');
    t.http.on(`${BASE}ItemDetail/`, { status: 404, bodyText: '' });
    const missing = await rejectsWith(t.api.itemDetail(ITEM, 'interactive'), 'server');
    expect(missing.status).toBe(404);
    t.http.on(`${BASE}ItemBid/ShowBidModal`, { status: 403, bodyText: '' });
    await rejectsWith(t.api.showBidModal(ITEM), 'blocked');
    expect(t.failures).toHaveLength(0);
  });
});

// ── R6: the itemDetail cache ────────────────────────────────────────────────

describe('R6: itemDetail cache (key item id; 60 s for open auctions; never in the last 5 min)', () => {
  const detail = (t: Setup, name = 'item-detail-open'): void => {
    t.http.on(`${BASE}ItemDetail/`, json(loadFixture(name)));
  };

  it('serves a repeat read within 60 s from the cache, and reads again at 60 s', async () => {
    const t = setup();
    detail(t);
    const first = await t.api.itemDetail(ITEM, 'background');
    t.clock.advance(DETAIL_CACHE_TTL_MS - 1);
    const second = await t.api.itemDetail(ITEM, 'interactive');
    expect(second).toEqual(first);
    expect(t.http.requests).toHaveLength(1);
    t.clock.advance(1);
    await t.api.itemDetail(ITEM, 'interactive');
    expect(t.http.requests).toHaveLength(2);
    expect(DETAIL_CACHE_TTL_MS).toBe(60 * S);
  });

  it('maxAgeMs can shorten the TTL (0 forces a read) but never lengthen it', async () => {
    const t = setup();
    detail(t);
    await t.api.itemDetail(ITEM, 'interactive');
    await t.api.itemDetail(ITEM, 'interactive', { maxAgeMs: 0 });
    expect(t.http.requests).toHaveLength(2);
    t.clock.advance(10 * S);
    await t.api.itemDetail(ITEM, 'interactive', { maxAgeMs: 5 * S });
    expect(t.http.requests).toHaveLength(3);
    t.clock.advance(59 * S);
    await t.api.itemDetail(ITEM, 'interactive', { maxAgeMs: 60 * 60 * S });
    expect(t.http.requests).toHaveLength(3);
    t.clock.advance(2 * S);
    await t.api.itemDetail(ITEM, 'interactive', { maxAgeMs: 60 * 60 * S });
    expect(t.http.requests).toHaveLength(4);
    await t.api.itemDetail(ITEM, 'interactive', { maxAgeMs: Number.NaN });
    expect(t.http.requests).toHaveLength(4); // a nonsense maxAgeMs falls back to the policy
  });

  it('never serves a cached detail inside the last 5 minutes before the end', async () => {
    const t = setup({ start: ITEM_END - DETAIL_NO_CACHE_BEFORE_END_MS - 2 * S });
    detail(t);
    await t.api.itemDetail(ITEM, 'interactive');
    t.clock.advance(1 * S);
    await t.api.itemDetail(ITEM, 'interactive');
    expect(t.http.requests).toHaveLength(1); // still outside the window: cached
    t.clock.advance(1 * S); // now exactly 5 min before the end
    await t.api.itemDetail(ITEM, 'interactive');
    await t.api.itemDetail(ITEM, 'interactive');
    expect(t.http.requests).toHaveLength(3);
    expect(DETAIL_NO_CACHE_BEFORE_END_MS).toBe(5 * MIN);
  });

  it('never caches across the end time (a read just before the end is never served after it)', async () => {
    const t = setup({ start: ITEM_END - 30 * S });
    detail(t);
    await t.api.itemDetail(ITEM, 'interactive');
    t.clock.advance(40 * S);
    await t.api.itemDetail(ITEM, 'interactive');
    expect(t.http.requests).toHaveLength(2);
  });

  it('does not cache a closed auction', async () => {
    const t = setup({ start: Date.UTC(2026, 9, 8, 7, 8, 0) });
    detail(t, 'item-detail-closed');
    const d = await t.api.itemDetail(ITEM, 'background');
    expect(d.isClosed).toBe(true);
    await t.api.itemDetail(ITEM, 'background');
    expect(t.http.requests).toHaveLength(2);
  });

  it('keys by item id, and the caller cannot mutate the cached copy', async () => {
    const t = setup();
    t.http.on(`${BASE}ItemDetail/GetItemDetailModelByItemId/${String(ITEM)}`, json(loadFixture('item-detail-open')));
    t.http.on(`${BASE}ItemDetail/GetItemDetailModelByItemId/372176454`, json(loadFixture('item-detail-pickup')));
    const a = await t.api.itemDetail(ITEM, 'interactive');
    const b = await t.api.itemDetail(372176454, 'interactive');
    expect(b.pickupOnly).toBe(true);
    a.minimumBid = 1;
    const again = await t.api.itemDetail(ITEM, 'interactive');
    expect(again.minimumBid).toBe(6801);
    expect(t.http.requests).toHaveLength(2);
  });

  it('a clock that moved backwards treats the cached detail as stale', async () => {
    const t = setup();
    detail(t);
    await t.api.itemDetail(ITEM, 'interactive');
    t.clock.set(T0 - 10 * S);
    await t.api.itemDetail(ITEM, 'interactive');
    expect(t.http.requests).toHaveLength(2);
  });

  it('reads anonymously: isHighBidder and inWatchlist are unknown (null)', async () => {
    const t = setup();
    detail(t);
    const d = await t.api.itemDetail(ITEM, 'interactive');
    expect(d.minimumBid).toBe(6801);
    expect(d.isHighBidder).toBeNull();
    expect(d.inWatchlist).toBeNull();
    expect(t.http.requests[0]?.url).toBe(`${BASE}ItemDetail/GetItemDetailModelByItemId/${String(ITEM)}`);
    expect(t.http.requests[0]?.method).toBe('GET');
  });

  it('rejects a bad item id before any HTTP call', async () => {
    const t = setup();
    detail(t);
    await rejectsWith(t.api.itemDetail(0, 'interactive'), 'schema');
    await rejectsWith(t.api.itemDetail(1.5, 'interactive'), 'schema');
    expect(t.http.requests).toHaveLength(0);
  });
});

// ── C6: itemDetail is auth 'optional': the bearer on the snipe lane only ────

describe('C6: snipe-lane itemDetail carries the bearer when there is one, and bypasses the cache', () => {
  /** item-detail-open as a logged-in leader would see it. */
  const leading = (): Record<string, unknown> => {
    const raw = loadFixture<Record<string, unknown> & { bidHistory: Record<string, unknown> }>('item-detail-open');
    raw.inWatchlist = true;
    raw.bidHistory.isHighBidderLogIn = true;
    return raw;
  };

  it('a snipe-lane read carries the bearer when the session has a token, and reads isHighBidder/inWatchlist', async () => {
    const t = setup();
    t.http.on(`${BASE}ItemDetail/`, json(leading()));
    const d = await t.api.itemDetail(ITEM, 'snipe');
    expect(header(t.http.requests[0], 'authorization')).toBe(`Bearer ${BEARER}`);
    expect(t.http.requests[0]?.credentials).toBe('omit');
    expect(d.isHighBidder).toBe(true);
    expect(d.inWatchlist).toBe(true);
  });

  it.each([
    ['no session', null],
    ['an expired session', { bearer: BEARER, expiresAt: T0 - 1, buyerId: '42' }],
  ])('a snipe-lane read with %s is anonymous and does not throw', async (_name, session) => {
    const t = setup({ session });
    t.http.on(`${BASE}ItemDetail/`, json(leading()));
    const d = await t.api.itemDetail(ITEM, 'snipe');
    expect(t.http.requests).toHaveLength(1);
    expect(header(t.http.requests[0], 'authorization')).toBeUndefined();
    expect(d.isHighBidder).toBeNull();
    expect(d.inWatchlist).toBeNull();
  });

  it.each(['background', 'interactive', 'canary'] satisfies Lane[])(
    'a %s-lane read never carries the bearer, even with a token',
    async (lane) => {
      const t = setup();
      t.http.on(`${BASE}ItemDetail/`, json(leading()));
      const d = await t.api.itemDetail(ITEM, lane);
      expect(header(t.http.requests[0], 'authorization')).toBeUndefined();
      expect(d.isHighBidder).toBeNull();
    },
  );

  it('a snipe-lane read ignores a fresh cache entry', async () => {
    const t = setup();
    t.http.on(`${BASE}ItemDetail/`, json(leading()));
    const cached = await t.api.itemDetail(ITEM, 'interactive');
    expect(cached.isHighBidder).toBeNull();
    t.clock.advance(1 * S);
    const live = await t.api.itemDetail(ITEM, 'snipe');
    expect(t.http.requests).toHaveLength(2);
    expect(live.isHighBidder).toBe(true);
  });

  it('a snipe-lane read is never written to the cache (an authenticated detail never reaches other lanes)', async () => {
    const t = setup();
    t.http.on(`${BASE}ItemDetail/`, json(leading()));
    await t.api.itemDetail(ITEM, 'snipe');
    const other = await t.api.itemDetail(ITEM, 'interactive');
    expect(t.http.requests).toHaveLength(2);
    expect(other.isHighBidder).toBeNull();
    await t.api.itemDetail(ITEM, 'interactive');
    expect(t.http.requests).toHaveLength(2); // the interactive read itself was cached
  });

  it('a snipe-lane read still makes its item the one serverTimeSample samples (anonymously, on the clock lane)', async () => {
    const t = setup();
    scriptAll(t.http);
    await t.api.itemDetail(ITEM, 'snipe');
    const sample = await t.api.serverTimeSample();
    expect(sample.source).toBe('itemDetail');
    expect(t.http.requests[1]?.url).toBe(`${BASE}ItemDetail/GetItemDetailModelByItemId/${String(ITEM)}`);
    expect(header(t.http.requests[1], 'authorization')).toBeUndefined();
  });
});

// ── serverTimeSample ────────────────────────────────────────────────────────

describe('serverTimeSample', () => {
  /** Runs `p` while the FakeHttp latency elapses on the fake clock. */
  async function withLatency<T>(t: Setup, p: Promise<T>, ms: number): Promise<T> {
    await flush();
    t.clock.advance(ms);
    return p;
  }

  it('with no known item: GetCurrentTime, sentAt/receivedAt are the real times around the HTTP call', async () => {
    const t = setup();
    t.http.on(`${BASE}Dashboard/GetCurrentTime`, { status: 200, bodyText: JSON.stringify(loadFixture('get-current-time')), latencyMs: 120 });
    const sample = await withLatency(t, t.api.serverTimeSample(), 120);
    expect(sample).toEqual<ClockSample>({
      serverMs: Date.UTC(2026, 9, 8, 3, 9, 15),
      sentAt: T0,
      receivedAt: T0 + 120,
      rttMs: 120,
      source: 'getCurrentTime',
    });
    expect(t.http.requests[0]).toMatchObject({ method: 'POST', url: `${BASE}Dashboard/GetCurrentTime` });
    expect(t.http.requests[0]?.body).toBeUndefined();
  });

  it('prefers a fresh ItemDetail read of the last open item read (never the cache)', async () => {
    const t = setup();
    t.http.on(`${BASE}ItemDetail/`, { status: 200, bodyText: JSON.stringify(loadFixture('item-detail-open')), latencyMs: 80 });
    await withLatency(t, t.api.itemDetail(ITEM, 'background'), 80);
    const sentAt = t.clock.now();
    const sample = await withLatency(t, t.api.serverTimeSample(), 80);
    expect(sample).toEqual<ClockSample>({
      serverMs: Date.UTC(2026, 9, 8, 3, 9, 15, 967),
      sentAt,
      receivedAt: sentAt + 80,
      rttMs: 80,
      source: 'itemDetail',
    });
    expect(t.http.requests).toHaveLength(2);
    expect(t.http.requests[1]?.url).toBe(`${BASE}ItemDetail/GetItemDetailModelByItemId/${String(ITEM)}`);
    expect(t.scheduler.runs[1]).toMatchObject({ lane: CLOCK_LANE, priority: CLOCK_PRIORITY });
  });

  it('falls back to GetCurrentTime once the known item has ended or read as closed', async () => {
    const t = setup();
    scriptAll(t.http);
    await t.api.itemDetail(ITEM, 'interactive');
    t.clock.set(ITEM_END + S);
    await t.api.serverTimeSample();
    expect(t.http.requests.at(-1)?.url).toBe(`${BASE}Dashboard/GetCurrentTime`);

    const u = setup({ start: Date.UTC(2026, 9, 8, 7, 8, 0) });
    scriptAll(u.http);
    u.http.on(`${BASE}ItemDetail/`, json(loadFixture('item-detail-closed')));
    await u.api.itemDetail(ITEM, 'interactive');
    await u.api.serverTimeSample();
    expect(u.http.requests.at(-1)?.url).toBe(`${BASE}Dashboard/GetCurrentTime`);
  });

  it('rejects (never guesses) when the helper refuses a backwards clock', async () => {
    const t = setup();
    t.http.on(`${BASE}Dashboard/GetCurrentTime`, { status: 200, bodyText: JSON.stringify(loadFixture('get-current-time')), latencyMs: 50 });
    const p = t.api.serverTimeSample().catch((e: unknown) => e);
    await flush();
    t.clock.set(T0 - 10 * S); // the wall clock jumps back mid-request: receivedAt < sentAt
    t.clock.advance(50);
    const err = await p;
    expect(err).toBeInstanceOf(SgwApiError);
    expect((err as SgwApiError).kind).toBe('server');
    expect((err as SgwApiError).message).toContain('clock sample');
    expect(t.failures).toHaveLength(0);
  });

  it('rejects when the helper refuses an ambiguous (fall-back hour) serverTime', async () => {
    // 2026-11-01 01:30 PT happens twice; the clock is inside that hour.
    const t = setup({ start: Date.UTC(2026, 10, 1, 8, 40, 0) });
    const raw = loadFixture<Record<string, unknown>>('item-detail-open');
    raw.endTime = '2026-11-01T03:00:00';
    raw.serverTime = '2026-11-01T01:30:00.000';
    t.http.on(`${BASE}ItemDetail/`, json(raw));
    await t.api.itemDetail(ITEM, 'interactive');
    const err = await rejectsWith(t.api.serverTimeSample(), 'server');
    expect(err.message).toContain('clock sample');
  });

  it('builds the sample with the injected SgwClock helpers', async () => {
    const calls: unknown[][] = [];
    const t = setup({
      sgwClock: {
        sampleFromServerTime: (...args) => {
          calls.push(['serverTime', ...args]);
          return null;
        },
        sampleFromGetCurrentTime: (...args) => {
          calls.push(['getCurrentTime', ...args]);
          return { serverMs: 1, sentAt: 2, receivedAt: 3, rttMs: 1, source: 'getCurrentTime' };
        },
      },
    });
    scriptAll(t.http);
    expect(await t.api.serverTimeSample()).toEqual({ serverMs: 1, sentAt: 2, receivedAt: 3, rttMs: 1, source: 'getCurrentTime' });
    expect(calls).toEqual([['getCurrentTime', '10/07/2026 20:09:15', T0, T0]]);
  });
});

// ── R5: lanes; every request goes through the scheduler ─────────────────────

describe('R5: lanes, and every request goes through the scheduler', () => {
  it('reads use the caller lane; writes the write lane; the bid modal the snipe lane; clock samples interactive', async () => {
    const t = setup();
    scriptAll(t.http);
    await t.api.search(PYREX, 'background');
    await t.api.itemDetail(ITEM, 'snipe');
    await t.api.shippingQuote(ITEM, '10001', 'background');
    await t.api.favorites('all', 'background');
    await t.api.savedSearches('interactive');
    await t.api.showBidModal(ITEM);
    await t.api.addFavorite(ITEM);
    await t.api.removeFavorite(ITEM);
    await t.api.saveFavoriteNote(55, 'n');
    await t.api.serverTimeSample();
    expect(t.scheduler.runs.map((r) => `${r.endpoint}@${r.lane}`)).toEqual([
      'search@background',
      'itemDetail@snipe',
      'shippingQuote@background',
      'favorites@background',
      'savedSearches@interactive',
      'showBidModal@snipe',
      'addFavorite@background',
      'removeFavorite@background',
      'saveFavoriteNote@background',
      'itemDetail@interactive',
    ]);
    expect(WRITE_LANE).toBe('background');
    // One scheduled run per HTTP request: nothing bypasses the scheduler.
    expect(t.http.requests).toHaveLength(t.scheduler.runs.length);
    expect(t.inner.stats().lanes.background.usedToday).toBe(6);
  });

  it('a scheduler refusal (budget, pause) surfaces unchanged and nothing is sent', async () => {
    const t = setup();
    scriptAll(t.http);
    t.scheduler.pause('test pause');
    await rejectsWith(t.api.search(PYREX, 'interactive'), 'paused');
    await rejectsWith(t.api.itemDetail(ITEM, 'interactive'), 'paused');
    expect(t.http.requests).toHaveLength(0);
  });
});

// ── Other reads ─────────────────────────────────────────────────────────────

describe('other reads', () => {
  it('shippingQuote: CalculateShipping body in the bundle field order; dollars become cents', async () => {
    const t = setup();
    scriptAll(t.http);
    expect(await t.api.shippingQuote(ITEM, ' 10001 ', 'interactive')).toEqual({ shipping: 1250, handling: 500 });
    expect(t.http.requests[0]?.url).toBe(`${BASE}ItemDetail/CalculateShipping`);
    expect(t.http.requests[0]?.body).toBe(`{"itemId":${String(ITEM)},"country":"US","province":"","zipCode":"10001","quantity":1,"clientIP":""}`);
  });

  it('shippingQuote: no quote is null; a bad ZIP is refused before any HTTP call', async () => {
    const t = setup();
    t.http.on(`${BASE}ItemDetail/CalculateShipping`, json({ shippingPrice: null, handlingPrice: null }));
    expect(await t.api.shippingQuote(ITEM, '10001-1234', 'interactive')).toBeNull();
    await rejectsWith(t.api.shippingQuote(ITEM, '1000', 'interactive'), 'schema');
    await rejectsWith(t.api.shippingQuote(ITEM, 'abcde', 'interactive'), 'schema');
    expect(t.http.requests).toHaveLength(1);
  });

  it('favorites: Type in the query, body {}, rows normalized', async () => {
    const t = setup();
    scriptAll(t.http);
    const favs = await t.api.favorites('close', 'interactive');
    expect(t.http.requests[0]).toMatchObject({ method: 'POST', url: `${BASE}Favorite/GetAllFavoriteItemsByType?Type=close`, body: '{}' });
    expect(favs).toEqual([{ itemId: ITEM, watchlistId: 55, notes: 'n', endTime: '2026-10-08T03:39:00.000Z', sellerId: 12, status: 'open' }]);
  });

  it('savedSearches: POST with no body, rows normalized to SearchQuery', async () => {
    const t = setup();
    scriptAll(t.http);
    const saved = await t.api.savedSearches('interactive');
    expect(t.http.requests[0]).toMatchObject({ method: 'POST', url: `${BASE}SaveSearches/GetSaveSearches` });
    expect(t.http.requests[0]?.body).toBeUndefined();
    expect(saved).toEqual([
      { id: 7, name: 'Pyrex', query: { searchText: 'pyrex', categoryIds: [], sellerIds: [], page: 1, lowPrice: 0, highPrice: 99999900 } },
    ]);
  });

  it('showBidModal: itemId in the query; minimumBid in cents', async () => {
    const t = setup();
    scriptAll(t.http);
    expect(await t.api.showBidModal(ITEM)).toEqual({ sellerId: 12, minimumBid: 6801 });
    expect(t.http.requests[0]).toMatchObject({ method: 'GET', url: `${BASE}ItemBid/ShowBidModal?itemId=${String(ITEM)}` });
  });

  it('every request carries a timeout', async () => {
    const t = setup();
    scriptAll(t.http);
    for (const [, call] of READ_AND_WRITE_CALLS) await call(t.api);
    for (const r of t.http.requests) expect(r.timeoutMs).toBeGreaterThan(0);
  });
});

// ── config.ts lines this card owns (rulings C6, I-29) ───────────────────────

describe('config.ts (I-29)', () => {
  it("itemDetail is auth 'optional', and SGW_CONFIG_VERSION moved past v1 for that change", () => {
    expect(SGW_ENDPOINTS.itemDetail.auth).toBe('optional');
    expect(SGW_CONFIG_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}\.\d+$/);
    expect(SGW_CONFIG_VERSION).not.toBe('2026-10-08.1');
  });
});
