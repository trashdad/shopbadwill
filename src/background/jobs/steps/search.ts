// T-52: the `search` step executor (I-07). One ItemListing page for one watch,
// through SgwApi.search on the run's lane. The adapter builds the body and
// rejects invalid params (an `extra` key that is a named param, a bad page)
// with SgwApiError('schema', 'search: invalid-query: ...') before any HTTP
// call, and hands the query's pickup filter to normalizeSearch (T-26). The
// page comes from the step: the watch's saved `page` is ignored (T-51 R2).
import { STORAGE_KEYS } from '../../../domain/storage/schema';
import type { JobStep, StepOutcome } from '../../../domain/watches/schema';
import { STEP_SKIP_PREFIX, type StepDeps } from './index';

export async function executeSearchStep(step: JobStep, deps: StepDeps): Promise<StepOutcome> {
  if (step.kind !== 'search') return { kind: 'error', message: `search executor got a '${step.kind}' step`, retryable: false };
  const watch = (await deps.repo.get(STORAGE_KEYS.watches)).find((w) => w.id === step.watchId);
  if (watch === undefined) return { kind: 'error', message: `watch ${step.watchId} not found`, retryable: false };
  // Disabled mid-run: no request for a watch the user switched off.
  if (!watch.enabled) return { kind: 'error', message: `${STEP_SKIP_PREFIX}watch ${watch.id} is disabled`, retryable: false };
  const { items, total } = await deps.api.search({ ...watch.query, page: step.page }, deps.lane);
  return { kind: 'search', items, total };
}

export default { kind: 'search' as const, run: executeSearchStep };
