// Fix round 1: envelope failures, PlaceBid outcome signal, pickup filter, strictness, edge cases.
import { describe, expect, it } from 'vitest';
import {
  htmlToText,
  normalizeCurrentTime,
  normalizeFavorites,
  normalizeItemDetail,
  normalizePlaceBidRaw,
  normalizeSavedSearches,
  normalizeSearch,
  normalizeShippingQuote,
  normalizeShowBidModal,
} from '../../../src/adapters/sgw/normalize';
import { loadFixture } from './fixtures';

const ctx = { observedAt: 1_760_000_000_000, authenticated: false };
const sctx = { ...ctx, query: { page: 1 } };

describe('pickupOnly on search rows is the query filter or unknown', () => {
  const raw = (): unknown => loadFixture('search-grid-p1');
  it('is unset (unknown) without a pickup filter', () => {
    const items = normalizeSearch(raw(), sctx).items;
    expect(items.every((l) => !('pickupOnly' in l))).toBe(true);
  });
  it('pickupOnly filter makes rows true; excludePickupOnly makes them false', () => {
    expect(
      normalizeSearch(raw(), { ...ctx, query: { page: 1, pickupOnly: true } }).items.every(
        (l) => l.pickupOnly === true,
      ),
    ).toBe(true);
    expect(
      normalizeSearch(raw(), { ...ctx, query: { page: 1, excludePickupOnly: true } }).items.every(
        (l) => l.pickupOnly === false,
      ),
    ).toBe(true);
  });
  it('reports the requested page', () => {
    expect(normalizeSearch(raw(), { ...ctx, query: { page: 3 } }).page).toBe(3);
  });
});

describe('envelope failures are not swallowed', () => {
  const unauthorized = { status: false, isUnauthorized: true, message: 'nope', data: [] };
  const failed = { status: false, isUnauthorized: false, message: 'boom', data: null };
  const cases: Array<[string, (raw: unknown) => unknown]> = [
    ['currentTime', (r) => normalizeCurrentTime(r)],
    ['favorites', (r) => normalizeFavorites(r, 0)],
    ['savedSearches', (r) => normalizeSavedSearches(r)],
    ['showBidModal', (r) => normalizeShowBidModal(r)],
    ['shippingQuote', (r) => normalizeShippingQuote(r)],
  ];
  for (const [name, fn] of cases) {
    it(`${name}: isUnauthorized is an auth error`, () => {
      expect(() => fn(unauthorized)).toThrow(expect.objectContaining({ name: 'SgwApiError', kind: 'auth' }));
    });
    it(`${name}: status false is a server error, not a schema error`, () => {
      expect(() => fn(failed)).toThrow(expect.objectContaining({ name: 'SgwApiError', kind: 'server' }));
    });
  }
});

describe('PlaceBid keeps the outcome signal', () => {
  it('status false and status true normalize differently', () => {
    expect(normalizePlaceBidRaw({ status: false, message: 'x' }).statusFlag).toBe(false);
    expect(normalizePlaceBidRaw({ status: true, message: 'x' }).statusFlag).toBe(true);
  });
  it('a numeric status is rawStatus and has no flag', () => {
    expect(normalizePlaceBidRaw({ status: 2, result: 1 })).toMatchObject({
      rawStatus: 2,
      statusFlag: null,
      rawResult: 1,
    });
  });
  it('an enveloped reply reads result and isHighBidder from data', () => {
    expect(
      normalizePlaceBidRaw({ status: true, message: 'ok', data: { result: 7, isHighBidder: true } }),
    ).toMatchObject({ rawResult: 7, isHighBidder: true, statusFlag: true });
  });
  it('status true alone is never success: no result and no high-bidder signal', () => {
    const out = normalizePlaceBidRaw({ status: true });
    expect(out.rawResult).toBeNull();
    expect(out.isHighBidder).toBeNull();
    expect(out).not.toHaveProperty('success');
  });
});

describe('strict consumed fields', () => {
  it('startingPrice is required on detail', () => {
    const raw = loadFixture<Record<string, unknown>>('item-detail-open');
    delete raw.startingPrice;
    expect(() => normalizeItemDetail(raw, ctx)).toThrow(/startingPrice/);
  });
  it('the pickupState key is required (null value allowed)', () => {
    const raw = loadFixture<Record<string, unknown>>('item-detail-open');
    raw.pickupState = null;
    expect(normalizeItemDetail(raw, ctx).sellerState).toBeUndefined();
    delete raw.pickupState;
    expect(() => normalizeItemDetail(raw, ctx)).toThrow(/pickupState/);
  });
});

