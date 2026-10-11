// T-57: landed-cost quotes (controller rulings R1–R7).
//
// - the `landedCost.get` handler: content senders only, at most 40 ids per
//   message, no request when the feature is off / homeZip is unset or invalid /
//   the kill switch is on, pickup-only answers without a request, quotes come
//   from the 24 h `sbw:quoteCache` (ZIP stored only as a hash) or from
//   SgwApi.shippingQuote on lane 'interactive', at most 40 quote requests per
//   page view (sending tab + page URL) — the 41st is refused with `budget`.
// - the `quote` step executor: same cache, the run's lane, nothing when the
//   feature is off; a fetched quote is audited without the ZIP.
// - the badge's pure helpers and the visible-id batcher (one message per batch).
import { readFileSync } from 'node:fs';
import { Window } from 'happy-dom';
import { h, render } from 'preact';
import { act } from 'preact/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { BackgroundContext } from '../../../src/background/context';
import {
  createLandedCostHandlers,
  hashZip,
  isValidZip,
  MAX_QUOTE_REQUESTS_PER_PAGE_VIEW,
  QUOTE_CACHE_TTL_MS,
  quoteSalt,
  register,
  type LandedCostHandlers,
} from '../../../src/background/handlers/landed-cost';
import quoteExecutor, { executeQuoteStep } from '../../../src/background/jobs/steps/quote';
import { createRouter, type Router, type RouterSender } from '../../../src/background/router';
import { createAuditLog } from '../../../src/domain/audit/log';
import { defaultSettings } from '../../../src/domain/settings/defaults';
import type { Settings } from '../../../src/domain/settings/schema';
import { Repo } from '../../../src/domain/storage/repo';
import { STORAGE_KEYS, type QuoteCacheEntry } from '../../../src/domain/storage/schema';
import type { ItemId, Lane, Listing, RequestSchedulerStats } from '../../../src/domain/types';
import type { JobRun, JobStep } from '../../../src/domain/watches/schema';
import type { LandedCostQuote } from '../../../src/messaging/protocol';
import { SgwApiError } from '../../../src/ports/errors';
import type { MessagingClient } from '../../../src/ports/messaging';
import { badge, badgeLine, flushLandedCostBatch, requestLandedCost } from '../../../src/content/ui/badges/landed-cost';
import { FakeClock } from '../../fakes/ports/fake-clock';
import { FakeMessaging } from '../../fakes/ports/fake-messaging';
import { FakeSgwApi } from '../../fakes/ports/fake-sgw-api';
import { FakeStorageAreas } from '../../fakes/ports/fake-storage';
import { FakeSwitches } from '../../fakes/ports/fake-switches';

const EXT_ID = 'ext-id';
const T0 = 1_700_000_000_000;
const HOUR = 3_600_000;
const URL_A = 'https://shopgoodwill.com/categories/listing?st=pyrex&sg=1';
const URL_B = 'https://shopgoodwill.com/categories/listing?st=pyrex&sg=2';
const ZIP = '43004';
const ZIP2 = '90210';

const CONTENT: RouterSender = { id: EXT_ID, url: URL_A, tab: { id: 3 } };
const UI: RouterSender = { id: EXT_ID, url: `chrome-extension://${EXT_ID}/options.html` };

const listing = (id: ItemId, over: Partial<Listing> = {}): Listing => ({
  itemId: id,
  title: `Item ${String(id)}`,
  currentPrice: 1000,
  startingMinimumBid: 1000,
  numBids: 0,
  endTime: new Date(T0 + 48 * HOUR).toISOString(),
  endTimeRaw: '2026-10-10T08:00:00',
  sellerId: 1,
  source: 'api',
  observedAt: T0,
  ...over,
});

type QuoteReply = Record<ItemId, LandedCostQuote | null>;

let clock: FakeClock;
let repo: Repo;
let api: FakeSgwApi;
let router: Router;
let handlers: LandedCostHandlers;
let pages: Map<ItemId, Listing>;

async function setSettings(patch: { landedCost?: boolean; homeZip?: string; killSwitch?: boolean }): Promise<void> {
  const s: Settings = defaultSettings();
  s.features.landedCost = patch.landedCost ?? false;
  if (patch.homeZip !== undefined) s.homeZip = patch.homeZip;
  s.killSwitch = patch.killSwitch ?? false;
  await repo.set(STORAGE_KEYS.settings, s);
}

const quoteCalls = (): Array<{ method: string; args: unknown[] }> => api.calls.filter((c) => c.method === 'shippingQuote');
const quoteArgs = (): unknown[] => quoteCalls().map((c) => c.args);
const seedQuote = (id: ItemId, zip: string = ZIP, shipping = 500, handling = 100): void => {
  api.shipping.set(`${String(id)}:${zip}`, { shipping, handling });
};
const cache = (): Promise<Record<ItemId, QuoteCacheEntry>> => repo.get(STORAGE_KEYS.quoteCache);
const env = (type: string, payload: unknown, reqId = `r-${type}`): Record<string, unknown> => ({ v: 1, reqId, type, payload });

/** The keyed ZIP hash under this install's stored salt (`sbw:quoteSalt`). */
const storedZipHash = async (zip: string, r: Repo = repo): Promise<string> => {
  const salt = await r.find(STORAGE_KEYS.quoteSalt);
  if (salt === undefined) throw new Error('no quote salt stored yet');
  return hashZip(zip, salt);
};

/** Unkeyed SHA-256 hex: what anyone can tabulate for all 100 000 five-digit ZIPs. */
const plainSha256 = async (text: string): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
};

beforeEach(async () => {
  clock = new FakeClock(T0);
  repo = new Repo(new FakeStorageAreas(), clock);
  api = new FakeSgwApi({ clock });
  pages = new Map<ItemId, Listing>();
  router = createRouter({
    runtimeId: EXT_ID,
    getURL: (p) => `chrome-extension://${EXT_ID}/${p}`,
    isQuickFavoriteEnabled: () => false,
    log: () => undefined,
  });
  // Wire the same handlers instance the router serves, so direct calls share
  // the page-view budget with router-level ones. register(ctx) itself (the
  // self-registration path) is covered by the integration suite's boot.
  handlers = createLandedCostHandlers({ api, repo, clock, pages: { findItem: (id: ItemId) => pages.get(id) } });
  router.register('landedCost.get', (payload, hctx) => handlers.get(payload.itemIds, hctx));
  await setSettings({ landedCost: true, homeZip: ZIP });
});

