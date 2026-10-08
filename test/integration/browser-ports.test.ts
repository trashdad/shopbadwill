import { http, HttpResponse, delay } from 'msw';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { browser } from 'wxt/browser';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import { BrowserAlarms } from '../../src/adapters/browser/alarms';
import { BrowserClock } from '../../src/adapters/browser/clock';
import { BrowserHttp } from '../../src/adapters/browser/http';
import { BrowserKeepAlive } from '../../src/adapters/browser/keep-alive';
import { BrowserKeepAwake } from '../../src/adapters/browser/keep-awake';
import { BrowserNotifier } from '../../src/adapters/browser/notifier';
import { BrowserPermissions } from '../../src/adapters/browser/permissions';
import { createStorageAreas } from '../../src/adapters/browser/storage';
import { HttpNetworkError, HttpTimeoutError } from '../../src/ports/errors';
import { mswServer } from '../setup/vitest.setup';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('BrowserAlarms', () => {
  it('clamps 0.1 min to 0.5 and passes persistAcrossSessions only when supported', async () => {
    const spy = vi.spyOn(browser.alarms, 'create');
    await new BrowserAlarms({ supportsPersist: false }).create('a', { delayInMinutes: 0.1, periodInMinutes: 0.2 });
    expect(spy).toHaveBeenLastCalledWith('a', { delayInMinutes: 0.5, periodInMinutes: 0.5 });
    await new BrowserAlarms({ supportsPersist: true }).create('b', { delayInMinutes: 2 });
    expect(spy).toHaveBeenLastCalledWith('b', { delayInMinutes: 2, persistAcrossSessions: true });
    expect((await browser.alarms.get('b'))?.name).toBe('b');
  });

  it('retries without persistAcrossSessions when the browser rejects it', async () => {
    const spy = vi
      .spyOn(browser.alarms, 'create')
      .mockRejectedValueOnce(new Error('Unexpected property "persistAcrossSessions"'));
    await new BrowserAlarms({ supportsPersist: true }).create('c', { delayInMinutes: 1 });
    expect(spy).toHaveBeenLastCalledWith('c', { delayInMinutes: 1 });
  });

  it('never detects persist support under Firefox', async () => {
    vi.stubEnv('FIREFOX', 'true');
    const spy = vi.spyOn(browser.alarms, 'create');
    await new BrowserAlarms().create('d', { delayInMinutes: 1 });
    expect(spy).toHaveBeenLastCalledWith('d', { delayInMinutes: 1 });
  });

  it('lists, fires and clears', async () => {
    const alarms = new BrowserAlarms({ supportsPersist: false });
    await alarms.create('e', { periodInMinutes: 1 });
    expect((await alarms.getAll()).map((a) => a.name)).toEqual(['e']);
    const cb = vi.fn();
    const off = alarms.onAlarm(cb);
    await fakeBrowser.alarms.onAlarm.trigger({ name: 'e', scheduledTime: 5, persistAcrossSessions: false });
    expect(cb).toHaveBeenCalledWith({ name: 'e', scheduledTime: 5 });
    off();
    await fakeBrowser.alarms.onAlarm.trigger({ name: 'e', scheduledTime: 6, persistAcrossSessions: false });
    expect(cb).toHaveBeenCalledTimes(1);
    expect(await alarms.clear('e')).toBe(true);
  });
});

