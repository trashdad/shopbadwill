// T-115: the combined-shipping hint. badge-registry.ts loads it by glob;
// sgw-overlay.ts mounts it per card.
//
// - Only when `features.comps` is on (default off) and the card has listing
//   data. Counts the OTHER items from the card's seller that the user tracks
//   (open `sbw:tracked` entries) or has armed (`sbw:snipes` in an active
//   state). No content-sendable message lists them, so the badge reads them
//   from storage.local (read only, like sgw-overlay.ts reads settings): data
//   the extension already holds. No message and no SGW request.
// - Cards rendered together share one in-flight storage read per key.
// - Text only (Preact text nodes; never innerHTML).
import type { VNode } from 'preact';
import { useEffect, useState } from 'preact/hooks';

import { createStorageAreas } from '../../../adapters/browser/storage';
import { STORAGE_KEYS } from '../../../domain/storage/schema';
import type { ItemId } from '../../../domain/types';
import type { CardBadge, CardBadgeProps } from '../badge-registry';

const shared = new Map<string, Promise<unknown>>();

/**
 * One storage.local read per key while it is in flight, shared by every card
 * that asks meanwhile. Resolves undefined on a read error (nothing renders).
 */
export function readLocalShared(key: string): Promise<unknown> {
  const existing = shared.get(key);
  if (existing !== undefined) return existing;
  const p = createStorageAreas()
    .local.get<unknown>(key)
    .catch(() => undefined)
    .finally(() => {
      if (shared.get(key) === p) shared.delete(key);
    });
  shared.set(key, p);
  return p;
}

/** Snipe states that are still going to bid. */
const ACTIVE_SNIPE_STATES = new Set(['armed', 'fallback-applied', 'waking', 'verified', 'firing']);

function records(value: unknown): Record<string, unknown>[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return [];
  return Object.values(value).filter((v): v is Record<string, unknown> => typeof v === 'object' && v !== null);
}

function endsAfter(endTime: unknown, now: number): boolean {
  if (typeof endTime !== 'string') return true;
  const ms = new Date(endTime).getTime();
  return Number.isNaN(ms) || ms > now;
}

/**
 * Distinct other items from `sellerId` that are tracked (no outcome yet, not
 * ended) or have an active snipe. Malformed records are skipped.
 */
export function combinedCount(tracked: unknown, snipes: unknown, sellerId: number, itemId: ItemId, now: number): number {
  const ids = new Set<number>();
  for (const t of records(tracked)) {
    if (t['sellerId'] !== sellerId || typeof t['itemId'] !== 'number') continue;
    if (t['outcome'] !== undefined || !endsAfter(t['endTime'], now)) continue;
    ids.add(t['itemId']);
  }
  for (const s of records(snipes)) {
    if (s['sellerId'] !== sellerId || typeof s['itemId'] !== 'number') continue;
    if (typeof s['state'] !== 'string' || !ACTIVE_SNIPE_STATES.has(s['state'])) continue;
    ids.add(s['itemId']);
  }
  ids.delete(itemId);
  return ids.size;
}

export function combinedText(n: number): string | null {
  if (n <= 0) return null;
  return `Same seller as ${String(n)} item${n === 1 ? '' : 's'} you're tracking: ask about combined shipping`;
}

function Combined(p: CardBadgeProps): VNode | null {
  const enabled = p.settings.features.comps;
  const sellerId = p.listing?.sellerId ?? null;
  const [count, setCount] = useState(0);

  useEffect(() => {
    setCount(0);
    if (!enabled || sellerId === null) return undefined;
    let disposed = false;
    void Promise.all([readLocalShared(STORAGE_KEYS.tracked), readLocalShared(STORAGE_KEYS.snipes)]).then(
      ([tracked, snipes]) => {
        if (!disposed) setCount(combinedCount(tracked, snipes, sellerId, p.itemId, p.now));
      },
    );
    return () => {
      disposed = true;
    };
  }, [enabled, sellerId, p.itemId, p.now]);

  if (!enabled || sellerId === null) return null;
  const text = combinedText(count);
  return text === null ? null : (
    <span class="chip" title="Items from one seller can often ship together; ask the seller before you pay">
      {text}
    </span>
  );
}

export const badge: CardBadge = { id: 'combined', order: 50, Component: Combined };
