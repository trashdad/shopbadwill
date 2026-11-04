// T-67: the `calendarUpsert` step executor (I-07). The run asks for one item's
// event; the sync is idempotent and shared (calendar-sync.ts), so the step runs
// a sync and reports on that item. It never makes an SGW request.
//
//   disconnected / needs reconnect  -> done: the link is `pending`, inserted after a connect
//   dry run, kill switch, health    -> done: nothing is written (the sync audits a dry run)
//   rate-limited / offline          -> done: the sync retries later (cooldown / backoff are kept)
//   the item's own op failed        -> error (not retryable here: the reconciler retries it with backoff)
import type { Repo } from '../../../domain/storage/repo';
import { STORAGE_KEYS } from '../../../domain/storage/schema';
import type { JobStep, StepOutcome } from '../../../domain/watches/schema';
import type { BackgroundContext } from '../../context';
import { syncFor } from '../calendar-sync';

/** The slice of T-52's StepDeps this executor reads (structurally compatible). */
export interface CalendarStepDeps {
  repo: Repo;
  ctx: BackgroundContext;
}

const DONE: StepOutcome = { kind: 'calendarUpsert', done: true };

export async function executeCalendarUpsert(step: JobStep, deps: CalendarStepDeps): Promise<StepOutcome> {
  if (step.kind !== 'calendarUpsert') {
    return { kind: 'error', message: `step skipped: calendar executor got a '${step.kind}' step`, retryable: false };
  }
  await syncFor(deps.ctx).syncNow('job-step');
  const link = (await deps.repo.get(STORAGE_KEYS.calendar)).links[step.itemId];
  if (link?.status === 'error') {
    return { kind: 'error', message: `calendar: ${link.lastError ?? 'the event could not be written'}`, retryable: false };
  }
  return DONE;
}

/** R1: the shape T-52's step registry loads. */
export default { kind: 'calendarUpsert' as const, run: executeCalendarUpsert };
