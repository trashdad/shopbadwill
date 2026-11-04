// The SGW content overlay (T-32), ISOLATED world. Logic lives in
// src/content/sgw-overlay.ts. It runs at document_start so the tap nonce is on
// <html> before the MAIN-world api-tap (T-31) has to buffer for long; the page
// UI and the card scan wait for the DOM.
//
// The page-level UI keeps T-01's host, an open-shadow <shopbadwill-badge> with a
// [role="status"] pill (the Firefox E2E smoke looks for it). In-card UI uses
// closed shadow roots (src/content/ui/shadow.ts). Preact is bundled into this
// script; its runtime's one innerHTML statement is the allowlisted entry in
// scripts/lint-webext.ts and scripts/check-prod-bundle.ts.
import { browser } from 'wxt/browser';
import { createShadowRootUi } from 'wxt/utils/content-script-ui/shadow-root';
import { defineContentScript } from 'wxt/utils/define-content-script';

import { createStorageAreas } from '../adapters/browser/storage';
import { startOverlay } from '../content/sgw-overlay';
import { PAGE_CSS } from '../content/ui/styles';
import { createMessagingClient } from '../messaging/client';

export default defineContentScript({
  matches: ['https://shopgoodwill.com/*'],
  runAt: 'document_start',
  main(ctx) {
    const overlay = startOverlay({
      win: window,
      messaging: createMessagingClient(browser.runtime),
      storage: createStorageAreas().local,
      async mountPageUi(hooks) {
        const ui = await createShadowRootUi(ctx, {
          name: 'shopbadwill-badge',
          position: 'inline',
          anchor: 'body',
          append: 'last',
          css: PAGE_CSS,
          isolateEvents: true,
          onMount(container) {
            hooks.onMount(container);
          },
          onRemove() {
            hooks.onRemove();
          },
        });
        ui.mount();
        return {
          remove() {
            ui.remove();
          },
        };
      },
    });
    ctx.addEventListener(window, 'wxt:locationchange', ({ newUrl }) => {
      overlay.onLocationChange(newUrl.href);
    });
    ctx.onInvalidated(() => {
      overlay.stop();
    });
  },
});
