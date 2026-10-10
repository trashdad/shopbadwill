// T-36: `kill.set`, the popup's kill switch. The only other way in is the
// Alt+Shift+K command, which main.ts listens for and which only ever turns it
// on. The switch flips in memory at once, then `settings.killSwitch` is
// persisted and `kill.on` / `kill.off` audited (Switches.setKill). The reply
// comes after the persist; a failed persist answers an error, and "on" stays on
// in memory. Every change broadcasts `switches.changed` (main.ts subscribes).
import type { BackgroundContext } from '../context';

export function register(ctx: BackgroundContext): void {
  ctx.router.register('kill.set', async ({ on }) => {
    await ctx.switches.setKill(on, 'kill.set');
    return undefined;
  });
}
