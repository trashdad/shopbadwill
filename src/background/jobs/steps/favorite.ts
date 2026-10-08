// T-53: the `favorite` step executor (I-07). A real write to the user's SGW
// account, so every refusal path is explicit:
//   notBefore in the future            -> deferred (no call)
//   watch missing / local              -> non-retryable error (skip), state untouched
//   sgw-late without notBefore         -> checked against the item's end; deferred while closed
//   already in the favorites cache     -> done, no call, no undo
//   settings.dryRun.favorites          -> audit `favorite.add {dryRun:true}`, no call, skip
//   writesAllowed('favorites') false   -> skip with the reason, never 'failed'
//   addFavorite ok                     -> favoriteState 'favorited' + audit with undo
//   SgwApiError paused / budget        -> skip (policy), state untouched
//   any other error                    -> favoriteState 'failed'; retryable once per run
import type { AuditLog } from '../../../domain/audit/types';
import { watchPermits } from '../../../domain/favorites/reconcile';
import type { Repo } from '../../../domain/storage/repo';
import { STORAGE_KEYS } from '../../../domain/storage/schema';
import type { EpochMs, ItemId, TrackedItem } from '../../../domain/types';
import type { JobStep, StepOutcome } from '../../../domain/watches/schema';
import { SgwApiError } from '../../../ports/errors';
import type { GlobalSwitches } from '../../../ports/global-switches';
import type { SgwApi } from '../../../ports/sgw-api';

export interface FavoriteStepDeps {
  api: Pick<SgwApi, 'addFavorite'>;
  switches: GlobalSwitches;
  audit: Pick<AuditLog, 'append'>;
  repo: Repo;
  now: () => EpochMs;
  /**
   * Items whose add already failed once in this run. Pass one fresh Set per run;
   * an item's second failure is not retryable. Defaults to a Set kept for the
   * life of `deps`.
   */
  attempted?: Set<ItemId>;
}

const skip = (message: string): StepOutcome => ({ kind: 'error', message, retryable: false });
const DONE: StepOutcome = { kind: 'favorite', done: true };
const fallbackAttempts = new WeakMap<object, Set<ItemId>>();

async function setState(repo: Repo, itemId: ItemId, state: TrackedItem['favoriteState']): Promise<void> {
  await repo.update(STORAGE_KEYS.tracked, (cur) => {
    const t = cur[itemId];
    return t === undefined ? cur : { ...cur, [itemId]: { ...t, favoriteState: state, updatedAt: repo.now() } };
  });
}

export async function executeFavoriteStep(step: JobStep, deps: FavoriteStepDeps): Promise<StepOutcome> {
  if (step.kind !== 'favorite') return skip(`favorite executor got a '${step.kind}' step`);
  const { repo, audit } = deps;
  const { itemId } = step;
  const now = deps.now();
  if (step.notBefore !== undefined && step.notBefore > now) return { kind: 'deferred', until: step.notBefore };

  const [watches, tracked, settings, cache] = await Promise.all([
    repo.get(STORAGE_KEYS.watches),
    repo.get(STORAGE_KEYS.tracked),
    repo.get(STORAGE_KEYS.settings),
    repo.get(STORAGE_KEYS.favoritesCache),
  ]);
  const watch = watches.find((w) => w.id === step.watchId);
  if (watch === undefined) return skip(`watch ${step.watchId} not found`);
  if (watch.favoriteMode === 'local') return skip(`watch ${watch.id} is local-only`);
  const item = tracked[itemId];
  if (watch.favoriteMode === 'sgw-late' && step.notBefore === undefined) {
    const end = item === undefined ? Number.NaN : new Date(item.endTime).getTime();
    if (Number.isNaN(end)) return skip('sgw-late step without notBefore and no known end time');
    const p = watchPermits(watch, end, now);
    if (!p.ok) return p.opensAt === undefined ? skip(p.reason) : { kind: 'deferred', until: p.opensAt };
  }

  if (cache.items.some((f) => f.itemId === itemId)) {
    if (item !== undefined && item.favoriteState !== 'favorited') await setState(repo, itemId, 'favorited');
    return DONE; // already on the account: no call, no undo (we did not add it)
  }

  if (settings.dryRun.favorites) {
    await audit.append({ actor: 'daily-job', kind: 'favorite.add', itemId, details: { watchId: step.watchId }, dryRun: true });
    return skip('dry-run: favorite not sent');
  }
  const verdict = await deps.switches.writesAllowed('favorites');
  if (!verdict.ok) {
    const why = verdict.why ?? 'writes not allowed';
    await audit.append({ actor: 'daily-job', kind: 'favorite.skipped', itemId, details: { watchId: step.watchId, why } });
    return skip(`favorites paused: ${why}`);
  }

  try {
    await deps.api.addFavorite(itemId);
  } catch (e) {
    if (e instanceof SgwApiError && (e.kind === 'paused' || e.kind === 'budget')) {
      return skip(`favorites paused: ${e.message}`);
    }
    const message = e instanceof Error ? e.message : String(e);
    await setState(repo, itemId, 'failed');
    await audit.append({ actor: 'daily-job', kind: 'favorite.failed', itemId, details: { watchId: step.watchId, error: message } });
    let attempted = deps.attempted ?? fallbackAttempts.get(deps);
    if (attempted === undefined) {
      attempted = new Set();
      fallbackAttempts.set(deps, attempted);
    }
    const firstFailure = !attempted.has(itemId);
    attempted.add(itemId);
    return { kind: 'error', message: `addFavorite failed: ${message}`, retryable: firstFailure };
  }

  await setState(repo, itemId, 'favorited');
  await audit.append({
    actor: 'daily-job',
    kind: 'favorite.add',
    itemId,
    details: { watchId: step.watchId },
    undo: { kind: 'unfavorite', ref: `removeFavorite:${String(itemId)}` },
  });
  return DONE;
}

/** R1: the shape T-52's step registry loads. */
export default { kind: 'favorite' as const, run: executeFavoriteStep };
