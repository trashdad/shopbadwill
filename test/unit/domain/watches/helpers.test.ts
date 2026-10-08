// T-50: Watch helpers: nextRunAtFor and the seen ring.
import { describe, expect, it } from 'vitest';

import { hasSeen, markSeen, nextRunAtFor, recordSeen } from '../../../../src/domain/watches/helpers';
import { WATCH_SEEN_RING_SIZE, type Watch } from '../../../../src/domain/watches/schema';

const NY = 'America/New_York';
const utc = (y: number, mo: number, d: number, h = 0, mi = 0): number => Date.UTC(y, mo - 1, d, h, mi);
const iso = (ms: number): string => new Date(ms).toISOString();
const settings = { dailyRun: { enabled: true, localTime: '07:00', catchUp: true } };

describe('nextRunAtFor', () => {
  it('07:00 New York in winter (EST, UTC-5) is 12:00Z', () => {
    expect(iso(nextRunAtFor(settings, utc(2026, 1, 15), NY))).toBe('2026-01-15T12:00:00.000Z');
  });

  it('07:00 New York in summer (EDT, UTC-4) is 11:00Z', () => {
    expect(iso(nextRunAtFor(settings, utc(2026, 7, 15), NY))).toBe('2026-07-15T11:00:00.000Z');
  });

  it('is strictly after now: at exactly the run instant it picks the next day', () => {
    const run = utc(2026, 7, 15, 11);
    expect(iso(nextRunAtFor(settings, run, NY))).toBe('2026-07-16T11:00:00.000Z');
    expect(iso(nextRunAtFor(settings, run - 1, NY))).toBe('2026-07-15T11:00:00.000Z');
  });

  it('across spring-forward (2026-03-08): Mar 7 run is EST, Mar 8 run is EDT', () => {
    const d1 = nextRunAtFor(settings, utc(2026, 3, 7), NY);
    expect(iso(d1)).toBe('2026-03-07T12:00:00.000Z');
    const d2 = nextRunAtFor(settings, d1, NY);
    expect(iso(d2)).toBe('2026-03-08T11:00:00.000Z');
    expect(d2 - d1).toBe(23 * 3_600_000);
  });

  it('across fall-back (2026-11-01): Oct 31 run is EDT, Nov 1 run is EST', () => {
    const d1 = nextRunAtFor(settings, utc(2026, 10, 31), NY);
    expect(iso(d1)).toBe('2026-10-31T11:00:00.000Z');
    const d2 = nextRunAtFor(settings, d1, NY);
    expect(iso(d2)).toBe('2026-11-01T12:00:00.000Z');
    expect(d2 - d1).toBe(25 * 3_600_000);
  });

  it('uses the user zone calendar day, not UTC', () => {
    // 03:00Z on Jul 15 is still Jul 14, 23:00 in New York: the next 07:00 is Jul 15.
    expect(iso(nextRunAtFor(settings, utc(2026, 7, 15, 3), NY))).toBe('2026-07-15T11:00:00.000Z');
  });

  it('a nonexistent wall time (02:30 on spring-forward) resolves once, after now', () => {
    const s = { dailyRun: { enabled: true, localTime: '02:30', catchUp: true } };
    expect(iso(nextRunAtFor(s, utc(2026, 3, 7, 12), NY))).toBe('2026-03-08T07:30:00.000Z');
  });

  it('an ambiguous wall time (01:30 on fall-back) takes the earlier instant', () => {
    const s = { dailyRun: { enabled: true, localTime: '01:30', catchUp: true } };
    expect(iso(nextRunAtFor(s, utc(2026, 11, 1), NY))).toBe('2026-11-01T05:30:00.000Z');
  });

  it('works for Pacific and for zones east of UTC', () => {
    expect(iso(nextRunAtFor(settings, utc(2026, 7, 15), 'America/Los_Angeles'))).toBe('2026-07-15T14:00:00.000Z');
    expect(iso(nextRunAtFor(settings, utc(2026, 7, 15), 'Europe/Berlin'))).toBe('2026-07-15T05:00:00.000Z');
  });
});

describe('seen ring', () => {
  it('puts new ids first, most recent first', () => {
    expect(recordSeen([3, 2, 1], [5, 4])).toEqual([5, 4, 3, 2, 1]);
  });

  it('dedupes on insert: a re-reported id moves to the front, once', () => {
    expect(recordSeen([3, 2, 1], [1, 9, 1])).toEqual([1, 9, 3, 2]);
  });

  it('evicts the oldest beyond the cap', () => {
    expect(recordSeen([4, 3, 2, 1], [5], 4)).toEqual([5, 4, 3, 2]);
    expect(recordSeen([], [1, 2, 3, 4, 5], 3)).toEqual([1, 2, 3]);
  });

  it('defaults to WATCH_SEEN_RING_SIZE', () => {
    const big = Array.from({ length: WATCH_SEEN_RING_SIZE }, (_, i) => i + 1);
    const out = recordSeen(big, [99_999]);
    expect(out).toHaveLength(WATCH_SEEN_RING_SIZE);
    expect(out[0]).toBe(99_999);
    expect(out).not.toContain(WATCH_SEEN_RING_SIZE);
  });

  it('is pure: inputs are not mutated', () => {
    const seen: readonly number[] = Object.freeze([2, 1]);
    const add: readonly number[] = Object.freeze([3]);
    expect(recordSeen(seen, add)).toEqual([3, 2, 1]);
    expect(seen).toEqual([2, 1]);
  });

  it('hasSeen and markSeen work on a Watch without mutating it', () => {
    const w = { seenItemIds: [2, 1] } as Watch;
    const w2 = markSeen(w, [7]);
    expect(w2.seenItemIds).toEqual([7, 2, 1]);
    expect(w.seenItemIds).toEqual([2, 1]);
    expect(hasSeen(w2, 7)).toBe(true);
    expect(hasSeen(w, 7)).toBe(false);
  });
});
