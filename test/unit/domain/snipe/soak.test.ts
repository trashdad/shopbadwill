// T-90: the soak rule (src/domain/snipe/soak.ts). Tests first, per the brief:
// p99 computed correctly; the lead rule clamps to [6 s, 15 s]; on-time =
// |error| ≤ 1 s (R5 adds the exact boundary at 1000 ms). Pure: no clock, no I/O.
import { describe, expect, it } from 'vitest';

import {
  fireErrorMs,
  isOnTime,
  measureLatencyMs,
  ON_TIME_TOLERANCE_MS,
  percentile,
  recommendLeadMs,
  RECOMMENDED_LEAD_MAX_MS,
  RECOMMENDED_LEAD_MIN_MS,
  soakSummary,
  timingMeasurements,
} from '../../../../src/domain/snipe/soak';
import type { Snipe } from '../../../../src/domain/snipe/types';

const now = Date.UTC(2026, 9, 10, 15, 0, 0);
const end = now + 2 * 3_600_000;

const snipe = (over: Partial<Snipe> = {}): Snipe => ({
  id: 's1',
  itemId: 700000001,
  title: 'Pyrex bowl',
  endTime: new Date(end).toISOString(),
  endTimeAtArm: new Date(end).toISOString(),
  maxBid: 5000,
  leadMs: 8000,
  fallback: 'early-proxy',
  dryRun: true,
  state: 'resolved',
  armedAt: now,
  attempt: {},
  history: [],
  ...over,
});

describe('percentile (nearest-rank, documented in soak.ts)', () => {
  it('p99 of 1..100 is exactly 99 (R5: p99 correctness)', () => {
    const values = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(values, 99)).toBe(99);
  });

  it('p50 and p95 of 1..100 follow the same nearest-rank rule', () => {
    const values = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(values, 50)).toBe(50);
    expect(percentile(values, 95)).toBe(95);
  });

  it('sorts the input first (order does not matter)', () => {
    const shuffled = [50, 1, 99, 2, 100, 3];
    expect(percentile(shuffled, 99)).toBe(100); // ceil(0.99 * 6) = 6 -> the largest
    expect(percentile(shuffled, 50)).toBe(3); // ceil(0.50 * 6) = 3 -> the 3rd smallest
  });

  it('handles a single value, an odd count, and duplicates', () => {
    expect(percentile([42], 99)).toBe(42);
    expect(percentile([10, 20, 30], 50)).toBe(20);
    expect(percentile([5, 5, 5, 7, 9], 99)).toBe(9);
  });

  it('small n (1, 2, 3) and ties: rank = ceil(p/100 × n), 1-based', () => {
    // n = 1: every percentile is the one value.
    expect([50, 95, 99].map((p) => percentile([7], p))).toEqual([7, 7, 7]);
    // n = 2: p50 -> rank 1 (the smaller), p95 and p99 -> rank 2 (the larger).
    expect([50, 95, 99].map((p) => percentile([300, 100], p))).toEqual([100, 300, 300]);
    // n = 3: p50 -> rank 2, p95 and p99 -> rank 3.
    expect([50, 95, 99].map((p) => percentile([30, 10, 20], p))).toEqual([20, 30, 30]);
    // Ties: the value at the rank, whichever copy it is.
    expect([50, 95, 99].map((p) => percentile([4, 4, 9], p))).toEqual([4, 9, 9]);
    expect([50, 95, 99].map((p) => percentile([2, 6, 6, 6], p))).toEqual([6, 6, 6]);
    expect([50, 95, 99].map((p) => percentile([1, 1, 1, 1], p))).toEqual([1, 1, 1]);
  });

  it('returns null for no values and does not mutate its input', () => {
    expect(percentile([], 99)).toBeNull();
    const input = [3, 1, 2];
    percentile(input, 50);
    expect(input).toEqual([3, 1, 2]);
  });
});

describe('isOnTime (|fire error| ≤ 1 s)', () => {
  it('the boundary is exactly 1000 ms (R5): 1000 and -1000 are on time', () => {
    expect(ON_TIME_TOLERANCE_MS).toBe(1000);
    expect(isOnTime(1000)).toBe(true);
    expect(isOnTime(-1000)).toBe(true);
    expect(isOnTime(999.9)).toBe(true);
  });

  it('anything over the boundary is late', () => {
    expect(isOnTime(1001)).toBe(false);
    expect(isOnTime(-1001)).toBe(false);
  });

  it('zero is on time', () => {
    expect(isOnTime(0)).toBe(true);
  });
});

describe('recommendLeadMs (clamp(p99 one-way + 5 s, 6 s, 15 s))', () => {
  it('clamps to 6 s at the bottom (R5: the 6 s clamp)', () => {
    expect(RECOMMENDED_LEAD_MIN_MS).toBe(6000);
    expect(recommendLeadMs([0])).toBe(6000);
    expect(recommendLeadMs([500, 900, 1000])).toBe(6000); // p99 1000 + 5000 = 6000
  });

  it('clamps to 15 s at the top (R5: the 15 s clamp)', () => {
    expect(RECOMMENDED_LEAD_MAX_MS).toBe(15000);
    expect(recommendLeadMs([12_000, 20_000])).toBe(15000); // p99 20000 + 5000 = 25000
    expect(recommendLeadMs([10_000])).toBe(15000); // exactly 10000 + 5000
  });

  it('passes a mid-range p99 through', () => {
    expect(recommendLeadMs([3000])).toBe(8000);
    expect(recommendLeadMs([100, 200, 3000])).toBe(8000); // p99 one-way = 3000
  });

  it('rounds to a whole millisecond (LeadMsSchema is .int())', () => {
    expect(recommendLeadMs([2500.5])).toBe(7501); // 2500.5 + 5000 = 7500.5 -> 7501
  });

  it('returns null with no samples', () => {
    expect(recommendLeadMs([])).toBeNull();
  });
});

