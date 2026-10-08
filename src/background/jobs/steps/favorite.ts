// T-53: the `favorite` step executor (I-07). A real write to the user's SGW
// account, so every refusal path is explicit. In order:
//   notBefore in the future            -> deferred (no call)
//   watch missing / disabled / local   -> policy skip, state untouched
//   item already 'favorited'           -> done, no call (the user owns it now)
//   item ended                         -> policy skip
//   sgw-late without notBefore         -> window checked against the item's end; deferred while closed
//   already in the favorites cache     -> done, no call, no undo
//   settings.killSwitch                -> audit `favorite.skipped`, policy skip (never a dry-run entry)
//   settings.dryRun.favorites          -> audit `favorite.add {dryRun:true}`, no call, policy skip
//   writesAllowed('favorites') false   -> audit `favorite.skipped`, policy skip with the reason
//   addFavorite ok                     -> 'favorited' + audit with undo
//   SgwApiError paused / budget        -> policy skip, state untouched
//   any other error                    -> 'failed' + audit `favorite.failed`, retryable:false.
//     "Retried once per run" is desired('failed') === 'add' plus T-52 queueing at most
//     one favorite step per item per run.
// Policy skips are `error` outcomes (retryable:false) whose message starts with
// FAVORITE_SKIP_PREFIX; callers tell them from real failures by that prefix.
import type { AuditLog } from '../../../domain/audit/types';
import { watchPermits } from '../../../domain/favorites/reconcile';
import type { Repo } from '../../../domain/storage/repo';
import { STORAGE_KEYS } from '../../../domain/storage/schema';
import type { ItemId, TrackedItem } from '../../../domain/types';
import type { JobStep, StepOutcome } from '../../../domain/watches/schema';
import { SgwApiError } from '../../../ports/errors';
import type { GlobalSwitches } from '../../../ports/global-switches';
import type { SgwApi } from '../../../ports/sgw-api';

/** Starts the message of every policy-skip outcome (dry-run, paused, kill, local, disabled, ended). */
export const FAVORITE_SKIP_PREFIX = 'favorite skipped: ';

/** The audit `undo.ref` for an extension-made favorite; T-58's undo parses it back. */
export const unfavoriteRef = (itemId: ItemId): string => `removeFavorite:${String(itemId)}`;
export function parseUnfavoriteRef(ref: string): ItemId | undefined {
  const m = /^removeFavorite:(\d+)$/.exec(ref);
  const id = m?.[1] === undefined ? 0 : Number(m[1]);
  return Number.isSafeInteger(id) && id > 0 ? id : undefined;
}

export interface FavoriteStepDeps {
  api: Pick<SgwApi, 'addFavorite'>;
  switches: GlobalSwitches;
  audit: Pick<AuditLog, 'append'>;
  /** Also the clock: `repo.now()`. */
  repo: Repo;
}

const skip = (why: string): StepOutcome => ({ kind: 'error', message: FAVORITE_SKIP_PREFIX + why, retryable: false });
const DONE: StepOutcome = { kind: 'favorite', done: true };

async function setState(repo: Repo, itemId: ItemId, state: TrackedItem['favoriteState']): Promise<void> {
  await repo.update(STORAGE_KEYS.tracked, (cur) => {
    const t = cur[itemId];
    return t === undefined ? cur : { ...cur, [itemId]: { ...t, favoriteState: state, updatedAt: repo.now() } };
  });
}

export async function executeFavoriteStep(step: JobStep, deps: FavoriteStepDeps): Promise<StepOutcome> {
  if (step.kind !== 'favorite') return skip(`executor got a '${step.kind}' step`);
  const { repo, audit } = deps;
  const { itemId } = step;
  const now = repo.now();
  if (step.notBefore !== undefined && step.notBefore > now) return { kind: 'deferred', until: step.notBefore };

  const [watches, tracked, settings, cache] = await Promise.all([
    repo.get(STORAGE_KEYS.watches),
    repo.get(STORAGE_KEYS.tracked),
    repo.get(STORAGE_KEYS.settings),
    repo.get(STORAGE_KEYS.favoritesCache),
  ]);
  const watch = watches.find((w) => w.id === step.watchId);
  if (watch === undefined) return skip(`watch ${step.watchId} not found`);
  if (!watch.enabled) return skip(`watch ${watch.id} is disabled`);
  if (watch.favoriteMode === 'local') return skip(`watch ${watch.id} is local-only`);
  const item = tracked[itemId];
  if (item?.favoriteState === 'favorited') return DONE;
  const end = item === undefined ? Number.NaN : new Date(item.endTime).getTime();
  if (!Number.isNaN(end) && end <= now) return skip('auction ended');
  if (watch.favoriteMode === 'sgw-late' && step.notBefore === undefined) {
    if (Number.isNaN(end)) return skip('sgw-late step without notBefore and no known end time');
    const p = watchPermits(watch, end, now);
    if (!p.ok) return { kind: 'deferred', until: p.opensAt ?? end };
  }

  if (cache.items.some((f) => f.itemId === itemId)) {
    if (item !== undefined) await setState(repo, itemId, 'favorited');
    return DONE; // already on the account: no call, no undo (we did not add it)
  }

  if (settings.killSwitch) {
    await audit.append({ actor: 'daily-job', kind: 'favorite.skipped', itemId, details: { watchId: step.watchId, why: 'kill switch' } });
    return skip('kill switch is on');
  }
  if (settings.dryRun.favorites) {
    await audit.append({ actor: 'daily-job', kind: 'favorite.add', itemId, details: { watchId: step.watchId }, dryRun: true });
    return skip('dry-run');
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
    return { kind: 'error', message: `addFavorite failed: ${message}`, retryable: false };
  }

  await setState(repo, itemId, 'favorited');
  await audit.append({
    actor: 'daily-job',
    kind: 'favorite.add',
    itemId,
    details: { watchId: step.watchId },
    undo: { kind: 'unfavorite', ref: unfavoriteRef(itemId) },
  });
  return DONE;
}

/** R1: the shape T-52's step registry loads. */
export default { kind: 'favorite' as const, run: executeFavoriteStep };
