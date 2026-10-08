import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { epochToPacificNaive, pacificNaiveToEpoch } from './clock';
import { loadSeed } from './seed/loader';
import { startFakeSgw, type FakeSgw } from './server';
import {
  AckResponseSchema,
  CalculateShippingResponseSchema,
  ErrorBodySchema,
  FavoritesResponseSchema,
  GetCurrentTimeResponseSchema,
  ItemDetailResponseSchema,
  ItemListingResponseSchema,
  LogResponseSchema,
  MintedTokenSchema,
  PlaceBidResponseSchema,
  SavedSearchesResponseSchema,
  ShowBidModalResponseSchema,
  TokenResponseSchema,
} from './shapes';

let sgw: FakeSgw;
let bearer: string;

beforeAll(async () => {
  sgw = await startFakeSgw({ port: 0 });
});
afterAll(async () => {
  await sgw.close();
});
// The seed has fixed end times, so pin the server clock for deterministic open/closed state.
const PIN = Date.parse('2026-10-08T00:00:00.000Z');
beforeEach(async () => {
  await post('/__scenario', { reset: true, serverNowMs: PIN });
  await fetch(`${sgw.url}/__log`, { method: 'DELETE' });
  bearer = sgw.mintToken().accessToken;
});

function post(path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${sgw.url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body ?? {}),
  });
}
const get = (path: string, headers: Record<string, string> = {}): Promise<Response> =>
  fetch(`${sgw.url}${path}`, { headers });
const authed = { authorization: '' };
function auth(): Record<string, string> {
  authed.authorization = `Bearer ${bearer}`;
  return { ...authed };
}
async function parse<S extends z.ZodType>(res: Response, schema: S): Promise<z.infer<S>> {
  return schema.parse(await res.json());
}
const SEARCH = { searchText: '', page: 1, closedAuctions: 'false', sortDescending: 'false' };

describe('seed and clock helpers', () => {
  it('loads hand-written samples: fractional naive-PT endTimes, 40+ rows', () => {
    const seed = loadSeed();
    expect(seed.items.length).toBeGreaterThan(80);
    expect(seed.items.some((i) => /\.\d+$/.test(i.endTime ?? ''))).toBe(true);
  });
  it('round-trips naive Pacific across DST', () => {
    expect(new Date(pacificNaiveToEpoch('2026-07-01T12:00:00')).toISOString()).toBe('2026-07-01T19:00:00.000Z');
    expect(new Date(pacificNaiveToEpoch('2026-12-01T12:00:00.5')).toISOString()).toBe('2026-12-01T20:00:00.500Z');
    expect(epochToPacificNaive(Date.parse('2026-07-01T19:00:00.123Z'), true)).toBe('2026-07-01T12:00:00.123');
  });
});

