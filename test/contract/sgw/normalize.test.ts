import { describe, expect, it } from 'vitest';
import {
  dollarsToCents,
  htmlToText,
  normalizeCurrentTime,
  normalizeFavorites,
  normalizeItemDetail,
  normalizePlaceBidRaw,
  normalizeSavedSearches,
  normalizeSearch,
  normalizeSellerInfo,
  normalizeShippingQuote,
  normalizeShowBidModal,
} from '../../../src/adapters/sgw/normalize';
import { ItemDetailSchema, ListingSchema } from '../../../src/domain/types';
import { SgwApiError } from '../../../src/ports/errors';
import { loadFixture } from './fixtures';

const ctx = { observedAt: 1_760_000_000_000, authenticated: false };
const sctx = { ...ctx, query: { page: 1 } };

interface RawSearch {
  searchResults: { items: Array<{ minimumBid: number; shippingPrice: number }>; itemCount: number };
}

describe('search normalization', () => {
  it('maps every fixture row to a valid Listing; search minimumBid becomes startingMinimumBid', () => {
    for (const name of ['search-grid-p1', 'search-list-p1', 'search-malformed-200']) {
      const raw = loadFixture<RawSearch>(name);
      const out = normalizeSearch(raw, sctx);
      expect(out.items).toHaveLength(40);
      expect(out.total).toBe(raw.searchResults.itemCount);
      out.items.forEach((l, i) => {
        ListingSchema.parse(l);
        expect(l.startingMinimumBid).toBe(Math.round((raw.searchResults.items[i]?.minimumBid ?? 0) * 100));
        expect(l.source).toBe('api');
        expect('minimumBid' in l).toBe(false);
      });
    }
  });
  it('empty search is zero rows, not an error', () => {
    expect(normalizeSearch(loadFixture('search-empty'), sctx)).toEqual({ items: [], total: 0, page: 1 });
  });
  it('shippingPrice 0 is calculated (null); 0.01 is a real price; buy-now 0 is none', () => {
    const out = normalizeSearch(loadFixture('search-grid-p1'), sctx).items;
    expect(out.some((l) => l.shippingPrice === 1)).toBe(true);
    expect(out.some((l) => l.shippingPrice === null)).toBe(true);
    expect(out.some((l) => l.buyNowPrice === null)).toBe(true);
    expect(out.some((l) => typeof l.buyNowPrice === 'number')).toBe(true);
  });
  it('null categoryListModel is a server error, not an empty result', () => {
    const raw = loadFixture<Record<string, unknown>>('search-empty');
    raw.categoryListModel = null;
    expect(() => normalizeSearch(raw, sctx)).toThrow(SgwApiError);
  });
});

describe('item detail normalization', () => {
  it('maps detail minimumBid to minimumBid (the next acceptable bid)', () => {
    const d = normalizeItemDetail(loadFixture('item-detail-open'), ctx);
    ItemDetailSchema.parse(d);
    expect(d.minimumBid).toBe(6801);
    expect(d.currentPrice).toBe(6701);
    expect(d.startingMinimumBid).toBe(999);
    expect(d.bidIncrement).toBe(100);
    expect(d.handlingPrice).toBe(500);
    expect(d.isClosed).toBe(false);
    expect(d.serverTimeRaw).toBe('2026-10-07T20:09:15.967');
    expect(d.serverTime).toBe('2026-10-08T03:09:15.967Z');
    expect(d.endTime).toBe('2026-10-08T03:39:00.000Z');
  });
  it('anonymous replies give null for isHighBidder and inWatchlist; authenticated keep the value', () => {
    const raw = loadFixture('item-detail-open');
    const a = normalizeItemDetail(raw, ctx);
    expect(a.isHighBidder).toBeNull();
    expect(a.inWatchlist).toBeNull();
    const b = normalizeItemDetail(raw, { ...ctx, authenticated: true });
    expect(b.isHighBidder).toBe(false);
    expect(b.inWatchlist).toBe(false);
  });
  it('pickupState becomes sellerState (the location field)', () => {
    expect(normalizeItemDetail(loadFixture('item-detail-open'), ctx).sellerState).toBe('IL');
    const p = normalizeItemDetail(loadFixture('item-detail-pickup'), ctx);
    expect(p.sellerState).toBe('PA');
    expect(p.pickupOnly).toBe(true);
  });
  it('closed fixture is closed; shipping 0 with calculation allowed is null; image url is joined', () => {
    const c = normalizeItemDetail(loadFixture('item-detail-closed'), ctx);
    ItemDetailSchema.parse(c);
    expect(c.isClosed).toBe(true);
    expect(c.shippingPrice).toBeNull();
    expect(c.imageUrl).toBe('https://img.test/4e49b812a032b1a5.jpg');
    expect(c.categoryPath).toBe('Tableware and Kitchenware');
  });
  it('bid history is newest first', () => {
    const d = normalizeItemDetail(loadFixture('item-detail-open'), ctx);
    expect(d.bidHistory).toHaveLength(22);
    const times = d.bidHistory.map((b) => Date.parse(b.time));
    expect([...times].sort((x, y) => y - x)).toEqual(times);
  });
  it('a bad Pacific time is a schema error', () => {
    const raw = loadFixture<Record<string, unknown>>('item-detail-open');
    raw.endTime = '2026-13-45T25:00:00';
    expect(() => normalizeItemDetail(raw, ctx)).toThrow(/endTime/);
  });
});

