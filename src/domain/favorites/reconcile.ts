// T-53: PLAN §3.7 FavoritesReconciler.desired(). Pure.
//
// 'add' only when ALL hold (idempotent; removal is never automatic):
//   - favoriteState is 'none' or 'failed' ('queued' and 'favorited' are 'none');
//   - the item is not in the favorites list cache;
//   - the auction has not ended;
//   - some enabled watch that tracks the item permits a favorite now:
//     'sgw' always, 'sgw-late' from `endTime - favoriteWithinHours`, 'local' never.
import { DEFAULT_FAVORITE_WITHIN_HOURS } from '../settings/defaults';
import type { EpochMs, Favorite, ItemId, TrackedItem } from '../types';
import type { Watch } from '../watches/schema';

const HOUR_MS = 3_600_000;

export interface DesiredFavorite {
  itemId: ItemId;
  action: 'add' | 'none';
  reason: string;
}

/** Whether watch `w` permits favoriting an item ending at `endMs`, as of `now`; `opensAt` is set for a closed sgw-late window. */
export function watchPermits(w: Watch, endMs: number, now: EpochMs): { ok: boolean; reason: string; opensAt?: number } {
  if (!w.enabled) return { ok: false, reason: `watch ${w.id} is disabled` };
  if (w.favoriteMode === 'local') return { ok: false, reason: `watch ${w.id} is local-only` };
  if (w.favoriteMode === 'sgw') return { ok: true, reason: `watch ${w.id}: sgw` };
  const opensAt = endMs - (w.favoriteWithinHours ?? DEFAULT_FAVORITE_WITHIN_HOURS) * HOUR_MS;
  return now >= opensAt
    ? { ok: true, reason: `watch ${w.id}: sgw-late window open` }
    : { ok: false, reason: `watch ${w.id}: sgw-late window opens at ${String(opensAt)}`, opensAt };
}

export function desired(
  tracked: readonly TrackedItem[],
  watches: readonly Watch[],
  now: EpochMs,
  /** The favorites list cache (`sbw:favoritesCache`.items). */
  cached: ReadonlyArray<Pick<Favorite, 'itemId'>> = [],
): DesiredFavorite[] {
  const inList = new Set(cached.map((f) => f.itemId));
  const byId = new Map(watches.map((w) => [w.id, w]));
  return tracked.map((t): DesiredFavorite => {
    const none = (reason: string): DesiredFavorite => ({ itemId: t.itemId, action: 'none', reason });
    if (t.favoriteState === 'favorited' || t.favoriteState === 'queued') return none(`state is ${t.favoriteState}`);
    if (inList.has(t.itemId)) return none('already in the favorites list');
    const endMs = new Date(t.endTime).getTime();
    if (Number.isNaN(endMs)) return none('end time unknown');
    if (endMs <= now) return none('auction ended');
    const reasons: string[] = [];
    for (const r of t.reasons) {
      if (r.kind !== 'watch' || r.id === undefined) continue;
      const w = byId.get(r.id);
      if (w === undefined) {
        reasons.push(`watch ${r.id} not found`);
        continue;
      }
      const p = watchPermits(w, endMs, now);
      if (p.ok) return { itemId: t.itemId, action: 'add', reason: p.reason };
      reasons.push(p.reason);
    }
    return none(reasons.length > 0 ? reasons.join('; ') : 'no watch asks for a favorite');
  });
}
