// T-59: the `sbw:test:fireAlarm` hook (src/test-hooks/fire-alarm.ts): fires
// one tracked test alarm by name, whatever its scheduledTime, so the E2E can
// trigger `sbw:tick` directly. Same harness as the other hook tests.
import { afterEach, describe, expect, it, vi } from 'vitest';

import { BrowserAlarms } from '../../../src/adapters/browser/alarms';
import { setTestClockTo } from '../../../src/adapters/browser/clock';
import { installHooks } from '../../../src/test-hooks';
import * as fireAlarmHook from '../../../src/test-hooks/fire-alarm';
import { fakeHookBrowser } from './fake-hook-browser';

const T = 1_800_000_000_000;
const MIN = 60_000;

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('sbw:test:fireAlarm', () => {
  it('fires a tracked alarm by name and reports its info', async () => {
    vi.stubEnv('SBW_TEST', '1');
    vi.spyOn(Date, 'now').mockReturnValue(T);
    setTestClockTo(T);
    const alarms = new BrowserAlarms();
    await alarms.create('sbw:tick', { periodInMinutes: 2 });
    const cb = vi.fn();
    alarms.onAlarm(cb);

    const browserStub = fakeHookBrowser();
    installHooks({ './fire-alarm.ts': fireAlarmHook }, browserStub);
    const port = browserStub.connect('sbw:test:fireAlarm');
    port.post({ payload: { name: 'sbw:tick' } });
    expect(await port.nextReply()).toEqual({
      ok: true,
      value: { name: 'sbw:tick', scheduledTime: T + 2 * MIN, periodInMinutes: 2 },
    });
    expect(cb).toHaveBeenCalledWith({ name: 'sbw:tick', scheduledTime: T + 2 * MIN, periodInMinutes: 2 });
  });

  it('reports a missing alarm as an error', async () => {
    vi.stubEnv('SBW_TEST', '1');
    const browserStub = fakeHookBrowser();
    installHooks({ './fire-alarm.ts': fireAlarmHook }, browserStub);
    const port = browserStub.connect('sbw:test:fireAlarm');
    port.post({ payload: { name: 'nope' } });
    const reply = await port.nextReply();
    expect(reply.ok).toBe(false);
    expect(reply.error).toMatch(/no test alarm named "nope"/);
  });

  it('refuses a payload without a name', async () => {
    vi.stubEnv('SBW_TEST', '1');
    const browserStub = fakeHookBrowser();
    installHooks({ './fire-alarm.ts': fireAlarmHook }, browserStub);
    const port = browserStub.connect('sbw:test:fireAlarm');
    port.post({ payload: {} });
    const reply = await port.nextReply();
    expect(reply.ok).toBe(false);
    expect(reply.error).toMatch(/expected \{ name: string \}/);
  });
});
