// T-113: the "Seen before at $X (date)" badge, picked up by the registry glob.
import { cleanup, render, waitFor } from '@testing-library/preact';
import { afterEach, describe, expect, it } from 'vitest';

import { BADGES } from '../../src/content/ui/badge-registry';
import { badge, relistLine } from '../../src/content/ui/badges/relist';
import { defaultSettings } from '../../src/domain/settings/defaults';
import type { Settings } from '../../src/domain/settings/schema';
import type { Listing } from '../../src/domain/types';
import { FakeMessaging } from '../fakes/ports/fake-messaging';

const NOW = Date.UTC(2026, 9, 12, 19, 0, 0);
const SEEN = Date.UTC(2026, 9, 3, 19, 0, 0);

function listing(itemId: number): Listing {
  return {
    itemId,
    title: 'Pyrex Bowl',
    currentPrice: 1299,
    startingMinimumBid: 500,
    numBids: 0,
    endTime: '2026-10-13T02:00:00.000Z',
    endTimeRaw: '2026-10-12T19:00:00',
    sellerId: 42,
    source: 'tap',
    observedAt: NOW,
  };
}

function settings(on: boolean): Settings {
  const s = defaultSettings();
  s.features.relistDetector = on;
  s.locale.timeZone = 'America/Los_Angeles';
  return s;
}

function mount(client: FakeMessaging, itemId: number, on: boolean, withListing = true) {
  const Component = badge.Component;
  return render(
    <Component
      itemId={itemId}
      listing={withListing ? listing(itemId) : null}
      settings={settings(on)}
      client={client}
      cardRoot={document.createElement('div')}
      now={NOW}
    />,
  );
}

const tick = () => new Promise((r) => setTimeout(r, 10));

afterEach(() => {
  cleanup();
});

describe('relist badge', () => {
  it('is registered by the badge glob', () => {
    expect(BADGES.map((b) => b.id)).toContain('relist');
  });

  it('shows "Seen before at $X (date)" as text, batching the visible cards into one message', async () => {
    const client = new FakeMessaging().handle('relist.lookup', ({ itemIds }) =>
      Object.fromEntries(itemIds.map((id) => [id, id === 2000 ? { itemId: 1000, price: 1450, seenAt: SEEN } : null])),
    );
    const a = mount(client, 2000, true);
    const b = mount(client, 2001, true);
    await waitFor(() => {
      expect(a.container.textContent).toBe('Seen before at $14.50 (Oct 3, 2026)');
    });
    expect(b.container.textContent).toBe('');
    expect(client.sent).toEqual([{ type: 'relist.lookup', payload: { itemIds: [2000, 2001] } }]);
    expect(a.container.querySelector('span')?.innerHTML).toBe('Seen before at $14.50 (Oct 3, 2026)');
  });

  it('never shows for the same item id', async () => {
    const client = new FakeMessaging().handle('relist.lookup', () => ({ 3000: { itemId: 3000, price: 100, seenAt: SEEN } }));
    const r = mount(client, 3000, true);
    await tick();
    expect(client.sent).toHaveLength(1);
    expect(r.container.textContent).toBe('');
  });

  it('sends nothing and shows nothing when features.relistDetector is off (the default)', async () => {
    expect(defaultSettings().features.relistDetector).toBe(false);
    const client = new FakeMessaging().handle('relist.lookup', () => ({ 4000: { itemId: 1, price: 100, seenAt: SEEN } }));
    const r = mount(client, 4000, false);
    await tick();
    expect(client.sent).toEqual([]);
    expect(r.container.textContent).toBe('');
  });

  it('sends nothing for a card without listing data', async () => {
    const client = new FakeMessaging().handle('relist.lookup', () => ({}));
    mount(client, 5000, true, false);
    await tick();
    expect(client.sent).toEqual([]);
  });

  it('shows nothing when the background fails', async () => {
    const client = new FakeMessaging().handle('relist.lookup', () => {
      throw new Error('restarting');
    });
    const r = mount(client, 6000, true);
    await tick();
    expect(r.container.textContent).toBe('');
  });

  it('renders untrusted values as text and falls back to UTC for a bad time zone', () => {
    expect(relistLine({ itemId: 1, price: 123456, seenAt: SEEN }, 2, 'Not/AZone')).toEqual({
      text: 'Seen before at $1,234.56 (Oct 3, 2026)',
      title: 'An earlier listing (item 1) of what looks like the same item was last seen at $1,234.56 on Oct 3, 2026',
    });
    expect(relistLine(null, 2, 'UTC')).toBeNull();
    expect(relistLine({ itemId: 2, price: 1, seenAt: SEEN }, 2, 'UTC')).toBeNull();
  });
});
