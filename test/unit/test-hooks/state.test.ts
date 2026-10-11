import { describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';

import { installHooks } from '../../../src/test-hooks';
import * as stateHook from '../../../src/test-hooks/state';
import { fakeHookBrowser } from './fake-hook-browser';

describe('sbw:test:state', () => {
  it('dumps storage.local, storage.session, alarms, the hook list and when the hooks were installed', async () => {
    vi.useFakeTimers({ now: 1_790_000_000_000, toFake: ['Date'] });
    const browserStub = fakeHookBrowser();
    installHooks({ './state.ts': stateHook }, browserStub);
    vi.useRealTimers();

    await fakeBrowser.storage.local.set({ settings: { killSwitch: false }, schemaVersion: 1 });
    await fakeBrowser.storage.session.set({ token: 'session-only' });
    await fakeBrowser.alarms.create('sbw:tick', { periodInMinutes: 2 });

    const port = browserStub.connect(stateHook.STATE_HOOK);
    port.post({});
    const reply = await port.nextReply();

    expect(reply.ok).toBe(true);
    expect(reply.value).toEqual({
      installedAt: 1_790_000_000_000,
      hooks: ['state'],
      storage: {
        local: { settings: { killSwitch: false }, schemaVersion: 1 },
        session: { token: 'session-only' },
      },
      alarms: [expect.objectContaining({ name: 'sbw:tick', periodInMinutes: 2 })],
    });
  });

  it('reports empty storage and no alarms on a fresh profile', async () => {
    const browserStub = fakeHookBrowser();
    installHooks({ './state.ts': stateHook }, browserStub);
    const port = browserStub.connect('sbw:test:state');
    port.post({});
    const reply = await port.nextReply();
    expect(reply.value).toMatchObject({ storage: { local: {}, session: {} }, alarms: [] });
  });
});
