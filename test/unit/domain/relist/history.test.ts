// T-113: the bounded relist history (`sbw:relistSeen`) and the "seen before" lookup.
import { describe, expect, it } from 'vitest';

import {
  emptyRelistSeen,
  findPrevious,
  parseRelistSeen,
  RELIST_MAX_AGE_MS,
  RELIST_MAX_ENTRIES,
  recordSightings,
  sightingOf,
  type RelistSeenRecord,
} from '../../../../src/domain/relist/history';
import type { Listing } from '../../../../src/domain/types';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 9, 12, 12, 0, 0);
const FP = '42|pyrex bowl|abc.jpg';

function listing(over: Partial<Listing> = {}): Listing {
  return {
    itemId: 2000,
    title: 'Pyrex Bowl',
    currentPrice: 1299,
    startingMinimumBid: 500,
    numBids: 3,
    endTime: '2026-10-13T02:00:00.000Z',
    endTimeRaw: '2026-10-12T19:00:00',
    sellerId: 42,
    imageUrl: 'https://img.test/abc.jpg',
    source: 'tap',
    observedAt: NOW,
    ...over,
  };
}

function withEntries(entries: RelistSeenRecord['entries']): RelistSeenRecord {
  return { version: 1, entries };
}

describe('parseRelistSeen', () => {
  it('accepts a valid record', () => {
    const rec = withEntries({ 1000: { fp: FP, price: 999, seenAt: NOW - DAY } });
    expect(parseRelistSeen(rec)).toEqual(rec);
  });

  it.each([
    ['missing', undefined],
    ['null', null],
    ['a string', 'nope'],
    ['a wrong version', { version: 2, entries: {} }],
    ['a negative price', { version: 1, entries: { 1000: { fp: FP, price: -1, seenAt: NOW } } }],
    ['a fractional price', { version: 1, entries: { 1000: { fp: FP, price: 1.5, seenAt: NOW } } }],
    ['an empty fingerprint', { version: 1, entries: { 1000: { fp: '', price: 1, seenAt: NOW } } }],
    ['a non-numeric key', { version: 1, entries: { abc: { fp: FP, price: 1, seenAt: NOW } } }],
  ])('parses %s as empty', (_name, raw) => {
    expect(parseRelistSeen(raw)).toEqual(emptyRelistSeen());
  });
});

describe('sightingOf', () => {
  it('takes the item id, fingerprint, current price and observation time of a listing', () => {
    expect(sightingOf(listing())).toEqual({ itemId: 2000, fingerprint: FP, price: 1299, seenAt: NOW });
  });

  it('is null when the listing has no usable fingerprint', () => {
    expect(sightingOf(listing({ title: '--' }))).toBeNull();
  });

  it('keeps only public listing data: no bid fields', () => {
    const s = sightingOf(listing({ isFavorite: true, numBids: 9 }));
    expect(Object.keys(s ?? {}).sort()).toEqual(['fingerprint', 'itemId', 'price', 'seenAt']);
  });
});

describe('recordSightings', () => {
  it('adds new sightings and updates the last price and time of a known item', () => {
    let rec = recordSightings(emptyRelistSeen(), [{ itemId: 1000, fingerprint: FP, price: 500, seenAt: NOW - 2 * DAY }], NOW);
    rec = recordSightings(rec, [{ itemId: 1000, fingerprint: FP, price: 800, seenAt: NOW - DAY }], NOW);
    expect(rec.entries[1000]).toEqual({ fp: FP, price: 800, seenAt: NOW - DAY });
  });

  it('never lets an older sighting overwrite a newer one', () => {
    const rec = recordSightings(
      withEntries({ 1000: { fp: FP, price: 800, seenAt: NOW - DAY } }),
      [{ itemId: 1000, fingerprint: FP, price: 500, seenAt: NOW - 2 * DAY }],
      NOW,
    );
    expect(rec.entries[1000]).toEqual({ fp: FP, price: 800, seenAt: NOW - DAY });
  });

  it('does not mutate its input', () => {
    const before = withEntries({ 1000: { fp: FP, price: 800, seenAt: NOW - DAY } });
    const copy = structuredClone(before);
    recordSightings(before, [{ itemId: 1001, fingerprint: FP, price: 1, seenAt: NOW }], NOW);
    expect(before).toEqual(copy);
  });

  it('clamps a future sighting to now', () => {
    const rec = recordSightings(emptyRelistSeen(), [{ itemId: 1, fingerprint: FP, price: 1, seenAt: NOW + DAY }], NOW);
    expect(rec.entries[1]?.seenAt).toBe(NOW);
  });

  it('drops entries older than 60 days', () => {
    const rec = recordSightings(
      withEntries({
        1: { fp: FP, price: 1, seenAt: NOW - RELIST_MAX_AGE_MS - 1 },
        2: { fp: FP, price: 2, seenAt: NOW - RELIST_MAX_AGE_MS },
      }),
      [{ itemId: 3, fingerprint: FP, price: 3, seenAt: NOW - RELIST_MAX_AGE_MS - 5 }],
      NOW,
    );
    expect(Object.keys(rec.entries)).toEqual(['2']);
  });

  it('keeps at most RELIST_MAX_ENTRIES (2,000) entries, evicting the oldest first', () => {
    expect(RELIST_MAX_ENTRIES).toBe(2000);
    const entries: RelistSeenRecord['entries'] = {};
    for (let i = 1; i <= RELIST_MAX_ENTRIES; i++) entries[i] = { fp: `${String(i)}|t|`, price: i, seenAt: NOW - DAY + i };
    const rec = recordSightings(withEntries(entries), [{ itemId: 999999, fingerprint: FP, price: 1, seenAt: NOW }], NOW);
    expect(Object.keys(rec.entries)).toHaveLength(RELIST_MAX_ENTRIES);
    expect(rec.entries[1]).toBeUndefined();
    expect(rec.entries[2]).toBeDefined();
    expect(rec.entries[999999]).toBeDefined();
  });

  it('survives a round trip through parseRelistSeen', () => {
    const rec = recordSightings(emptyRelistSeen(), [{ itemId: 1000, fingerprint: FP, price: 500, seenAt: NOW }], NOW);
    expect(parseRelistSeen(JSON.parse(JSON.stringify(rec)))).toEqual(rec);
  });
});

