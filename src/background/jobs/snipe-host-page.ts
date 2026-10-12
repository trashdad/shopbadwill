// T-116: the background wiring of the runner-page SnipeHost's hooks.
//
// The host's deps are frozen at { clock, log } (src/background/jobs/snipe-runner.ts
// builds them), so the two things it needs beyond them are set here, through
// setSnipeHostPageHooks (src/adapters/browser/snipe-host-page.ts):
//
// - `stillAhead`: whether the snipe's window time is still ahead of `now`.
//   The runner keeps the window from the T-5 min wake through the first
//   post-read (end + 5 s), so a window closed before that is still needed.
// - `auditClosed`: the audit entry for an early user close (R2: "audit it").
//
// Self-registered (I-01): the jobs glob loads this module; nothing else is
// edited. The hooks are module-level, so every host instance created later
// (the runner constructs its host during job registration) uses them.
import { setSnipeHostPageHooks } from '../../adapters/browser/snipe-host-page';
import { isoMs } from '../../domain/snipe/preflight';
import { STORAGE_KEYS } from '../../domain/storage/schema';
import type { BackgroundContext } from '../context';
import { POST_READ_AFTER_END_MS } from './snipe-runner';

export function register(ctx: BackgroundContext): void {
  setSnipeHostPageHooks({
    stillAhead: async (snipeId, now) => {
      const snipe = (await ctx.repo.get(STORAGE_KEYS.snipes))[snipeId];
      // Unknown snipe: the runner acquired it for an open snipe, so keep the window.
      if (snipe === undefined) return true;
      return now < isoMs(snipe.endTime) + POST_READ_AFTER_END_MS;
    },
    auditClosed: async (snipeId, closedAt, reacquired) => {
      const snipe = (await ctx.repo.get(STORAGE_KEYS.snipes))[snipeId];
      await ctx.audit.append({
        actor: 'snipe',
        kind: 'snipe.host-window-closed',
        ...(snipe === undefined ? {} : { itemId: snipe.itemId }),
        ref: snipeId,
        details: { closedAt, reacquired },
        ...(snipe === undefined ? {} : { dryRun: snipe.dryRun }),
      });
    },
  });
}
