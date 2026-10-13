// T-122: the dashboard's "Other tracked items": every tracked item that no other
// list shows (not a watch match, not a favorite, not on the calendar), each with
// the same audited "Stop tracking" as T-117/T-120 (`tracked.remove`). An item
// with an open snipe cannot be stopped here: the snipe must be cancelled first.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/preact';
import { h } from 'preact';
import { afterEach, describe, expect, it } from 'vitest';

import type { Snipe } from '../../src/domain/snipe/types';
import type { TrackedItem } from '../../src/domain/types';
import { Dashboard } from '../../src/ui/dashboard/Dashboard';
import { loadSections } from '../../src/ui/dashboard/registry';
import { builtinModules } from '../../src/ui/dashboard/sections';
import { section } from '../../src/ui/dashboard/sections/tracked';
import { FakeMessaging } from '../fakes/ports/fake-messaging';

afterEach(() => {
  cleanup();
});

const NOW = Date.UTC(2026, 9, 7, 12, 0, 0);

const item = (itemId: number, title: string, over: Partial<TrackedItem> = {}): TrackedItem => ({
  itemId,
  title,
  endTime: '2026-10-20T02:00:00.000Z',
  sellerId: 1,
  reasons: [{ kind: 'manual' }],
  favoriteState: 'none',
  calendar: false,
  addedAt: NOW,
  updatedAt: NOW,
  ...over,
});

const snipe = (itemId: number, state: Snipe['state']): Snipe => ({
  id: `s${String(itemId)}`,
  itemId,
  title: 'Sniped',
  endTime: '2026-10-20T02:00:00.000Z',
  endTimeAtArm: '2026-10-20T02:00:00.000Z',
  sellerId: 1,
  maxBid: 2000,
  leadMs: 8000,
  fallback: 'early-proxy',
  dryRun: true,
  state,
  armedAt: NOW,
  attempt: {},
  history: [{ at: NOW, from: 'draft', to: 'armed', why: 'arm' }],
});

const ITEMS: TrackedItem[] = [
  item(1, 'Manual lamp'),
  item(2, 'Sniped radio', { reasons: [{ kind: 'snipe', id: 's2' }] }),
  item(3, 'Watched camera', { reasons: [{ kind: 'watch', id: 'w1' }] }),
  item(4, 'Favorite vase', { favoriteState: 'favorited' }),
  item(5, 'Calendar clock', { calendar: true }),
  item(6, 'Done snipe kettle', { reasons: [{ kind: 'snipe', id: 's6' }] }),
];

/** tracked.list drops what tracked.remove removed, like the background. */
function fake(opts: { snipes?: Snipe[] | 'missing'; items?: TrackedItem[] } = {}): FakeMessaging {
  const m = new FakeMessaging();
  const items = opts.items ?? ITEMS;
  const removed = (id: number): boolean => m.sent.some((s) => s.type === 'tracked.remove' && (s.payload as { itemId: number }).itemId === id);
  m.handle('tracked.list', () => items.filter((t) => !removed(t.itemId)));
  if (opts.snipes !== 'missing') {
    const snipes = opts.snipes ?? [];
    m.handle('snipe.list', () => snipes);
  }
  m.handle('tracked.remove', () => undefined);
  return m;
}

const mount = (m: FakeMessaging) => render(h(section.Component, { client: m, userTz: 'UTC', openOptions: () => undefined }));
const list = (): HTMLElement => screen.getByRole('list', { name: 'Other tracked items' });

