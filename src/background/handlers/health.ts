// T-36: `health.get`, the health panel's and the popup's one read.
//   sgw:          the last HealthReport (T-30), or a failing one while storage
//                 needs repair (meta-corrupt / migration failure);
//   session:      the stored session's expiry (kept even when expired), or null;
//   sessionState: SgwSession.state();
//   google:       GoogleAuthProvider.status() (no network);
//   budget:       RequestScheduler.stats().
//   sticky:       the sticky schema failures and the features each blocks (T-30b).
// It only reads; it never runs a health check (that costs SGW requests).
//
// `health.clearSticky` (T-30b R2, ui only): the user checked a sticky failure and
// resumes. It removes that one entry (through T-30's recordSchemaSuccess, which
// also recomposes the report), audits `health.resume`, and re-evaluates the
// switches at once. Stale, clock and session failures are untouched: they clear
// only through probes or real state.
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
      sticky: ctx.switches.stickyFailures(),
    };
  });

  ctx.router.register('health.clearSticky', async ({ endpoint }) => {
    const before = await ctx.repo.find(STORAGE_KEYS.healthProbe);
    if (before === undefined || !before.sticky.some((x) => x.endpoint === endpoint)) return undefined;
    await ctx.health.recordSchemaSuccess(endpoint);
    ctx.switches.noteHealthProbe(await ctx.repo.find(STORAGE_KEYS.healthProbe));
    const report = await ctx.health.last();
    if (report !== null) ctx.switches.noteHealthReport(report);
    try {
      await ctx.audit.append({ actor: 'user', kind: 'health.resume', details: { endpoint, action: 'user resumed after checking' } });
    } catch {
      // An audit failure never undoes the resume (the report's own health.recovered entry is separate).
    }
    return undefined;
  });
}
