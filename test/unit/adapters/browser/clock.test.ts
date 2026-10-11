// T-59: the Clock time-travel seam (src/adapters/browser/clock.ts). Compiled
// out of production (`import.meta.env.SBW_TEST` is the literal `false` there):
// under Vitest the flag follows `process.env.SBW_TEST` via vi.stubEnv, as the
// existing test-hooks tests do.
import { afterEach, describe, expect, it, vi } from 'vitest';

import { advanceTestClock, BrowserClock, setTestClockTo } from '../../../../src/adapters/browser/clock';

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
});
