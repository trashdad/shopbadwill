// T-53: `favorites.sync`, the one favorites list read (lane 'interactive').
// Caches the list and marks listed tracked items favorited. It never downgrades:
// 'favorited' means "handled, and the user owns it now"; the cache is the truth
// for "on SGW right now", so a favorite the user removed stays handled.
// Registered by T-36's register(ctx), not here.
import type { Repo } from '../../domain/storage/repo';
import { STORAGE_KEYS } from '../../domain/storage/schema';
import type { SgwApi } from '../../ports/sgw-api';
import type { Handler } from '../router';

export interface FavoritesHandlerDeps {
  api: Pick<SgwApi, 'favorites'>;
  repo: Repo;
}

export function createFavoritesHandlers(deps: FavoritesHandlerDeps): { 'favorites.sync': Handler<'favorites.sync'> } {
  return {
    'favorites.sync': async () => {
      const items = await deps.api.favorites('all', 'interactive');
      const now = deps.repo.now();
      await deps.repo.set(STORAGE_KEYS.favoritesCache, { fetchedAt: now, items });
      const listed = new Set(items.map((f) => f.itemId));
      await deps.repo.update(STORAGE_KEYS.tracked, (cur) => {
        const next = { ...cur };
        for (const t of Object.values(cur)) {
          if (listed.has(t.itemId) && t.favoriteState !== 'favorited') {
            next[t.itemId] = { ...t, favoriteState: 'favorited', updatedAt: now };
          }
        }
        return next;
      });
      return undefined;
    },
  };
}
