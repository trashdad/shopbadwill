// T-67: the dashboard Calendar section (T-54 registry, I-10 .ics download).
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { h } from 'preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AuthStatus } from '../../src/domain/calendar/types';
import type { TrackedItem } from '../../src/domain/types';
import { loadSections } from '../../src/ui/dashboard/registry';
import { builtinModules } from '../../src/ui/dashboard/sections';
import { section } from '../../src/ui/dashboard/sections/calendar';
import { FakeMessaging } from '../fakes/ports/fake-messaging';

const CONNECTED: AuthStatus = { connected: true, provider: 'pkce', grantedScopes: [], needsInteraction: false, configured: true, account: 'me@example.com' };
const OFF: AuthStatus = { connected: false, provider: 'none', grantedScopes: [], needsInteraction: false, configured: true };

const tracked = (itemId: number, calendar: boolean): TrackedItem => ({
  itemId,
  title: `Item ${String(itemId)}`,
  endTime: '2026-10-20T02:00:00.000Z',
  sellerId: 1,
  reasons: [{ kind: 'manual' }],
  favoriteState: 'none',
  calendar,
  addedAt: 1,
  updatedAt: 1,
});

const blobs: Blob[] = [];
beforeEach(() => {
  blobs.length = 0;
  vi.spyOn(URL, 'createObjectURL').mockImplementation((b: Blob | MediaSource) => {
    blobs.push(b as Blob);
    return 'blob:sbw-test';
  });
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const mount = (m: FakeMessaging) =>
  render(h(section.Component, { client: m, userTz: 'UTC', openOptions: () => undefined }));

describe('dashboard calendar section', () => {
  it('is picked up by the T-54 registry', () => {
    expect(loadSections(builtinModules).map((s) => s.id)).toContain('calendar');
  });

  it('shows the connection and downloads a .ics of the calendar items, with no Google call', async () => {
    const m = new FakeMessaging();
    m.handle('calendar.status', () => CONNECTED);
    m.handle('tracked.list', () => [tracked(1, true), tracked(2, false), tracked(3, true)]);
    m.handle('calendar.ics', () => ({ ics: 'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n' }));
    mount(m);
    expect(await screen.findByText(/Connected as me@example.com/)).toBeTruthy();
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Disconnect' }).disabled).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: /Download .ics/ }));
    expect((await screen.findByRole('status')).textContent).toBe('Downloaded.');
    expect(m.sent.filter((s) => s.type === 'calendar.ics').map((s) => s.payload)).toEqual([{ itemIds: [1, 3] }]);
    expect(blobs).toHaveLength(1);
    expect(m.sent.some((s) => s.type === 'calendar.connect' || s.type === 'calendar.syncNow')).toBe(false);
  });

  it('disconnected: says events wait as pending, Disconnect is off, Connect sends calendar.connect', async () => {
    const m = new FakeMessaging();
    m.handle('calendar.status', () => OFF);
    m.handle('calendar.connect', () => CONNECTED);
    mount(m);
    expect(await screen.findByText(/Not connected. Events are queued as pending/)).toBeTruthy();
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Disconnect' }).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: /Connect Google Calendar/ }));
    await waitFor(() => {
      expect(m.sent.filter((s) => s.type === 'calendar.connect')).toHaveLength(1);
    });
  });

  describe('T-117: Stop tracking', () => {
    const list = (m: FakeMessaging): TrackedItem[] => {
      const items = [tracked(1, true), tracked(2, false), tracked(3, true)];
      m.handle('calendar.status', () => CONNECTED);
      m.handle('tracked.list', () => items.filter((t) => !m.sent.some((s) => s.type === 'tracked.remove' && (s.payload as { itemId: number }).itemId === t.itemId)));
      return items;
    };
    const onCalendar = () => screen.findByRole('list', { name: 'Auctions on your calendar' });

    it('lists only the calendar items, each with a Stop tracking button; titles are text only', async () => {
      const m = new FakeMessaging();
      const items = list(m);
      items[0] = { ...items[0], title: '<img src=x onerror=alert(1)>' } as TrackedItem;
      mount(m);
      const ul = await onCalendar();
      const rows = ul.querySelectorAll('li');
      expect(rows).toHaveLength(2);
      expect(rows[0]?.textContent).toContain('<img src=x onerror=alert(1)>');
      expect(ul.querySelector('img')).toBeNull();
      expect(rows[1]?.textContent).toContain('Item 3');
      expect(screen.getAllByRole('button', { name: /^Stop tracking/ })).toHaveLength(2);
    });

    it('confirm, then tracked.remove is sent once, the list reloads and the result is shown', async () => {
      const m = new FakeMessaging();
      list(m);
      m.handle('tracked.remove', () => undefined);
      mount(m);
      await onCalendar();
      fireEvent.click(screen.getByRole('button', { name: 'Stop tracking Item 3' }));
      // The confirm step names the dedicated calendar; nothing is sent yet.
      expect(screen.getByText(/removed from your "ShopGoodwill Auctions" calendar/)).toBeTruthy();
      expect(m.sent.filter((s) => s.type === 'tracked.remove')).toEqual([]);
      fireEvent.click(screen.getByRole('button', { name: 'Yes, stop tracking' }));
      expect((await screen.findByRole('status')).textContent).toMatch(/Stopped tracking Item 3/);
      expect(m.sent.filter((s) => s.type === 'tracked.remove').map((s) => s.payload)).toEqual([{ itemId: 3 }]);
      await waitFor(() => {
        expect(screen.queryByText('Item 3')).toBeNull();
      });
      expect(screen.queryByRole('alert')).toBeNull();
    });

    it('cancel sends nothing and closes the confirm step', async () => {
      const m = new FakeMessaging();
      list(m);
      m.handle('tracked.remove', () => undefined);
      mount(m);
      await onCalendar();
      fireEvent.click(screen.getByRole('button', { name: 'Stop tracking Item 1' }));
      fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
      expect(screen.queryByRole('button', { name: 'Yes, stop tracking' })).toBeNull();
      expect(m.sent.some((s) => s.type === 'tracked.remove')).toBe(false);
      expect(screen.getByText('Item 1')).toBeTruthy();
    });

    it('a failure is shown as an alert and the item stays listed', async () => {
      const m = new FakeMessaging();
      list(m);
      m.handle('tracked.remove', () => {
        throw new Error('storage is full');
      });
      mount(m);
      await onCalendar();
      fireEvent.click(screen.getByRole('button', { name: 'Stop tracking Item 1' }));
      fireEvent.click(screen.getByRole('button', { name: 'Yes, stop tracking' }));
      expect((await screen.findByRole('alert')).textContent).toMatch(/Could not stop tracking Item 1/);
      expect(screen.queryByRole('status')).toBeNull();
      expect(screen.getByText('Item 1')).toBeTruthy();
    });
  });

  it('a missing background handler reads as unavailable, not as a problem', async () => {
    const m = new FakeMessaging();
    mount(m);
    expect(await screen.findByText(/Calendar status is unavailable/)).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