describe('endpoint responses validate against the local shapes', () => {
  it('Search/ItemListing: 40 rows per page, string-boolean body, maxTotalRecords', async () => {
    const res = await post('/api/Search/ItemListing', { ...SEARCH, pageSize: 10 });
    expect(res.status).toBe(200);
    const body = await parse(res, ItemListingResponseSchema);
    expect(body.searchResults.items).toHaveLength(40);
    expect(body.searchResults.itemCount).toBeGreaterThan(40);
    const p2 = await parse(await post('/api/Search/ItemListing', { ...SEARCH, page: 2 }), ItemListingResponseSchema);
    expect(p2.searchResults.items[0]?.itemId).not.toBe(body.searchResults.items[0]?.itemId);
  });
  it('Search: filters by text and reports isFavorite only when authenticated', async () => {
    const q = { ...SEARCH, searchText: 'pyrex butterprint' };
    const anon = await parse(await post('/api/Search/ItemListing', q), ItemListingResponseSchema);
    expect(anon.searchResults.items.map((i) => i.itemId)).toEqual([279250057]);
    expect(anon.searchResults.items[0]?.isFavorite).toBe(false);
    const withAuth = await parse(await post('/api/Search/ItemListing', q, auth()), ItemListingResponseSchema);
    expect(withAuth.searchResults.items[0]?.isFavorite).toBe(true);
  });
  it('ItemDetail: serverTime has ms, minimumBid differs from the search-row value', async () => {
    const d = await parse(await get('/api/ItemDetail/GetItemDetailModelByItemId/279250057'), ItemDetailResponseSchema);
    expect(d.minimumBid).toBe(17);
    expect(d.endTime).toBe('2026-10-08T19:18:30.45');
    expect(d.inWatchlist).toBeNull();
    const row = (await parse(await post('/api/Search/ItemListing', { ...SEARCH, searchText: 'butterprint' }), ItemListingResponseSchema))
      .searchResults.items[0];
    expect(row?.minimumBid).toBe(12.99);
    const a = await parse(await get('/api/ItemDetail/GetItemDetailModelByItemId/279250057', auth()), ItemDetailResponseSchema);
    expect(a.inWatchlist).toBe(true);
  });
  it('ItemDetail: unknown item is 404, closed item is flagged', async () => {
    expect((await get('/api/ItemDetail/GetItemDetailModelByItemId/1')).status).toBe(404);
    const d = await parse(await get('/api/ItemDetail/GetItemDetailModelByItemId/279199001'), ItemDetailResponseSchema);
    expect(d.isClosed).toBe(true);
  });
  it('Dashboard/GetCurrentTime: seconds only', async () => {
    await parse(await post('/api/Dashboard/GetCurrentTime'), GetCurrentTimeResponseSchema);
  });
  it('CalculateShipping', async () => {
    await parse(await post('/api/itemDetail/CalculateShipping', { itemId: 279250057, zipCode: '98101' }), CalculateShippingResponseSchema);
  });
  it('favorites: add, list, note, remove, saved searches', async () => {
    const h = auth();
    await parse(await get('/api/Favorite/AddToFavorite?itemId=279250102', h), AckResponseSchema);
    let favs = await parse(await post('/api/Favorite/GetAllFavoriteItemsByType?Type=open', {}, h), FavoritesResponseSchema);
    const added = favs.find((f) => f.itemId === 279250102);
    expect(added).toBeDefined();
    expect(favs.some((f) => f.itemId === 279199001)).toBe(false); // closed
    const closed = await parse(await post('/api/Favorite/GetAllFavoriteItemsByType?Type=close', {}, h), FavoritesResponseSchema);
    expect(closed.map((f) => f.itemId)).toEqual([279199001]);
    await parse(await post('/api/Favorite/Save', { notes: 'max 9', watchlistId: added?.watchlistId }, h), AckResponseSchema);
    favs = await parse(await post('/api/Favorite/GetAllFavoriteItemsByType?Type=all', {}, h), FavoritesResponseSchema);
    expect(favs.find((f) => f.itemId === 279250102)?.notes).toBe('max 9');
    await parse(await get('/api/Favorite/RemoveItemFromFavoriteList?itemId=279250102', h), AckResponseSchema);
    favs = await parse(await post('/api/Favorite/GetAllFavoriteItemsByType?Type=all', {}, h), FavoritesResponseSchema);
    expect(favs.some((f) => f.itemId === 279250102)).toBe(false);
    await parse(await post('/api/SaveSearches/GetSaveSearches', {}, h), SavedSearchesResponseSchema);
  });
  it('bidding endpoints are stubs returning result -3', async () => {
    const h = auth();
    await parse(await get('/api/ItemBid/ShowBidModal?itemId=279250057', h), ShowBidModalResponseSchema);
    const r = await parse(
      await post('/api/ItemBid/PlaceBid', { itemId: 279250057, bidAmount: '20.00', sellerId: 31, quantity: 1 }, h),
      PlaceBidResponseSchema,
    );
    expect(r.result).toBe(-3);
  });
  it('unknown path 404, wrong method 405', async () => {
    expect((await get('/api/Nope')).status).toBe(404);
    expect((await get('/api/Search/ItemListing')).status).toBe(405);
  });
});

describe('SGW quirks', () => {
  it('double quote in searchText is 403', async () => {
    const res = await post('/api/Search/ItemListing', { ...SEARCH, searchText: '"pyrex"' });
    expect(res.status).toBe(403);
    await parse(res, ErrorBodySchema);
  });
  it('malformed bodies and real-boolean bodies are 200 with zero rows', async () => {
    for (const body of ['{not json', '[]', JSON.stringify({ ...SEARCH, closedAuctions: false }), '{}']) {
      const res = await post('/api/Search/ItemListing', body);
      expect(res.status).toBe(200);
      const b = await parse(res, ItemListingResponseSchema);
      expect(b.searchResults.items).toHaveLength(0);
    }
  });
  it('bearer validation: missing/garbage/expired is 401, valid passes', async () => {
    expect((await get('/api/Favorite/AddToFavorite?itemId=279250102')).status).toBe(401);
    expect((await get('/api/Favorite/AddToFavorite?itemId=279250102', { authorization: 'Bearer a.b.c' })).status).toBe(401);
    const expired = sgw.mintToken({ expiresInMs: -1000 }).accessToken;
    expect((await get('/api/Favorite/AddToFavorite?itemId=279250102', { authorization: `Bearer ${expired}` })).status).toBe(401);
    expect((await get('/api/Favorite/AddToFavorite?itemId=279250102', auth())).status).toBe(200);
  });
  it('configurable token expiry via /__token and SignIn/RefreshToken', async () => {
    const t = await parse(await post('/__token', { expiresInMs: 120_000 }), MintedTokenSchema);
    expect(t.expiresAtMs - PIN).toBeGreaterThan(100_000);
    expect(t.expiresAtMs - PIN).toBeLessThan(200_000);
    await post('/__scenario', { tokenLifetimeMs: 5000 });
    const r = await parse(await post('/api/SignIn/RefreshToken', { refreshToken: 'x', clientIpAddress: '1.2.3.4' }), TokenResponseSchema);
    const claims = JSON.parse(Buffer.from(r.accessToken.split('.')[1] ?? '', 'base64url').toString()) as { exp: number };
    expect(claims.exp * 1000 - PIN).toBeLessThan(10_000);
  });
  it('Bid cookie makes the next bid call 403', async () => {
    await post('/__scenario', { bidSetsCookie: true });
    const bid = { itemId: 279250057, bidAmount: '20.00', sellerId: 31, quantity: 1 };
    const first = await post('/api/ItemBid/PlaceBid', bid, auth());
    expect(first.headers.get('set-cookie')).toContain('Bid=1');
    const second = await post('/api/ItemBid/PlaceBid', bid, { ...auth(), cookie: 'Bid=1' });
    expect(second.status).toBe(403);
  });
});

