// MAIN-world observer of buyerapi traffic (T-31). Logic lives in
// src/content/api-tap.main.ts. Manifest: world MAIN, document_start.
import { defineContentScript } from 'wxt/utils/define-content-script';

import { installApiTap } from '../content/api-tap.main';

export default defineContentScript({
  matches: ['https://shopgoodwill.com/*'],
  world: 'MAIN',
  runAt: 'document_start',
  main() {
    installApiTap(window);
  },
});
