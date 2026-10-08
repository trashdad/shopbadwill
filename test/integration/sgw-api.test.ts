// T-26 integration: SgwApiAdapter → real RequestScheduler (T-25) → real
// BrowserHttp (T-34, fetch) → MSW. MSW answers with the T-07 fixtures; any
// request without a handler fails the test (test/setup/vitest.setup.ts), so no
// request can reach the real SGW (R7). The audit log is the real one (T-35's
// Repo + T-41's createAuditLog) over in-memory storage.
import { http, HttpResponse } from 'msw';
import { afterEach, describe, expect, it } from 'vitest';

import { BrowserHttp } from '../../src/adapters/browser/http';
import { SgwApiAdapter, type SchemaFailure, type WriteFeature, type WriteSwitches } from '../../src/adapters/sgw/api-adapter';
import { SgwClockAdapter } from '../../src/adapters/sgw/clock-adapter';
import { searchQueryFromUrl } from '../../src/adapters/sgw/query-url';
import { SgwRequestScheduler } from '../../src/adapters/sgw/request-scheduler';
import { createAuditLog } from '../../src/domain/audit/log';
import { Repo } from '../../src/domain/storage/repo';
import type { Lane, LaneConfig, SearchQuery } from '../../src/domain/types';
import { SgwApiError } from '../../src/ports/errors';
import { SGW_FIXTURES, loadFixture } from '../contract/sgw/fixtures';
import { FakeClock } from '../fakes/ports/fake-clock';
import { FakeStorage } from '../fakes/ports/fake-storage';
import { FakeSwitches } from '../fakes/ports/fake-switches';
import { mswServer } from '../setup/vitest.setup';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const BASE = 'https://buyerapi.shopgoodwill.com/api/';
const T0 = Date.UTC(2026, 9, 8, 3, 9, 16);
const ITEM = 702801256;
const BEARER = 'hhhh.pppp.ssss';

const ZERO_GAP: LaneConfig = { minIntervalMs: 0, jitterMs: 0, maxConcurrent: 1, dailyBudget: 1000 };
const FAST_LANES: Record<Lane, LaneConfig> = { interactive: ZERO_GAP, background: ZERO_GAP, snipe: ZERO_GAP, canary: ZERO_GAP };

class Switches extends FakeSwitches implements WriteSwitches {
  killSwitch = false;
  dryRun: Record<WriteFeature, boolean> = { favorites: false, bidding: false };
  state(feature: WriteFeature): { killSwitch: boolean; dryRun: boolean } {
    return { killSwitch: this.killSwitch, dryRun: this.dryRun[feature] };
  }
  override writesAllowed(feature: 'favorites' | 'calendar' | 'bidding'): Promise<{ ok: boolean; why?: string }> {
    if (this.killSwitch) return Promise.resolve({ ok: false, why: 'kill switch' });
    if (feature !== 'calendar' && this.dryRun[feature]) return Promise.resolve({ ok: false, why: 'dry run' });
    return super.writesAllowed(feature);
  }
}

interface Seen {
  method: string;
  url: string;
  credentials: RequestCredentials;
  cookie: string | null;
  authorization: string | null;
  body: string;
}

/** Every request MSW saw, handled or not (the ZERO-HTTP assertions count these). */
const started: string[] = [];
mswServer.events.on('request:start', ({ request }) => {
  started.push(`${request.method} ${request.url}`);
});
afterEach(() => {
  started.length = 0;
});

function setup(start = T0) {
  const clock = new FakeClock(start);
  const scheduler = new SgwRequestScheduler({
    clock,
    http: new BrowserHttp({ now: () => clock.now(), isOnline: () => true }),
    storage: new FakeStorage(),
    random: () => 0,
    lanes: FAST_LANES,
  });
  const audit = createAuditLog(new Repo({ local: new FakeStorage(), session: new FakeStorage() }, clock));
  const switches = new Switches();
  const failures: SchemaFailure[] = [];
  const api = new SgwApiAdapter({
    scheduler,
    clock,
    session: { current: () => Promise.resolve({ bearer: BEARER, expiresAt: start + 86_400_000, buyerId: '42' }) },
    switches,
    audit,
    health: {
      flagSchemaFailure: (f) => {
        failures.push(f);
      },
    },
    sgwClock: new SgwClockAdapter(clock),
  });
  const seen: Seen[] = [];
  const record = async (request: Request): Promise<void> => {
    seen.push({
      method: request.method,
      url: request.url,
      credentials: request.credentials,
      cookie: request.headers.get('cookie'),
      authorization: request.headers.get('authorization'),
      body: await request.clone().text(),
    });
  };
  return { clock, scheduler, audit, switches, failures, api, seen, record };
}

type Setup = ReturnType<typeof setup>;
const ENVELOPE = { message: 'Ok', status: true, type: null, primaryKey: null, isUnauthorized: false };

