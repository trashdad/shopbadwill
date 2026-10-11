// T-71 (R7): open the onboarding page on a fresh install, on the reason 'install'
// only — updates never re-open it. The runtime.onInstalled wiring already exists
// in main.ts (ctx.lifecycle, replayed through the event gate after startup), so
// this module only subscribes; main.ts and wxt.config.ts stay untouched.
//
// A failure to open the tab (e.g. the fake browser in tests) is ignored: the
// onboarding page stays reachable, and the gap to an options-page link is noted
// in the T-71 report.
import { browser } from 'wxt/browser';

import type { BackgroundContext } from '../context';

export const ONBOARDING_PATH = '/onboarding.html';

export function register(ctx: BackgroundContext): void {
  ctx.lifecycle.onInstalled((details) => {
    if (details.reason !== 'install') return;
    try {
      void browser.tabs
        .create({ url: browser.runtime.getURL(ONBOARDING_PATH) })
        .then(
          () => undefined,
          () => undefined,
        );
    } catch {
      // No tabs API here (test fakes): nothing to do.
    }
  });
}