describe('BrowserHttp', () => {
  it('throws HttpTimeoutError after timeoutMs', async () => {
    mswServer.use(
      http.get('https://slow.example.test/x', async () => {
        await delay(2_000);
        return HttpResponse.text('late');
      }),
    );
    const p = new BrowserHttp().send({
      url: 'https://slow.example.test/x',
      method: 'GET',
      timeoutMs: 50,
      credentials: 'omit',
    });
    await expect(p).rejects.toBeInstanceOf(HttpTimeoutError);
    await expect(p).rejects.toMatchObject({ timeoutMs: 50 });
  });

  it('returns status, lower-cased headers, body and timing; sends credentials omit', async () => {
    mswServer.use(
      http.post('https://api.example.test/echo', async ({ request }) =>
        HttpResponse.text(`${request.credentials}:${await request.text()}`, { headers: { 'X-Thing': 'v' } }),
      ),
    );
    const times = [100, 150];
    const res = await new BrowserHttp({ now: () => times.shift() ?? 0 }).send({
      url: 'https://api.example.test/echo',
      method: 'POST',
      body: 'hi',
      headers: { authorization: 'Bearer x' },
      timeoutMs: 1000,
      credentials: 'omit',
    });
    expect(res).toMatchObject({ status: 200, bodyText: 'omit:hi', startedAt: 100, endedAt: 150 });
    expect(res.headers['x-thing']).toBe('v');
  });

  it('beforeSend is true only when fetch was not called', async () => {
    const fetchFn = vi.fn<typeof fetch>().mockRejectedValue(new TypeError('Failed to fetch'));
    const h = new BrowserHttp({ fetch: fetchFn });
    const base = { method: 'GET', timeoutMs: 100, credentials: 'omit' } as const;
    await expect(h.send({ ...base, url: 'not a url' })).rejects.toMatchObject({ beforeSend: true });
    expect(fetchFn).not.toHaveBeenCalled();
    await expect(
      new BrowserHttp({ fetch: fetchFn, isOnline: () => false }).send({ ...base, url: 'https://a.example.test/' }),
    ).rejects.toMatchObject({ beforeSend: true });
    expect(fetchFn).not.toHaveBeenCalled();
    const err = await h.send({ ...base, url: 'https://a.example.test/' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpNetworkError);
    expect(err).toMatchObject({ beforeSend: false });
  });
});

describe('BrowserNotifier', () => {
  it('supportsActions is false under FIREFOX and true otherwise', () => {
    expect(new BrowserNotifier().supportsActions).toBe(true);
    vi.stubEnv('FIREFOX', 'true');
    expect(new BrowserNotifier().supportsActions).toBe(false);
  });

  it('Firefox sends basic notifications without buttons', async () => {
    const spy = vi.spyOn(browser.notifications, 'create');
    const n = new BrowserNotifier({ supportsActions: false });
    await n.notify({ id: 'x', title: 't', message: 'm', priority: 2, actions: [{ id: 'a', title: 'A' }] });
    const opts = spy.mock.calls[0]?.[1] as unknown as Record<string, unknown>;
    expect(opts).toMatchObject({ type: 'basic', title: 't', message: 'm' });
    expect(opts).not.toHaveProperty('buttons');
  });

  it('maps button clicks to action ids and body clicks to click, opening the url', async () => {
    const n = new BrowserNotifier({ supportsActions: true });
    const tabs = vi.spyOn(browser.tabs, 'create').mockResolvedValue({} as never);
    const id = await n.notify({
      title: 't',
      message: 'm',
      actions: [
        { id: 'snooze', title: 'Snooze' },
        { id: 'open', title: 'Open' },
      ],
      openUrlOnClick: 'https://example.test/',
    });
    const cb = vi.fn();
    n.onAction(cb);
    await fakeBrowser.notifications.onButtonClicked.trigger(id, 1);
    expect(cb).toHaveBeenLastCalledWith(id, 'open');
    await fakeBrowser.notifications.onClicked.trigger(id);
    expect(cb).toHaveBeenLastCalledWith(id, 'click');
    expect(tabs).toHaveBeenCalledWith({ url: 'https://example.test/' });
  });
});

describe('BrowserPermissions', () => {
  it('delegates and notifies on removal', async () => {
    const p = new BrowserPermissions();
    vi.spyOn(browser.permissions, 'contains').mockResolvedValue(true as never);
    vi.spyOn(browser.permissions, 'request').mockResolvedValue(false as never);
    expect(await p.contains({ origins: ['https://x.test/*'] })).toBe(true);
    expect(await p.request({ permissions: ['power'] })).toBe(false);
    // fakeBrowser has no permissions events: hand-written fake event.
    const listeners = new Set<() => void>();
    vi.spyOn(browser.permissions.onRemoved, 'addListener').mockImplementation((l) => {
      listeners.add(l as () => void);
    });
    vi.spyOn(browser.permissions.onRemoved, 'removeListener').mockImplementation((l) => {
      listeners.delete(l as () => void);
    });
    const cb = vi.fn();
    const off = p.onRemoved(cb);
    listeners.forEach((l) => {
      l();
    });
    expect(cb).toHaveBeenCalledTimes(1);
    off();
    listeners.forEach((l) => {
      l();
    });
    expect(cb).toHaveBeenCalledTimes(1);
  });
});

describe('BrowserKeepAwake', () => {
  const setPower = (power: unknown): void => {
    (browser as unknown as { power: unknown }).power = power;
  };
  afterEach(() => {
    setPower(undefined);
  });

  it('is a no-op when power is unavailable', async () => {
    setPower(undefined);
    const k = new BrowserKeepAwake();
    expect(k.available).toBe(false);
    await expect(k.hold('x')).resolves.toBeUndefined();
    await expect(k.release()).resolves.toBeUndefined();
  });

  it('holds only when the permission is granted, and releases once', async () => {
    const power = { requestKeepAwake: vi.fn(), releaseKeepAwake: vi.fn() };
    setPower(power);
    const contains = vi.spyOn(browser.permissions, 'contains').mockResolvedValue(false as never);
    const k = new BrowserKeepAwake();
    expect(k.available).toBe(true);
    await k.hold('snipe');
    expect(power.requestKeepAwake).not.toHaveBeenCalled();
    contains.mockResolvedValue(true as never);
    await k.hold('snipe');
    expect(power.requestKeepAwake).toHaveBeenCalledWith('system');
    await k.release();
    await k.release();
    expect(power.releaseKeepAwake).toHaveBeenCalledTimes(1);
  });
});

describe('BrowserKeepAlive', () => {
  it('calls runtime.getPlatformInfo every interval until stopped', async () => {
    vi.useFakeTimers();
    const spy = vi.spyOn(browser.runtime, 'getPlatformInfo').mockResolvedValue({} as never);
    const k = new BrowserKeepAlive();
    k.start(20_000);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(spy).toHaveBeenCalledTimes(3);
    k.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(spy).toHaveBeenCalledTimes(3);
  });
});

describe('BrowserClock', () => {
  it('wraps Date, performance and timers', async () => {
    const c = new BrowserClock();
    expect(Math.abs(c.now() - Date.now())).toBeLessThan(50);
    expect(c.monotonic()).toBeGreaterThan(0);
    const fn = vi.fn();
    const id = c.setTimeout(fn, 5);
    expect(typeof id).toBe('number');
    await new Promise((r) => setTimeout(r, 30));
    expect(fn).toHaveBeenCalledTimes(1);
    const fn2 = vi.fn();
    c.clearTimeout(c.setTimeout(fn2, 5));
    await new Promise((r) => setTimeout(r, 30));
    expect(fn2).not.toHaveBeenCalled();
  });
});

describe('storage areas', () => {
  it('gets, sets, removes and filters change events by area', async () => {
    const s = createStorageAreas();
    const local = vi.fn();
    const session = vi.fn();
    s.local.onChanged(local);
    s.session.onChanged(session);
    await s.local.set({ a: 1, b: 2 });
    await s.session.set({ a: 'x' });
    expect(await s.local.get<number>('a')).toBe(1);
    expect(await s.session.get<string>('a')).toBe('x');
    expect(await s.local.get('missing')).toBeUndefined();
    await s.local.remove(['a']);
    expect(await s.local.get('a')).toBeUndefined();
    expect(local).toHaveBeenCalled();
    expect(session).toHaveBeenCalledTimes(1);
  });
});
