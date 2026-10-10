// T-32 (I-06): the card-badge registry. The overlay mounts every
// `./badges/*.tsx` module that exports `badge: CardBadge`, in order, inside
// each card's tools row (a closed shadow root). A later card adds ONE badge
// file and changes nothing else.
//
// A badge renders text only (Preact text nodes; never markup) and must not
// touch the page's DOM. It may read `cardRoot` (e.g. for an
// IntersectionObserver) and talk to the background through `client`; it must
// never fetch from SGW itself. A badge that throws is dropped for that card
// and the rest of the row keeps working; a malformed or duplicate badge module
// is skipped (a broken file must never break the overlay on a live page).
import type { ComponentType } from 'preact';

import type { Settings } from '../../domain/settings/schema';
import type { ItemId, Listing } from '../../domain/types';
import type { MessagingClient } from '../../ports/messaging';

export interface CardBadgeProps {
  itemId: ItemId;
  /** The listing from the page's own API data (untrusted: render as text), or null when only the DOM is known. */
  listing: Listing | null;
  settings: Settings;
  client: MessagingClient;
  /** The card's root element on the page. Read it; never modify it. */
  cardRoot: Element;
  /** EpochMs when the row was rendered. */
  now: number;
}

export interface CardBadge {
  /** Unique, lowercase kebab-case; also the `data-badge` attribute of the badge's wrapper. */
  id: string;
  /** Ascending; ties break by id. */
  order: number;
  Component: ComponentType<CardBadgeProps>;
}

const ID_RE = /^[a-z][a-z0-9-]*$/;

function isBadge(value: unknown): value is CardBadge {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v['id'] === 'string' &&
    ID_RE.test(v['id']) &&
    typeof v['order'] === 'number' &&
    Number.isFinite(v['order']) &&
    typeof v['Component'] === 'function'
  );
}

/** Valid badges from a glob result, in display order. Malformed and duplicate ids are skipped (first by path wins). */
export function loadBadges(modules: Record<string, unknown>): CardBadge[] {
  const found: CardBadge[] = [];
  const ids = new Set<string>();
  for (const path of Object.keys(modules).sort()) {
    const mod = modules[path];
    const badge = typeof mod === 'object' && mod !== null ? (mod as Record<string, unknown>)['badge'] : undefined;
    if (!isBadge(badge) || ids.has(badge.id)) continue;
    ids.add(badge.id);
    found.push(badge);
  }
  return found.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
}

/** Every badge file under ./badges/, bundled eagerly into the content script. */
export const BADGES: readonly CardBadge[] = loadBadges(import.meta.glob('./badges/*.tsx', { eager: true }));
