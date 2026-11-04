// T-36: `settings.get` and `settings.set`.
//
// settings.set merges whole top-level groups (the options page sends one
// group at a time), validates the result, and runs the settings.set
// interceptors (ctx.interceptors.settingsSet; T-102's live gate) inside the
// settings write lock, so the check and the write see the same settings. A
// veto refuses the write with the interceptor's message.
//
// It never changes `killSwitch`: kill.set and the shortcut own it (R3), so a
// stale whole-settings object can never resume automation. For the same
// reason it never changes `snipe.completedDryRuns` (T-90): the dry-run counter
// owns it, and live bidding is gated on it. A page that sends back its whole
// `snipe` group cannot roll the count back with a stale copy, nor raise it.
// The interceptors see the kept count in `next`. The new settings
// reach the switches (dry-run) and the scheduler (considerate mode) before the
// reply, not only when storage.onChanged arrives.
import { SettingsSchema, type Settings } from '../../domain/settings/schema';
import { STORAGE_KEYS } from '../../domain/storage/schema';
import type { BackgroundContext } from '../context';
import { nextDailySlot } from '../jobs/daily-job-runner';
import type { HandlerContext } from '../router';

export function register(ctx: BackgroundContext): void {
  ctx.router.register('settings.get', () => ctx.repo.get(STORAGE_KEYS.settings));
  ctx.router.register('settings.set', async (patch, hctx) => {
    await applySettingsPatch(ctx, patch, hctx);
    return undefined;
  });
}

export async function applySettingsPatch(ctx: BackgroundContext, patch: Partial<Settings>, hctx: HandlerContext): Promise<Settings> {
  let before: Settings | undefined;
  const next = await ctx.repo.withLock(STORAGE_KEYS.settings, async () => {
    const current = await ctx.repo.get(STORAGE_KEYS.settings);
    const groups: Partial<Settings> = { ...patch };
    delete groups.killSwitch;
    const draft = { ...current, ...groups, killSwitch: current.killSwitch };
    const merged = SettingsSchema.parse({
      ...draft,
      snipe: { ...draft.snipe, completedDryRuns: current.snipe.completedDryRuns },
    });
    await ctx.interceptors.settingsSet.check({ patch, current, next: merged, sender: hctx });
    await ctx.repo.set(STORAGE_KEYS.settings, merged);
    before = current;
    return merged;
  });
  ctx.switches.noteSettings(next);
  if (before !== undefined) await reslotWatches(ctx, before, next);
  return next;
}

/**
 * T-118 (L5): a new daily run time (or zone) takes effect at its next
 * occurrence: the same day if that time is still ahead. Each watch's pending
 * slot moves to it; an overdue slot is left for the scheduler's catch-up rule.
 */
async function reslotWatches(ctx: BackgroundContext, before: Settings, after: Settings): Promise<void> {
  if (before.dailyRun.localTime === after.dailyRun.localTime && before.locale.timeZone === after.locale.timeZone) return;
  const now = ctx.clock.now();
  const slot = nextDailySlot(after, now);
  await ctx.repo.update(STORAGE_KEYS.watches, (watches) =>
    watches.some((w) => w.nextRunAt > now && w.nextRunAt !== slot)
      ? watches.map((w) => (w.nextRunAt > now ? { ...w, nextRunAt: slot } : w))
      : watches,
  );
}
