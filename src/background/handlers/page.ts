// T-36: what content scripts report from SGW pages (`page.*`).
//
// - page.listings and page.detail are kept in memory per tab (ctx.pages) for
//   rules.preview and quick.track. Tap data is untrusted: the router has
//   already schema-validated it, and it is only ever rendered as text.
// - page.token goes to the one SessionAdapter (T-28 validates the JWT, the
//   BuyerId and the rejection history), as `source: 'tap'`.
// - page.domHealth keeps the latest card-selector report per tab; T-30's health
//   reads the most recent one (`domReport()`).
import type { BackgroundContext } from '../context';
import { tabIdOf } from '../context';

export function register(ctx: BackgroundContext): void {
  const { router, pages, clock } = ctx;

  router.register('page.listings', ({ url, listings, capturedAt }, { sender }) => {
    pages.recordListings({ tabId: tabIdOf(sender), url, listings, capturedAt, receivedAt: clock.now() });
    return undefined;
  });

  router.register('page.detail', ({ detail }) => {
    pages.recordDetail(detail);
    return undefined;
  });

  router.register('page.token', async ({ bearer, capturedAt }) => {
    await ctx.session.observe({ bearer, capturedAt, source: 'tap' });
    return undefined;
  });

  router.register('page.domHealth', (report, { sender }) => {
    pages.recordDomHealth({ ...report, tabId: tabIdOf(sender), at: clock.now() });
    return undefined;
  });
}
