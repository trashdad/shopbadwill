// T-126: the popup's "Sync now" — one click runs the calendar sync, then the
// favorites sync, and says what happened to each. Watch searches are not run.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { h } from 'preact';
import { afterEach, describe, expect, it } from 'vitest';

import { defaultSettings } from '../../src/domain/settings/defaults';
import { section, SyncSection } from '../../src/entrypoints/popup/sections/sync';
import { collectSections } from '../../src/entrypoints/popup/registry';
import type { MsgReply } from '../../src/messaging/protocol';
import { FakeMessaging } from '../fakes/ports/fake-messaging';

afterEach(cleanup);

type SyncReply = MsgReply<'calendar.syncNow'>;

function setup(opts: { kill?: boolean; calendar?: () => SyncReply | Promise<SyncReply>; favorites?: () => undefined | Promise<undefined> } = {}) {
  const m = new FakeMessaging();
  const s = defaultSettings();
  s.killSwitch = opts.kill ?? false;
  m.handle('settings.get', () => structuredClone(s));
  m.handle('calendar.syncNow', opts.calendar ?? (() => ({ status: 'synced', changed: 2, pending: 0, errors: 0 })));
  m.handle('favorites.sync', opts.favorites ?? (() => undefined));
  m.handle('job.runNow', () => {
    throw new Error('must not run');
  });
  render(h(SyncSection, { messaging: m }));
  return m;
}

const button = () => screen.findByRole('button', { name: 'Sync now' });

describe('popup Sync now', () => {
  it('is a registered popup section', () => {
    expect(collectSections({ sync: { section } }).map((x) => x.id)).toEqual(['sync']);
  });

  it('runs calendar.syncNow then favorites.sync, never job.runNow, and reports each part', async () => {
    const m = setup();
    const b = await button();
    await waitFor(() => {
      expect((b as HTMLButtonElement).disabled).toBe(false);
    });
    fireEvent.click(b);
    expect(await screen.findByText('Calendar: Sync finished: 2 event(s) updated.')).toBeTruthy();
    expect(await screen.findByText('Favorites: Favorites synced.')).toBeTruthy();
    const types = m.sent.map((x) => x.type).filter((t) => t !== 'settings.get');
    expect(types).toEqual(['calendar.syncNow', 'favorites.sync']);
  });

  it('says watch searches are not run here', async () => {
    setup();
    await button();
    expect(screen.getByText('Searches run on their schedule; use Run now in Options → Watches to check them now.')).toBeTruthy();
  });

  it('a calendar failure is shown and does not stop the favorites sync', async () => {
    const m = setup({ calendar: () => ({ status: 'needs-reconnect', changed: 0, pending: 3, errors: 0, detail: 'Forbidden' }) });
    const b = await button();
    await waitFor(() => {
      expect((b as HTMLButtonElement).disabled).toBe(false);
    });
    fireEvent.click(b);
    const cal = await screen.findByText(/^Calendar: Google refused the calendar write\. 3 item\(s\) still waiting\. Google said: Forbidden$/);
    expect(cal.getAttribute('data-ok')).toBe('false');
    expect(await screen.findByText('Favorites: Favorites synced.')).toBeTruthy();
    expect(m.sent.map((x) => x.type)).toContain('favorites.sync');
  });

  it('a calendar error thrown by the background does not stop the favorites sync; a favorites error is described', async () => {
    setup({
      calendar: () => {
        throw new Error('Calendar broke');
      },
      favorites: () => {
        throw new Error('Not signed in to ShopGoodwill.');
      },
    });
    const b = await button();
    await waitFor(() => {
      expect((b as HTMLButtonElement).disabled).toBe(false);
    });
    fireEvent.click(b);
    expect(await screen.findByText('Calendar: Calendar broke')).toBeTruthy();
    expect(await screen.findByText('Favorites: Not signed in to ShopGoodwill.')).toBeTruthy();
  });

  it('the button is disabled while running', async () => {
    let release: (r: SyncReply) => void = () => undefined;
    setup({ calendar: () => new Promise<SyncReply>((r) => (release = r)) });
    const b = (await button()) as HTMLButtonElement;
    await waitFor(() => {
      expect(b.disabled).toBe(false);
    });
    fireEvent.click(b);
    await waitFor(() => {
      expect(b.disabled).toBe(true);
    });
    release({ status: 'synced', changed: 0, pending: 0, errors: 0 });
    expect(await screen.findByText('Favorites: Favorites synced.')).toBeTruthy();
    await waitFor(() => {
      expect(b.disabled).toBe(false);
    });
  });

  it('is disabled with a hint while the kill switch is on, and follows switches.changed', async () => {
    const m = setup({ kill: true });
    expect(await screen.findByText('Kill switch is on')).toBeTruthy();
    const b = (await button()) as HTMLButtonElement;
    expect(b.disabled).toBe(true);
    m.broadcast('switches.changed', { killSwitch: false, writesAllowed: {} });
    await waitFor(() => {
      expect(b.disabled).toBe(false);
    });
    expect(screen.queryByText('Kill switch is on')).toBeNull();
    m.broadcast('switches.changed', { killSwitch: true, writesAllowed: {} });
    await waitFor(() => {
      expect(b.disabled).toBe(true);
    });
    expect(m.sent.map((x) => x.type)).not.toContain('calendar.syncNow');
  });
});