/** MSW handlers for every endpoint, recording what arrived. */
function serveAll(t: Setup, detail: unknown = loadFixture('item-detail-open')): void {
  const reply =
    (body: () => unknown) =>
    async ({ request }: { request: Request }) => {
      await t.record(request);
      return HttpResponse.json(body() as Record<string, unknown>);
    };
  mswServer.use(
    http.post(`${BASE}Search/ItemListing`, reply(() => loadFixture('search-grid-p1'))),
    http.get(`${BASE}ItemDetail/GetItemDetailModelByItemId/:id`, reply(() => detail)),
    http.post(`${BASE}Dashboard/GetCurrentTime`, reply(() => loadFixture('get-current-time'))),
    http.post(`${BASE}ItemDetail/CalculateShipping`, reply(() => ({ shippingPrice: 9.99, handlingPrice: 2 }))),
    http.post(
      `${BASE}Favorite/GetAllFavoriteItemsByType`,
      reply(() => ({ ...ENVELOPE, data: [{ itemId: ITEM, watchlistId: 55, notes: null, endTime: '2026-10-07T20:39:00', sellerId: 12 }] })),
    ),
    http.get(`${BASE}Favorite/AddToFavorite`, reply(() => ENVELOPE)),
    http.get(`${BASE}Favorite/RemoveItemFromFavoriteList`, reply(() => ENVELOPE)),
    http.post(`${BASE}Favorite/Save`, reply(() => ENVELOPE)),
    http.post(`${BASE}SaveSearches/GetSaveSearches`, reply(() => ({ ...ENVELOPE, data: [] }))),
    http.get(`${BASE}ItemBid/ShowBidModal`, reply(() => ({ sellerId: 12, minimumBid: 68.01 }))),
  );
}

function recordedSearch(fixture: string): { body: string; capturedAt: number } {
  const m = JSON.parse(readFileSync(path.join(SGW_FIXTURES, 'manifest.json'), 'utf8')) as {
    fixtures: Array<{ fixture: string; capturedAt: string; requestBody?: unknown }>;
  };
  const e = m.fixtures.find((f) => f.fixture === fixture);
  if (e?.requestBody === undefined) throw new Error(`no recorded body for ${fixture}`);
  return { body: JSON.stringify(e.requestBody), capturedAt: new Date(e.capturedAt).getTime() };
}

async function kindOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'resolved';
  } catch (e) {
    return e instanceof SgwApiError ? e.kind : `not an SgwApiError: ${String(e)}`;
  }
}

