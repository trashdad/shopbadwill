import { describe, expect, it } from 'vitest';
import { buildDesiredEvent, hashDesired } from '../../../../src/domain/calendar/event-builder';
import { DesiredEventSchema } from '../../../../src/domain/calendar/types';
import { DEFAULT_SETTINGS } from '../../../../src/domain/settings/defaults';
import { SettingsSchema, type Settings } from '../../../../src/domain/settings/schema';
import type { Listing, TrackedItem } from '../../../../src/domain/types';

const listing: Listing = {
  itemId: 279250057,
  title: 'Vintage <b>Glass</b> Vase',
  currentPrice: 1299,
  startingMinimumBid: 100,
  numBids: 2,
  endTime: '2026-10-08T04:30:00.000Z',
  endTimeRaw: '2026-10-07T21:30:00',
  sellerId: 1,
  pickupOnly: false,
  source: 'api',
  observedAt: 1,
};
const tracked: TrackedItem = {
  itemId: 279250057,
  title: listing.title,
  endTime: listing.endTime,
  sellerId: 1,
  reasons: [{ kind: 'manual' }],
  favoriteState: 'none',
  calendar: true,
  addedAt: 1,
  updatedAt: 1,
};
const settings: Settings = SettingsSchema.parse({ ...DEFAULT_SETTINGS, locale: { timeZone: 'America/New_York' } });

describe('buildDesiredEvent', () => {
  it('starts at the auction end, popup 60/15/5 by default, and validates', () => {
    const e = buildDesiredEvent(tracked, listing, settings);
    expect(e.startUtc).toBe(listing.endTime);
    expect(e.reminders).toEqual([60, 15, 5].map((minutes) => ({ method: 'popup', minutes })));
    expect(DesiredEventSchema.safeParse(e).success).toBe(true);
    expect(e.privateProps).toEqual({ sbwItemId: '279250057', sbwGen: '0', sbwState: 'open' });
  });
  it('rejects 6 reminders', () => {
    const s = { ...settings, calendar: { ...settings.calendar, reminders: [1, 2, 3, 4, 5, 6] } };
    expect(() => buildDesiredEvent(tracked, listing, s)).toThrow(RangeError);
  });
  it('describes dual time with next-day marker, price, max bid and link', () => {
    const e = buildDesiredEvent(tracked, listing, settings, { maxBid: 2500 });
    expect(e.description).toContain('9:30 PM PT · 12:30 AM ET (+1 day)');
    expect(e.description).toContain('$12.99');
    expect(e.description).toContain('$25.00');
    expect(e.description).toContain('https://shopgoodwill.com/item/279250057');
    expect(buildDesiredEvent(tracked, listing, settings).description).not.toContain('max bid');
  });
  it('keeps titles as plain text and caps at 200 chars', () => {
    expect(buildDesiredEvent(tracked, listing, settings).title).toBe('Vintage <b>Glass</b> Vase');
    const long = buildDesiredEvent(tracked, { ...listing, title: `a\nb${'x'.repeat(500)}` }, settings).title;
    expect(Array.from(long).length).toBe(200);
    expect(long).not.toContain('\n');
  });
  it('maps outcome to state and rejects mismatched items', () => {
    expect(buildDesiredEvent({ ...tracked, outcome: 'won' }, listing, settings).privateProps.sbwState).toBe('won');
    expect(() => buildDesiredEvent({ ...tracked, itemId: 9 }, listing, settings)).toThrow(RangeError);
  });
});

describe('hashDesired', () => {
  const base = buildDesiredEvent(tracked, listing, settings);
  it('is stable for equal content, regardless of key order', () => {
    const same = buildDesiredEvent(tracked, { ...listing, observedAt: 99, numBids: 7 }, settings);
    expect(hashDesired(same)).toBe(hashDesired(base));
    const reordered = Object.fromEntries(Object.entries(base).reverse()) as typeof base;
    expect(hashDesired(reordered)).toBe(hashDesired(base));
  });
  it('changes when content changes', () => {
    const moved = { ...listing, endTime: '2026-10-08T04:31:00.000Z', endTimeRaw: '2026-10-07T21:31:00' };
    const hashes = new Set([
      hashDesired(base),
      hashDesired(buildDesiredEvent(tracked, { ...listing, currentPrice: 1300 }, settings)),
      hashDesired(buildDesiredEvent(tracked, { ...listing, title: 'Other' }, settings)),
      hashDesired(buildDesiredEvent(tracked, moved, settings)),
      hashDesired(buildDesiredEvent(tracked, listing, settings, { generation: 1 })),
      hashDesired(buildDesiredEvent(tracked, listing, settings, { maxBid: 5000 })),
      hashDesired(buildDesiredEvent(tracked, listing, { ...settings, calendar: { ...settings.calendar, reminders: [30] } })),
    ]);
    expect(hashes.size).toBe(7);
  });
});

describe('fix round 1', () => {
  it('derives the description time from startUtc, ignoring endTimeRaw', () => {
    const e = buildDesiredEvent(tracked, { ...listing, endTimeRaw: 'garbage' }, settings);
    expect(e.startUtc).toBe(listing.endTime);
    expect(e.description).toContain('9:30 PM PT · 12:30 AM ET (+1 day)');
    const later = buildDesiredEvent(tracked, { ...listing, endTime: '2026-10-08T05:00:00.000Z', endTimeRaw: 'x' }, settings);
    expect(later.description).toContain('10:00 PM PT');
  });
  it('replaces lone surrogates in titles', () => {
    const t = buildDesiredEvent(tracked, { ...listing, title: 'a\ud800b' }, settings).title;
    expect(t).toBe('a�b');
    expect(t.isWellFormed()).toBe(true);
  });
});
