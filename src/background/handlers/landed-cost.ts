// T-57: `landedCost.get`, the considerate shipping-quote lookup behind the
// landed-cost badge (controller rulings R1–R5).
//
// - Content senders only (R5), and at most 40 item ids per message.
// - NO SGW request when any of these holds (R3): `features.landedCost` is off
//   (the default), `homeZip` is unset or invalid, the kill switch is on
//   (persisted settings or the in-memory switch, which can lead the write),
//   or the read gate is blocked (scheduler pause, interactive backoff, or a
//   spent interactive budget). The kill switch answers null for every item,
//   including a cached one. A blocked read gate still answers a cached quote
//   and answers null for anything that would have been fetched.
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
//   error. A scheduler `budget` error whose message contains the ZIP is
//   rethrown as a fresh error with a fixed message.
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

/**
 * The page-view id is the document URL without its fragment. A content script
 * cannot mint a new budget by appending `#…` (or by sending a fresh request
 * id: the key never reads the message). A different path or query is a new
 * page view.
 */
function pageViewUrl(url: string | undefined): string {
  if (url === undefined) return '';
  const hash = url.indexOf('#');
  return hash === -1 ? url : url.slice(0, hash);
}

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

/** A thrown probe is treated as blocked (fail closed). */
function flagOn(probe: (() => boolean) | undefined): boolean {
  if (probe === undefined) return false;
  try {
    return probe();
  } catch {
    return true;
  }
}

/** True when the error text or its enumerable fields contain the home ZIP. */
function errorHasZip(err: SgwApiError, zip: string): boolean {
  if (zip === '') return false;
  if (err.message.includes(zip)) return true;
  try {
    return JSON.stringify(err).includes(zip);
  } catch {
    return false;
  }
}

/**
 * The scheduler's read gate for the interactive lane (R3): a global pause, a
 * missing lane, a backoff still in the future, or a spent daily budget.
 * Same rule as DailyJobRunner.laneBlocked.
 */
function interactiveReadsBlocked(ctx: BackgroundContext): boolean {
  const stats = ctx.scheduler.stats();
  if (stats.paused !== undefined) return true;
  // A partial stats record (a lane the scheduler has not published) is blocked.
  const lane = (stats.lanes as Partial<typeof stats.lanes>).interactive;
  if (lane === undefined) return true;
  const now = ctx.clock.now();
  return (lane.backoffUntil !== undefined && lane.backoffUntil > now) || lane.usedToday >= lane.budget;
}

export interface LandedCostDeps {
  api: Pick<SgwApi, 'shippingQuote'>;
  repo: Repo;
  clock: Clock;
  /** The page's own listing data: pickup-only is answered without a request. */
  pages: Pick<PageStore, 'findItem'>;
  /**
   * Live kill switch. Settings can still say off while this is already on
   * (the in-memory switch is set before the persist). Omit in unit tests
   * that only flip `settings.killSwitch`.
   */
  killSwitchOn?: () => boolean;
  /**
   * Read gate. A blocked gate serves the cache and does not call SGW.
   * Omit when the test has no scheduler.
   */
  readsBlocked?: () => boolean;
}

export interface LandedCostHandlers {
  get(itemIds: readonly ItemId[], hctx: HandlerContext): Promise<Record<ItemId, LandedCostQuote | null>>;
}

export function createLandedCostHandlers(deps: LandedCostDeps): LandedCostHandlers {
  const { api, repo, clock, pages, killSwitchOn, readsBlocked } = deps;

  // Quote requests sent per page view, keyed by sending tab + URL without the
  // fragment (R3). Not a client-supplied id: a new reqId cannot reset it.
  const sent = new Map<string, number>();

  const pageViewKey = (hctx: HandlerContext): string => `${String(tabIdOf(hctx.sender) ?? '')}|${pageViewUrl(hctx.sender.url)}`;

  /**
   * Reserves `n` quote requests against the page view, synchronously: no await
   * between the check and the write, so concurrent messages can never
   * overspend the 40-request budget. Older page views of the same tab are
   * dropped; the map itself is bounded. Re-inserting the current key makes it
   * the newest, so a busy tab is not the one evicted.
   */
  const reserve = (hctx: HandlerContext, n: number): void => {
    const key = pageViewKey(hctx);
    const next = (sent.get(key) ?? 0) + n;
    sent.delete(key);
    sent.set(key, next);
    const tabPrefix = `${String(tabIdOf(hctx.sender) ?? '')}|`;
    for (const k of [...sent.keys()]) if (k.startsWith(tabPrefix) && k !== key) sent.delete(k);
    while (sent.size > MAX_PAGE_VIEWS) {
      const oldest = sent.keys().next();
      if (oldest.done === true || oldest.value === key) break;
      sent.delete(oldest.value);
    }
  };

  return {
    async get(itemIds, hctx) {
      requireContent('landedCost.get', hctx);
      // R5: the cap is the message length, before dedupe. 41 copies of one id
      // are still 41 ids.
      if (itemIds.length > MAX_LANDED_COST_IDS_PER_MESSAGE) {
        throw new SgwApiError(
          'schema',
          `landedCost.get: at most ${String(MAX_LANDED_COST_IDS_PER_MESSAGE)} item ids per message (got ${String(itemIds.length)})`,
        );
      }
      const ids = [...new Set(itemIds)];

      const g = gate(await repo.get(STORAGE_KEYS.settings));
      const reply: Record<ItemId, LandedCostQuote | null> = {};
      // The kill switch answers nothing, including a quote already in the cache.
      if (!g.ok || flagOn(killSwitchOn)) {
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
        // Re-check after the cache reads, before any reservation or send.
        // A blocked read gate keeps the cached answers above and skips the rest.
        if (flagOn(killSwitchOn) || flagOn(readsBlocked)) {
          for (const id of needed) reply[id] = null;
          return reply;
        }
        if ((sent.get(pageViewKey(hctx)) ?? 0) + needed.length > MAX_QUOTE_REQUESTS_PER_PAGE_VIEW) {
          throw new SgwApiError(
            'budget',
            `landed cost: this page view used its ${String(MAX_QUOTE_REQUESTS_PER_PAGE_VIEW)} quote requests; the request is refused`,
          );
        }
        reserve(hctx, needed.length);
        for (const id of needed) {
          if (flagOn(killSwitchOn) || flagOn(readsBlocked)) {
            reply[id] = null;
            continue;
          }
          let quote: CachedQuote | null;
          try {
            quote = await api.shippingQuote(id, g.zip, QUOTE_LANE);
          } catch (e) {
            // A refusal from the scheduler (paused/budget) or a failure must not
            // take the other badges down: the item reads as "no quote". A
            // `budget` error is rethrown so the page stops, and its message is
            // replaced when it contains the ZIP (R4): the router logs thrown
            // errors.
            if (e instanceof SgwApiError && e.kind === 'budget') {
              if (errorHasZip(e, g.zip)) {
                throw new SgwApiError('budget', 'landed cost: the quote lane refused the request');
              }
              throw e;
            }
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
    killSwitchOn: () => ctx.switches.view().killSwitch,
    readsBlocked: () => interactiveReadsBlocked(ctx),
  });
  ctx.router.register('landedCost.get', (payload, hctx) => handlers.get(payload.itemIds, hctx));
}