describe('other normalizers', () => {
  it('GetCurrentTime data is Pacific wall time', () => {
    expect(new Date(normalizeCurrentTime(loadFixture('get-current-time'))).toISOString()).toBe('2026-10-08T03:09:15.000Z');
  });
  it('seller info', () => {
    expect(normalizeSellerInfo(loadFixture('seller-info'))).toEqual({ sellerId: 955353, name: 'Goodwill of O', state: 'IL' });
  });
  it('favorites derive status from endTime; notes default to empty', () => {
    const raw = {
      status: true,
      data: [
        { itemId: 1, watchlistId: 7, notes: null, endTime: '2026-10-07T20:00:00', sellerId: 3 },
        { itemId: 2, watchlistId: 8, notes: 'max 5', endTime: '2026-10-09T20:00:00', sellerId: 3 },
      ],
    };
    const out = normalizeFavorites(raw, Date.parse('2026-10-08T12:00:00Z'));
    expect(out.map((f) => f.status)).toEqual(['closed', 'open']);
    expect(out.map((f) => f.notes)).toEqual(['', 'max 5']);
  });
  it('saved searches, show bid modal, shipping quote', () => {
    const s = normalizeSavedSearches({
      status: true,
      data: [{ saveSearchId: 5, searchName: 'p', searchText: 'pyrex', selectedCategoryIds: '12,x,3', lowPrice: 0, highPrice: '30.5' }],
    });
    expect(s[0]).toMatchObject({ id: 5, name: 'p', query: { searchText: 'pyrex', categoryIds: [12, 3], highPrice: 3050 } });
    expect(normalizeShowBidModal({ sellerId: 4, minimumBid: 12.5 })).toEqual({ sellerId: 4, minimumBid: 1250 });
    expect(normalizeShippingQuote({ shippingPrice: 11.5, handlingPrice: 3 })).toEqual({ shipping: 1150, handling: 300 });
    expect(normalizeShippingQuote({})).toBeNull();
  });
});

describe('html and money', () => {
  it('message HTML is stripped to text', () => {
    expect(htmlToText('<p>You are the <strong>high</strong> bidder at $5.00.</p><p>Good&nbsp;luck &amp; thanks</p>')).toBe(
      'You are the high bidder at $5.00.\nGood luck & thanks',
    );
    expect(htmlToText('a<br/>b<script>alert(1)</script>c')).toBe('a\nb c');
    expect(htmlToText('&lt;b&gt; &#65;&#x42;')).toBe('<b> AB');
  });
  it('placeBid raw result carries text, not HTML', () => {
    expect(normalizePlaceBidRaw({ status: false, result: -3, message: '<p>This auction is <b>closed</b>.</p>' })).toEqual({
      statusFlag: false,
      isUnauthorized: false,
      rawStatus: null,
      rawResult: -3,
      messageText: 'This auction is closed.',
      isHighBidder: null,
    });
  });
  it('dollars to cents has no float error', () => {
    expect(dollarsToCents(67.01)).toBe(6701);
    expect(dollarsToCents(0.29)).toBe(29);
    expect(dollarsToCents(1.15)).toBe(115);
  });
});
