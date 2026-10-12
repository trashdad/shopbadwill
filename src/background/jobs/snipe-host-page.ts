// T-116: the background wiring of the runner-page SnipeHost's hooks.
//
// The host's deps are frozen at { clock, log } (src/background/jobs/snipe-runner.ts
// builds them), so what it needs beyond them is set here, through
// setSnipeHostPageHooks (src/adapters/browser/snipe-host-page.ts):
//
// - `stillAhead`: whether the snipe's window time is still ahead of `now`.
//   The runner keeps the window from the T-5 min wake through the first
//   post-read (end + 5 s), so a window closed before that is still needed.
// - `needsWindow`: whether a runner page left by a worker that died
//   mid-window may still be adopted: its snipe exists, is not finished, and
//   its window time is ahead. Otherwise the page is an orphan.
// - `auditClosed`: the audit entry for an early user close (R2: "audit it").
//
// On a Firefox build (the runner-page verdict) the startup also closes the
// orphan pages (reapRunnerPages); the runner adopts the others when it
// re-acquires their snipe. A Chrome build never looks for them (R4).
//
// Self-registered (I-01): the jobs glob loads this module; nothing else is
// edited. The hooks are module-level, so every host instance created later
// (the runner constructs its host during job registration) uses them.
import { hostVerdict } from '../../adapters/browser/snipe-host';
import { reapRunnerPages, setSnipeHostPageHooks } from '../../adapters/browser/snipe-host-page';
import { isoMs } from '../../domain/snipe/preflight';
import type { Snipe } from '../../domain/snipe/types';
import { STORAGE_KEYS } from '../../domain/storage/schema';
import type { BackgroundContext } from '../context';
import { POST_READ_AFTER_END_MS } from './snipe-runner';

/** A finished snipe never holds a window again (the runner's terminal states). */
const FINISHED: ReadonlySet<Snipe['state']> = new Set(['resolved', 'killed']);

function log(message: string, error?: unknown): void {
  console.warn(`[ShopBadwill] ${message}`, error);
}

export function register(ctx: BackgroundContext): void {
  const snipeOf = async (snipeId: string): Promise<Snipe | undefined> =>
    (await ctx.repo.get(STORAGE_KEYS.snipes))[snipeId];

  setSnipeHostPageHooks({
    stillAhead: async (snipeId, now) => {
      const snipe = await snipeOf(snipeId);
      // Unknown snipe: the runner acquired it for an open snipe, so keep the window.
      if (snipe === undefined) return true;
      return now < isoMs(snipe.endTime) + POST_READ_AFTER_END_MS;
    },
    needsWindow: async (snipeId, now) => {
      const snipe = await snipeOf(snipeId);
      if (snipe === undefined || FINISHED.has(snipe.state)) return false;
      return now < isoMs(snipe.endTime) + POST_READ_AFTER_END_MS;
    },
    auditClosed: async (snipeId, closedAt, reacquired) => {
      const snipe = await snipeOf(snipeId);
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

  // A worker that died mid-window left its runner pages open: close those
  // whose snipe no longer needs one (the runner adopts the rest).
  if (hostVerdict() === 'runner-page') {
    void reapRunnerPages({ now: ctx.clock.now(), log }).catch((e: unknown) => {
      log('snipe host: the left-over runner pages could not be reaped', e);
    });
  }
}
