// T-36: `health.get`, the health panel's and the popup's one read.
//   sgw:          the last HealthReport (T-30), or a failing one while storage
//                 needs repair (meta-corrupt / migration failure);
//   session:      the stored session's expiry (kept even when expired), or null;
//   sessionState: SgwSession.state();
//   google:       GoogleAuthProvider.status() (no network);
//   budget:       RequestScheduler.stats().
// It only reads; it never runs a health check (that costs SGW requests).
import type { AuthStatus } from '../../domain/calendar/types';
import { STORAGE_KEYS } from '../../domain/storage/schema';
import type { BackgroundContext } from '../context';

const NO_GOOGLE: AuthStatus = { connected: false, provider: 'none', grantedScopes: [], needsInteraction: false, configured: false };

export function register(ctx: BackgroundContext): void {
  ctx.router.register('health.get', async () => {
    const [record, sessionState, google] = await Promise.all([
      ctx.repo.find(STORAGE_KEYS.sgwSession),
      ctx.session.state(),
      ctx.google.status().catch(() => NO_GOOGLE),
    ]);
    return {
      sgw: ctx.switches.healthReport(),
      session: record?.expiresAt ?? null,
      sessionState,
      google,
      budget: ctx.scheduler.stats(),
    };
  });
}
