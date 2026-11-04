// T-113: `relist.lookup`, the relist detector behind the "Seen before at $X"
// badge. It makes NO SGW request: it only uses listings the extension already
// has, from the API tap (`page.listings` / `page.detail`, kept in ctx.pages)
// and the 6 h `sbw:listingCache`. Those are copied into the longer-lived,
// bounded `sbw:relistSeen` history (2,000 entries, 60 days; public listing
// data only, never the user's bids).
//
// - Content senders only; at most 40 ids (the message schema).
// - `features.relistDetector` off (the default): every id answers null and
//   nothing is read or written beyond the settings.
// - An item never matches itself; see src/domain/relist/history.ts.
import { findPrevious, recordSightings, sightingOf, type RelistSighting } from '../../domain/relist/history';
import type { Repo } from '../../domain/storage/repo';
import { STORAGE_KEYS } from '../../domain/storage/schema';
import type { ItemId, Listing } from '../../domain/types';
import type { RelistLookupHit } from '../../messaging/protocol';
import type { Clock } from '../../ports/clock';
import { requireContent, type BackgroundContext, type PageStore } from '../context';
import type { HandlerContext } from '../router';

export interface RelistDeps {
  repo: Repo;
  clock: Clock;
  pages: Pick<PageStore, 'findItem'>;
}

export interface RelistHandlers {
  lookup(itemIds: readonly ItemId[], hctx: HandlerContext): Promise<Record<ItemId, RelistLookupHit | null>>;
}

export function createRelistHandlers(deps: RelistDeps): RelistHandlers {
  const { repo, clock, pages } = deps;
  return {
    async lookup(itemIds, hctx) {
      requireContent('relist.lookup', hctx);
      const ids = [...new Set(itemIds)];
      const reply: Record<ItemId, RelistLookupHit | null> = {};
      for (const id of ids) reply[id] = null;

      const settings = await repo.get(STORAGE_KEYS.settings);
      if (!settings.features.relistDetector || ids.length === 0) return reply;

      const now = clock.now();
      const cache = await repo.get(STORAGE_KEYS.listingCache);
      const sightings: RelistSighting[] = [];
      for (const entry of Object.values(cache)) {
        const s = sightingOf(entry.listing);
        if (s !== null) sightings.push(s);
      }
      const queried: Listing[] = [];
      for (const id of ids) {
        const listing = pages.findItem(id) ?? cache[id]?.listing;
        if (listing === undefined) continue;
        queried.push(listing);
        const s = sightingOf(listing);
        if (s !== null) sightings.push(s);
      }
      if (queried.length === 0) return reply;

      const history = await repo.update(STORAGE_KEYS.relistSeen, (current) => recordSightings(current, sightings, now));
      for (const listing of queried) {
        const fingerprint = sightingOf(listing)?.fingerprint ?? null;
        reply[listing.itemId] = findPrevious(history, { itemId: listing.itemId, fingerprint, relistId: listing.relistId }, now);
      }
      return reply;
    },
  };
}

export function register(ctx: BackgroundContext): void {
  const handlers = createRelistHandlers({ repo: ctx.repo, clock: ctx.clock, pages: ctx.pages });
  ctx.router.register('relist.lookup', (payload, hctx) => handlers.lookup(payload.itemIds, hctx));
}
