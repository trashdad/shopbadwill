// T-115: the comps link-out. badge-registry.ts loads it by glob; sgw-overlay.ts
// mounts it per card.
//
// - Only when `features.comps` is on (default off) and the card has listing
//   data. A plain link to eBay's sold-listings search for the card's
//   normalized title. The extension never fetches it: the browser opens it in
//   a new tab only when the user clicks (noopener noreferrer, so eBay gets no
//   referrer and no window handle).
// - Text only (Preact text nodes; never innerHTML). No message is sent.
import type { VNode } from 'preact';

import { normalizeTitle } from '../../../domain/relist/fingerprint';
import type { CardBadge, CardBadgeProps } from '../badge-registry';

/** The eBay sold+completed search for the normalized title, or null when the title has nothing to search on. */
export function compsUrl(title: string): string | null {
  const q = normalizeTitle(title);
  if (q === '') return null;
  const params = new URLSearchParams({ _nkw: q, LH_Sold: '1', LH_Complete: '1' });
  return `https://www.ebay.com/sch/i.html?${params.toString()}`;
}

function Comps(p: CardBadgeProps): VNode | null {
  if (!p.settings.features.comps || p.listing === null) return null;
  const href = compsUrl(p.listing.title);
  return href === null ? null : (
    <a
      class="chip"
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      title="Search eBay sold listings for this title (opens a new tab)"
    >
      Sold comps
    </a>
  );
}

export const badge: CardBadge = { id: 'comps', order: 40, Component: Comps };
