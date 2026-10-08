// The T-04 fake SGW server must speak the real schemas (ledger ruling): every
// response it gives validates against src/adapters/sgw/schemas.ts and
// normalizes. Endpoints whose real shape is still provisional are held to the
// provisional schema.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  normalizeCurrentTime,
  normalizeFavorites,
  normalizeItemDetail,
  normalizePlaceBidRaw,
  normalizeSavedSearches,
  normalizeSearch,
  normalizeShippingQuote,
  normalizeShowBidModal,
} from '../../../src/adapters/sgw/normalize';
import { SgwProblemDetailsSchema, parseEndpoint } from '../../../src/adapters/sgw/schemas';
import { startFakeSgw, type FakeSgw } from '../../fakes/fake-sgw-server/server';
import { loadFixture } from './fixtures';

let sgw: FakeSgw;
const PIN = Date.parse('2026-10-08T00:00:00.000Z');

beforeAll(async () => {
  sgw = await startFakeSgw({ port: 0, scenario: { serverNowMs: PIN } });
});
afterAll(async () => {
  await sgw.close();
});

const bearer = (): Record<string, string> => ({ authorization: `Bearer ${sgw.mintToken().accessToken}` });
async function call(method: 'GET' | 'POST', path: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`${sgw.url}/api/${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    ...(method === 'POST' ? { body: JSON.stringify(body ?? {}) } : {}),
  });
  return { status: res.status, json: (await res.json()) as unknown };
}
const SEARCH = { searchText: '', page: 1, closedAuctions: 'false', sortDescending: 'false' };
const ctx = { observedAt: PIN, authenticated: false };

describe('fake server responses validate against the real schemas', () => {
  it('Search/ItemListing', async () => {
    const { json } = await call('POST', 'Search/ItemListing', SEARCH);
    parseEndpoint('search', json);
    const out = normalizeSearch(json, 1, ctx);
    expect(out.items).toHaveLength(40);
    expect(out.total).toBeGreaterThan(40);
  });

  it('ItemDetail: open, closed, anonymous and authenticated', async () => {
    const open = await call('GET', 'ItemDetail/GetItemDetailModelByItemId/279250057');
    parseEndpoint('itemDetail', open.json);
    const d = normalizeItemDetail(open.json, ctx);
    expect(d.minimumBid).toBe(1700);
    expect(d.startingMinimumBid).toBe(1299);
    expect(d.isClosed).toBe(false);
    expect(d.sellerState).toBeDefined();
    expect(d.bidHistory.length).toBeGreaterThan(0);
    const authed = await call('GET', 'ItemDetail/GetItemDetailModelByItemId/279250057', undefined, bearer());
    expect(normalizeItemDetail(authed.json, { ...ctx, authenticated: true }).inWatchlist).toBe(true);
    const closed = await call('GET', 'ItemDetail/GetItemDetailModelByItemId/279199001');
    expect(normalizeItemDetail(closed.json, ctx).isClosed).toBe(true);
  });

  it('GetCurrentTime', async () => {
    const { json } = await call('POST', 'Dashboard/GetCurrentTime');
    parseEndpoint('currentTime', json);
    expect(Math.abs(normalizeCurrentTime(json) - PIN)).toBeLessThan(5000);
  });

  it('CalculateShipping (provisional shape)', async () => {
    const { json } = await call('POST', 'itemDetail/CalculateShipping', { itemId: 279250057, zipCode: '98101' });
    parseEndpoint('shippingQuote', json);
    expect(normalizeShippingQuote(json)).not.toBeNull();
  });

  it('favorites, add/remove, saved searches (provisional shapes)', async () => {
    const h = bearer();
    const added = await call('GET', 'Favorite/AddToFavorite?itemId=279250102', undefined, h);
    parseEndpoint('addFavorite', added.json);
    const favs = await call('POST', 'Favorite/GetAllFavoriteItemsByType?Type=all', {}, h);
    parseEndpoint('favorites', favs.json);
    expect(normalizeFavorites(favs.json, PIN).some((f) => f.itemId === 279250102)).toBe(true);
    const removed = await call('GET', 'Favorite/RemoveItemFromFavoriteList?itemId=279250102', undefined, h);
    parseEndpoint('removeFavorite', removed.json);
    const saved = await call('POST', 'SaveSearches/GetSaveSearches', undefined, h);
    parseEndpoint('savedSearches', saved.json);
    expect(normalizeSavedSearches(saved.json).length).toBeGreaterThan(0);
  });

  it('ShowBidModal and PlaceBid (provisional shapes)', async () => {
    const h = bearer();
    const modal = await call('GET', 'ItemBid/ShowBidModal?itemId=279250102', undefined, h);
    parseEndpoint('showBidModal', modal.json);
    expect(normalizeShowBidModal(modal.json).minimumBid).toBe(400);
    const bid = await call('POST', 'ItemBid/PlaceBid', { itemId: 279250102, bidAmount: '4.00', sellerId: 31, quantity: 1 }, h);
    parseEndpoint('placeBid', bid.json);
    const raw = normalizePlaceBidRaw(bid.json);
    expect(raw.messageText).not.toContain('<');
    const closed = await call('POST', 'ItemBid/PlaceBid', { itemId: 279199001, bidAmount: '4.00', sellerId: 31, quantity: 1 }, h);
    expect(normalizePlaceBidRaw(closed.json).rawResult).toBe(-3);
  });

  it('SignIn/RefreshToken and RevokeToken', async () => {
    const r = await call('POST', 'SignIn/RefreshToken', { refreshToken: 'x' });
    parseEndpoint('refreshToken', r.json);
    const rv = await call('POST', 'SignIn/RevokeToken', {}, bearer());
    parseEndpoint('revokeToken', rv.json);
  });
});

describe('fake search matches the real malformed-input behavior (S-1 #7, #10)', () => {
  it('unparseable selectedCategoryIds: 200 with unfiltered rows (search-malformed-200)', async () => {
    const real = normalizeSearch(loadFixture('search-malformed-200'), 1, ctx);
    expect(real.items).toHaveLength(40);
    const { status, json } = await call('POST', 'Search/ItemListing', { ...SEARCH, selectedCategoryIds: 'not-a-number' });
    expect(status).toBe(200);
    const fake = normalizeSearch(json, 1, ctx);
    const all = normalizeSearch((await call('POST', 'Search/ItemListing', SEARCH)).json, 1, ctx);
    expect(fake.items).toHaveLength(40);
    expect(fake.total).toBe(all.total);
    expect(fake.items.map((i) => i.itemId)).toEqual(all.items.map((i) => i.itemId));
  });

  it('non-numeric lowPrice/highPrice: 400 problem+json (search-malformed-400)', async () => {
    const { status, json } = await call('POST', 'Search/ItemListing', { ...SEARCH, lowPrice: 'abc', highPrice: 'xyz' });
    expect(status).toBe(400);
    const p = SgwProblemDetailsSchema.parse(json);
    expect(Object.keys(p.errors ?? {}).sort()).toEqual(['highPrice', 'lowPrice']);
  });
});
