// T-59: the Alarms time-travel seam (src/adapters/browser/alarms.ts). In a
// test build the browser alarm API is never touched: alarms are tracked in
// fake time and fired by the `sbw:test:advance` / `sbw:test:fireAlarm` hooks.
// Production behavior (the real API) is unchanged and covered by
// test/integration/browser-ports.test.ts.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { browser } from 'wxt/browser';

import { BrowserAlarms, fireDueTestAlarms, fireTestAlarm } from '../../../../src/adapters/browser/alarms';
import { setTestClockTo } from '../../../../src/adapters/browser/clock';

const T = 1_800_000_000_000;
const MIN = 60_000;

/** The seam's fake now still ticks with real time; pin Date.now so the assertions are exact. */
function pinWallClock(): void {
  vi.spyOn(Date, 'now').mockReturnValue(T);
}

afterEach(async () => {
  // The test-build registry is module state: clear whatever this test left.
  const alarms = new BrowserAlarms();
  for (const a of await alarms.getAll()) await alarms.clear(a.name);
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('BrowserAlarms time travel (SBW_TEST)', () => {
  it('tracks alarms in fake time and never calls the browser API', async () => {
    vi.stubEnv('SBW_TEST', '1');
    pinWallClock();
    setTestClockTo(T);
    const create = vi.spyOn(browser.alarms, 'create');
    const alarms = new BrowserAlarms();
    await alarms.create('sbw:tick', { periodInMinutes: 2 });
    expect(create).not.toHaveBeenCalled();
    expect(await alarms.getAll()).toEqual([{ name: 'sbw:tick', scheduledTime: T + 2 * MIN, periodInMinutes: 2 }]);
    expect(await alarms.clear('sbw:tick')).toBe(true);
    expect(await alarms.getAll()).toEqual([]);
  });

  it('clamps delay and period to the 0.5 min production floor', async () => {
    vi.stubEnv('SBW_TEST', '1');
    pinWallClock();
    setTestClockTo(T);
    const alarms = new BrowserAlarms();
    await alarms.create('soon', { delayInMinutes: 0.1 });
    expect(await alarms.getAll()).toEqual([{ name: 'soon', scheduledTime: T + 0.5 * MIN }]);
  });

  it('fireDueTestAlarms fires due alarms in order, rescheduling periodic ones', async () => {
    vi.stubEnv('SBW_TEST', '1');
    pinWallClock();
    setTestClockTo(T);
    const alarms = new BrowserAlarms();
    await alarms.create('one', { when: T + 1 * MIN });
    await alarms.create('tick', { when: T + 1 * MIN, periodInMinutes: 2 });
    const cb = vi.fn();
    alarms.onAlarm(cb);

    // At T + 90 s the one-shot is due and the periodic one fires, rescheduling
    // to T + 3 min, which is not due yet.
    expect(fireDueTestAlarms(T + 1.5 * MIN)).toEqual([
      { name: 'one', scheduledTime: T + 1 * MIN },
      { name: 'tick', scheduledTime: T + 1 * MIN, periodInMinutes: 2 },
    ]);
    expect(cb).toHaveBeenCalledTimes(2);
    expect(await alarms.getAll()).toEqual([{ name: 'tick', scheduledTime: T + 3 * MIN, periodInMinutes: 2 }]);

    // A later fire that passes only one occurrence fires it once more.
    fireDueTestAlarms(T + 4.5 * MIN);
    expect(cb).toHaveBeenCalledTimes(3);
    expect(await alarms.getAll()).toEqual([{ name: 'tick', scheduledTime: T + 5 * MIN, periodInMinutes: 2 }]);
  });

  it('fireTestAlarm fires one alarm by name, whatever its scheduledTime', async () => {
    vi.stubEnv('SBW_TEST', '1');
    pinWallClock();
    setTestClockTo(T);
    const alarms = new BrowserAlarms();
    await alarms.create('sbw:tick', { periodInMinutes: 2 });
    const cb = vi.fn();
    alarms.onAlarm(cb);
    expect(fireTestAlarm('sbw:tick')).toEqual({ name: 'sbw:tick', scheduledTime: T + 2 * MIN, periodInMinutes: 2 });
    expect(cb).toHaveBeenCalledWith({ name: 'sbw:tick', scheduledTime: T + 2 * MIN, periodInMinutes: 2 });
    expect(await alarms.getAll()).toEqual([{ name: 'sbw:tick', scheduledTime: T + 4 * MIN, periodInMinutes: 2 }]);
    expect(() => fireTestAlarm('missing')).toThrow(/no test alarm named "missing"/);
  });

  it('production builds keep delegating to the browser API', async () => {
    vi.stubEnv('SBW_TEST', '');
    const create = vi.spyOn(browser.alarms, 'create');
    await new BrowserAlarms({ supportsPersist: false }).create('a', { periodInMinutes: 2 });
    expect(create).toHaveBeenCalledWith('a', { periodInMinutes: 2 });
  });
});