describe('T-122: Other tracked items', () => {
  it('is picked up by the registry, right after Matches and favorites', () => {
    const ids = loadSections(builtinModules).map((s) => s.id);
    expect(ids).toContain('tracked');
    expect(ids.indexOf('tracked')).toBe(ids.indexOf('matches') + 1);
  });

  it('lists a manual-only and a snipe-only item with title, link and end time, and nothing shown elsewhere', async () => {
    const m = fake();
    mount(m);
    await screen.findByRole('list', { name: 'Other tracked items' });
    const l = list();
    expect(within(l).getByRole('link', { name: 'Manual lamp' }).getAttribute('href')).toBe('https://shopgoodwill.com/item/1');
    expect(within(l).getByRole('link', { name: 'Sniped radio' }).getAttribute('href')).toBe('https://shopgoodwill.com/item/2');
    expect(within(l).getAllByText(/Ends/).length).toBeGreaterThan(0);
    expect(within(l).queryByText('Watched camera')).toBeNull();
    expect(within(l).queryByText('Favorite vase')).toBeNull();
    expect(within(l).queryByText('Calendar clock')).toBeNull();
    // Rendering reads storage only: no SGW or Google message.
    expect([...new Set(m.sent.map((s) => s.type))].sort()).toEqual(['snipe.list', 'tracked.list']);
  });

  it('does not duplicate an item already in Matches, Favorites or Calendar on the full dashboard', async () => {
    const m = fake();
    render(h(Dashboard, { client: m, sections: loadSections(builtinModules), userTz: 'UTC', openOptions: () => undefined }));
    await screen.findByRole('list', { name: 'Other tracked items' });
    await screen.findByRole('list', { name: 'Matches' });
    for (const title of ['Watched camera', 'Favorite vase', 'Manual lamp', 'Sniped radio']) {
      expect(screen.getAllByRole('link', { name: title })).toHaveLength(1);
    }
    expect(within(list()).queryByText('Calendar clock')).toBeNull();
  });

  it('shows a short empty state when every tracked item is listed elsewhere', async () => {
    const m = fake({ items: [ITEMS[2] as TrackedItem, ITEMS[4] as TrackedItem] });
    mount(m);
    expect(await screen.findByText(/No other tracked items/)).toBeTruthy();
    expect(screen.queryByRole('list', { name: 'Other tracked items' })).toBeNull();
  });

  it('Stop tracking: confirm without calendar wording, then the same tracked.remove once; the list reloads', async () => {
    const m = fake();
    mount(m);
    await screen.findByRole('list', { name: 'Other tracked items' });
    fireEvent.click(within(list()).getByRole('button', { name: 'Stop tracking Manual lamp' }));
    expect(m.sent.some((s) => s.type === 'tracked.remove')).toBe(false);
    expect(within(list()).getByText(/^Stop tracking Manual lamp\?/).textContent).not.toMatch(/calendar/i);
    fireEvent.click(within(list()).getByRole('button', { name: 'Yes, stop tracking' }));
    expect((await screen.findByRole('status')).textContent).toBe('Stopped tracking Manual lamp.');
    expect(m.sent.filter((s) => s.type === 'tracked.remove').map((s) => s.payload)).toEqual([{ itemId: 1 }]);
    await waitFor(() => {
      expect(within(list()).queryByText('Manual lamp')).toBeNull();
    });
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('an item with an open snipe cannot be stopped: the action is disabled with "Cancel the snipe first"', async () => {
    const m = fake({ snipes: [snipe(2, 'armed'), snipe(6, 'resolved')] });
    mount(m);
    await screen.findByRole('list', { name: 'Other tracked items' });
    const radio = within(list()).getByRole<HTMLButtonElement>('button', { name: 'Stop tracking Sniped radio' });
    await waitFor(() => {
      expect(radio.disabled).toBe(true);
    });
    expect(within(list()).getByText(/Cancel the snipe first/)).toBeTruthy();
    fireEvent.click(radio);
    expect(within(list()).queryByRole('button', { name: 'Yes, stop tracking' })).toBeNull();
    // A resolved snipe does not block, and neither does an item with no snipe.
    expect(within(list()).getByRole<HTMLButtonElement>('button', { name: 'Stop tracking Done snipe kettle' }).disabled).toBe(false);
    expect(within(list()).getByRole<HTMLButtonElement>('button', { name: 'Stop tracking Manual lamp' }).disabled).toBe(false);
    expect(m.sent.some((s) => s.type === 'tracked.remove')).toBe(false);
  });

  it('when snipes cannot be read, Stop tracking stays disabled rather than risk orphaning a snipe', async () => {
    const m = fake({ snipes: 'missing' });
    mount(m);
    await screen.findByRole('list', { name: 'Other tracked items' });
    await waitFor(() => {
      expect(within(list()).getByRole<HTMLButtonElement>('button', { name: 'Stop tracking Manual lamp' }).disabled).toBe(true);
    });
    expect(within(list()).getAllByText(/Snipes could not be read/).length).toBeGreaterThan(0);
  });

  it('a failed removal is an alert and the item stays', async () => {
    const m = new FakeMessaging();
    m.handle('tracked.list', () => [ITEMS[0] as TrackedItem]);
    m.handle('snipe.list', () => []);
    m.handle('tracked.remove', () => {
      throw new Error('storage full');
    });
    mount(m);
    await screen.findByRole('list', { name: 'Other tracked items' });
    fireEvent.click(within(list()).getByRole('button', { name: 'Stop tracking Manual lamp' }));
    fireEvent.click(within(list()).getByRole('button', { name: 'Yes, stop tracking' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/Could not stop tracking Manual lamp/);
    expect(within(list()).getByText('Manual lamp')).toBeTruthy();
  });
});
