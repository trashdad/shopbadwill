// T-52: the `detail` step executor (I-07). One anonymous ItemDetail read on the
// run's lane (T-26 caches open items for 60 s on non-snipe lanes). T-51 plans
// it for a candidate whose rules need data the search row lacks, or whose
// watch favorites or feeds the calendar; the strict pass then runs on it.
import type { JobStep, StepOutcome } from '../../../domain/watches/schema';
import type { StepDeps } from './index';

export async function executeDetailStep(step: JobStep, deps: StepDeps): Promise<StepOutcome> {
  if (step.kind !== 'detail') return { kind: 'error', message: `detail executor got a '${step.kind}' step`, retryable: false };
  const detail = await deps.api.itemDetail(step.itemId, deps.lane);
  return { kind: 'detail', detail };
}

export default { kind: 'detail' as const, run: executeDetailStep };
