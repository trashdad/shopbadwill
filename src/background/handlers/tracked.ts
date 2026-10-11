// T-52: `tracked.list` (soonest-ending first) and `tracked.remove`.
// Removing an item does not unfavorite it on SGW (removal is never automatic,
// §3.7); an item a watch already matched stays in that watch's seen ring, so
// the daily job does not add it back.
import { STORAGE_KEYS } from '../../domain/storage/schema';
import type { BackgroundContext } from '../context';

export function register(ctx: BackgroundContext): void {
  const { router, repo } = ctx;

  router.register('tracked.list', async () =>
    Object.values(await repo.get(STORAGE_KEYS.tracked)).sort(
      (a, b) => new Date(a.endTime).getTime() - new Date(b.endTime).getTime() || a.itemId - b.itemId,
    ),
  );

  router.register('tracked.remove', async ({ itemId }) => {
    await repo.update(STORAGE_KEYS.tracked, (cur) =>
      Object.hasOwn(cur, itemId) ? Object.fromEntries(Object.entries(cur).filter(([id]) => Number(id) !== itemId)) : cur,
    );
    return undefined;
  });
}
