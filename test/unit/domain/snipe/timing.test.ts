import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  CLOCK_SAMPLE_COUNT,
  CLOCK_SAMPLE_SPACING_MS,
  MAX_CLOCK_OFFSET_MS,
  MAX_RTT_MS,
  assessClock,
  clockSanity,
  computeFireAt,
  planClockSamples,
  toLocalFireAt,
} from '../../../../src/domain/snipe/timing';
import type { ComputeFireAt } from '../../../../src/domain/snipe/types';

const END = 1_800_000_000_000;

describe('computeFireAt', () => {
  it('is end - lead - oneWay (rtt/2)', () => {
    const f: ComputeFireAt = computeFireAt;
    expect(f(END, 8000, 150)).toBe(END - 8000 - 150);
  });

  it('allows fractional one-way latency', () => {
    expect(computeFireAt(END, 8000, 87.5)).toBe(END - 8087.5);
  });

  it('rejects negative or non-finite inputs with RangeError', () => {
    expect(() => computeFireAt(END, 8000, -1)).toThrow(RangeError);
    expect(() => computeFireAt(END, 8000, Number.NaN)).toThrow(RangeError);
    expect(() => computeFireAt(END, 8000, Number.POSITIVE_INFINITY)).toThrow(RangeError);
    expect(() => computeFireAt(END, Number.NaN, 100)).toThrow(RangeError);
  });

  it('property: fireAt < end - lead for any valid lead and oneWay >= 1', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 3000, max: 30000 }),
        fc.double({ min: 1, max: 1e6, noNaN: true }),
        fc.integer({ min: 1e12, max: 4e12 }),
        (lead, oneWay, end) => computeFireAt(end, lead, oneWay) < end - lead,
      ),
    );
  });
});

describe('toLocalFireAt', () => {
  it('local clock 1.3 s ahead of server (offset -1300) fires 1.3 s later on the local clock', () => {
    const server = computeFireAt(END, 8000, 100);
    expect(toLocalFireAt(server, -1300)).toBe(server + 1300);
  });

  it('local clock behind server fires earlier locally', () => {
    expect(toLocalFireAt(1000, 250)).toBe(750);
  });
});

describe('planClockSamples', () => {
  it('is 3 samples 20 s apart starting at wake', () => {
    expect(CLOCK_SAMPLE_COUNT).toBe(3);
    expect(CLOCK_SAMPLE_SPACING_MS).toBe(20_000);
    expect(planClockSamples(5000)).toEqual([5000, 25_000, 45_000]);
  });
});

const ok = (over: Partial<{ offsetMs: number; rttMs: number; confidence: 'none' | 'low' | 'high' }> = {}) => ({
  offsetMs: 0,
  rttMs: 200,
  samples: 3,
  confidence: 'high' as const,
  ...over,
});

describe('clockSanity', () => {
  it('allows exactly 5 min, aborts strictly beyond (both signs)', () => {
    expect(MAX_CLOCK_OFFSET_MS).toBe(300_000);
    expect(clockSanity({ offsetMs: 300_000 })).toEqual({ ok: true });
    expect(clockSanity({ offsetMs: -300_000 })).toEqual({ ok: true });
    expect(clockSanity({ offsetMs: 300_001 })).toEqual({ ok: false, reason: 'clock-skew' });
    expect(clockSanity({ offsetMs: -300_001 })).toEqual({ ok: false, reason: 'clock-skew' });
  });
  it('aborts on non-finite offset', () => {
    expect(clockSanity({ offsetMs: Number.NaN })).toEqual({ ok: false, reason: 'clock-skew' });
  });
});

describe('assessClock', () => {
  it('null offset aborts like confidence none', () => {
    expect(assessClock(null)).toEqual({ ok: false, reason: 'no-offset' });
    expect(assessClock(ok({ confidence: 'none' }))).toEqual({ ok: false, reason: 'no-offset' });
  });
  it('rtt: exactly 2000 allowed, above aborts', () => {
    expect(MAX_RTT_MS).toBe(2000);
    expect(assessClock(ok({ rttMs: 2000 }))).toEqual({ ok: true, offsetMs: 0, rttMs: 2000, oneWayMs: 1000 });
    expect(assessClock(ok({ rttMs: 2001 }))).toEqual({ ok: false, reason: 'rtt-too-high' });
  });
  it('clock skew aborts', () => {
    expect(assessClock(ok({ offsetMs: 300_001 }))).toEqual({ ok: false, reason: 'clock-skew' });
    expect(assessClock(ok({ offsetMs: -300_000, confidence: 'low' }))).toMatchObject({ ok: true, offsetMs: -300_000 });
  });
});
