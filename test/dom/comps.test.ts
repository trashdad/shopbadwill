// T-115: the comps link-out, combined-shipping hint and pickup-distance badges.
// All three are off unless features.comps is on; none of them sends a message.
import { cleanup, render, waitFor } from '@testing-library/preact';
import { h } from 'preact';
import { afterEach, describe, expect, it } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';

import type { CardBadge } from '../../src/content/ui/badge-registry';
import { BADGES } from '../../src/content/ui/badge-registry';
import { badge as combined, combinedCount } from '../../src/content/ui/badges/combined';
import { badge as comps, compsUrl } from '../../src/content/ui/badges/comps';
import { badge as pickup, pickupLine } from '../../src/content/ui/badges/pickup';
import { defaultSettings } from '../../src/domain/settings/defaults';
import type { Settings } from '../../src/domain/settings/schema';
import { STORAGE_KEYS } from '../../src/domain/storage/schema';
import type { Listing } from '../../src/domain/types';
import { FakeMessaging } from '../fakes/ports/fake-messaging';

const NOW = Date.UTC(2026, 9, 12, 19, 0, 0);
const LATER = '2026-10-20T02:00:00.000Z';
const EARLIER = '2026-10-01T02:00:00.000Z';
const HOME_ZIP = '60601';

function listing(itemId: number, extra: Partial<Listing> = {}): Listing {
  return {
    itemId,
    title: 'Vintage PYREX Bowl -- "Butterprint" & Lid #403',
    currentPrice: 1299,
    startingMinimumBid: 500,
    numBids: 0,
    endTime: LATER,
    endTimeRaw: '2026-10-19T19:00:00',
    sellerId: 42,
    source: 'tap',
    observedAt: NOW,
    ...extra,
  };
}

function settings(on: boolean, homeZip: string | null = HOME_ZIP): Settings {
  const s = defaultSettings();
  s.features.comps = on;
  if (homeZip !== null) s.homeZip = homeZip;
  return s;
}

function mount(b: CardBadge, l: Listing | null, s: Settings, client = new FakeMessaging()) {
  return render(
    h(b.Component, {
      itemId: l?.itemId ?? 1,
      listing: l,
      settings: s,
      client,
      cardRoot: document.createElement('div'),
      now: NOW,
    }),
  );
}

function tracked(itemId: number, sellerId: number, extra: Record<string, unknown> = {}) {
  return {
    itemId,
    title: 'x',
    endTime: LATER,
    sellerId,
    reasons: [{ kind: 'manual' }],
    favoriteState: 'none',
    calendar: false,
    addedAt: NOW,
    updatedAt: NOW,
    ...extra,
  };
}

function snipe(id: string, itemId: number, sellerId: number, state: string) {
  return { id, itemId, sellerId, state, title: 'x', endTime: LATER };
}

const tick = () => new Promise((r) => setTimeout(r, 20));

afterEach(() => {
  cleanup();
});

describe('registration and the flag', () => {
  it('registers all three badges by the glob', () => {
    const ids = BADGES.map((b) => b.id);
    expect(ids).toEqual(expect.arrayContaining(['comps', 'combined', 'pickup']));
  });

  it('features.comps is off by default and every badge renders nothing then', async () => {
    expect(defaultSettings().features.comps).toBe(false);
    await fakeBrowser.storage.local.set({
      [STORAGE_KEYS.tracked]: { 7: tracked(7, 42) },
    });
    const client = new FakeMessaging();
    const l = listing(100, { pickupOnly: true, sellerState: 'IN' });
    const a = mount(comps, l, settings(false), client);
    const b = mount(combined, l, settings(false), client);
    const c = mount(pickup, l, settings(false), client);
    await tick();
    expect(a.container.textContent).toBe('');
    expect(b.container.textContent).toBe('');
    expect(c.container.textContent).toBe('');
    expect(client.sent).toEqual([]);
  });
});

describe('comps link-out', () => {
  it('builds an encoded eBay sold-listings search from the normalized title', () => {
    expect(compsUrl('Vintage PYREX Bowl -- "Butterprint" & Lid #403')).toBe(
      'https://www.ebay.com/sch/i.html?_nkw=vintage+pyrex+bowl+butterprint+lid+403&LH_Sold=1&LH_Complete=1',
    );
    expect(compsUrl('Crème & <script>')).toBe(
      'https://www.ebay.com/sch/i.html?_nkw=creme+script&LH_Sold=1&LH_Complete=1',
    );
    expect(compsUrl(' -- !! ')).toBeNull();
  });

  it('renders a plain text link that opens in a new tab with noopener noreferrer', async () => {
    const client = new FakeMessaging();
    const r = mount(comps, listing(100, { title: 'Lamp <b>bold</b> & co' }), settings(true), client);
    const a = r.container.querySelector('a');
    expect(a).not.toBeNull();
    expect(a?.getAttribute('href')).toBe(
      'https://www.ebay.com/sch/i.html?_nkw=lamp+b+bold+b+co&LH_Sold=1&LH_Complete=1',
    );
    expect(a?.getAttribute('target')).toBe('_blank');
    expect(a?.getAttribute('rel')).toBe('noopener noreferrer');
    expect(a?.children).toHaveLength(0);
    expect(a?.textContent).toBe('Sold comps');
    await tick();
    expect(client.sent).toEqual([]);
  });

  it('renders nothing without listing data or with an empty title', () => {
    expect(mount(comps, null, settings(true)).container.textContent).toBe('');
    expect(mount(comps, listing(100, { title: '!!' }), settings(true)).container.textContent).toBe('');
  });
});

