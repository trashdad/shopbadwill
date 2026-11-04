// T-113: the relist history (`sbw:relistSeen`) and the "seen before" lookup.
// Pure. The history holds public listing data only (item id, fingerprint,
// last seen current price, last seen time): never the user's bids.
//
// - Bounded: entries older than 60 days are dropped, and at most 2,000 are
//   kept, the least recently seen evicted first.
// - "Seen before" never matches the item itself, and only matches an EARLIER
//   item id (SGW ids grow): a concurrent or newer duplicate is not a relist.
// - A `relistId` (the item this one relists) wins over the fingerprint when
//   the history knows it.
import { parseRelistSeen, type RelistSeenRecord } from '../storage/schema';
import type { Cents, EpochMs, ItemId, Listing } from '../types';
import { relistFingerprint } from './fingerprint';

export { parseRelistSeen, type RelistSeenRecord };

export const RELIST_MAX_ENTRIES = 2000;
export const RELIST_MAX_AGE_MS = 60 * 24 * 60 * 60 * 1000;

export function emptyRelistSeen(): RelistSeenRecord {
  return { version: 1, entries: {} };
}

/** One observation of a public listing. */
export interface RelistSighting {
  itemId: ItemId;
  fingerprint: string;
  price: Cents;
  seenAt: EpochMs;
}

/** The sighting of a listing (its current price when observed), or null when it has no fingerprint. */
export function sightingOf(listing: Listing): RelistSighting | null {
  const fingerprint = relistFingerprint(listing);
  if (fingerprint === null) return null;
  return { itemId: listing.itemId, fingerprint, price: listing.currentPrice, seenAt: listing.observedAt };
}

/** Upserts the sightings (a newer one wins), then prunes to 60 days and 2,000 entries. Returns a new record. */
export function recordSightings(record: RelistSeenRecord, sightings: readonly RelistSighting[], now: EpochMs): RelistSeenRecord {
  const entries: RelistSeenRecord['entries'] = { ...record.entries };
  for (const s of sightings) {
    const seenAt = Math.min(s.seenAt, now);
    const cur = entries[s.itemId];
    if (cur !== undefined && cur.seenAt > seenAt) continue;
    entries[s.itemId] = { fp: s.fingerprint, price: s.price, seenAt };
  }
  const cutoff = now - RELIST_MAX_AGE_MS;
  let kept = Object.entries(entries).filter(([, e]) => e.seenAt >= cutoff);
  if (kept.length > RELIST_MAX_ENTRIES) {
    kept = kept.sort(([, a], [, b]) => b.seenAt - a.seenAt).slice(0, RELIST_MAX_ENTRIES);
  }
  const next: RelistSeenRecord['entries'] = {};
  for (const [id, e] of kept) next[Number(id)] = e;
  return { version: 1, entries: next };
}

export interface RelistQuery {
  itemId: ItemId;
  fingerprint: string | null;
  relistId?: number | null;
}

/** An earlier listing of the same item: its id, last seen price and when. */
export interface RelistHit {
  itemId: ItemId;
  price: Cents;
  seenAt: EpochMs;
}

/** The earlier listing `query` relists, or null. Never the item itself. */
export function findPrevious(record: RelistSeenRecord, query: RelistQuery, now: EpochMs): RelistHit | null {
  const cutoff = now - RELIST_MAX_AGE_MS;
  const { relistId } = query;
  if (relistId !== undefined && relistId !== null && relistId > 0 && relistId !== query.itemId) {
    const e = record.entries[relistId];
    if (e !== undefined && e.seenAt >= cutoff) return { itemId: relistId, price: e.price, seenAt: e.seenAt };
  }
  if (query.fingerprint === null) return null;
  let best: RelistHit | null = null;
  for (const [key, e] of Object.entries(record.entries)) {
    const id = Number(key);
    if (id >= query.itemId || e.fp !== query.fingerprint || e.seenAt < cutoff) continue;
    if (best === null || e.seenAt > best.seenAt) best = { itemId: id, price: e.price, seenAt: e.seenAt };
  }
  return best;
}
