// T-85 (R1): the card "Snipe…" deep link. It ONLY sends `ui.openSnipe` — the
// background opens the dashboard prefilled with this item (never arms; arming
// happens in the dashboard through snipe.arm). Nothing here talks to SGW and
// a synthetic (untrusted) click sends nothing, like the quick actions. The
// badge registry glob (badge-registry.ts) picks this file up; no registry edit.
import type { VNode } from 'preact';

import type { CardBadge, CardBadgeProps } from '../badge-registry';

function SnipeLink({ itemId, client }: CardBadgeProps): VNode {
  return (
    <button
      type="button"
      data-action="snipe"
      title="Open the dashboard to arm a snipe (never arms from here)"
      onClick={(e) => {
        if (!e.isTrusted) return;
        void client.send('ui.openSnipe', { itemId }).catch(() => undefined);
      }}
    >
      Snipe…
    </button>
  );
}

export const badge: CardBadge = { id: 'snipe-link', order: 60, Component: SnipeLink };
