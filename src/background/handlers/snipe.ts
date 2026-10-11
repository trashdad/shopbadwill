// T-84: the snipe messages (PLAN §3.12): `snipe.prepare`, `snipe.arm`,
// `snipe.disarm` and `snipe.list`, all UI-only (the router refuses content
// scripts). They go through the runner (jobs/snipe-runner.ts), which owns every
// state change: `snipe.arm` resets the runner-owned fields the payload carries
// (attempt, fireAt, wakeAlarm, measured, outcome) and arms through the reducer;
// `snipe.disarm` is a `disarm { by: 'user' }` the reducer may refuse (after
// `sent`, a bid may already be out).
import { getSnipeRunner, type SnipeRunner } from '../jobs/snipe-runner';
import type { BackgroundContext } from '../context';

/** T-36 self-registration (I-01). The runner registers with the jobs, after the handlers; it is looked up per message. */
export function register(ctx: BackgroundContext): void {
  const runner = (): SnipeRunner => {
    const r = getSnipeRunner(ctx);
    if (r === undefined) throw new Error('The snipe runner is not running; reload the extension.');
    return r;
  };
  ctx.router.register('snipe.prepare', ({ itemId }) => runner().prepare(itemId));
  ctx.router.register('snipe.arm', ({ snipe, typedConfirmation }) =>
    runner().arm(
      {
        id: snipe.id,
        itemId: snipe.itemId,
        title: snipe.title,
        maxBid: snipe.maxBid,
        ...(snipe.allInMax === undefined ? {} : { allInMax: snipe.allInMax }),
        ...(snipe.estShipping === undefined ? {} : { estShipping: snipe.estShipping }),
        ...(snipe.estHandling === undefined ? {} : { estHandling: snipe.estHandling }),
        leadMs: snipe.leadMs,
        fallback: snipe.fallback,
        dryRun: snipe.dryRun,
        ...(snipe.groupId === undefined ? {} : { groupId: snipe.groupId }),
      },
      typedConfirmation,
    ),
  );
  ctx.router.register('snipe.disarm', async ({ id }) => {
    await runner().disarm(id);
    return undefined;
  });
  ctx.router.register('snipe.list', () => runner().list());
}
