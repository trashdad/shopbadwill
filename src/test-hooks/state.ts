// `sbw:test:state` (PLAN §7.5, S-6): dumps what the background has persisted,
// so an E2E test can check from outside that the background ran (for example
// that `reconcile()` re-created the `sbw:tick` alarm). Test builds only; see
// ./index.ts for how hooks are loaded and called.
import type { TestHookAlarm, TestHookContext } from './index';

export const STATE_HOOK = 'sbw:test:state';

export interface TestState {
  /** Epoch ms at which this background instance installed its hooks (resets on every event-page wake). */
  installedAt: number;
  /** Every installed hook, by module name. */
  hooks: readonly string[];
  storage: { local: Record<string, unknown>; session: Record<string, unknown> };
  alarms: TestHookAlarm[];
}

export function install(ctx: TestHookContext): void {
  const installedAt = Date.now();
  ctx.serve(STATE_HOOK, async (): Promise<TestState> => {
    const { storage, alarms } = ctx.browser;
    const [local, session, allAlarms] = await Promise.all([
      storage.local.get(null),
      storage.session.get(null),
      alarms.getAll(),
    ]);
    return { installedAt, hooks: ctx.hooks, storage: { local, session }, alarms: allAlarms };
  });
}
