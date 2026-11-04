// T-84: the snipe messages (PLAN §3.12): `snipe.prepare`, `snipe.arm`,
// `snipe.disarm` and `snipe.list`, all UI-only (the router refuses content
// scripts). They go through the runner (jobs/snipe-runner.ts), which owns every
// state change: `snipe.arm` resets the runner-owned fields the payload carries
// (attempt, fireAt, wakeAlarm, measured, outcome) and arms through the reducer;
// `snipe.disarm` is a `disarm { by: 'user' }` the reducer may refuse (after
// `sent`, a bid may already be out).
import { getSnipeRunner, KILL_ARM_REFUSAL, type SnipeRunner } from '../jobs/snipe-runner';
import type { BackgroundContext } from '../context';

/**
 * T-118 (F4): the `notifications` permission is optional. Without it every snipe
 * alert (at risk, soon, unconfirmed) is dropped, so an arm without it is
 * audited. Never blocks the arm: it runs after, and a failing check or append
 * is swallowed. A check that throws counts as "not allowed".
 */
async function auditIfNotifyOff(ctx: BackgroundContext, id: string, itemId: number): Promise<void> {
  try {
    let allowed = false;
    try {
      allowed = await ctx.permissions.contains({ permissions: ['notifications'] });
    } catch {
      allowed = false;
    }
    if (allowed) return;
    await ctx.audit.append({
      actor: 'user',
      kind: 'snipe.notify-off',
      itemId,
      ref: id,
      details: { permission: 'notifications', note: 'Notifications are off: no alert will be shown if this snipe is at risk.' },
    });
  } catch {
    // The warning is best effort; the snipe is already armed.
  }
}

/** T-36 self-registration (I-01). The runner registers with the jobs, after the handlers; it is looked up per message. */
export function register(ctx: BackgroundContext): void {
  const runner = (): SnipeRunner => {
    const r = getSnipeRunner(ctx);
    if (r === undefined) throw new Error('The snipe runner is not running; reload the extension.');
    return r;
  };
  ctx.router.register('snipe.prepare', ({ itemId }) => runner().prepare(itemId));
  ctx.router.register('snipe.arm', async ({ snipe, typedConfirmation }) => {
    // T-84c: refuse cleanly while the kill switch is on. The arm does not
    // happen and then get stopped by the kill disarm-all; nothing is stored.
    // The runner checks again under its lock (a kill that lands while the item is read).
    if (ctx.switches.view().killSwitch) throw new Error(KILL_ARM_REFUSAL);
    const armed = await runner().arm(
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
    );
    await auditIfNotifyOff(ctx, armed.id, armed.itemId);
    return armed;
  });
  ctx.router.register('snipe.disarm', async ({ id }) => {
    await runner().disarm(id);
    return undefined;
  });
  ctx.router.register('snipe.list', () => runner().list());
}
