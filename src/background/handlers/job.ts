// T-52: `job.runNow` and `job.status`.
//
// - job.runNow { watchIds? } joins the active run if there is one (R3: never
//   two runs at once; the joined run drains on lane interactive), else starts
//   a manual run of the given watches (default: every enabled watch). It
//   answers once the run is planned; the steps then run at 1 request per
//   second and the `sbw:job-progress` port streams them. Without the SGW host
//   permission, or with nothing to run, it answers an error saying why.
// - job.status answers the active run, else the latest one, else null.
import type { BackgroundContext } from '../context';
import { runnerFor } from '../jobs/daily-job-runner';

export function register(ctx: BackgroundContext): void {
  ctx.router.register('job.runNow', async ({ watchIds }) => {
    await runnerFor(ctx).runNow(watchIds);
    return undefined;
  });
  ctx.router.register('job.status', () => runnerFor(ctx).status());
}
