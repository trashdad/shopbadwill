// Placeholder overlay (T-01): mounts an empty Shadow DOM badge on every SGW
// page to prove the content-script + Shadow DOM pipeline. Replaced by the real
// overlay in T-32.
//
// Built with plain DOM, not Preact: Preact's runtime contains an `innerHTML`
// assignment (for `dangerouslySetInnerHTML`), which `web-ext lint
// --warnings-as-errors` rejects (UNSAFE_VAR_ASSIGNMENT).
import { createShadowRootUi } from 'wxt/utils/content-script-ui/shadow-root';
import { defineContentScript } from 'wxt/utils/define-content-script';

const BADGE_STYLE: Partial<CSSStyleDeclaration> = {
  position: 'fixed',
  right: '12px',
  bottom: '12px',
  zIndex: '2147483647',
  padding: '4px 8px',
  borderRadius: '4px',
  background: '#1f2937',
  color: '#ffffff',
  font: '12px/1.4 system-ui, sans-serif',
  pointerEvents: 'none',
};

export default defineContentScript({
  matches: ['https://shopgoodwill.com/*'],
  async main(ctx) {
    const ui = await createShadowRootUi(ctx, {
      name: 'shopbadwill-badge',
      position: 'inline',
      anchor: 'body',
      append: 'last',
      onMount(container) {
        const badge = document.createElement('div');
        badge.setAttribute('role', 'status');
        badge.textContent = 'ShopBadwill ready';
        Object.assign(badge.style, BADGE_STYLE);
        container.append(badge);
        return badge;
      },
      onRemove(badge) {
        badge?.remove();
      },
    });
    ui.mount();
  },
});
