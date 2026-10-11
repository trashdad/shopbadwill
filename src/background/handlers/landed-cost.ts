// T-57: `landedCost.get`, the considerate shipping-quote lookup behind the
// landed-cost badge (controller rulings R1–R5).
//
// - Content senders only (R5), and at most 40 item ids per message.
// - NO SGW request when any of these holds (R3): `features.landedCost` is off
//   (the default), `homeZip` is unset or invalid, or the kill switch is on.
//   Those answer null for every item.
// - A pickup-only item (from the page's own `page.listings` data) answers
//   `{ shipping: 0, handling: 0, pickup: true }` with no request (R1).
// - Otherwise quotes come from the 24 h `sbw:quoteCache` (keyed by item, the
//   ZIP stored only as its SHA-256 hash: a ZIP change misses the cache, R2),
//   or from `SgwApi.shippingQuote` on lane `interactive` (R3).
// - At most 40 quote requests per page view (the sending tab plus the page
//   URL): the reservation is made synchronously, so concurrent messages can
//   never overspend, and the 41st request is refused with SgwApiError('budget')
//   before anything is sent. Cached quotes are never re-fetched within 24 h.
// - `homeZip` is personal (R4): it is only ever passed to `shippingQuote` and
//   hashed for the cache; it is never logged, audited, stored or put in an
//   error.
import type { Settings } from '../../domain/settings/schema';
import type { Repo } from '../../domain/storage/repo';
import { STORAGE_KEYS, type QuoteCacheEntry } from '../../domain/storage/schema';
import type { Cents, EpochMs, ItemId, Lane } from '../../domain/types';
import type { LandedCostQuote } from '../../messaging/protocol';
import { SgwApiError } from '../../ports/errors';
import type { SgwApi } from '../../ports/sgw-api';
import type { Clock } from '../../ports/clock';
import { requireContent, tabIdOf, type BackgroundContext, type PageStore } from '../context';
import type { HandlerContext } from '../router';

/** R2: a stored quote is fresh for 24 h from `fetchedAt`. */
export const QUOTE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
/** R3: at most 40 quote requests per page view; the 41st is refused with `budget`. */
export const MAX_QUOTE_REQUESTS_PER_PAGE_VIEW = 40;
/** R5: at most 40 item ids per landedCost.get message. */
export const MAX_LANDED_COST_IDS_PER_MESSAGE = 40;
/** Bound on the quote cache (expired entries go first, then the oldest). */
export const QUOTE_CACHE_MAX_ENTRIES = 1000;
/** The lane the handler quotes on (R3): user-triggered, 1 req/s. */
const QUOTE_LANE: Lane = 'interactive';
/** Page views remembered for the budget (bounded; the oldest fall off). */
const MAX_PAGE_VIEWS = 20;
/** The same shape the adapter accepts before anything is sent. */
const US_ZIP = /^\d{5}(-\d{4})?$/;

/** True for a US ZIP ("12345" or "12345-6789"), like SgwApiAdapter. */
export function isValidZip(zip: string): boolean {
  return US_ZIP.test(zip.trim());
}

