// T-113: the `relist.lookup` handler. No SGW access at all; the history is
// filled from the tap (ctx.pages) and `sbw:listingCache`, and kept in the
// bounded `sbw:relistSeen`, only while `features.relistDetector` is on.
import { beforeEach, describe, expect, it } from 'vitest';

import { createRelistHandlers } from '../../../src/background/handlers/relist';
import { createRouter, type Router, type RouterSender } from '../../../src/background/router';
import { RELIST_MAX_AGE_MS } from '../../../src/domain/relist/history';
import { defaultSettings } from '../../../src/domain/settings/defaults';
import { Repo } from '../../../src/domain/storage/repo';
import { STORAGE_KEYS } from '../../../src/domain/storage/schema';
import type { ItemId, Listing } from '../../../src/domain/types';
import { FakeClock } from '../../fakes/ports/fake-clock';
import { FakeStorageAreas } from '../../fakes/ports/fake-storage';

const EXT_ID = 'ext-id';
const T0 = Date.UTC(2026, 9, 12, 12, 0, 0);
const DAY = 24 * 60 * 60 * 1000;
const CONTENT: RouterSender = { id: EXT_ID, url: 'https://shopgoodwill.com/categories/listing?st=pyrex', tab: { id: 3 } };
const UI: RouterSender = { id: EXT_ID, url: `chrome-extension://${EXT_ID}/options.html` };

const listing = (id: ItemId, over: Partial<Listing> = {}): Listing => ({
  itemId: id,
  title: 'Pyrex Butterprint Bowl',
  currentPrice: 1000,
  startingMinimumBid: 500,
  numBids: 0,
  endTime: '2026-10-14T02:00:00.000Z',
  endTimeRaw: '2026-10-13T19:00:00',
  sellerId: 7,
  imageUrl: 'https://img.test/p/abc.jpg',
  source: 'tap',
  observedAt: T0,
  ...over,
});

let clock: FakeClock;
let areas: FakeStorageAreas;
let repo: Repo;
let router: Router;
let pages: Map<ItemId, Listing>;

async function setFeature(on: boolean): Promise<void> {
  const s = defaultSettings();
  s.features.relistDetector = on;
  await repo.set(STORAGE_KEYS.settings, s);
}

async function lookup(ids: ItemId[], sender: RouterSender = CONTENT): Promise<unknown> {
  const r = await router.handle({ v: 1, reqId: 'r-1', type: 'relist.lookup', payload: { itemIds: ids } }, sender);
  if (!r.ok) throw new Error(JSON.stringify(r));
  return r.reply;
}

beforeEach(async () => {
  clock = new FakeClock(T0);
  areas = new FakeStorageAreas();
  repo = new Repo(areas, clock);
  pages = new Map();
  router = createRouter({
    runtimeId: EXT_ID,
    getURL: (p) => `chrome-extension://${EXT_ID}/${p}`,
    isQuickFavoriteEnabled: () => false,
    log: () => undefined,
  });
  const handlers = createRelistHandlers({ repo, clock, pages: { findItem: (id: ItemId) => pages.get(id) } });
  router.register('relist.lookup', (payload, hctx) => handlers.lookup(payload.itemIds, hctx));
  await setFeature(true);
});

describe('relist.lookup', () => {
  it('is off by default: null for all, and nothing is stored', async () => {
    await repo.set(STORAGE_KEYS.settings, defaultSettings());
    pages.set(1000, listing(1000));
    expect(await lookup([1000])).toEqual({ 1000: null });
    expect(await repo.find(STORAGE_KEYS.relistSeen)).toBeUndefined();
  });

  it('remembers a tapped listing and recognises its relist later', async () => {
    pages.set(1000, listing(1000, { currentPrice: 1450 }));
    expect(await lookup([1000])).toEqual({ 1000: null });

    clock.set(T0 + 9 * DAY);
    pages.clear();
    pages.set(2000, listing(2000, { title: 'PYREX butterprint bowl!', observedAt: T0 + 9 * DAY }));
    expect(await lookup([2000])).toEqual({ 2000: { itemId: 1000, price: 1450, seenAt: T0 } });
  });

  it('never answers the same item id, even when looked up again', async () => {
    pages.set(1000, listing(1000));
    await lookup([1000]);
    clock.set(T0 + DAY);
    pages.set(1000, listing(1000, { observedAt: T0 + DAY, currentPrice: 2000 }));
    expect(await lookup([1000])).toEqual({ 1000: null });
    expect((await repo.get(STORAGE_KEYS.relistSeen)).entries[1000]).toEqual({
      fp: '7|pyrex butterprint bowl|abc.jpg',
      price: 2000,
      seenAt: T0 + DAY,
    });
  });

  it('fills the history from sbw:listingCache, which outlives its 6 h TTL there', async () => {
    await repo.set(STORAGE_KEYS.listingCache, { 900: { listing: listing(900, { currentPrice: 777 }), expiresAt: T0 + 6 * 3_600_000 } });
    pages.set(2000, listing(2000));
    expect(await lookup([2000])).toEqual({ 2000: { itemId: 900, price: 777, seenAt: T0 } });
    expect((await repo.get(STORAGE_KEYS.relistSeen)).entries[900]).toBeDefined();
  });

  it('uses relistId when the listing carries one', async () => {
    pages.set(1000, listing(1000, { title: 'Old title', imageUrl: 'https://img.test/old.jpg', currentPrice: 300 }));
    await lookup([1000]);
    pages.set(2000, listing(2000, { relistId: 1000 }));
    expect(await lookup([2000])).toEqual({ 2000: { itemId: 1000, price: 300, seenAt: T0 } });
  });

  it('answers null for an item it has no data for, and stores nothing for it', async () => {
    expect(await lookup([5000])).toEqual({ 5000: null });
    expect(await repo.find(STORAGE_KEYS.relistSeen)).toBeUndefined();
  });

  it('forgets listings after 60 days', async () => {
    pages.set(1000, listing(1000));
    await lookup([1000]);
    clock.set(T0 + RELIST_MAX_AGE_MS + 1);
    pages.clear();
    pages.set(2000, listing(2000, { observedAt: T0 + RELIST_MAX_AGE_MS + 1 }));
    expect(await lookup([2000])).toEqual({ 2000: null });
    expect(Object.keys((await repo.get(STORAGE_KEYS.relistSeen)).entries)).toEqual(['2000']);
  });

  it('treats an invalid stored history as empty', async () => {
    await areas.local.set({ [STORAGE_KEYS.relistSeen]: { version: 9, junk: true } });
    pages.set(2000, listing(2000));
    expect(await lookup([2000])).toEqual({ 2000: null });
    expect((await repo.get(STORAGE_KEYS.relistSeen)).version).toBe(1);
  });

  it('stores only public listing fields', async () => {
    pages.set(1000, listing(1000, { isFavorite: true, numBids: 4 }));
    await lookup([1000]);
    const raw = JSON.stringify(await areas.local.get(STORAGE_KEYS.relistSeen));
    expect(raw).not.toContain('isFavorite');
    expect(raw).not.toContain('numBids');
    expect(Object.keys((await repo.get(STORAGE_KEYS.relistSeen)).entries[1000] ?? {}).sort()).toEqual(['fp', 'price', 'seenAt']);
  });

  it('refuses a non-content sender', async () => {
    const r = await router.handle({ v: 1, reqId: 'r-2', type: 'relist.lookup', payload: { itemIds: [1] } }, UI);
    expect(r.ok).toBe(false);
  });
});