describe('SgwApiAdapter over the real scheduler, fetch and MSW', () => {
  it.each([
    ['search-grid-p1', { searchText: 'pyrex', categoryIds: [], sellerIds: [], page: 1, layout: 'grid' }, 40],
    ['search-list-p1', { searchText: 'vintage camera', categoryIds: [], sellerIds: [], page: 1, layout: 'list' }, 40],
    ['search-empty', { searchText: 'zqxjvw unicornium plinth', categoryIds: [], sellerIds: [], page: 1 }, 0],
  ] satisfies Array<[string, SearchQuery, number]>)(
    '%s: the ItemListing body on the wire is the recorded one, byte-for-byte',
    async (fixture, q, rows) => {
      const recorded = recordedSearch(fixture);
      const t = setup(recorded.capturedAt);
      mswServer.use(
        http.post(`${BASE}Search/ItemListing`, async ({ request }) => {
          await t.record(request);
          return HttpResponse.json(loadFixture<Record<string, unknown>>(fixture));
        }),
      );
      const out = await t.api.search(q, 'interactive');
      expect(t.seen).toHaveLength(1);
      expect(t.seen[0]?.body).toBe(recorded.body);
      expect(out.items).toHaveLength(rows);
    },
  );

  it("every method: credentials 'omit', no cookie, and the bearer only on auth endpoints", async () => {
    const t = setup();
    serveAll(t);
    await t.api.search({ searchText: '"pyrex"', categoryIds: [], sellerIds: [], page: 1, pickupOnly: true }, 'interactive');
    await t.api.itemDetail(ITEM, 'interactive');
    await t.api.shippingQuote(ITEM, '10001', 'interactive');
    await t.api.serverTimeSample();
    await t.api.favorites('open', 'interactive');
    await t.api.savedSearches('interactive');
    await t.api.showBidModal(ITEM);
    await t.api.addFavorite(ITEM);
    await t.api.removeFavorite(ITEM);
    await t.api.saveFavoriteNote(55, 'note');
    const auth = (s: Seen): boolean => s.authorization !== null;
    expect(t.seen.map((s) => `${s.method} ${new URL(s.url).pathname}${auth(s) ? ' +bearer' : ''}`)).toEqual([
      'POST /api/Search/ItemListing',
      `GET /api/ItemDetail/GetItemDetailModelByItemId/${String(ITEM)}`,
      'POST /api/ItemDetail/CalculateShipping',
      `GET /api/ItemDetail/GetItemDetailModelByItemId/${String(ITEM)}`, // the clock sample re-reads the known item
      'POST /api/Favorite/GetAllFavoriteItemsByType +bearer',
      'POST /api/SaveSearches/GetSaveSearches +bearer',
      'GET /api/ItemBid/ShowBidModal +bearer',
      'GET /api/Favorite/AddToFavorite +bearer',
      'GET /api/Favorite/RemoveItemFromFavoriteList +bearer',
      'POST /api/Favorite/Save +bearer',
    ]);
    for (const s of t.seen) {
      expect(s.credentials).toBe('omit');
      expect(s.cookie).toBeNull();
      if (auth(s)) expect(s.authorization).toBe(`Bearer ${BEARER}`);
    }
    // String booleans and no quotes reached the wire.
    const searchBody = JSON.parse(t.seen[0]?.body ?? '{}') as Record<string, unknown>;
    expect(searchBody.searchText).toBe('pyrex');
    expect(searchBody.searchPickupOnly).toBe('true');
  });

  it('a write in dry-run records an audit intent and makes ZERO HTTP requests', async () => {
    const t = setup();
    t.switches.dryRun.favorites = true;
    t.switches.dryRun.bidding = true;
    expect(await kindOf(t.api.addFavorite(ITEM))).toBe('paused');
    expect(await kindOf(t.api.removeFavorite(ITEM))).toBe('paused');
    expect(await kindOf(t.api.saveFavoriteNote(55, 'note'))).toBe('paused');
    expect(
      await kindOf(t.api.placeBid({ itemId: ITEM, sellerId: 12, bidAmount: 7000, quantity: 1 }, { idempotencyKey: 'k', timeoutMs: 20_000 })),
    ).toBe('paused');
    expect(started).toEqual([]);
    const entries = await t.audit.list({ limit: 10 });
    expect(entries.map((e) => [e.kind, e.itemId ?? e.ref, e.dryRun, e.details])).toEqual([
      ['bid.place', ITEM, true, { action: 'bid' }],
      ['favorite.note', 'watchlist:55', true, { action: 'note' }],
      ['favorite.remove', ITEM, true, { action: 'remove' }],
      ['favorite.add', ITEM, true, { action: 'add' }],
    ]);
  });

  it('a write with the kill switch on makes ZERO HTTP requests and is audited as blocked', async () => {
    const t = setup();
    t.switches.killSwitch = true;
    expect(await kindOf(t.api.addFavorite(ITEM))).toBe('paused');
    expect(started).toEqual([]);
    const [entry] = await t.audit.list({ limit: 1 });
    expect(entry).toMatchObject({ kind: 'write.blocked', itemId: ITEM, details: { action: 'favorite.add', reason: 'kill-switch' } });
  });

  it('R1: a search URL with an unparseable filter never reaches SGW', async () => {
    const t = setup();
    for (const url of [
      'https://shopgoodwill.com/categories/listing?st=pyrex&lp=abc&hp=xyz',
      'https://shopgoodwill.com/categories/listing?st=pyrex&c=abc',
    ]) {
      const q = searchQueryFromUrl(url);
      if (q === null) throw new Error('fixture URL did not parse');
      expect(await kindOf(t.api.search(q, 'interactive'))).toBe('schema');
    }
    expect(started).toEqual([]);
    expect(t.failures).toEqual([]);
  });

  it('a renamed response field → SgwApiError(schema) and health flagged', async () => {
    const t = setup();
    const raw = loadFixture<Record<string, unknown>>('item-detail-open');
    raw.serverTimeUtc = raw.serverTime;
    delete raw.serverTime;
    serveAll(t, raw);
    expect(await kindOf(t.api.itemDetail(ITEM, 'interactive'))).toBe('schema');
    expect(t.failures).toHaveLength(1);
    expect(t.failures[0]).toMatchObject({ endpoint: 'itemDetail', at: T0 });
    expect(t.failures[0]?.message).toContain('serverTime');
  });

  it('serverTimeSample samples the known item’s ItemDetail serverTime', async () => {
    const t = setup();
    serveAll(t);
    await t.api.itemDetail(ITEM, 'background');
    const sample = await t.api.serverTimeSample();
    expect(sample).toMatchObject({ source: 'itemDetail', serverMs: Date.UTC(2026, 9, 8, 3, 9, 15, 967), sentAt: T0, receivedAt: T0 });
  });

  it('a 403 from SGW is `blocked`, and the lane then refuses locally without another request', async () => {
    const t = setup();
    mswServer.use(http.get(`${BASE}ItemBid/ShowBidModal`, () => new HttpResponse(null, { status: 403 })));
    expect(await kindOf(t.api.showBidModal(ITEM))).toBe('blocked');
    expect(started).toHaveLength(1);
    expect(await kindOf(t.api.showBidModal(ITEM))).toBe('blocked');
    expect(started).toHaveLength(1);
  });
});