/** SHA-256 hex of the ZIP (R2: the hash is stored, never the ZIP). */
export async function hashZip(zip: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(zip.trim()));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** The shipping + handling part of a cached quote (no pickup flag, R2's record shape). */
export interface CachedQuote {
  shipping: Cents;
  handling: Cents;
}

/** A fresh cache entry for the item and ZIP hash, or undefined (absent, other ZIP, expired). */
export async function readCachedQuote(
  repo: Repo,
  itemId: ItemId,
  zipHash: string,
  now: EpochMs,
): Promise<CachedQuote | undefined> {
  const cache = await repo.get(STORAGE_KEYS.quoteCache);
  const entry = cache[itemId];
  if (entry === undefined || entry['zip-hash'] !== zipHash) return undefined;
  if (now < entry.fetchedAt || now - entry.fetchedAt >= QUOTE_CACHE_TTL_MS) return undefined;
  return { shipping: entry.shipping, handling: entry.handling };
}

/**
 * Stores the quote under the ZIP hash. Drops expired entries, then evicts the
 * oldest beyond QUOTE_CACHE_MAX_ENTRIES; the entry just written is never
 * evicted. An invalid stored record already read as empty (Repo default).
 */
export async function writeCachedQuote(
  repo: Repo,
  itemId: ItemId,
  zipHash: string,
  quote: CachedQuote,
  now: EpochMs,
): Promise<void> {
  await repo.update(STORAGE_KEYS.quoteCache, (cache) => {
    const fresh: Array<[ItemId, QuoteCacheEntry]> = [];
    for (const [key, entry] of Object.entries(cache)) {
      if (now < entry.fetchedAt || now - entry.fetchedAt >= QUOTE_CACHE_TTL_MS) continue;
      fresh.push([Number(key), entry]);
    }
    fresh.sort((a, b) => a[1].fetchedAt - b[1].fetchedAt);
    const kept: Record<ItemId, QuoteCacheEntry> = {};
    for (const [id, entry] of fresh.slice(-(QUOTE_CACHE_MAX_ENTRIES - 1))) kept[id] = entry;
    kept[itemId] = { shipping: quote.shipping, handling: quote.handling, 'zip-hash': zipHash, fetchedAt: now };
    return kept;
  });
}

/** R3: when may a quote request go out at all? */
type Gate = { ok: true; zip: string } | { ok: false };

function gate(settings: Settings): Gate {
  const zip = (settings.homeZip ?? '').trim();
  if (!settings.features.landedCost || settings.killSwitch || !isValidZip(zip)) return { ok: false };
  return { ok: true, zip };
}

export interface LandedCostDeps {
  api: Pick<SgwApi, 'shippingQuote'>;
  repo: Repo;
  clock: Clock;
  /** The page's own listing data: pickup-only is answered without a request. */
  pages: Pick<PageStore, 'findItem'>;
}

export interface LandedCostHandlers {
  get(itemIds: readonly ItemId[], hctx: HandlerContext): Promise<Record<ItemId, LandedCostQuote | null>>;
}

export function createLandedCostHandlers(deps: LandedCostDeps): LandedCostHandlers {
  const { api, repo, clock, pages } = deps;

  // Quote requests sent per page view, keyed by sending tab + page URL (R3).
  const sent = new Map<string, number>();

  const pageViewKey = (hctx: HandlerContext): string => `${String(tabIdOf(hctx.sender) ?? '')}|${hctx.sender.url ?? ''}`;

  /**
   * Reserves `n` quote requests against the page view, synchronously: no await
   * between the check and the write, so concurrent messages can never
   * overspend the 40-request budget. Older page views of the same tab are
   * dropped; the map itself is bounded.
   */
  const reserve = (hctx: HandlerContext, n: number): void => {
    const key = pageViewKey(hctx);
    sent.set(key, (sent.get(key) ?? 0) + n);
    const tabPrefix = `${String(tabIdOf(hctx.sender) ?? '')}|`;
    for (const k of [...sent.keys()]) if (k.startsWith(tabPrefix) && k !== key) sent.delete(k);
    while (sent.size > MAX_PAGE_VIEWS) {
      const oldest = sent.keys().next();
      if (oldest.done === true) break;
      sent.delete(oldest.value);
    }
  };

  return {
    async get(itemIds, hctx) {
      requireContent('landedCost.get', hctx);
      const ids = [...new Set(itemIds)];
      if (ids.length > MAX_LANDED_COST_IDS_PER_MESSAGE) {
        throw new SgwApiError(
          'schema',
          `landedCost.get: at most ${String(MAX_LANDED_COST_IDS_PER_MESSAGE)} item ids per message (got ${String(ids.length)})`,
        );
      }

      const g = gate(await repo.get(STORAGE_KEYS.settings));
      const reply: Record<ItemId, LandedCostQuote | null> = {};
      if (!g.ok) {
        for (const id of ids) reply[id] = null;
        return reply;
      }

      const zipHash = await hashZip(g.zip);
      const now = clock.now();
      const needed: ItemId[] = [];
      for (const id of ids) {
        if (pages.findItem(id)?.pickupOnly === true) {
          reply[id] = { shipping: 0, handling: 0, pickup: true };
          continue;
        }
        const cached = await readCachedQuote(repo, id, zipHash, now);
        if (cached !== undefined) {
          reply[id] = { ...cached, pickup: false };
          continue;
        }
        needed.push(id);
      }

      if (needed.length > 0) {
        if ((sent.get(pageViewKey(hctx)) ?? 0) + needed.length > MAX_QUOTE_REQUESTS_PER_PAGE_VIEW) {
          throw new SgwApiError(
            'budget',
            `landed cost: this page view used its ${String(MAX_QUOTE_REQUESTS_PER_PAGE_VIEW)} quote requests; the request is refused`,
          );
        }
        reserve(hctx, needed.length);
        for (const id of needed) {
          let quote: CachedQuote | null;
          try {
            quote = await api.shippingQuote(id, g.zip, QUOTE_LANE);
          } catch (e) {
            // A refusal from the scheduler (paused/budget) or a failure must not
            // take the other badges down: the item reads as "no quote". R4:
            // these errors carry no ZIP.
            if (e instanceof SgwApiError && e.kind === 'budget') throw e;
            quote = null;
          }
          if (quote === null) {
            reply[id] = null;
            continue;
          }
          reply[id] = { ...quote, pickup: false };
          try {
            await writeCachedQuote(repo, id, zipHash, quote, now);
          } catch {
            // A failed cache write must not lose the quote already computed.
          }
        }
      }
      return reply;
    },
  };
}

/** T-36 self-registration (I-01): the handlers registry loads this module; main.ts needs no edit. */
export function register(ctx: BackgroundContext): void {
  const handlers = createLandedCostHandlers({
    api: ctx.api,
    repo: ctx.repo,
    clock: ctx.clock,
    pages: ctx.pages,
  });
  ctx.router.register('landedCost.get', (payload, hctx) => handlers.get(payload.itemIds, hctx));
}