describe('per-snipe measurements', () => {
  it('fire error = firedAt − fireAt (both persisted)', () => {
    const s = snipe({ fireAt: end - 8000, measured: { offsetMs: 1300, rttMs: 300, firedAt: end - 7900 } });
    expect(fireErrorMs(s)).toBe(100);
  });

  it('fire error is null when the fire or the plan was never persisted', () => {
    expect(fireErrorMs(snipe({ fireAt: end - 8000 }))).toBeNull();
    expect(fireErrorMs(snipe({ measured: { firedAt: end - 7900 } }))).toBeNull();
  });

  it('measure latency = responseAt − firedAt', () => {
    const s = snipe({ measured: { firedAt: end - 7900, responseAt: end - 7500 } });
    expect(measureLatencyMs(s)).toBe(400);
  });

  it('measure latency is null without both instants', () => {
    expect(measureLatencyMs(snipe({ measured: { firedAt: end - 7900 } }))).toBeNull();
    expect(measureLatencyMs(snipe({}))).toBeNull();
  });

  it('timingMeasurements carries timing data and the snipe id only (never the max bid)', () => {
    const s = snipe({
      fireAt: end - 8000,
      measured: { offsetMs: 1300, rttMs: 300, firedAt: end - 7850, responseAt: end - 7500 },
    });
    const row = timingMeasurements(s);
    expect(row.snipeId).toBe('s1');
    expect(row.offsetMs).toBe(1300);
    expect(row.rttMs).toBe(300);
    expect(row.fireErrorMs).toBe(150);
    expect(row.latencyMs).toBe(350);
    expect(row.onTime).toBe(true);
    expect(row.alarmDelayMs).toBeNull(); // never persisted (R3): "not recorded"
    expect(row).not.toHaveProperty('maxBid');
    expect(JSON.stringify(row)).not.toContain('5000');
  });
});

describe('soakSummary', () => {
  it('is empty when nothing fired', () => {
    const s = soakSummary([snipe({ state: 'killed' }), snipe({ id: 's2', state: 'armed' })]);
    expect(s).toEqual({
      firesAttempted: 0,
      latencySamples: 0,
      onTime: 0,
      offTime: 0,
      onTimeRate: 0,
      p50Ms: null,
      p95Ms: null,
      p99Ms: null,
      recommendedLeadMs: null,
    });
  });

  it('counts only dry-run fires and derives on-time and percentiles', () => {
    const dry = (id: string, error: number, latency?: number) =>
      snipe({
        id,
        fireAt: end - 8000,
        measured: {
          firedAt: end - 8000 + error,
          ...(latency === undefined ? {} : { responseAt: end - 8000 + error + latency }),
        },
      });
    const live = snipe({
      id: 'live1',
      dryRun: false,
      fireAt: end - 8000,
      measured: { firedAt: end - 8000 + 300, responseAt: end - 8000 + 300 + 200 },
    });
    const s = soakSummary([
      dry('d1', 300, 400), // on time, latency 400
      dry('d2', -600, 1000), // on time
      dry('d3', 1500, 300), // late
      dry('d4', 0), // fired, no latency sample (the measure read failed)
      live,
      snipe({ id: 'd5', state: 'armed' }), // never fired
    ]);
    expect(s.firesAttempted).toBe(4);
    expect(s.onTime).toBe(3); // d1, d2 and d4 (error 0) are on time; d3 is late
    expect(s.offTime).toBe(1);
    expect(s.onTimeRate).toBe(0.75);
    expect(s.latencySamples).toBe(3);
    // nearest-rank on [300, 400, 1000]: p50 = 400, p95 = 1000, p99 = 1000
    expect(s.p50Ms).toBe(400);
    expect(s.p95Ms).toBe(1000);
    expect(s.p99Ms).toBe(1000);
    // p99 one-way = 500 -> 500 + 5000 = 5500 -> clamped to 6 s
    expect(s.recommendedLeadMs).toBe(6000);
  });

  it('counts a fire error of exactly 1000 ms as on time and 1001 ms as off time', () => {
    const mk = (id: string, error: number, dryRun = true) =>
      snipe({
        id,
        dryRun,
        fireAt: end - 8000,
        measured: { firedAt: end - 8000 + error },
      });
    const s = soakSummary([mk('on', 1000), mk('early', -1000), mk('off', 1001), mk('live', 0, false)]);
    expect(s.firesAttempted).toBe(3);
    expect(s.onTime).toBe(2);
    expect(s.offTime).toBe(1);
  });

  it('computes a real recommendation between the clamps', () => {
    const mk = (id: string, latency: number) =>
      snipe({ id, fireAt: end - 8000, measured: { firedAt: end - 8000, responseAt: end - 8000 + latency } });
    const s = soakSummary([mk('a', 3000), mk('b', 5000), mk('c', 7000), mk('d', 9000), mk('e', 11_000)]);
    expect(s.firesAttempted).toBe(5);
    // nearest-rank p99 of [3000,5000,7000,9000,11000]: ceil(0.99*5)=5 -> 11000
    expect(s.p99Ms).toBe(11_000);
    // one-way p99 = 5500 -> 5500 + 5000 = 10500
    expect(s.recommendedLeadMs).toBe(10_500);
  });
});
