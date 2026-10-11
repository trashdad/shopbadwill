// T-56: the `notifyDigest` step executor (I-07), the last step of a run. It
// sends the late-add alerts first (immediate, they bypass quiet hours), then
// the digest (deferred to the end of quiet hours by an alarm). It never makes an
// SGW request and never fails the run: a notification problem is audited.
import type { AuditLog } from '../../../domain/audit/types';
import type { Repo } from '../../../domain/storage/repo';
import type { JobRun, JobStep, StepOutcome } from '../../../domain/watches/schema';
import type { BackgroundContext } from '../../context';
import { deliverDigest, sendLateAdds, type NotifyDeps } from '../notify';

/** The slice of T-52's StepDeps this executor reads (structurally compatible). */
export interface NotifyStepDeps {
  repo: Repo;
  audit: Pick<AuditLog, 'append'>;
  run: Readonly<JobRun>;
  ctx: Pick<BackgroundContext, 'audit' | 'notifier' | 'permissions' | 'alarms'>;
}

const DONE: StepOutcome = { kind: 'notifyDigest', done: true };

export async function executeNotifyDigest(step: JobStep, deps: NotifyStepDeps): Promise<StepOutcome> {
  if (step.kind !== 'notifyDigest') {
    return { kind: 'error', message: `step skipped: notify executor got a '${step.kind}' step`, retryable: false };
  }
  const { ctx, run } = deps;
  const n: NotifyDeps = {
    repo: deps.repo,
    audit: ctx.audit,
    notifier: ctx.notifier,
    permissions: ctx.permissions,
    alarms: ctx.alarms,
  };
  try {
    await sendLateAdds(n, run);
    await deliverDigest(n, run);
  } catch (e) {
    await deps.audit.append({
      actor: 'daily-job',
      kind: 'notify.failed',
      ref: run.id,
      details: { error: (e instanceof Error ? e.message : String(e)).slice(0, 200) },
    });
  }
  return DONE;
}

/** R1: the shape T-52's step registry loads. */
export default { kind: 'notifyDigest' as const, run: executeNotifyDigest };
