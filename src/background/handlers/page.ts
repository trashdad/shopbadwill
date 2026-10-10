// T-36: what content scripts report from SGW pages (`page.*`).
//
// - page.listings and page.detail are kept in memory per tab (ctx.pages) for
//   rules.preview and quick.track. Tap data is untrusted: the router has
//   already schema-validated it, and it is only ever rendered as text.
// - page.token goes to the one SessionAdapter (T-28 validates the JWT, the
//   BuyerId and the rejection history), as `source: 'tap'`.
// - page.domHealth keeps the latest card-selector report per tab; T-30's health
//   reads the most recent one (`domReport()`).
// Every one of them refuses a sender that is not a content script, on top of
// the router's checks (requireContent).
import type { BackgroundContext } from '../context';
import { requireContent, tabIdOf } from '../context';

export function register(ctx: BackgroundContext): void {
  const { router, pages, clock } = ctx;

  router.register('page.listings', ({ url, listings, capturedAt }, hctx) => {
    requireContent('page.listings', hctx);
    const { sender } = hctx;
    pages.recordListings({ tabId: tabIdOf(sender), url, listings, capturedAt, receivedAt: clock.now() });
    return undefined;
  });

  router.register('page.detail', ({ detail }, hctx) => {
    requireContent('page.detail', hctx);
    pages.recordDetail(detail);
    return undefined;
  });

  router.register('page.token', async ({ bearer, capturedAt }, hctx) => {
    requireContent('page.token', hctx);
    await ctx.session.observe({ bearer, capturedAt, source: 'tap' });
    return undefined;
  });

  router.register('page.domHealth', (report, hctx) => {
    requireContent('page.domHealth', hctx);
    pages.recordDomHealth({ ...report, tabId: tabIdOf(hctx.sender), at: clock.now() });
    return undefined;
  });
}
