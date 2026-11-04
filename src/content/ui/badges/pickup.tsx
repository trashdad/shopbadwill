// T-115: the pickup distance. badge-registry.ts loads it by glob;
// sgw-overlay.ts mounts it per card.
//
// - Only when `features.comps` is on (default off), for a pickup-only item
//   whose state is known, and when `settings.homeZip` maps to a state.
//   Search rows rarely carry the pickup flag or the seller's state, so the
//   badge falls back to the item's cached detail (`sbw:detailCache`, read only
//   from storage.local): data the extension already holds. No message and no
//   SGW request.
// - The distance is COARSE (state centroid to state centroid, see
//   domain/geo/zip-distance.ts) and labelled "(approx.)".
// - `homeZip` is personal (R4): it is never logged, rendered or put in a title.
// - Text only (Preact text nodes; never innerHTML).
import type { VNode } from 'preact';
import { useEffect, useState } from 'preact/hooks';

import { approxPickupMiles, zipToState } from '../../../domain/geo/zip-distance';
import { STORAGE_KEYS } from '../../../domain/storage/schema';
import type { CardBadge, CardBadgeProps } from '../badge-registry';
import { readLocalShared } from './combined';

export interface BadgeLine {
  text: string;
  title: string;
}

const TITLE =
  'Approximate: measured between the centers of your home state and the pickup state, not to the pickup address';

/** The badge text, or null when either side is unknown. */
export function pickupLine(homeZip: string | undefined, pickupState: string | undefined): BadgeLine | null {
  const miles = approxPickupMiles(homeZip, pickupState);
  if (miles === null) return null;
  if (miles === 0) return { text: 'Pickup in your state (approx.)', title: TITLE };
  return { text: `Pickup about ${miles.toLocaleString('en-US')} mi away (approx.)`, title: TITLE };
}

interface PickupInfo {
  pickupOnly?: boolean;
  state?: string;
}

/** The cached detail's pickup flag and seller state, if any. */
function fromDetailCache(cache: unknown, itemId: number): PickupInfo {
  if (typeof cache !== 'object' || cache === null) return {};
  const entry = (cache as Record<string, unknown>)[String(itemId)];
  if (typeof entry !== 'object' || entry === null) return {};
  const detail = (entry as Record<string, unknown>)['detail'];
  if (typeof detail !== 'object' || detail === null) return {};
  const d = detail as Record<string, unknown>;
  const info: PickupInfo = {};
  if (typeof d['pickupOnly'] === 'boolean') info.pickupOnly = d['pickupOnly'];
  if (typeof d['sellerState'] === 'string') info.state = d['sellerState'];
  return info;
}

function Pickup(p: CardBadgeProps): VNode | null {
  const enabled = p.settings.features.comps;
  const homeZip = p.settings.homeZip;
  const hasHome = zipToState(homeZip) !== null;
  const listing = p.listing;
  const known: PickupInfo = {};
  if (listing?.pickupOnly !== undefined) known.pickupOnly = listing.pickupOnly;
  if (listing?.sellerState !== undefined) known.state = listing.sellerState;
  const complete = known.pickupOnly !== undefined && known.state !== undefined;
  const [cached, setCached] = useState<PickupInfo>({});

  useEffect(() => {
    setCached({});
    // A shipping item (or no home ZIP) needs nothing more.
    if (!enabled || listing === null || !hasHome || complete || known.pickupOnly === false) return undefined;
    let disposed = false;
    void readLocalShared(STORAGE_KEYS.detailCache).then((cache) => {
      if (!disposed) setCached(fromDetailCache(cache, p.itemId));
    });
    return () => {
      disposed = true;
    };
  }, [enabled, listing === null, hasHome, complete, known.pickupOnly, p.itemId]);

  if (!enabled || listing === null) return null;
  const pickupOnly = known.pickupOnly ?? cached.pickupOnly;
  const state = known.state ?? cached.state;
  if (pickupOnly !== true) return null;
  const line = pickupLine(homeZip, state);
  return line === null ? null : (
    <span class="chip" title={line.title}>
      {line.text}
    </span>
  );
}

export const badge: CardBadge = { id: 'pickup', order: 60, Component: Pickup };
