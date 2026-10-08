// Placeholder background (T-01). Replaced by the composition root in T-36.
import { browser } from 'wxt/browser';
import { defineBackground } from 'wxt/utils/define-background';

export default defineBackground(() => {
  console.info('[ShopBadwill] background heartbeat', {
    version: browser.runtime.getManifest().version,
    at: new Date().toISOString(),
  });
});