describe('scenario toggles', () => {
  it('skew shifts serverTime and GetCurrentTime', async () => {
    const before = PIN;
    await post('/__scenario', { skewMs: 600_000 });
    const d = await parse(await get('/api/ItemDetail/GetItemDetailModelByItemId/279250057'), ItemDetailResponseSchema);
    const skewed = pacificNaiveToEpoch(d.serverTime);
    expect(skewed - before).toBeGreaterThan(599_000);
    expect(skewed - before).toBeLessThan(605_000);
    const t = await parse(await post('/api/Dashboard/GetCurrentTime'), GetCurrentTimeResponseSchema);
    expect(pacificNaiveToEpoch(t) - before).toBeGreaterThan(598_000);
  });
  it('latency is at least the configured value, per endpoint', async () => {
    await post('/__scenario', { latencyMs: { 'Dashboard/GetCurrentTime': 200 } });
    let t0 = performance.now();
    await post('/api/Dashboard/GetCurrentTime');
    expect(performance.now() - t0).toBeGreaterThanOrEqual(195);
    t0 = performance.now();
    await get('/api/ItemDetail/GetItemDetailModelByItemId/279250057');
    expect(performance.now() - t0).toBeLessThan(150);
  });
  it('injected errors: 429 with Retry-After, 5xx, times-limited, clearable', async () => {
    await post('/__scenario', { name: 'rate-limited' });
    const r = await post('/api/Dashboard/GetCurrentTime');
    expect(r.status).toBe(429);
    expect(r.headers.get('retry-after')).toBe('30');
    await post('/__scenario', { reset: true, serverNowMs: PIN, errors: { 'Search/ItemListing': { status: 503, times: 2 } } });
    expect((await post('/api/Search/ItemListing', SEARCH)).status).toBe(503);
    expect((await post('/api/Search/ItemListing', SEARCH)).status).toBe(503);
    expect((await post('/api/Search/ItemListing', SEARCH)).status).toBe(200);
    await post('/__scenario', { errors: { '*': { status: 403 } } });
    expect((await post('/api/Dashboard/GetCurrentTime')).status).toBe(403);
    await post('/__scenario', { errors: { '*': null } });
    expect((await post('/api/Dashboard/GetCurrentTime')).status).toBe(200);
  });
  it('pinned server clock ticks from serverNowMs; unknown preset is 400', async () => {
    await post('/__scenario', { serverNowMs: Date.parse('2026-10-08T19:18:00.000Z') });
    const t = await parse(await post('/api/Dashboard/GetCurrentTime'), GetCurrentTimeResponseSchema);
    expect(t).toBe('2026-10-08T12:18:00');
    expect((await post('/__scenario', { name: 'nope' })).status).toBe(400);
  });
  it('startFakeSgw accepts a named scenario', async () => {
    const other = await startFakeSgw({ port: 0, scenario: 'skew-minus-5s' });
    try {
      const s = (await (await fetch(`${other.url}/__scenario`)).json()) as { scenario: { skewMs: number } };
      expect(s.scenario.skewMs).toBe(-5000);
    } finally {
      await other.close();
    }
  });
});

describe('request log', () => {
  it('stamps requests with the client-declared fake time', async () => {
    const fake = Date.parse('2026-10-08T19:18:00.000Z');
    await post('/api/Dashboard/GetCurrentTime', {}, { 'x-sbw-fake-now': String(fake) });
    await get('/api/Nope');
    await post('/api/Search/ItemListing', SEARCH, { 'x-sbw-fake-now': '2026-10-08T19:18:01.500Z', ...auth() });
    const log = await parse(await get('/__log'), LogResponseSchema);
    expect(log.entries.map((e) => [e.endpoint, e.status])).toEqual([
      ['Dashboard/GetCurrentTime', 200],
      ['/api/Nope', 404],
      ['Search/ItemListing', 200],
    ]);
    expect(log.entries[0]?.fakeNowMs).toBe(fake);
    expect(log.entries[0]?.requestTimeMs).toBe(fake);
    expect(log.entries[1]?.fakeNowMs).toBeNull();
    expect(log.entries[2]?.fakeNowMs).toBe(Date.parse('2026-10-08T19:18:01.500Z'));
    expect(log.entries[2]?.hasBearer).toBe(true);
    expect(log.entries[1]?.requestTimeMs).toBe(log.entries[1]?.receivedAtMs);
  });
});
