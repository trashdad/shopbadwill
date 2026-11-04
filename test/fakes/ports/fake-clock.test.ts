import { describe, expect, it } from 'vitest';

import { FakeClock } from './fake-clock';

describe('FakeClock', () => {
  it('only moves when advanced', () => {
    const c = new FakeClock(1000);
    expect(c.now()).toBe(1000);
    expect(c.monotonic()).toBe(0);
    c.advance(250);
    expect(c.now()).toBe(1250);
    expect(c.monotonic()).toBe(250);
  });

  it('fires timers in time then creation order, with the clock at each fire time', () => {
    const c = new FakeClock(0);
    const log: string[] = [];
    c.setTimeout(() => log.push(`b@${String(c.now())}`), 20);
    c.setTimeout(() => log.push(`a@${String(c.now())}`), 10);
    c.setTimeout(() => log.push(`c@${String(c.now())}`), 20);
    c.advance(19);
    expect(log).toEqual(['a@10']);
    c.advance(1);
    expect(log).toEqual(['a@10', 'b@20', 'c@20']);
    expect(c.now()).toBe(20);
  });

  it('runs timers scheduled by timers inside the window and not outside', () => {
    const c = new FakeClock(0);
    let n = 0;
    const tick = (): void => {
      n += 1;
      c.setTimeout(tick, 10);
    };
    c.setTimeout(tick, 10);
    c.advance(35);
    expect(n).toBe(3);
    expect(c.pendingTimers).toBe(1);
  });

  it('clearTimeout cancels and ignores unknown ids', () => {
    const c = new FakeClock(0);
    let fired = false;
    const id = c.setTimeout(() => {
      fired = true;
    }, 5);
    c.clearTimeout(id);
    c.clearTimeout(9999);
    c.advance(10);
    expect(fired).toBe(false);
  });

  it('treats a negative delay as 0 and rejects negative advance', () => {
    const c = new FakeClock(0);
    let fired = false;
    c.setTimeout(() => {
      fired = true;
    }, -5);
    c.advance(0);
    expect(fired).toBe(true);
    expect(() => {
      c.advance(-1);
    }).toThrow(RangeError);
  });

  it('set() moves the wall clock without touching timers', () => {
    const c = new FakeClock(0);
    let fired = false;
    c.setTimeout(() => {
      fired = true;
    }, 100);
    c.set(1_000_000);
    expect(c.now()).toBe(1_000_000);
    expect(fired).toBe(false);
    c.advance(100);
    expect(fired).toBe(true);
    expect(c.now()).toBe(1_000_100);
  });
});
