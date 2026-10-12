// T-52: `tracked.list` (soonest-ending first) and `tracked.remove`.
// Removing an item does not unfavorite it on SGW (removal is never automatic,
// §3.7); an item a watch already matched stays in that watch's seen ring, so
// the daily job does not add it back.
// T-117: a removal is audited (actor 'user', kind 'tracked.remove'), once, only
// when the item was tracked. No undo: no audit undo kind re-tracks an item.
import { STORAGE_KEYS } from '../../domain/storage/schema';
import type { TrackedItem } from '../../domain/types';
import type { BackgroundContext } from '../context';

export function register(ctx: BackgroundContext): void {
  const { router, repo } = ctx;

  router.register('tracked.list', async () =>
    Object.values(await repo.get(STORAGE_KEYS.tracked)).sort(
      (a, b) => new Date(a.endTime).getTime() - new Date(b.endTime).getTime() || a.itemId - b.itemId,
    ),
  );

  router.register('tracked.remove', async ({ itemId }) => {
    let removed: TrackedItem | undefined;
    await repo.update(STORAGE_KEYS.tracked, (cur) => {
      removed = Object.hasOwn(cur, itemId) ? cur[itemId] : undefined;
      return removed === undefined ? cur : Object.fromEntries(Object.entries(cur).filter(([id]) => Number(id) !== itemId));
    });
    if (removed !== undefined) {
      await ctx.audit.append({ actor: 'user', kind: 'tracked.remove', itemId, details: { calendar: removed.calendar } });
    }
    return undefined;
  });
}
