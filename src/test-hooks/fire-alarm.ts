// `sbw:test:fireAlarm` (T-59, PLAN §7.5): fires one tracked test alarm by
// name, whatever its scheduledTime, so the E2E can trigger `sbw:tick`
// directly after moving the fake clock (advance.ts fires only alarms that
// became due; the tick alarm was scheduled in real terms before the clock was
// anchored, so a direct fire is the deterministic trigger). The reply is the
// fired alarm's info `{ name, scheduledTime, periodInMinutes? }`. Test builds
// only; see ./index.ts for how hooks are loaded and called.
import { z } from 'zod';

import { fireTestAlarm } from '../adapters/browser/alarms';
import type { TestHookContext } from './index';

export const FIRE_ALARM_HOOK = 'sbw:test:fireAlarm';

const FireAlarmSchema = z.strictObject({ name: z.string().min(1) });

export function install(ctx: TestHookContext): void {
  ctx.serve(FIRE_ALARM_HOOK, (payload) => {
    const parsed = FireAlarmSchema.safeParse(payload);
    if (!parsed.success) {
      throw new Error(`expected { name: string }; got ${JSON.stringify(payload)}`);
    }
    return fireTestAlarm(parsed.data.name);
  });
}
