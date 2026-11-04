// T-89: BrowserHttp's own timestamps (`startedAt` / `endedAt`) come from the
// same clock as BrowserClock. In a TEST build that clock carries T-59's
// time-travel offset, so every ClockSample (sentAt / receivedAt), every
// `observedAt` and the snipe runner's read round trips are in the fake
// timebase the runner schedules in; production reads Date.now(), unchanged.
// Under Vitest the flag follows `process.env.SBW_TEST` via vi.stubEnv.
import { afterEach, describe, expect, it, vi } from 'vitest';

import { setTestClockTo } from '../../../../src/adapters/browser/clock';
import { BrowserHttp } from '../../../../src/adapters/browser/http';

const T = 1_800_000_000_000;
const HOUR = 3_600_000;

const ok = (): Promise<Response> => Promise.resolve(new Response('{}', { status: 200 }));
const req = { url: 'https://api.example.test/x', method: 'GET', timeoutMs: 1000, credentials: 'omit' } as const;

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('BrowserHttp timestamps', () => {
  it('a test build stamps requests on the time-travel clock', async () => {
    vi.stubEnv('SBW_TEST', '1');
    vi.spyOn(Date, 'now').mockReturnValue(T);
    setTestClockTo(T + 5 * HOUR);
    const res = await new BrowserHttp({ fetch: ok, isOnline: () => true }).send(req);
    expect(res.startedAt).toBe(T + 5 * HOUR);
    expect(res.endedAt).toBe(T + 5 * HOUR);
  });

  it('production stamps requests with Date.now(), whatever offset a test left behind', async () => {
    vi.stubEnv('SBW_TEST', '1');
    vi.spyOn(Date, 'now').mockReturnValue(T);
    setTestClockTo(T + 5 * HOUR);
    vi.stubEnv('SBW_TEST', '');
    const res = await new BrowserHttp({ fetch: ok, isOnline: () => true }).send(req);
    expect(res.startedAt).toBe(T);
    expect(res.endedAt).toBe(T);
  });

  it('an injected now still wins', async () => {
    vi.stubEnv('SBW_TEST', '1');
    const times = [10, 25];
    const res = await new BrowserHttp({ fetch: ok, isOnline: () => true, now: () => times.shift() ?? 0 }).send(req);
    expect([res.startedAt, res.endedAt]).toEqual([10, 25]);
  });
});
