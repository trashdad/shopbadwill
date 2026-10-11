// T-36: `settings.get` and `settings.set`.
//
// settings.set merges whole top-level groups (the options page sends one
// group at a time), validates the result, and runs the settings.set
// interceptors (ctx.interceptors.settingsSet; T-102's live gate) inside the
// settings write lock, so the check and the write see the same settings. A
// veto refuses the write with the interceptor's message.
//
// It never changes `killSwitch`: kill.set and the shortcut own it (R3), so a
// stale whole-settings object can never resume automation. The new settings
// reach the switches (dry-run) and the scheduler (considerate mode) before the
// reply, not only when storage.onChanged arrives.
import { SettingsSchema, type Settings } from '../../domain/settings/schema';
import { STORAGE_KEYS } from '../../domain/storage/schema';
import type { BackgroundContext } from '../context';
import type { HandlerContext } from '../router';

export function register(ctx: BackgroundContext): void {
  ctx.router.register('settings.get', () => ctx.repo.get(STORAGE_KEYS.settings));
  ctx.router.register('settings.set', async (patch, hctx) => {
    await applySettingsPatch(ctx, patch, hctx);
    return undefined;
  });
}

export async function applySettingsPatch(ctx: BackgroundContext, patch: Partial<Settings>, hctx: HandlerContext): Promise<Settings> {
  const next = await ctx.repo.withLock(STORAGE_KEYS.settings, async () => {
    const current = await ctx.repo.get(STORAGE_KEYS.settings);
    const groups: Partial<Settings> = { ...patch };
    delete groups.killSwitch;
    const merged = SettingsSchema.parse({ ...current, ...groups, killSwitch: current.killSwitch });
    await ctx.interceptors.settingsSet.check({ patch, current, next: merged, sender: hctx });
    await ctx.repo.set(STORAGE_KEYS.settings, merged);
    return merged;
  });
  ctx.switches.noteSettings(next);
  return next;
}
