import { describe, expect, it } from 'vitest';

import type { AlarmInfo } from '../../../src/ports/alarms';
import { clampMinutes, FakeAlarms, MAX_EXTRA_DELAY_MS, type FakeAlarmsOptions } from './fake-alarms';
import { FakeClock } from './fake-clock';

const MIN = 60_000;

function setup(opts?: FakeAlarmsOptions) {
  const clock = new FakeClock(0);
  const alarms = new FakeAlarms(clock, opts);
  const fired: Array<AlarmInfo & { at: number }> = [];
  alarms.onAlarm((a) => fired.push({ ...a, at: clock.now() }));
  return { clock, alarms, fired };
}

describe('clampMinutes', () => {
  it('clamps below the 0.5 floor and leaves the floor and above alone', () => {
    expect(clampMinutes(0)).toEqual({ value: 0.5, clamped: true });
    expect(clampMinutes(0.49)).toEqual({ value: 0.5, clamped: true });
    expect(clampMinutes(-3)).toEqual({ value: 0.5, clamped: true });
    expect(clampMinutes(0.5)).toEqual({ value: 0.5, clamped: false });
    expect(clampMinutes(2)).toEqual({ value: 2, clamped: false });
  });
});

describe('FakeAlarms clamping', () => {
  it('clamps delayInMinutes < 0.5 and records a warning', async () => {
    const { alarms } = setup();
    await alarms.create('a', { delayInMinutes: 0.1 });
    expect(alarms.warnings).toHaveLength(1);
    expect(alarms.warnings[0]).toContain('delayInMinutes');
    expect(await alarms.getAll()).toEqual([{ name: 'a', scheduledTime: 30_000 }]);
  });

  it('clamps periodInMinutes < 0.5 and records a warning', async () => {
    const { alarms } = setup();
    await alarms.create('p', { periodInMinutes: 0.01 });
    expect(alarms.warnings).toHaveLength(1);
    expect(alarms.warnings[0]).toContain('periodInMinutes');
    expect(await alarms.getAll()).toEqual([{ name: 'p', scheduledTime: 30_000, periodInMinutes: 0.5 }]);
  });

  it('records one warning per clamped field and none when both are legal', async () => {
    const { alarms } = setup();
    await alarms.create('both', { delayInMinutes: 0.2, periodInMinutes: 0.2 });
    expect(alarms.warnings).toHaveLength(2);
    await alarms.create('ok', { delayInMinutes: 0.5, periodInMinutes: 1 });
    await alarms.create('when', { when: 5000 });
    expect(alarms.warnings).toHaveLength(2);
  });

  it('uses the period as the first delay when only a period is given', async () => {
    const { alarms } = setup();
    await alarms.create('p', { periodInMinutes: 2 });
    expect(await alarms.getAll()).toEqual([{ name: 'p', scheduledTime: 2 * MIN, periodInMinutes: 2 }]);
  });

  it('is immediately due when neither when, delay nor period is given', async () => {
    const { alarms, fired } = setup();
    await alarms.create('now', {});
    alarms.advance(0);
    expect(fired.map((f) => f.name)).toEqual(['now']);
  });
});

describe('FakeAlarms.advance', () => {
  it('fires a one-shot alarm once at its time and removes it', async () => {
    const { alarms, fired } = setup();
    await alarms.create('a', { delayInMinutes: 1 });
    alarms.advance(59_999);
    expect(fired).toHaveLength(0);
    alarms.advance(1);
    expect(fired).toEqual([{ name: 'a', scheduledTime: MIN, at: MIN }]);
    expect(await alarms.getAll()).toEqual([]);
    alarms.advance(10 * MIN);
    expect(fired).toHaveLength(1);
  });

  it('repeats periodic alarms, including several periods in one advance', async () => {
    const { alarms, fired, clock } = setup();
    await alarms.create('p', { delayInMinutes: 1, periodInMinutes: 1 });
    alarms.advance(3.5 * MIN);
    expect(fired.map((f) => f.at)).toEqual([MIN, 2 * MIN, 3 * MIN]);
    expect(fired.map((f) => f.scheduledTime)).toEqual([MIN, 2 * MIN, 3 * MIN]);
    expect(clock.now()).toBe(3.5 * MIN);
  });

  it('fires alarms in time order', async () => {
    const { alarms, fired } = setup();
    await alarms.create('late', { when: 2000 });
    await alarms.create('early', { when: 1000 });
    alarms.advance(5000);
    expect(fired.map((f) => f.name)).toEqual(['early', 'late']);
  });

  it('adds the extra delay to the firing time but not to scheduledTime', async () => {
    const { alarms, fired } = setup({ extraDelayMs: 7000 });
    await alarms.create('a', { delayInMinutes: 1 });
    alarms.advance(MIN);
    expect(fired).toHaveLength(0);
    alarms.advance(7000);
    expect(fired).toEqual([{ name: 'a', scheduledTime: MIN, at: MIN + 7000 }]);
  });

  it('draws a function extra delay once per occurrence and caps it at 60 s', async () => {
    const draws = [1000, 500_000, -5];
    const { alarms, fired } = setup({ extraDelayMs: () => draws.shift() ?? 0 });
    await alarms.create('p', { delayInMinutes: 1, periodInMinutes: 1 });
    alarms.advance(3 * MIN + MAX_EXTRA_DELAY_MS);
    expect(fired.map((f) => f.at)).toEqual([MIN + 1000, 2 * MIN + MAX_EXTRA_DELAY_MS, 3 * MIN, 4 * MIN]);
  });

  it('create replaces an alarm with the same name, and clear removes it', async () => {
    const { alarms, fired } = setup();
    await alarms.create('a', { when: 1000 });
    await alarms.create('a', { when: 9000 });
    expect(await alarms.getAll()).toHaveLength(1);
    expect(await alarms.clear('a')).toBe(true);
    expect(await alarms.clear('a')).toBe(false);
    alarms.advance(10_000);
    expect(fired).toHaveLength(0);
  });

  it('unsubscribe stops callbacks', async () => {
    const clock = new FakeClock(0);
    const alarms = new FakeAlarms(clock);
    let n = 0;
    const off = alarms.onAlarm(() => {
      n += 1;
    });
    await alarms.create('a', { when: 10 });
    off();
    alarms.advance(100);
    expect(n).toBe(0);
  });
});
