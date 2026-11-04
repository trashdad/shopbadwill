// T-52: `tracked.list` (soonest-ending first) and `tracked.remove`.
// Removing an item does not unfavorite it on SGW (removal is never automatic,
// §3.7); an item a watch already matched stays in that watch's seen ring, so
// the daily job does not add it back.
// T-117: a removal is audited (actor 'user', kind 'tracked.remove'), once, only
// when the item was tracked. No undo: no audit undo kind re-tracks an item.
// T-124: `tracked.add` (content only: the item page panel's Track) builds the
// item from the detail the sending tab itself reported (`page.detail`), with
// reason 'manual', and is audited (kind 'tracked.add') when it changed
// anything. No SGW request: without that tab's detail it refuses. The panel's
// Stop tracking sends the same `tracked.remove` (content may now send it).
import { STORAGE_KEYS } from '../../domain/storage/schema';
import type { TrackedItem } from '../../domain/types';
import { requireContent, tabIdOf, type BackgroundContext } from '../context';
import { trackManually } from './quick';

/** Why tracked.add refused (the content script shows its own copy; this reaches the log and extension pages). */
export const TRACK_ADD_REFUSAL = 'This page has not reported the item yet. Reload the page and try again.';

export function register(ctx: BackgroundContext): void {
  const { router, repo } = ctx;

  router.register('tracked.list', async () =>
    Object.values(await repo.get(STORAGE_KEYS.tracked)).sort(
      (a, b) => new Date(a.endTime).getTime() - new Date(b.endTime).getTime() || a.itemId - b.itemId,
    ),
  );

  router.register('tracked.add', async ({ itemId }, hctx) => {
    requireContent('tracked.add', hctx);
    const detail = ctx.pages.detailFor(tabIdOf(hctx.sender), itemId);
    if (await trackManually(ctx, itemId, detail, TRACK_ADD_REFUSAL)) {
      await ctx.audit.append({ actor: 'user', kind: 'tracked.add', itemId, details: { source: 'item-page' } });
    }
    return undefined;
  });

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