describe('bid history', () => {
  it('drops retracted bids; numBids then exceeds the history length', () => {
    const raw = loadFixture<{ bidHistory: { bidComplete: Array<Record<string, unknown>> } }>('item-detail-open');
    const log = raw.bidHistory.bidComplete;
    log[3] = { ...log[3], retracted: true };
    const d = normalizeItemDetail(raw, ctx);
    expect(d.bidHistory).toHaveLength(21);
    expect(d.numBids).toBeGreaterThan(d.bidHistory.length);
  });
});

describe('htmlToText edge cases', () => {
  it('a bare < or > does not eat text', () => {
    expect(htmlToText('Bid must be < $5 and > $3')).toBe('Bid must be < $5 and > $3');
    expect(htmlToText('<p>a < b</p>')).toBe('a < b');
  });
  it('decodes typographic named entities', () => {
    expect(
      htmlToText('It&rsquo;s &ldquo;fine&rdquo; &lsquo;x&rsquo; &copy; &reg; &trade; &hellip; &mdash; &ndash;'),
    ).toBe('It’s “fine” ‘x’ © ® ™ … — –');
  });
  it('an unclosed script drops the rest; comments vanish', () => {
    expect(htmlToText('keep<script>alert(1) and more')).toBe('keep');
    expect(htmlToText('a<!-- hidden -->b')).toBe('ab');
  });
});

describe('shipping quote', () => {
  it('is null when shippingPrice is null even if handling is present', () => {
    expect(normalizeShippingQuote({ shippingPrice: null, handlingPrice: 3 })).toBeNull();
    expect(normalizeShippingQuote({ handlingPrice: 3 })).toBeNull();
  });
});

describe('serverTime in the fall-back hour', () => {
  it('picks the candidate nearest observedAt', () => {
    const raw = loadFixture<Record<string, unknown>>('item-detail-open');
    raw.serverTime = '2026-11-01T01:30:00.000';
    raw.endTime = '2026-11-01T03:00:00';
    // 01:30 PDT = 08:30Z, 01:30 PST = 09:30Z
    const first = normalizeItemDetail(raw, { ...ctx, observedAt: Date.parse('2026-11-01T08:30:01Z') });
    const second = normalizeItemDetail(raw, { ...ctx, observedAt: Date.parse('2026-11-01T09:30:01Z') });
    expect(first.serverTime).toBe('2026-11-01T08:30:00.000Z');
    expect(second.serverTime).toBe('2026-11-01T09:30:00.000Z');
  });
});

describe('fix round 2: PlaceBid data may be any shape', () => {
  it.each([[[]], ['text'], [0], [null]])('data %j does not throw a schema error', (data) => {
    const out = normalizePlaceBidRaw({ status: false, isUnauthorized: true, data });
    expect(out.isUnauthorized).toBe(true);
    expect(out.rawResult).toBeNull();
    expect(out.isHighBidder).toBeNull();
  });
  it('reads result and isHighBidder only from a plain-object data', () => {
    expect(normalizePlaceBidRaw({ status: true, data: { result: 4, isHighBidder: false } })).toMatchObject({
      rawResult: 4,
      isHighBidder: false,
    });
    expect(normalizePlaceBidRaw({ status: true, data: [{ result: 4 }] }).rawResult).toBeNull();
  });
  it('ignores a non-numeric result inside data instead of throwing', () => {
    expect(normalizePlaceBidRaw({ status: true, data: { result: 'x', isHighBidder: 'y' } })).toMatchObject({
      rawResult: null,
      isHighBidder: null,
    });
  });
});

describe('fix round 2: flat-mode envelope detection', () => {
  it('a bare {status:false, message} is a server error from shippingQuote and showBidModal', () => {
    const raw = { status: false, message: 'bad' };
    for (const fn of [normalizeShippingQuote, normalizeShowBidModal]) {
      expect(() => fn(raw)).toThrow(expect.objectContaining({ name: 'SgwApiError', kind: 'server' }));
    }
  });
  it('bare shapes still work', () => {
    expect(normalizeShowBidModal({ sellerId: 1, minimumBid: 2 })).toEqual({ sellerId: 1, minimumBid: 200 });
    expect(normalizeShippingQuote({ shippingPrice: 1, handlingPrice: 0 })).toEqual({ shipping: 100, handling: 0 });
  });
});

describe('fix round 2: comments are stripped before the unclosed-script rule', () => {
  it('a script tag inside a comment is not an unclosed script', () => {
    expect(htmlToText('a<!-- <script> -->b')).toBe('ab');
  });
});
