// T-52: the `favoritesList` step executor (I-07). The run's one read of the
// user's SGW favorites (auth; without a session it fails with `auth` before
// anything is sent). The list is cached in `sbw:favoritesCache` (T-53's favorite
// executor and desired() read it), and listed tracked items are marked
// favorited. Like T-53's favorites.sync it never downgrades: 'favorited' means
// handled, and the user owns it from then on.
import { STORAGE_KEYS } from '../../../domain/storage/schema';
import type { JobStep, StepOutcome } from '../../../domain/watches/schema';
import type { StepDeps } from './index';

export async function executeFavoritesListStep(step: JobStep, deps: StepDeps): Promise<StepOutcome> {
  if (step.kind !== 'favoritesList') {
    return { kind: 'error', message: `favoritesList executor got a '${step.kind}' step`, retryable: false };
  }
  const { repo } = deps;
  const items = await deps.api.favorites('all', deps.lane);
  const now = repo.now();
  await repo.set(STORAGE_KEYS.favoritesCache, { fetchedAt: now, items });
  const listed = new Set(items.map((f) => f.itemId));
  await repo.update(STORAGE_KEYS.tracked, (cur) => {
    let next = cur;
    for (const t of Object.values(cur)) {
      if (!listed.has(t.itemId) || t.favoriteState === 'favorited') continue;
      if (next === cur) next = { ...cur };
      next[t.itemId] = { ...t, favoriteState: 'favorited', updatedAt: now };
    }
    return next;
  });
  return { kind: 'favoritesList', items };
}

export default { kind: 'favoritesList' as const, run: executeFavoritesListStep };
