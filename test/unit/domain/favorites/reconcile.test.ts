import { describe, expect, it } from 'vitest';

import { desired } from '../../../../src/domain/favorites/reconcile';
import { DEFAULT_FAVORITE_WITHIN_HOURS } from '../../../../src/domain/settings/defaults';
import type { TrackedItem } from '../../../../src/domain/types';
import type { Watch } from '../../../../src/domain/watches/schema';

const NOW = Date.UTC(2026, 9, 8, 11, 0);
const HOUR = 3_600_000;
const iso = (ms: number): string => new Date(ms).toISOString();

const watch = (over: Partial<Watch> = {}): Watch => ({
  id: 'w1',
  name: 'w',
  enabled: true,
  query: { searchText: 'x', categoryIds: [], sellerIds: [], page: 1 },
  ruleIds: [],
  maxPages: 1,
  favoriteMode: 'sgw',
  calendar: false,
  notify: false,
  nextRunAt: 0,
  seenItemIds: [],
  ...over,
});

const item = (over: Partial<TrackedItem> = {}): TrackedItem => ({
  itemId: 101,
  title: 't',
  endTime: iso(NOW + 48 * HOUR),
  sellerId: 1,
  reasons: [{ kind: 'watch', id: 'w1' }],
  favoriteState: 'none',
  calendar: false,
  addedAt: NOW,
  updatedAt: NOW,
  ...over,
});

describe('desired()', () => {
  it('adds an sgw item in state none', () => {
    expect(desired([item()], [watch()], NOW)).toMatchObject([{ itemId: 101, action: 'add' }]);
  });

  it('retries a failed item', () => {
    expect(desired([item({ favoriteState: 'failed' })], [watch()], NOW)[0]?.action).toBe('add');
  });

  it('already favorited per the cache -> none', () => {
    const r = desired([item()], [watch()], NOW, [{ itemId: 101 }]);
    expect(r[0]).toMatchObject({ action: 'none', reason: expect.stringContaining('already') as string });
  });

  it('favorited and queued states -> none', () => {
    expect(desired([item({ favoriteState: 'favorited' }), item({ itemId: 102, favoriteState: 'queued' })], [watch()], NOW).map((d) => d.action)).toEqual(['none', 'none']);
  });

  it('local mode never favorites (R4)', () => {
    expect(desired([item()], [watch({ favoriteMode: 'local' })], NOW)[0]?.action).toBe('none');
  });

  it('disabled watch and unknown watch -> none', () => {
    expect(desired([item()], [watch({ enabled: false })], NOW)[0]?.action).toBe('none');
    expect(desired([item()], [], NOW)[0]?.action).toBe('none');
    expect(desired([item({ reasons: [{ kind: 'manual' }] })], [watch()], NOW)[0]?.action).toBe('none');
  });

  it('sgw-late waits for the window (default hours, then per-watch hours)', () => {
    const end = NOW + (DEFAULT_FAVORITE_WITHIN_HOURS + 1) * HOUR;
    const t = item({ endTime: iso(end) });
    const late = watch({ favoriteMode: 'sgw-late' });
    expect(desired([t], [late], NOW)[0]?.action).toBe('none');
    expect(desired([t], [late], NOW + HOUR)[0]?.action).toBe('add');
    expect(desired([t], [watch({ favoriteMode: 'sgw-late', favoriteWithinHours: 24 })], NOW)[0]?.action).toBe('add');
  });

  it('ended auctions are never favorited', () => {
    expect(desired([item({ endTime: iso(NOW - 1) })], [watch()], NOW)[0]?.action).toBe('none');
  });

  it('any permitting watch is enough', () => {
    const t = item({ reasons: [{ kind: 'watch', id: 'w2' }, { kind: 'watch', id: 'w1' }] });
    expect(desired([t], [watch({ id: 'w2', favoriteMode: 'local' }), watch()], NOW)[0]?.action).toBe('add');
  });
});
