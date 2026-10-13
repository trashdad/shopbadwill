// T-104: `sbw:test:notifications` (src/test-hooks/notifications.ts), the
// test-only record of what the background asked the browser to show. Chrome
// answers `notifications.getAll()` with ids only, and the permission is
// optional (a headless E2E cannot answer its prompt), so the money E2E reads
// the outcome notification's text from here.
import { describe, expect, it, vi } from 'vitest';

import { installHooks } from '../../../src/test-hooks';
import * as notificationsHook from '../../../src/test-hooks/notifications';
import { fakeHookBrowser, type FakeHookBrowser, type Reply } from './fake-hook-browser';

interface NotificationsApi {
  create(...args: unknown[]): unknown;
  clear?(id: string): unknown;
}
type WithNotifications = FakeHookBrowser & { notifications?: NotificationsApi };

function rig(browser: WithNotifications = fakeHookBrowser()): { browser: WithNotifications; call: (payload: unknown) => Promise<Reply> } {
  installHooks({ './notifications.ts': notificationsHook }, browser);
  const call = (payload: unknown): Promise<Reply> => {
    const port = browser.connect(notificationsHook.NOTIFICATIONS_HOOK);
    port.post({ payload });
    return port.nextReply();
  };
  return { browser, call };
}

function api(browser: WithNotifications): NotificationsApi {
  const n = browser.notifications;
  if (n === undefined) throw new Error('no notifications on the browser');
  return n;
}

describe('sbw:test:notifications', () => {
  it('is dormant until the harness installs it: loading the hook leaves notifications alone', () => {
    const { browser } = rig();
    expect(browser.notifications).toBeUndefined();
  });

  it('without the permission (no API), install puts a recording stand-in on the browser', async () => {
    const { browser, call } = rig();
    expect(await call({ op: 'install' })).toEqual({ ok: true, value: { mode: 'stand-in' } });
    // The notifier's call shape: create(id, options) → the id (Chrome's promise form).
    await expect(api(browser).create('sbw:snipe:a:1', { type: 'basic', title: 'Won: Pyrex', message: 'Won at $17.50.' })).resolves.toBe('sbw:snipe:a:1');
    // The one-argument form gets an id.
    const id = await api(browser).create({ type: 'basic', title: 'T', message: 'M' });
    expect(typeof id).toBe('string');
    const listed = await call({ op: 'list' });
    expect(listed.ok).toBe(true);
    expect(listed.value).toEqual([
      { id: 'sbw:snipe:a:1', title: 'Won: Pyrex', message: 'Won at $17.50.', at: expect.any(Number) as number },
      { id, title: 'T', message: 'M', at: expect.any(Number) as number },
    ]);
    // A second install keeps the same stand-in and the record.
    expect((await call({ op: 'install' })).value).toEqual({ mode: 'stand-in' });
    expect((await call({ op: 'list' })).value).toHaveLength(2);
  });

  it('with the permission (a real API), install records and then passes every call through unchanged', async () => {
    const browser: WithNotifications = fakeHookBrowser();
    const realCreate = vi.fn((nid: unknown) => Promise.resolve(`real:${String(nid)}`));
    const real: NotificationsApi = { create: realCreate, clear: () => Promise.resolve(true) };
    browser.notifications = real;
    const { call } = rig(browser);
    expect((await call({ op: 'install' })).value).toEqual({ mode: 'wrapped' });
    expect(browser.notifications).toBe(real);
    const options = { type: 'basic', title: 'Lost: Pyrex', message: 'Lost: outbid at $21.00.' };
    await expect(api(browser).create('n1', options)).resolves.toBe('real:n1');
    expect(realCreate).toHaveBeenCalledWith('n1', options);
    expect((await call({ op: 'list' })).value).toEqual([{ id: 'n1', title: 'Lost: Pyrex', message: 'Lost: outbid at $21.00.', at: expect.any(Number) as number }]);
    // Uninstall restores the browser's own create.
    expect((await call({ op: 'uninstall' })).value).toEqual({ uninstalled: true });
    await api(browser).create('n2', options);
    expect(realCreate).toHaveBeenCalledTimes(2);
    expect((await call({ op: 'list' })).value, 'no longer recorded').toHaveLength(1);
  });

  it('clear forgets the record; uninstall removes the stand-in', async () => {
    const { browser, call } = rig();
    await call({ op: 'install' });
    await api(browser).create('x', { title: 't', message: 'm' });
    expect((await call({ op: 'clear' })).value).toEqual({ cleared: true });
    expect((await call({ op: 'list' })).value).toEqual([]);
    await call({ op: 'uninstall' });
    expect(browser.notifications).toBeUndefined();
  });

  it('refuses a payload it does not know', async () => {
    const { call } = rig();
    const reply = await call({ op: 'show' });
    expect(reply.ok).toBe(false);
    expect(reply.error).toContain("expected { op: 'install' | 'list' | 'clear' | 'uninstall' }");
  });
});
