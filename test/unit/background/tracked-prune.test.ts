// T-129: planPrune, the pure decision of which tracked items a prune pass deletes.
import { describe, expect, it } from 'vitest';

import { OUTCOME_NOTIFY_ALARM_PREFIX } from '../../../src/background/jobs/outcomes';
import { PRUNE_AFTER_END_MS, planPrune, type PruneInput } from '../../../src/background/jobs/tracked-prune';
import type { CalendarLink } from '../../../src/domain/calendar/types';
import type { Snipe } from '../../../src/domain/snipe/types';
import type { TrackedItem } from '../../../src/domain/types';

const END = Date.UTC(2026, 9, 11, 16, 0, 0);
const MIN = 60_000;

const item = (itemId: number, over: Partial<TrackedItem> = {}): TrackedItem => ({
  itemId,
  title: `Item ${String(itemId)}`,
  endTime: new Date(END).toISOString(),
  sellerId: 1,
  reasons: [{ kind: 'manual' }],
  favoriteState: 'none',
  calendar: false,
  addedAt: END - 60 * MIN,
  updatedAt: END - 60 * MIN,
  ...over,
});

const snipe = (id: string, itemId: number, state: Snipe['state']): Snipe => ({
  id,
  itemId,
  title: 'Sniped',
  endTime: new Date(END).toISOString(),
  endTimeAtArm: new Date(END).toISOString(),
  maxBid: 2000,
  leadMs: 8000,
  fallback: 'skip',
  dryRun: true,
  state,
  armedAt: END - 60 * MIN,
  attempt: {},
  history: [],
});

const link = (itemId: number, status: CalendarLink['status'] = 'synced'): CalendarLink => ({
  itemId,
  eventId: `sbv${String(itemId)}g0`,
  generation: 0,
  calendarId: 'cal',
  lastSyncedHash: 'h',
  status,
});

const plan = (tracked: TrackedItem[], now: number, over: Partial<PruneInput> = {}): number[] =>
  planPrune({ tracked: Object.fromEntries(tracked.map((t) => [t.itemId, t])), snipes: {}, links: {}, deferredAlarms: {}, now, ...over });

describe('planPrune', () => {
  it('a recorded outcome prunes at once, even before the end', () => {
    expect(plan([item(1, { outcome: 'won' }), item(2, { outcome: 'unknown' }), item(3)], END - MIN)).toEqual([1, 2]);
  });

  it('without an outcome: kept until exactly 6 h after the end, then pruned', () => {
    expect(plan([item(1)], END + PRUNE_AFTER_END_MS - 1)).toEqual([]);
    expect(plan([item(1)], END + PRUNE_AFTER_END_MS)).toEqual([1]);
  });

  it('an outcome read still owed (a snipe, the calendar flag or a live event) keeps it past 6 h', () => {
    const late = END + 24 * 60 * MIN;
    const snipes = { s1: snipe('s1', 1, 'resolved') };
    expect(plan([item(1)], late, { snipes })).toEqual([]);
    expect(plan([item(2, { calendar: true })], late)).toEqual([]);
    expect(plan([item(3)], late, { links: { 3: link(3) } })).toEqual([]);
    // A deleted event is no reason to read.
    expect(plan([item(4)], late, { links: { 4: link(4, 'deleted') } })).toEqual([4]);
  });

  it('a snipe in any state but resolved or killed blocks it', () => {
    const now = END + 24 * 60 * MIN;
    for (const state of ['draft', 'armed', 'fallback-applied', 'waking', 'verified', 'firing', 'sent'] as const) {
      expect(plan([item(1, { outcome: 'won' })], now, { snipes: { s: snipe('s', 1, state) } })).toEqual([]);
    }
    for (const state of ['resolved', 'killed'] as const) {
      expect(plan([item(1, { outcome: 'won' })], now, { snipes: { s: snipe('s', 1, state) } })).toEqual([1]);
    }
  });

  it('waits for the runner outbox, a deferred outcome notice and an ntfy reminder still to fire', () => {
    const now = END + 10 * MIN;
    const t = [item(1, { outcome: 'won' })];
    const snipes = { s: snipe('s', 1, 'resolved') };
    expect(plan(t, now, { snipes, runner: { s: { outbox: [{ kind: 'scheduleWake', snipeId: 's', at: now }] } } })).toEqual([]);
    expect(plan(t, now, { snipes, runner: { s: { outbox: [] } } })).toEqual([1]);
    expect(plan(t, now, { deferredAlarms: { [`${OUTCOME_NOTIFY_ALARM_PREFIX}1`]: now + MIN } })).toEqual([]);
    const entry = (fireAt: number, status: 'scheduled' | 'deferred' = 'scheduled') => ({ seq: 'sbw-1-5-0', leadMin: 5, fireAt, status });
    expect(plan(t, now, { ntfy: { 1: { fingerprint: 'f', entries: [entry(now + MIN)] } } })).toEqual([]);
    expect(plan(t, now, { ntfy: { 1: { fingerprint: 'f', entries: [entry(now - MIN)] } } })).toEqual([1]);
    expect(plan(t, now, { ntfy: { 1: { fingerprint: 'f', entries: [entry(now + MIN, 'deferred')] } } })).toEqual([1]);
  });
});