describe('findPrevious', () => {
  const rec = withEntries({
    1000: { fp: FP, price: 999, seenAt: NOW - 10 * DAY },
    1500: { fp: FP, price: 1450, seenAt: NOW - 3 * DAY },
    1800: { fp: '42|other|abc.jpg', price: 5, seenAt: NOW - DAY },
  });

  it('finds the most recently seen earlier listing with the same fingerprint', () => {
    expect(findPrevious(rec, { itemId: 2000, fingerprint: FP }, NOW)).toEqual({ itemId: 1500, price: 1450, seenAt: NOW - 3 * DAY });
  });

  it('never matches the same item id', () => {
    const only = withEntries({ 2000: { fp: FP, price: 999, seenAt: NOW - DAY } });
    expect(findPrevious(only, { itemId: 2000, fingerprint: FP }, NOW)).toBeNull();
    expect(findPrevious(only, { itemId: 2000, fingerprint: FP, relistId: 2000 }, NOW)).toBeNull();
  });

  it('ignores later item ids: a concurrent or newer duplicate is not "seen before"', () => {
    const later = withEntries({ 3000: { fp: FP, price: 999, seenAt: NOW - DAY } });
    expect(findPrevious(later, { itemId: 2000, fingerprint: FP }, NOW)).toBeNull();
  });

  it('ignores entries older than 60 days', () => {
    const old = withEntries({ 1000: { fp: FP, price: 999, seenAt: NOW - RELIST_MAX_AGE_MS - 1 } });
    expect(findPrevious(old, { itemId: 2000, fingerprint: FP }, NOW)).toBeNull();
    expect(findPrevious(old, { itemId: 2000, fingerprint: null, relistId: 1000 }, NOW)).toBeNull();
  });

  it('is null when nothing matches or there is no fingerprint', () => {
    expect(findPrevious(rec, { itemId: 2000, fingerprint: '7|x|' }, NOW)).toBeNull();
    expect(findPrevious(rec, { itemId: 2000, fingerprint: null }, NOW)).toBeNull();
  });

  it('uses relistId when present, even when the fingerprint changed', () => {
    expect(findPrevious(rec, { itemId: 2000, fingerprint: '7|new title|new.jpg', relistId: 1000 }, NOW)).toEqual({
      itemId: 1000,
      price: 999,
      seenAt: NOW - 10 * DAY,
    });
  });

  it('falls back to the fingerprint when the relistId is unknown, 0/null, or the item itself', () => {
    const expected = { itemId: 1500, price: 1450, seenAt: NOW - 3 * DAY };
    expect(findPrevious(rec, { itemId: 2000, fingerprint: FP, relistId: 4242 }, NOW)).toEqual(expected);
    expect(findPrevious(rec, { itemId: 2000, fingerprint: FP, relistId: null }, NOW)).toEqual(expected);
    expect(findPrevious(rec, { itemId: 2000, fingerprint: FP, relistId: 0 }, NOW)).toEqual(expected);
    expect(findPrevious(rec, { itemId: 1500, fingerprint: FP, relistId: 1500 }, NOW)).toEqual({
      itemId: 1000,
      price: 999,
      seenAt: NOW - 10 * DAY,
    });
  });
});