describe('landedCost.get handler', () => {
  const get = async (ids: ItemId[], sender: RouterSender = CONTENT, reqId = 'r-landedCost.get'): Promise<QuoteReply> => {
    const r = await router.handle(env('landedCost.get', { itemIds: ids }, reqId), sender);
    if (!r.ok) throw new Error(JSON.stringify(r));
    return r.reply as QuoteReply;
  };

  it('makes NO request when the feature is off (the default): null for all', async () => {
    await setSettings({ landedCost: false, homeZip: ZIP });
    expect(await get([1, 2])).toEqual({ 1: null, 2: null });
    expect(quoteCalls()).toEqual([]);
  });

  it('makes NO request when homeZip is unset or invalid: null for all', async () => {
    for (const zip of [undefined, '', '4300', 'abcde', '  ']) {
      await setSettings({ landedCost: true, homeZip: zip });
      expect(await get([1])).toEqual({ 1: null });
    }
    expect(quoteCalls()).toEqual([]);
  });

  it('makes NO request when the kill switch is on: null for all', async () => {
    await setSettings({ landedCost: true, homeZip: ZIP, killSwitch: true });
    expect(await get([1, 2])).toEqual({ 1: null, 2: null });
    expect(quoteCalls()).toEqual([]);
  });

  it('quotes on lane interactive and answers { shipping, handling, pickup: false }', async () => {
    seedQuote(1);
    seedQuote(2, ZIP, 750, 0);
    expect(await get([1, 2])).toEqual({
      1: { shipping: 500, handling: 100, pickup: false },
      2: { shipping: 750, handling: 0, pickup: false },
    });
    expect(quoteArgs()).toEqual([
      [1, ZIP, 'interactive'],
      [2, ZIP, 'interactive'],
    ]);
  });

  it('answers a pickup-only item with { shipping: 0, handling: 0, pickup: true } and no request', async () => {
    pages.set(9, listing(9, { pickupOnly: true }));
    seedQuote(9); // must never be read
    expect(await get([9])).toEqual({ 9: { shipping: 0, handling: 0, pickup: true } });
    expect(quoteCalls()).toEqual([]);
  });

  it('answers a null quote with null and caches nothing', async () => {
    expect(await get([1])).toEqual({ 1: null });
    expect(quoteCalls()).toHaveLength(1);
    expect(await cache()).toEqual({});
  });

  it('caches the quote under a ZIP hash (never the ZIP) and never re-fetches within 24 h', async () => {
    seedQuote(1);
    expect(await get([1])).toEqual({ 1: { shipping: 500, handling: 100, pickup: false } });
    const stored = await cache();
    expect(stored[1]).toEqual({
      shipping: 500,
      handling: 100,
      'zip-hash': await storedZipHash(ZIP),
      fetchedAt: T0,
    });
    expect(JSON.stringify(stored)).not.toContain(ZIP);

    clock.advance(23 * HOUR);
    expect(await get([1])).toEqual({ 1: { shipping: 500, handling: 100, pickup: false } });
    expect(quoteCalls()).toHaveLength(1); // cache hit

    clock.advance(HOUR); // 24 h after the fetch: stale
    expect(await get([1])).toEqual({ 1: { shipping: 500, handling: 100, pickup: false } });
    expect(quoteCalls()).toHaveLength(2);
  });

  it('a homeZip change misses the cache (the hash differs)', async () => {
    seedQuote(1);
    await get([1]);
    await setSettings({ landedCost: true, homeZip: ZIP2 });
    seedQuote(1, ZIP2, 900, 25);
    expect(await get([1])).toEqual({ 1: { shipping: 900, handling: 25, pickup: false } });
    expect(quoteCalls()).toHaveLength(2);
    const stored = await cache();
    expect(stored[1]).toMatchObject({ 'zip-hash': await storedZipHash(ZIP2) });
    expect(JSON.stringify(stored)).not.toContain(ZIP2);
  });

  it('allows at most 40 quote requests per page view: the 41st is refused with budget', async () => {
    for (let id = 1; id <= 40; id++) seedQuote(id);
    expect(Object.keys(await get(Array.from({ length: 40 }, (_, i) => i + 1)))).toHaveLength(40);
    expect(quoteCalls()).toHaveLength(MAX_QUOTE_REQUESTS_PER_PAGE_VIEW);

    seedQuote(41);
    await expect(handlers.get([41], { sender: CONTENT, senderClass: 'content' })).rejects.toMatchObject({ kind: 'budget' });
    expect(quoteCalls()).toHaveLength(MAX_QUOTE_REQUESTS_PER_PAGE_VIEW); // nothing new was sent
  });

  it('allows exactly 40 spread over several messages (each request counted once); the 41st is refused', async () => {
    for (let id = 1; id <= 41; id++) seedQuote(id);
    for (let first = 1; first <= 40; first += 10) {
      const ids = Array.from({ length: 10 }, (_, i) => first + i);
      expect(Object.values(await get(ids)).every((q) => q !== null)).toBe(true);
    }
    expect(quoteCalls()).toHaveLength(40);
    await expect(handlers.get([41], { sender: CONTENT, senderClass: 'content' })).rejects.toMatchObject({ kind: 'budget' });
    expect(quoteCalls()).toHaveLength(40);
  });

  it('refuses a whole message when it would need more than the page-view remainder, sending nothing', async () => {
    for (let id = 1; id <= 26; id++) seedQuote(id);
    await get(Array.from({ length: 26 }, (_, i) => i + 1));
    expect(quoteCalls()).toHaveLength(26);

    for (let id = 27; id <= 41; id++) seedQuote(id);
    await expect(handlers.get(Array.from({ length: 15 }, (_, i) => i + 27), { sender: CONTENT, senderClass: 'content' })).rejects.toMatchObject({
      kind: 'budget',
    });
    expect(quoteCalls()).toHaveLength(26);
  });

  it('the budget is per page view: a new URL resets it', async () => {
    for (let id = 1; id <= 40; id++) seedQuote(id);
    await get(Array.from({ length: 40 }, (_, i) => i + 1));
    seedQuote(41);
    const other = { id: EXT_ID, url: URL_B, tab: { id: 3 } };
    expect(await get([41], other)).toEqual({ 41: { shipping: 500, handling: 100, pickup: false } });
    expect(quoteCalls()).toHaveLength(41);
  });

  it('a hash-only URL change is not a new page view and does not reset the budget', async () => {
    for (let id = 1; id <= 40; id++) seedQuote(id);
    await get(Array.from({ length: 40 }, (_, i) => i + 1));
    seedQuote(41);
    const hashed = { id: EXT_ID, url: `${URL_A}#${String(Date.now())}`, tab: { id: 3 } };
    await expect(handlers.get([41], { sender: hashed, senderClass: 'content' })).rejects.toMatchObject({ kind: 'budget' });
    expect(quoteCalls()).toHaveLength(MAX_QUOTE_REQUESTS_PER_PAGE_VIEW);
  });

  it('a fresh request id from the content script does not reset the page-view budget', async () => {
    for (let id = 1; id <= 40; id++) seedQuote(id);
    await get(Array.from({ length: 40 }, (_, i) => i + 1), CONTENT, 'req-a');
    seedQuote(41);
    const r = await router.handle(env('landedCost.get', { itemIds: [41] }, 'req-b-fresh'), CONTENT);
    expect(r.ok).toBe(false);
    expect(quoteCalls()).toHaveLength(MAX_QUOTE_REQUESTS_PER_PAGE_VIEW);
    expect(JSON.stringify(r)).not.toContain(ZIP);
  });

  it('refuses more than 40 ids in one message before any request', async () => {
    await expect(handlers.get(Array.from({ length: 41 }, (_, i) => i + 1), { sender: CONTENT, senderClass: 'content' })).rejects.toMatchObject({
      kind: 'schema',
    });
    expect(quoteCalls()).toEqual([]);
  });

  it('fetches each id once even when a message repeats ids', async () => {
    seedQuote(1);
    expect(await get([1, 1, 2])).toEqual({
      1: { shipping: 500, handling: 100, pickup: false },
      2: null,
    });
    expect(quoteCalls()).toHaveLength(2);
  });

  it('an extension page may not send it (content senders only)', async () => {
    const r = await router.handle(env('landedCost.get', { itemIds: [1] }), UI);
    expect(r).toEqual({ ok: false, error: { code: 'handler_error', message: 'only a content script may send "landedCost.get"' } });
    expect(quoteCalls()).toEqual([]);
  });

  it('a failed quote answers null for that item and the rest still resolve', async () => {
    seedQuote(1);
    seedQuote(2);
    api.failNext('shippingQuote', 'network');
    expect(await get([1, 2])).toEqual({
      1: null,
      2: { shipping: 500, handling: 100, pickup: false },
    });
  });

  it('counts a failed quote toward the 40', async () => {
    api.failNext('shippingQuote', 'network');
    expect(await get([1])).toEqual({ 1: null });
    for (let id = 2; id <= 40; id++) seedQuote(id);
    await get(Array.from({ length: 39 }, (_, i) => i + 2));
    expect(quoteCalls()).toHaveLength(40);
    seedQuote(41);
    await expect(handlers.get([41], { sender: CONTENT, senderClass: 'content' })).rejects.toMatchObject({ kind: 'budget' });
    expect(quoteCalls()).toHaveLength(40);
  });

  it('answers a fully cached message after the budget is spent, and does not call SGW', async () => {
    for (let id = 1; id <= 40; id++) seedQuote(id);
    const first = await get(Array.from({ length: 40 }, (_, i) => i + 1));
    expect(await get([1, 40])).toEqual({ 1: first[1], 40: first[40] });
    expect(quoteCalls()).toHaveLength(40);
  });

  it('an invalid stored quote cache parses to empty, then a real quote is fetched', async () => {
    await repo.setRaw(STORAGE_KEYS.quoteCache, { 1: { shipping: 'nope', homeZip: ZIP } });
    expect(await repo.get(STORAGE_KEYS.quoteCache)).toEqual({});
    seedQuote(1);
    expect(await get([1])).toEqual({ 1: { shipping: 500, handling: 100, pickup: false } });
    expect(quoteCalls()).toHaveLength(1);
    expect(JSON.stringify(await cache())).not.toContain(ZIP);
  });

  it('makes NO request when the in-memory kill switch is on, even if settings still say off', async () => {
    seedQuote(1);
    await get([1]);
    expect(quoteCalls()).toHaveLength(1);
    const killed = createLandedCostHandlers({
      api,
      repo,
      clock,
      pages: { findItem: (id) => pages.get(id) },
      killSwitchOn: () => true,
    });
    expect(await killed.get([1], { sender: CONTENT, senderClass: 'content' })).toEqual({ 1: null });
    expect(quoteCalls()).toHaveLength(1);
  });

  it('makes NO request when the read gate is blocked, and still serves a cached quote', async () => {
    seedQuote(1);
    seedQuote(2);
    await get([1]);
    expect(quoteCalls()).toHaveLength(1);
    const gated = createLandedCostHandlers({
      api,
      repo,
      clock,
      pages: { findItem: (id) => pages.get(id) },
      readsBlocked: () => true,
    });
    expect(await gated.get([1, 2], { sender: CONTENT, senderClass: 'content' })).toEqual({
      1: { shipping: 500, handling: 100, pickup: false },
      2: null,
    });
    expect(quoteCalls()).toHaveLength(1);
  });

  it('refuses 41 copies of one id: the cap is the message length, before dedupe', async () => {
    seedQuote(1);
    await expect(handlers.get(Array.from({ length: 41 }, () => 1), { sender: CONTENT, senderClass: 'content' })).rejects.toMatchObject({
      kind: 'schema',
    });
    expect(quoteCalls()).toEqual([]);
  });

  it('zod refuses more than 40 item ids before the handler runs', async () => {
    const ids = Array.from({ length: 41 }, (_, i) => i + 1);
    const r = await router.handle(env('landedCost.get', { itemIds: ids }), CONTENT);
    expect(r).toMatchObject({ ok: false, error: { code: 'invalid_message' } });
    expect(quoteCalls()).toEqual([]);
    expect(JSON.stringify(r)).not.toContain(ZIP);
  });

  it('a scheduler budget error is rethrown without the ZIP', async () => {
    api.shippingQuote = () => Promise.reject(new SgwApiError('budget', `lane spent for ${ZIP}`));
    const err = await handlers.get([1], { sender: CONTENT, senderClass: 'content' }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(SgwApiError);
    if (!(err instanceof SgwApiError)) throw new Error('expected a budget refusal');
    expect(err.kind).toBe('budget');
    expect(err.message).not.toContain(ZIP);
    expect(JSON.stringify(err)).not.toContain(ZIP);
  });

  it('the budget error never carries the ZIP', async () => {
    for (let id = 1; id <= 40; id++) seedQuote(id);
    await get(Array.from({ length: 40 }, (_, i) => i + 1));
    const err = await handlers.get([41], { sender: CONTENT, senderClass: 'content' }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(SgwApiError);
    if (!(err instanceof SgwApiError)) throw new Error('expected a budget refusal');
    expect(err.message).not.toContain(ZIP);
  });
});

const contentGet = async (ids: ItemId[], sender: RouterSender = CONTENT, via: Router = router): Promise<QuoteReply> => {
  const r = await via.handle(env('landedCost.get', { itemIds: ids }), sender);
  if (!r.ok) throw new Error(JSON.stringify(r));
  return r.reply as QuoteReply;
};
const tabSender = (tab: number, url: string = URL_A): RouterSender => ({ id: EXT_ID, url, tab: { id: tab } });

const stepRun = (id: string): JobRun => ({
  id,
  trigger: 'scheduled',
  startedAt: T0,
  status: 'running',
  steps: [],
  cursor: 0,
  results: { newMatches: [], favorited: [], calendarUpserts: [], errors: [] },
  candidates: [],
});

describe('ZIP hash privacy: a per-install salt (sbw:quoteSalt)', () => {
  it('stores a keyed hash, not the plain SHA-256 of the ZIP, so a table of 5-digit ZIPs cannot reverse it', async () => {
    seedQuote(1);
    await contentGet([1]);
    const salt = await repo.find(STORAGE_KEYS.quoteSalt);
    expect(salt).toMatch(/^[0-9a-f]{64}$/);
    expect(salt).not.toContain(ZIP);
    const stored = (await cache())[1];
    expect(stored?.['zip-hash']).toMatch(/^[0-9a-f]{64}$/);
    expect(stored?.['zip-hash']).not.toBe(await plainSha256(ZIP));
    expect(stored?.['zip-hash']).toBe(await hashZip(ZIP, salt ?? ''));
  });

  it('two installs with the same ZIP store different hashes', async () => {
    seedQuote(1);
    await contentGet([1]);
    const otherRepo = new Repo(new FakeStorageAreas(), clock);
    const s = defaultSettings();
    s.features.landedCost = true;
    s.homeZip = ZIP;
    await otherRepo.set(STORAGE_KEYS.settings, s);
    const other = createLandedCostHandlers({ api, repo: otherRepo, clock, pages: { findItem: () => undefined } });
    await other.get([1], { sender: tabSender(9), senderClass: 'content' });
    const mine = (await cache())[1]?.['zip-hash'];
    const theirs = (await otherRepo.get(STORAGE_KEYS.quoteCache))[1]?.['zip-hash'];
    expect(mine).toMatch(/^[0-9a-f]{64}$/);
    expect(theirs).toMatch(/^[0-9a-f]{64}$/);
    expect(theirs).not.toBe(mine);
  });

  it('creates the salt once: concurrent first use and the quote step share it', async () => {
    seedQuote(1);
    seedQuote(2);
    await Promise.all([contentGet([1], tabSender(1)), contentGet([2], tabSender(2))]);
    const stored = await cache();
    expect(stored[1]?.['zip-hash']).toBe(stored[2]?.['zip-hash']);
    const salt = await repo.find(STORAGE_KEYS.quoteSalt);
    expect(await quoteSalt(repo)).toBe(salt);
    // The quote step reads the handler's entry: same salt, same hash, no request.
    const deps = {
      api,
      repo,
      audit: createAuditLog(repo),
      switches: new FakeSwitches(),
      lane: 'background' as Lane,
      run: stepRun('run-s'),
      ctx: {} as unknown as BackgroundContext,
    };
    expect(await executeQuoteStep({ kind: 'quote', itemId: 1 }, deps)).toEqual({ kind: 'quote', quote: { shipping: 500, handling: 100 } });
    expect(quoteCalls()).toHaveLength(2);
  });

  it('an invalid stored salt is replaced by a fresh one; the old entries miss and a real quote is fetched', async () => {
    seedQuote(1);
    await contentGet([1]);
    const before = await repo.find(STORAGE_KEYS.quoteSalt);
    await repo.setRaw(STORAGE_KEYS.quoteSalt, `zip ${ZIP}`);
    expect(await contentGet([1])).toEqual({ 1: { shipping: 500, handling: 100, pickup: false } });
    expect(quoteCalls()).toHaveLength(2);
    const after = await repo.find(STORAGE_KEYS.quoteSalt);
    expect(after).toMatch(/^[0-9a-f]{64}$/);
    expect(after).not.toBe(before);
    expect((await cache())[1]?.['zip-hash']).toBe(await hashZip(ZIP, after ?? ''));
  });

  it('makes no salt while the feature is off', async () => {
    await setSettings({ landedCost: false, homeZip: ZIP });
    await contentGet([1]);
    expect(await repo.getRaw(STORAGE_KEYS.quoteSalt)).toBeUndefined();
  });
});

describe('page-view budget memory', () => {
  it('a tab that moves to a new URL forgets its old page view', async () => {
    for (let i = 1; i <= 50; i++) {
      seedQuote(i);
      await contentGet([i], tabSender(3, `${URL_A}&p=${String(i)}`));
    }
    expect(handlers.pageViewsTracked()).toBe(1);
  });

  it('keeps at most 20 page views across tabs: closed tabs fall off, oldest first', async () => {
    for (let tab = 1; tab <= 100; tab++) {
      seedQuote(tab);
      await contentGet([tab], tabSender(tab));
    }
    expect(handlers.pageViewsTracked()).toBe(20);
  });

  it('a message that sends nothing adds no page view', async () => {
    await setSettings({ landedCost: false, homeZip: ZIP });
    await contentGet([1], tabSender(5));
    expect(handlers.pageViewsTracked()).toBe(0);
  });
});

describe('register(ctx): the live kill switch and read-gate probes', () => {
  const laneStats = (over: Partial<RequestSchedulerStats['lanes']> = {}, paused?: RequestSchedulerStats['paused']): RequestSchedulerStats => {
    const lane = { usedToday: 0, budget: 300, nextAllowedAt: T0 };
    const stats: RequestSchedulerStats = {
      lanes: {
        interactive: { ...lane },
        background: { ...lane, budget: 120 },
        snipe: { ...lane, budget: 80 },
        canary: { ...lane, budget: 4 },
        ...over,
      },
      cacheHits: 0,
    };
    if (paused !== undefined) stats.paused = paused;
    return stats;
  };

  const boot = (stats: () => RequestSchedulerStats, killSwitch = false): Router => {
    const r = createRouter({
      runtimeId: EXT_ID,
      getURL: (p) => `chrome-extension://${EXT_ID}/${p}`,
      isQuickFavoriteEnabled: () => false,
      log: () => undefined,
    });
    const ctx = {
      api,
      repo,
      clock,
      pages: { findItem: (id: ItemId) => pages.get(id) },
      switches: { view: () => ({ killSwitch }) },
      scheduler: { stats },
      router: r,
    } as unknown as BackgroundContext;
    register(ctx);
    return r;
  };

  it('an open gate quotes on the interactive lane', async () => {
    seedQuote(1);
    expect(await contentGet([1], CONTENT, boot(() => laneStats()))).toEqual({ 1: { shipping: 500, handling: 100, pickup: false } });
    expect(quoteArgs()).toEqual([[1, ZIP, 'interactive']]);
  });

  it('the in-memory kill switch: no request', async () => {
    seedQuote(1);
    expect(await contentGet([1], CONTENT, boot(() => laneStats(), true))).toEqual({ 1: null });
    expect(quoteCalls()).toEqual([]);
  });

  it('interactive lane in backoff: no request; once the backoff has passed, it quotes', async () => {
    seedQuote(1);
    let backoffUntil = T0 + 60_000;
    const r = boot(() => laneStats({ interactive: { usedToday: 0, budget: 300, nextAllowedAt: T0, backoffUntil } }));
    expect(await contentGet([1], CONTENT, r)).toEqual({ 1: null });
    expect(quoteCalls()).toEqual([]);
    backoffUntil = T0;
    expect(await contentGet([1], CONTENT, r)).toEqual({ 1: { shipping: 500, handling: 100, pickup: false } });
    expect(quoteCalls()).toHaveLength(1);
  });

  it('a spent interactive budget, a scheduler pause, or a throwing probe: no request', async () => {
    seedQuote(1);
    const spent = laneStats({ interactive: { usedToday: 300, budget: 300, nextAllowedAt: T0 } });
    const paused = laneStats({}, { until: null, reason: 'manual' });
    const blocked: Array<() => RequestSchedulerStats> = [
      () => spent,
      () => paused,
      () => {
        throw new Error('stats unavailable');
      },
    ];
    for (const stats of blocked) expect(await contentGet([1], CONTENT, boot(stats))).toEqual({ 1: null });
    expect(quoteCalls()).toEqual([]);
  });

  it('a background-lane backoff does not block the interactive handler', async () => {
    seedQuote(1);
    const stats = laneStats({ background: { usedToday: 0, budget: 120, nextAllowedAt: T0, backoffUntil: T0 + 60_000 } });
    expect(await contentGet([1], CONTENT, boot(() => stats))).toEqual({ 1: { shipping: 500, handling: 100, pickup: false } });
  });

  it('the quote step: a background-lane backoff or spent budget refuses with paused and sends nothing', async () => {
    seedQuote(101);
    const deps = (stats: RequestSchedulerStats): Parameters<typeof executeQuoteStep>[1] => ({
      api,
      repo,
      audit: createAuditLog(repo),
      switches: new FakeSwitches(),
      lane: 'background',
      run: stepRun('run-g'),
      ctx: { scheduler: { stats: () => stats } } as unknown as BackgroundContext,
    });
    const backoff = laneStats({ background: { usedToday: 0, budget: 120, nextAllowedAt: T0, backoffUntil: T0 + 1 } });
    const spent = laneStats({ background: { usedToday: 120, budget: 120, nextAllowedAt: T0 } });
    for (const stats of [backoff, spent]) {
      await expect(executeQuoteStep({ kind: 'quote', itemId: 101 }, deps(stats))).rejects.toMatchObject({ kind: 'paused' });
    }
    expect(quoteCalls()).toEqual([]);
    // Only the background lane gates the step: an interactive backoff does not.
    const interactiveOnly = laneStats({ interactive: { usedToday: 0, budget: 300, nextAllowedAt: T0, backoffUntil: T0 + 1 } });
    expect(await executeQuoteStep({ kind: 'quote', itemId: 101 }, deps(interactiveOnly))).toEqual({
      kind: 'quote',
      quote: { shipping: 500, handling: 100 },
    });
  });
});

describe('homeZip never reaches a log', () => {
  const logged: string[] = [];
  const text = (a: unknown): string => {
    if (a instanceof Error) return `${a.name} ${a.message} ${a.stack ?? ''} ${JSON.stringify(a)}`;
    if (typeof a === 'string') return a;
    try {
      return JSON.stringify(a);
    } catch {
      return String(a);
    }
  };

  beforeEach(() => {
    logged.length = 0;
    for (const m of ['log', 'info', 'warn', 'error', 'debug', 'trace'] as const) {
      vi.spyOn(console, m).mockImplementation((...args: unknown[]) => {
        logged.push(args.map(text).join(' '));
      });
    }
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('across a quote, a failed quote, cache hits, a page-budget refusal, a scheduler refusal and the quote step', async () => {
    const r = createRouter({
      runtimeId: EXT_ID,
      getURL: (p) => `chrome-extension://${EXT_ID}/${p}`,
      isQuickFavoriteEnabled: () => false,
      log: (message, error) => {
        logged.push(`${message} ${text(error)}`);
      },
    });
    const h = createLandedCostHandlers({ api, repo, clock, pages: { findItem: () => undefined } });
    r.register('landedCost.get', (payload, hctx) => h.get(payload.itemIds, hctx));
    for (let id = 1; id <= 40; id++) seedQuote(id);
    api.failNext('shippingQuote', 'network');
    await contentGet(Array.from({ length: 40 }, (_, i) => i + 1), CONTENT, r);
    await contentGet([2, 3], CONTENT, r); // cache hits
    expect((await r.handle(env('landedCost.get', { itemIds: [41] }), CONTENT)).ok).toBe(false); // page budget
    const realQuote = api.shippingQuote.bind(api);
    api.shippingQuote = () => Promise.reject(new SgwApiError('budget', `lane spent for ${ZIP}`));
    expect((await r.handle(env('landedCost.get', { itemIds: [50] }), tabSender(8))).ok).toBe(false);
    api.shippingQuote = () => Promise.reject(new SgwApiError('network', `no route to ${ZIP}`));
    expect(await contentGet([51], tabSender(10), r)).toEqual({ 51: null });
    const deps = {
      api,
      repo,
      audit: createAuditLog(repo),
      switches: new FakeSwitches(),
      lane: 'background' as Lane,
      run: stepRun('run-l'),
      ctx: {} as unknown as BackgroundContext,
    };
    await executeQuoteStep({ kind: 'quote', itemId: 77 }, deps).catch(() => undefined);
    api.shippingQuote = realQuote;
    seedQuote(78);
    await executeQuoteStep({ kind: 'quote', itemId: 78 }, deps);
    expect(logged.some((line) => line.includes('landedCost.get'))).toBe(true); // the router did log the refusals
    for (const line of logged) expect(line).not.toContain(ZIP);
  });
});

describe('quote step executor', () => {
  const step: JobStep = { kind: 'quote', itemId: 101 };
  const run: JobRun = {
    id: 'run-1',
    trigger: 'scheduled',
    startedAt: T0,
    status: 'running',
    steps: [step],
    cursor: 0,
    results: { newMatches: [], favorited: [], calendarUpserts: [], errors: [] },
    candidates: [],
  };
  let audit: ReturnType<typeof createAuditLog>;

  const deps = (): Parameters<typeof executeQuoteStep>[1] => ({
    api,
    repo,
    audit,
    switches: new FakeSwitches(),
    lane: 'background',
    run,
    ctx: {} as unknown as BackgroundContext,
  });

  beforeEach(() => {
    audit = createAuditLog(repo);
  });

  it('does nothing when the feature is off: quote null, no call, no audit', async () => {
    await setSettings({ landedCost: false, homeZip: ZIP });
    expect(await executeQuoteStep(step, deps())).toEqual({ kind: 'quote', quote: null });
    expect(quoteCalls()).toEqual([]);
    expect(await audit.list({ limit: 5 })).toEqual([]);
  });

  it('does nothing under the kill switch or without a valid homeZip', async () => {
    for (const s of [{ killSwitch: true }, { homeZip: undefined }, { homeZip: 'nope' }]) {
      await setSettings({ landedCost: true, ...s });
      expect(await executeQuoteStep(step, deps())).toEqual({ kind: 'quote', quote: null });
    }
    expect(quoteCalls()).toEqual([]);
  });

  it('quotes on the run lane, caches under the ZIP hash and audits without the ZIP', async () => {
    seedQuote(101);
    expect(await executeQuoteStep(step, deps())).toEqual({ kind: 'quote', quote: { shipping: 500, handling: 100 } });
    expect(quoteArgs()).toEqual([[101, ZIP, 'background']]);
    expect(await cache()).toMatchObject({ 101: { shipping: 500, handling: 100, 'zip-hash': await storedZipHash(ZIP) } });
    const [entry] = await audit.list({ limit: 5 });
    expect(entry).toMatchObject({ actor: 'daily-job', kind: 'quote.fetched', itemId: 101 });
    expect(JSON.stringify(await audit.exportJson())).not.toContain(ZIP);
    expect(JSON.stringify(await cache())).not.toContain(ZIP);
  });

  it('serves a fresh cache entry with no call (24 h TTL)', async () => {
    seedQuote(101);
    await executeQuoteStep(step, deps());
    clock.advance(QUOTE_CACHE_TTL_MS - 1);
    expect(await executeQuoteStep(step, deps())).toEqual({ kind: 'quote', quote: { shipping: 500, handling: 100 } });
    expect(quoteCalls()).toHaveLength(1);
    clock.advance(1);
    expect(await executeQuoteStep(step, deps())).toEqual({ kind: 'quote', quote: { shipping: 500, handling: 100 } });
    expect(quoteCalls()).toHaveLength(2);
  });

  it('a null quote is not cached and not audited', async () => {
    expect(await executeQuoteStep(step, deps())).toEqual({ kind: 'quote', quote: null });
    expect(quoteCalls()).toHaveLength(1);
    expect(await cache()).toEqual({});
    expect(await audit.list({ limit: 5 })).toEqual([]);
  });

  it('propagates SgwApiError so the runner can map it', async () => {
    seedQuote(101);
    api.failNext('shippingQuote', 'network');
    await expect(executeQuoteStep(step, deps())).rejects.toMatchObject({ kind: 'network' });
  });

  it('is { kind: quote, run } and quotes on the background lane even when the run drains on interactive', async () => {
    expect(quoteExecutor).toMatchObject({ kind: 'quote', run: executeQuoteStep });
    seedQuote(101);
    expect(await executeQuoteStep(step, { ...deps(), lane: 'interactive' })).toEqual({
      kind: 'quote',
      quote: { shipping: 500, handling: 100 },
    });
    expect(quoteArgs()).toEqual([[101, ZIP, 'background']]);
  });

  it('does nothing when the in-memory kill switch is on and settings are not updated yet', async () => {
    seedQuote(101);
    const switches = new FakeSwitches() as FakeSwitches & { view: () => { killSwitch: boolean } };
    switches.view = () => ({ killSwitch: true });
    expect(await executeQuoteStep(step, { ...deps(), switches })).toEqual({ kind: 'quote', quote: null });
    expect(quoteCalls()).toEqual([]);
    expect(await audit.list({ limit: 5 })).toEqual([]);
  });

  it('does not call SGW when the read gate is closed, and the refusal carries no ZIP', async () => {
    seedQuote(101);
    const ctx = {
      scheduler: {
        stats: () => ({ paused: { until: null, reason: `paused near ${ZIP}` }, lanes: {}, cacheHits: 0 }),
      },
    } as unknown as BackgroundContext;
    const err = await executeQuoteStep(step, { ...deps(), ctx }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(SgwApiError);
    if (!(err instanceof SgwApiError)) throw new Error('expected the read gate to refuse');
    expect(err.kind).toBe('paused');
    expect(err.message).not.toContain(ZIP);
    expect(quoteCalls()).toEqual([]);
  });

  it('strips homeZip out of an error it propagates', async () => {
    api.shippingQuote = () => Promise.reject(new SgwApiError('network', `no route to ${ZIP}`, { status: 503 }));
    const err = await executeQuoteStep(step, deps()).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(SgwApiError);
    if (!(err instanceof SgwApiError)) throw new Error('expected a network error');
    expect(err.kind).toBe('network');
    expect(err.status).toBe(503);
    expect(err.message).not.toContain(ZIP);
    expect(JSON.stringify(await audit.list({ limit: 5 }))).not.toContain(ZIP);
  });
});

describe('shared helpers', () => {
  it('isValidZip accepts trimmed 5-digit and ZIP+4 forms only', () => {
    expect(isValidZip('43004')).toBe(true);
    expect(isValidZip(' 43004 ')).toBe(true);
    expect(isValidZip('43004-1234')).toBe(true);
    expect(isValidZip('4300')).toBe(false);
    expect(isValidZip('430041')).toBe(false);
    expect(isValidZip('abcde')).toBe(false);
    expect(isValidZip('')).toBe(false);
  });

  it('hashZip is a 64-hex keyed hash that differs per ZIP and per salt, and is not the plain SHA-256', async () => {
    const saltA = 'a1'.repeat(32);
    const saltB = 'b2'.repeat(32);
    const a = await hashZip(ZIP, saltA);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(await hashZip(ZIP, saltA)).toBe(a);
    expect(await hashZip(` ${ZIP} `, saltA)).toBe(a);
    expect(await hashZip(ZIP2, saltA)).not.toBe(a);
    expect(await hashZip(ZIP, saltB)).not.toBe(a);
    expect(a).not.toBe(await plainSha256(ZIP));
    expect(a).not.toContain(ZIP);
  });
});

describe('landed-cost badge', () => {
  it('badgeLine: pickup-only, a quoted item, and nothing for a null quote', () => {
    expect(badgeLine({ shipping: 0, handling: 0, pickup: true }, 1000)).toEqual({
      text: 'Pickup only',
      title: 'Pickup only: no shipping or handling charged',
    });
    expect(badgeLine({ shipping: 500, handling: 100, pickup: false }, 1299)).toEqual({
      text: 'Landed $18.99',
      title: 'Current $12.99 + shipping $5.00 + handling $1.00',
    });
    // 10 + 20 + 30 cents. Summing the dollar amounts 0.10 + 0.20 + 0.30 is not 0.60 in binary floating point.
    expect(badgeLine({ shipping: 20, handling: 30, pickup: false }, 10)?.text).toBe('Landed $0.60');
    // (29.99 + 8.99 + 0.57) * 100 is 3954.9999999999995 in floating point: a dollar sum that truncates shows $39.54.
    expect(badgeLine({ shipping: 899, handling: 57, pickup: false }, 2999)?.text).toBe('Landed $39.55');
    expect(badgeLine(null, 1299)).toBeNull();
    expect(JSON.stringify(badgeLine({ shipping: 20, handling: 30, pickup: false }, 10))).not.toContain(ZIP);
  });

  it('requestLandedCost batches every visible id into ONE message and resolves each entry', async () => {
    const fake = new FakeMessaging();
    fake.handle('landedCost.get', ({ itemIds }) => {
      const reply: Record<ItemId, LandedCostQuote> = {};
      for (const id of itemIds) reply[id] = { shipping: 500, handling: 100, pickup: false };
      return reply;
    });
    const a = requestLandedCost(fake, 1);
    const b = requestLandedCost(fake, 2);
    flushLandedCostBatch(fake);
    expect(await Promise.all([a, b])).toEqual([
      { shipping: 500, handling: 100, pickup: false },
      { shipping: 500, handling: 100, pickup: false },
    ]);
    expect(fake.sent).toHaveLength(1);
    expect(fake.sent[0]?.type).toBe('landedCost.get');
    expect((fake.sent[0]?.payload as { itemIds: ItemId[] }).itemIds).toEqual([1, 2]);
  });

  it('a failed batch resolves every pending id to null (never rejects)', async () => {
    const fake = new FakeMessaging(); // no handler: send rejects
    const a = requestLandedCost(fake, 7);
    flushLandedCostBatch(fake);
    expect(await a).toBeNull();
  });

  it('renders text only: no innerHTML, and homeZip is not in the badge module', () => {
    const src = readFileSync(new URL('../../../src/content/ui/badges/landed-cost.tsx', import.meta.url), 'utf8');
    expect(src).not.toMatch(/\.innerHTML|dangerouslySetInnerHTML/);
    expect(src).not.toMatch(/homeZip/);
  });

  it('asks only for cards the IntersectionObserver reports as visible, in one batch', async () => {
    const window = new Window();
    const prevDocument = globalThis.document;
    const prevObserver = globalThis.IntersectionObserver;
    const observers: FakeObserver[] = [];
    class FakeObserver {
      readonly observed: Element[] = [];
      constructor(private readonly cb: (entries: Array<{ isIntersecting: boolean; target: Element }>) => void) {
        observers.push(this);
      }
      observe(target: Element): void {
        this.observed.push(target);
      }
      disconnect(): void {
        /* the badge drops the card once it has been seen */
      }
      unobserve(): void {
        /* unused */
      }
      takeRecords(): [] {
        return [];
      }
      fire(isIntersecting: boolean): void {
        const target = this.observed[0];
        if (target === undefined) throw new Error('observed nothing');
        this.cb([{ isIntersecting, target }]);
      }
    }
    globalThis.document = window.document as unknown as Document;
    globalThis.IntersectionObserver = FakeObserver as unknown as typeof IntersectionObserver;
    const doc = window.document;
    const host = doc.createElement('div');
    doc.body.appendChild(host);
    const cardA = doc.createElement('article');
    const cardB = doc.createElement('article');
    const sent: ItemId[][] = [];
    const client: MessagingClient = {
      send: (_type, payload) => {
        const ids = (payload as { itemIds: ItemId[] }).itemIds;
        sent.push(ids);
        const reply: Record<ItemId, LandedCostQuote | null> = {};
        for (const id of ids) {
          reply[id] =
            id === 2 ? { shipping: 0, handling: 0, pickup: true } : { shipping: 20, handling: 30, pickup: false };
        }
        return Promise.resolve(reply as never);
      },
      connect: () => () => undefined,
      onBroadcast: () => () => undefined,
    };
    const settings = defaultSettings();
    settings.features.landedCost = true;
    try {
      await act(() => {
        render(
          h('div', null, [
            h(badge.Component, {
              itemId: 1,
              listing: listing(1, { currentPrice: 10 }),
              settings,
              client,
              cardRoot: cardA as unknown as Element,
              now: T0,
            }),
            h(badge.Component, {
              itemId: 2,
              listing: listing(2, { currentPrice: 10 }),
              settings,
              client,
              cardRoot: cardB as unknown as Element,
              now: T0,
            }),
          ]),
          host,
        );
      });
      expect(observers).toHaveLength(2);
      expect(observers[0]?.observed[0]).toBe(cardA);
      expect(observers[1]?.observed[0]).toBe(cardB);
      expect(sent).toEqual([]);
      await act(() => {
        observers[0]?.fire(false);
        observers[1]?.fire(false);
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(sent).toEqual([]);
      await act(async () => {
        observers[0]?.fire(true);
        observers[1]?.fire(true);
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(sent).toEqual([[1, 2]]);
      const chips = [...host.querySelectorAll('.chip')];
      expect(chips.map((chip) => chip.textContent)).toEqual(['Landed $0.60', 'Pickup only']);
      for (const chip of chips) expect(chip.childElementCount).toBe(0);
      expect(host.innerHTML).not.toContain(ZIP);
    } finally {
      render(null, host);
      flushLandedCostBatch(client);
      globalThis.document = prevDocument;
      globalThis.IntersectionObserver = prevObserver;
      window.close();
    }
  });

  it('renders nothing, observes nothing and sends nothing when the feature or the badge toggle is off; turning it off hides a shown badge', async () => {
    const window = new Window();
    const prevDocument = globalThis.document;
    const prevObserver = globalThis.IntersectionObserver;
    const observed: Element[] = [];
    const callbacks: Array<(entries: Array<{ isIntersecting: boolean }>) => void> = [];
    class FakeObserver {
      constructor(cb: (entries: Array<{ isIntersecting: boolean }>) => void) {
        callbacks.push(cb);
      }
      observe(target: Element): void {
        observed.push(target);
      }
      disconnect(): void {
        /* nothing to release */
      }
      unobserve(): void {
        /* unused */
      }
      takeRecords(): [] {
        return [];
      }
    }
    globalThis.document = window.document as unknown as Document;
    globalThis.IntersectionObserver = FakeObserver as unknown as typeof IntersectionObserver;
    const doc = window.document;
    const host = doc.createElement('div');
    doc.body.appendChild(host);
    const card = doc.createElement('article');
    const sent: ItemId[][] = [];
    const client: MessagingClient = {
      send: (_type, payload) => {
        const ids = (payload as { itemIds: ItemId[] }).itemIds;
        sent.push(ids);
        const reply: Record<ItemId, LandedCostQuote | null> = {};
        for (const id of ids) reply[id] = { shipping: 500, handling: 100, pickup: false };
        return Promise.resolve(reply as never);
      },
      connect: () => () => undefined,
      onBroadcast: () => () => undefined,
    };
    const mount = (settings: Settings): Promise<void> =>
      act(() => {
        render(
          h(badge.Component, { itemId: 5, listing: listing(5, { currentPrice: 1299 }), settings, client, cardRoot: card as unknown as Element, now: T0 }),
          host,
        );
      });
    const featureOff = defaultSettings(); // features.landedCost is false by default
    const toggleOff = defaultSettings();
    toggleOff.features.landedCost = true;
    toggleOff.overlay.landedCostBadges = false;
    const on = defaultSettings();
    on.features.landedCost = true;
    try {
      for (const settings of [featureOff, toggleOff]) {
        await mount(settings);
        await act(async () => {
          for (const cb of callbacks) cb([{ isIntersecting: true }]);
          await new Promise((resolve) => setTimeout(resolve, 0));
        });
        expect(observed).toEqual([]);
        expect(sent).toEqual([]);
        expect(host.textContent).toBe('');
        render(null, host);
      }
      await mount(on);
      await act(async () => {
        for (const cb of callbacks) cb([{ isIntersecting: true }]);
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
      expect(sent).toEqual([[5]]);
      expect(host.textContent).toBe('Landed $18.99');
      await mount(featureOff);
      expect(host.textContent).toBe('');
    } finally {
      render(null, host);
      flushLandedCostBatch(client);
      globalThis.document = prevDocument;
      globalThis.IntersectionObserver = prevObserver;
      window.close();
    }
  });
});
