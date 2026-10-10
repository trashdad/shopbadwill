// T-24b: normalizers on the real logged-in fixtures (shipping quote is an HTML string; saved searches have no name).
import { describe, expect, it } from 'vitest';
import { normalizeFavorites, normalizeSavedSearches, normalizeShippingQuote } from '../../../src/adapters/sgw/normalize';
import { loadFixture } from './fixtures';

const quote = (html: string): unknown => html;
const page = (ship: string, hand: string, total?: string): string =>
  `<p>Estimated Shipping and Handling:</p><p>Shipped From: X, WA 00000</p><p>Shipping Carrier: FedEx<p>Address: A</p>` +
  `<p>Shipping: <span id='shipping-span'>${ship}</span></p><p>Handling: ${hand}</p>` +
  (total === undefined ? '' : `<p><b>Total Shipping and Handling: ${total}</b></p>`);

describe('shippingQuote on the real fixture', () => {
  it('parses the HTML string to exact cents', () => {
    expect(normalizeShippingQuote(loadFixture('calculate-shipping'))).toEqual({ shipping: 1104, handling: 300 });
  });
  it('never leaks address text into the result', () => {
    expect(JSON.stringify(normalizeShippingQuote(loadFixture('calculate-shipping')))).not.toMatch(/address|redacted|TownTB/i);
  });
});

describe('shippingQuote edge cases (synthetic)', () => {
  it('parses a normal quote with $ and ignores the service level', () => {
    expect(normalizeShippingQuote(quote(page('$5.50 (GROUND)', '$1.25', '$6.75')))).toEqual({ shipping: 550, handling: 125 });
  });
  it('missing Handling gives null', () => {
    expect(normalizeShippingQuote(quote(page('$5.50 (GROUND)', '', undefined).replace(/<p>Handling: <\/p>/, '')))).toBeNull();
  });
  it('a non-numeric amount gives null', () => {
    expect(normalizeShippingQuote(quote(page('$5.50 (GROUND)', 'TBD', '$5.50')))).toBeNull();
    expect(normalizeShippingQuote(quote(page('call us', '$1.00')))).toBeNull();
  });
  it('a quote with no Total line gives null', () => {
    expect(normalizeShippingQuote(quote(page('$5.50 (GROUND)', '$1.25')))).toBeNull();
  });
  it('a Total mismatch gives null', () => {
    expect(normalizeShippingQuote(quote(page('$5.50 (GROUND)', '$1.25', '$7.00')))).toBeNull();
  });
  it('HTML entities in amounts are decoded', () => {
    expect(normalizeShippingQuote(quote(page('&#36;5.50 (GROUND)', '&#36;1.25', '&#36;6.75')))).toEqual({ shipping: 550, handling: 125 });
  });
  it('three decimals and an empty string give null', () => {
    expect(normalizeShippingQuote(quote(page('$5.555', '$1.00')))).toBeNull();
    expect(normalizeShippingQuote('')).toBeNull();
  });
});

describe('savedSearches on the real fixture', () => {
  it('maps the first row: id, derived name, query', () => {
    const out = normalizeSavedSearches(loadFixture('saved-searches'));
    expect(out.length).toBeGreaterThan(0);
    const first = out[0];
    expect(first).toBeDefined();
    expect(typeof first?.id).toBe('number');
    expect(typeof first?.name).toBe('string');
    expect(first).toMatchObject({
      id: 348195,
      name: 'g7x',
      query: {
        searchText: 'g7x',
        categoryIds: [],
        sellerIds: [],
        page: 1,
        lowPrice: 0,
        highPrice: 99999900,
        pickupOnly: false,
        excludePickupOnly: false,
        oneCentShippingOnly: false,
        closedAuctions: false,
        sortColumn: 1,
        sortDescending: false,
        layout: 'grid',
      },
    });
  });
});

describe('savedSearches synthetic', () => {
  const env = (row: object): unknown => ({ status: true, data: [row] });
  it('falls back to "Search #<id>" when searchText is blank', () => {
    expect(normalizeSavedSearches(env({ savedSearchId: 9, searchText: '  ' }))[0]?.name).toBe('Search #9');
  });
  it('trims the name; unknown fields with URL params go to extra', () => {
    const q = normalizeSavedSearches(env({ savedSearchId: 9, searchText: ' pyrex ', selectedGroup: 'g1', searchBuyNowOnly: '' }))[0];
    expect(q?.name).toBe('pyrex');
    expect(q?.query.extra).toEqual({ sg: 'g1' });
  });
  it('caed and cadb reach extra only when closedAuctions is true', () => {
    const row = { savedSearchId: 9, searchText: 'x', closedAuctionDaysBack: 7, closedAuctionEndingDate: '2026-06-13T00:00:00' };
    const on = normalizeSavedSearches(env({ ...row, searchClosedAuctions: true }))[0];
    expect(on?.query.extra).toEqual({ cadb: '7', caed: '2026-06-13T00:00:00' });
    const off = normalizeSavedSearches(env({ ...row, searchClosedAuctions: false }))[0];
    expect(off?.query.extra).toBeUndefined();
    const unset = normalizeSavedSearches(env(row))[0];
    expect(unset?.query.extra).toBeUndefined();
  });
  it('a row with no id is a schema error', () => {
    expect(() => normalizeSavedSearches(env({ searchText: 'x' }))).toThrow(expect.objectContaining({ kind: 'schema' }));
  });
});

describe('favorites status comes from the row type', () => {
  const NOW = Date.parse('2026-10-08T12:00:00Z');
  it('matches `type` on every row of the real fixture', () => {
    const raw = loadFixture<{ data: Array<{ type: string }> }>('favorites-all');
    const out = normalizeFavorites(raw, NOW);
    expect(out.length).toBe(raw.data.length);
    out.forEach((f, i) => {
      expect(f.status).toBe(raw.data[i]?.type === 'Close' ? 'closed' : 'open');
    });
  });
  const row = (extra: object): unknown => ({
    status: true,
    data: [{ itemId: 1, watchlistId: 7, notes: '', endTime: '2030-01-01T20:00:00', sellerId: 3, ...extra }],
  });
  it('type "Close" with a future endTime is closed; "Open" with a past endTime is open', () => {
    expect(normalizeFavorites(row({ type: 'Close' }), NOW)[0]?.status).toBe('closed');
    expect(normalizeFavorites(row({ type: 'Open', endTime: '2020-01-01T20:00:00' }), NOW)[0]?.status).toBe('open');
  });
  it('a missing or invalid type falls back to endTime', () => {
    expect(normalizeFavorites(row({}), NOW)[0]?.status).toBe('open');
    expect(normalizeFavorites(row({ type: 'weird', endTime: '2020-01-01T20:00:00' }), NOW)[0]?.status).toBe('closed');
    expect(normalizeFavorites(row({ type: null }), NOW)[0]?.status).toBe('open');
  });
});
