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
import { beforeEach, describe, expect, it } from 'vitest';

import type { BackgroundContext } from '../../../src/background/context';
import {
  createLandedCostHandlers,
  hashZip,
  isValidZip,
  MAX_QUOTE_REQUESTS_PER_PAGE_VIEW,
  QUOTE_CACHE_TTL_MS,
  type LandedCostHandlers,
} from '../../../src/background/handlers/landed-cost';
import { executeQuoteStep } from '../../../src/background/jobs/steps/quote';
import { createRouter, type Router, type RouterSender } from '../../../src/background/router';
import { createAuditLog } from '../../../src/domain/audit/log';
import { defaultSettings } from '../../../src/domain/settings/defaults';
import type { Settings } from '../../../src/domain/settings/schema';
import { Repo } from '../../../src/domain/storage/repo';
import { STORAGE_KEYS, type QuoteCacheEntry } from '../../../src/domain/storage/schema';
import type { ItemId, Listing } from '../../../src/domain/types';
import type { JobRun, JobStep } from '../../../src/domain/watches/schema';
import type { LandedCostQuote } from '../../../src/messaging/protocol';
import { SgwApiError } from '../../../src/ports/errors';
import { badgeLine, flushLandedCostBatch, requestLandedCost } from '../../../src/content/ui/badges/landed-cost';
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
const env = (type: string, payload: unknown): Record<string, unknown> => ({ v: 1, reqId: `r-${type}`, type, payload });

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
  const get = async (ids: ItemId[], sender: RouterSender = CONTENT): Promise<QuoteReply> => {
    const r = await router.handle(env('landedCost.get', { itemIds: ids }), sender);
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
      'zip-hash': await hashZip(ZIP),
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
    expect(stored[1]).toMatchObject({ 'zip-hash': await hashZip(ZIP2) });
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
    expect(await cache()).toMatchObject({ 101: { shipping: 500, handling: 100, 'zip-hash': await hashZip(ZIP) } });
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

  it('hashZip is a 64-hex SHA-256 that differs per ZIP', async () => {
    const a = await hashZip(ZIP);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(await hashZip(ZIP)).toBe(a);
    expect(await hashZip(ZIP2)).not.toBe(a);
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
    expect(badgeLine(null, 1299)).toBeNull();
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
});
