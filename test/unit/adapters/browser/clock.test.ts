// T-59: the Clock time-travel seam (src/adapters/browser/clock.ts). Compiled
// out of production (`import.meta.env.SBW_TEST` is the literal `false` there):
// under Vitest the flag follows `process.env.SBW_TEST` via vi.stubEnv, as the
// existing test-hooks tests do.
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  advanceTestClock,
  BrowserClock,
  fireDueTestTimers,
  pendingTestTimers,
  setTestClockTo,
} from '../../../../src/adapters/browser/clock';

const T = 1_800_000_000_000;
const MIN = 60_000;

/** The seam's fake now still ticks with real time; pin Date.now so the assertions are exact. */
function pinWallClock(): void {
  vi.spyOn(Date, 'now').mockReturnValue(T);
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('BrowserClock time travel (SBW_TEST)', () => {
  it('production builds ignore the offset and never throw on it', () => {
    vi.stubEnv('SBW_TEST', '');
    expect(Math.abs(setTestClockTo(T) - Date.now())).toBeLessThan(50);
    const c = new BrowserClock();
    expect(Math.abs(c.now() - Date.now())).toBeLessThan(50);
    expect(c.monotonic()).toBeGreaterThan(0);
    expect(Math.abs(advanceTestClock(MIN) - Date.now())).toBeLessThan(50);
  });

  it('setTestClockTo pins now() to the given instant', () => {
    vi.stubEnv('SBW_TEST', '1');
    pinWallClock();
    expect(setTestClockTo(T)).toBe(T);
    expect(new BrowserClock().now()).toBe(T);
  });

  it('advanceTestClock fast-forwards wall and monotonic time together', () => {
    vi.stubEnv('SBW_TEST', '1');
    pinWallClock();
    setTestClockTo(T);
    const c = new BrowserClock();
    const monoBefore = c.monotonic();
    expect(advanceTestClock(5 * MIN)).toBe(T + 5 * MIN);
    expect(c.now()).toBe(T + 5 * MIN);
    // Real monotonic time also passes while the test runs: the delta is the
    // fake step plus a few real milliseconds, never the fake step alone.
    const delta = c.monotonic() - monoBefore;
    expect(delta).toBeGreaterThanOrEqual(5 * MIN);
    expect(delta).toBeLessThan(5 * MIN + 50);
  });

  it('refuses a negative or non-finite move and changes nothing', () => {
    vi.stubEnv('SBW_TEST', '1');
    pinWallClock();
    setTestClockTo(T);
    expect(() => advanceTestClock(-1)).toThrow(/non-negative/);
    expect(() => advanceTestClock(Number.NaN)).toThrow(/non-negative/);
    expect(() => setTestClockTo(Number.POSITIVE_INFINITY)).toThrow(/finite/);
    expect(new BrowserClock().now()).toBe(T);
  });

  it('fast-forwards Clock timers: one whose fake deadline passed fires on advance, once', () => {
    vi.stubEnv('SBW_TEST', '1');
    pinWallClock();
    setTestClockTo(T);
    const c = new BrowserClock();
    const due = vi.fn();
    const later = vi.fn();
    c.setTimeout(due, 2 * MIN);
    const laterId = c.setTimeout(later, 10 * MIN);
    expect(pendingTestTimers()).toEqual([T + 2 * MIN, T + 10 * MIN]);
    expect(fireDueTestTimers(advanceTestClock(1 * MIN))).toBe(0);
    expect(due).not.toHaveBeenCalled();
    expect(fireDueTestTimers(advanceTestClock(2 * MIN))).toBe(1);
    expect(due).toHaveBeenCalledTimes(1);
    expect(fireDueTestTimers(advanceTestClock(1 * MIN))).toBe(0);
    expect(due).toHaveBeenCalledTimes(1);
    expect(pendingTestTimers()).toEqual([T + 10 * MIN]);
    c.clearTimeout(laterId);
    expect(pendingTestTimers()).toEqual([]);
    expect(fireDueTestTimers(advanceTestClock(60 * MIN))).toBe(0);
    expect(later).not.toHaveBeenCalled();
  });

  it('a fast-forwarded timer still fires on real time when nobody advances', async () => {
    vi.stubEnv('SBW_TEST', '1');
    const c = new BrowserClock();
    await new Promise<void>((resolve) => c.setTimeout(resolve, 1));
    expect(pendingTestTimers()).toEqual([]);
  });

  it('production builds track no timers', () => {
    vi.stubEnv('SBW_TEST', '');
    const c = new BrowserClock();
    const id = c.setTimeout(() => undefined, 10 * MIN);
    expect(pendingTestTimers()).toEqual([]);
    expect(fireDueTestTimers(Number.MAX_SAFE_INTEGER)).toBe(0);
    c.clearTimeout(id);
  });
});