describe('combined-shipping hint', () => {
  it('counts other open tracked items and armed snipes from the same seller', () => {
    const t = { 7: tracked(7, 42), 8: tracked(8, 42, { outcome: 'won' }), 9: tracked(9, 42, { endTime: EARLIER }), 10: tracked(10, 5), 100: tracked(100, 42) };
    const s = {
      a: snipe('a', 11, 42, 'armed'),
      b: snipe('b', 7, 42, 'armed'),
      c: snipe('c', 12, 42, 'resolved'),
      d: snipe('d', 13, 42, 'draft'),
      e: snipe('e', 14, 5, 'armed'),
    };
    expect(combinedCount(t, s, 42, 100, NOW)).toBe(2);
    expect(combinedCount(undefined, undefined, 42, 100, NOW)).toBe(0);
    expect(combinedCount('junk', [1, 2], 42, 100, NOW)).toBe(0);
  });

  it('shows the hint as text from data already in storage, sending nothing', async () => {
    await fakeBrowser.storage.local.set({
      [STORAGE_KEYS.tracked]: { 7: tracked(7, 42), 100: tracked(100, 42) },
      [STORAGE_KEYS.snipes]: { a: snipe('a', 11, 42, 'armed') },
    });
    const client = new FakeMessaging();
    const r = mount(combined, listing(100), settings(true), client);
    await waitFor(() => {
      expect(r.container.textContent).toBe("Same seller as 2 items you're tracking: ask about combined shipping");
    });
    expect(r.container.querySelector('span')?.children).toHaveLength(0);
    expect(client.sent).toEqual([]);
  });

  it('uses the singular for one item and renders nothing for none', async () => {
    await fakeBrowser.storage.local.set({ [STORAGE_KEYS.tracked]: { 7: tracked(7, 42), 8: tracked(8, 9) } });
    const one = mount(combined, listing(100), settings(true));
    const none = mount(combined, listing(101, { sellerId: 77 }), settings(true));
    await waitFor(() => {
      expect(one.container.textContent).toBe("Same seller as 1 item you're tracking: ask about combined shipping");
    });
    expect(none.container.textContent).toBe('');
  });
});

describe('pickup distance', () => {
  it('formats an approximate distance, or "in your state"', () => {
    expect(pickupLine(HOME_ZIP, 'CA')?.text).toMatch(/^Pickup about [\d,]+ mi away \(approx\.\)$/);
    expect(pickupLine(HOME_ZIP, 'IL')?.text).toBe('Pickup in your state (approx.)');
    expect(pickupLine(undefined, 'IL')).toBeNull();
    expect(pickupLine(HOME_ZIP, undefined)).toBeNull();
  });

  it('shows the distance for a pickup-only card and never the home ZIP', async () => {
    const r = mount(pickup, listing(100, { pickupOnly: true, sellerState: 'IN' }), settings(true));
    await waitFor(() => {
      expect(r.container.textContent).toMatch(/^Pickup about \d+ mi away \(approx\.\)$/);
    });
    expect(r.container.innerHTML).not.toContain(HOME_ZIP);
    expect(r.container.innerHTML).not.toContain('606');
  });

  it('falls back to the cached item detail for the pickup flag and state', async () => {
    await fakeBrowser.storage.local.set({
      [STORAGE_KEYS.detailCache]: { 100: { detail: { pickupOnly: true, sellerState: 'CA' }, expiresAt: NOW + 1000 } },
    });
    const r = mount(pickup, listing(100), settings(true));
    await waitFor(() => {
      expect(r.container.textContent).toMatch(/^Pickup about [\d,]+ mi away \(approx\.\)$/);
    });
  });

  it('shows nothing when the item ships, or either side is unknown', async () => {
    const ships = mount(pickup, listing(100, { pickupOnly: false, sellerState: 'IN' }), settings(true));
    const noZip = mount(pickup, listing(101, { pickupOnly: true, sellerState: 'IN' }), settings(true, null));
    const badZip = mount(pickup, listing(102, { pickupOnly: true, sellerState: 'IN' }), settings(true, '0000'));
    const noState = mount(pickup, listing(103, { pickupOnly: true }), settings(true));
    await tick();
    expect(ships.container.textContent).toBe('');
    expect(noZip.container.textContent).toBe('');
    expect(badZip.container.textContent).toBe('');
    expect(noState.container.textContent).toBe('');
  });
});
