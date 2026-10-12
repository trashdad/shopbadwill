// T-59: the `sbw:test:advance` hook (src/test-hooks/advance.ts): fast-forwards
// the Clock port, fires the alarms that became due, and stamps every
// background fetch with `x-sbw-fake-now` (what the fake SGW server logs in
// /__log). Same harness as the other hook tests.
import { afterEach, describe, expect, it, vi } from 'vitest';

import { BrowserAlarms } from '../../../src/adapters/browser/alarms';
import { BrowserClock, setTestClockTo } from '../../../src/adapters/browser/clock';
import { installHooks } from '../../../src/test-hooks';
import * as advanceHook from '../../../src/test-hooks/advance';
import { fakeHookBrowser } from './fake-hook-browser';

const T = 1_800_000_000_000;
const MIN = 60_000;

/** The seam's fake now still ticks with real time; pin Date.now so the assertions are exact. */
function pinWallClock(): void {
  vi.spyOn(Date, 'now').mockReturnValue(T);
}

function installAdvance() {
  const browserStub = fakeHookBrowser();
  installHooks({ './advance.ts': advanceHook }, browserStub);
  return browserStub;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('sbw:test:advance', () => {
  it('advances the Clock port by ms and reports the new now', async () => {
    vi.stubEnv('SBW_TEST', '1');
    pinWallClock();
    setTestClockTo(T);
    const browserStub = installAdvance();
    const port = browserStub.connect('sbw:test:advance');
    port.post({ payload: { ms: 5 * MIN } });
    expect(await port.nextReply()).toEqual({ ok: true, value: { now: T + 5 * MIN, fired: [], timers: [] } });
    expect(new BrowserClock().now()).toBe(T + 5 * MIN);
  });

  it('sets the Clock port to an absolute instant with to', async () => {
    vi.stubEnv('SBW_TEST', '1');
    pinWallClock();
    setTestClockTo(T);
    const browserStub = installAdvance();
    const port = browserStub.connect('sbw:test:advance');
    port.post({ payload: { to: T - 3 * MIN } });
    expect(await port.nextReply()).toEqual({ ok: true, value: { now: T - 3 * MIN, fired: [], timers: [] } });
    expect(new BrowserClock().now()).toBe(T - 3 * MIN);
  });

  it('fires the alarms that become due and names them', async () => {
    vi.stubEnv('SBW_TEST', '1');
    pinWallClock();
    setTestClockTo(T);
    const alarms = new BrowserAlarms();
    await alarms.create('sbw:tick', { when: T + 1 * MIN, periodInMinutes: 2 });
    const cb = vi.fn();
    alarms.onAlarm(cb);
    const browserStub = installAdvance();
    const port = browserStub.connect('sbw:test:advance');
    port.post({ payload: { ms: 2.5 * MIN } });
    expect(await port.nextReply()).toEqual({ ok: true, value: { now: T + 2.5 * MIN, fired: ['sbw:tick'], timers: [] } });
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('fires the Clock timers that become due and lists the pending deadlines', async () => {
    vi.stubEnv('SBW_TEST', '1');
    pinWallClock();
    setTestClockTo(T);
    const c = new BrowserClock();
    const gap = vi.fn();
    const later = c.setTimeout(() => undefined, 30 * MIN);
    c.setTimeout(gap, 2 * MIN);
    const browserStub = installAdvance();
    const peek = browserStub.connect('sbw:test:advance');
    peek.post({ payload: { ms: 0 } });
    // (`fired` lists alarms; an earlier test's periodic alarm may still be registered.)
    expect(await peek.nextReply()).toMatchObject({ ok: true, value: { now: T, timers: [T + 2 * MIN, T + 30 * MIN] } });
    const port = browserStub.connect('sbw:test:advance');
    port.post({ payload: { ms: 3 * MIN } });
    expect(await port.nextReply()).toMatchObject({ ok: true, value: { now: T + 3 * MIN, timers: [T + 30 * MIN] } });
    expect(gap).toHaveBeenCalledTimes(1);
    c.clearTimeout(later);
  });

  it('refuses a payload with neither ms nor to', async () => {
    vi.stubEnv('SBW_TEST', '1');
    const browserStub = installAdvance();
    const empty = browserStub.connect('sbw:test:advance');
    empty.post({ payload: {} });
    const emptyReply = await empty.nextReply();
    expect(emptyReply.ok).toBe(false);
    expect(emptyReply.error).toMatch(/at least one of them/);
    const negative = browserStub.connect('sbw:test:advance');
    negative.post({ payload: { ms: -1 } });
    const negativeReply = await negative.nextReply();
    expect(negativeReply.ok).toBe(false);
    expect(negativeReply.error).toMatch(/at least one of them/);
  });

  it('stamps every background fetch with x-sbw-fake-now', async () => {
    vi.stubEnv('SBW_TEST', '1');
    pinWallClock();
    setTestClockTo(T);
    const real = vi.fn<typeof fetch>().mockResolvedValue(new Response('ok', { status: 200 }));
    vi.stubGlobal('fetch', real);
    installAdvance();
    const res = await globalThis.fetch('https://buyerapi.shopgoodwill.com/api/Search/ItemListing', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(res.status).toBe(200);
    const [url, init] = real.mock.calls[0] ?? [];
    expect(url).toBe('https://buyerapi.shopgoodwill.com/api/Search/ItemListing');
    const headers = new Headers(init?.headers);
    expect(headers.get('x-sbw-fake-now')).toBe(String(T));
  });
});
