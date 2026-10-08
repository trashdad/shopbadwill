import { describe, expect, it } from 'vitest';

import { FakeClock } from './fake-clock';
import { FakeKeepAlive } from './fake-keepalive';
import { FakeKeepAwake } from './fake-keepawake';
import { FakeNotifier } from './fake-notifier';
import { FakePermissions } from './fake-permissions';

describe('FakeNotifier', () => {
  it('assigns ids, records notifications, and routes actions and clicks', async () => {
    const n = new FakeNotifier();
    const events: Array<[string, string]> = [];
    const off = n.onAction((id, action) => events.push([id, action]));
    const a = await n.notify({ title: 't', message: 'm' });
    const b = await n.notify({ id: 'custom', title: 't2', message: 'm2' });
    expect([a, b]).toEqual(['fake-notification-1', 'custom']);
    expect(n.sent.map((s) => s.id)).toEqual([a, b]);
    n.triggerAction(a, 'snooze');
    n.click(b);
    off();
    n.click(b);
    expect(events).toEqual([
      [a, 'snooze'],
      [b, 'click'],
    ]);
  });

  it('models Firefox with supportsActions false', () => {
    expect(new FakeNotifier({ supportsActions: false }).supportsActions).toBe(false);
    expect(new FakeNotifier().supportsActions).toBe(true);
  });
});

describe('FakePermissions', () => {
  it('contains checks both permissions and origins', async () => {
    const p = new FakePermissions({ permissions: ['alarms'], origins: ['https://a/*'] });
    expect(await p.contains({ permissions: ['alarms'] })).toBe(true);
    expect(await p.contains({ origins: ['https://a/*'] })).toBe(true);
    expect(await p.contains({ permissions: ['alarms', 'power'] })).toBe(false);
    expect(await p.contains({ origins: ['https://b/*'] })).toBe(false);
    expect(await p.contains({})).toBe(true);
  });

  it('request grants by default, can be declined, and records asks', async () => {
    const p = new FakePermissions();
    expect(await p.request({ permissions: ['power'] })).toBe(true);
    expect(await p.contains({ permissions: ['power'] })).toBe(true);
    p.grantRequests = false;
    expect(await p.request({ origins: ['https://x/*'] })).toBe(false);
    expect(await p.contains({ origins: ['https://x/*'] })).toBe(false);
    expect(p.requested).toHaveLength(2);
  });

  it('revoke removes grants and fires onRemoved until unsubscribed', async () => {
    const p = new FakePermissions({ permissions: ['power'], origins: ['https://a/*'] });
    let n = 0;
    const off = p.onRemoved(() => {
      n += 1;
    });
    p.revoke({ permissions: ['power'], origins: ['https://a/*'] });
    expect(n).toBe(1);
    expect(await p.contains({ permissions: ['power'] })).toBe(false);
    expect(await p.contains({ origins: ['https://a/*'] })).toBe(false);
    off();
    p.revoke({});
    expect(n).toBe(1);
  });
});

describe('FakeKeepAwake', () => {
  it('tracks holds and releases', async () => {
    const k = new FakeKeepAwake();
    await k.hold('snipe');
    expect(k.isHeld).toBe(true);
    await k.release();
    expect(k.isHeld).toBe(false);
    expect(k.holds).toEqual(['snipe']);
    expect(k.releases).toBe(1);
  });

  it('is a recording no-op when unavailable', async () => {
    const k = new FakeKeepAwake({ available: false });
    await k.hold('x');
    expect(k.available).toBe(false);
    expect(k.isHeld).toBe(false);
    expect(k.holds).toEqual(['x']);
  });
});

describe('FakeKeepAlive', () => {
  it('records start and stop without a clock', () => {
    const k = new FakeKeepAlive();
    k.start(20_000);
    expect(k.running).toBe(true);
    k.stop();
    expect(k.running).toBe(false);
    expect(k.starts).toEqual([20_000]);
    expect(k.stops).toBe(1);
  });

  it('pings on the fake clock, restarts cleanly, and stops pinging', () => {
    const clock = new FakeClock(0);
    const k = new FakeKeepAlive(clock);
    k.start(1000);
    clock.advance(3500);
    expect(k.pings).toBe(3);
    k.start(500);
    expect(clock.pendingTimers).toBe(1);
    clock.advance(1000);
    expect(k.pings).toBe(5);
    k.stop();
    clock.advance(5000);
    expect(k.pings).toBe(5);
    expect(clock.pendingTimers).toBe(0);
  });
});
