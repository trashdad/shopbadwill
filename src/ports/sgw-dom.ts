// Contract v1 (T-02): PLAN §3.3 SgwDom port. Implemented by T-27
// (src/adapters/sgw/dom-adapter.ts).
import type { ItemId, Listing } from '../domain/types';

export interface CardHandle {
  itemId: ItemId;
  root: Element;
  /** Where badges mount. */
  anchor: Element;
  layout: 'grid' | 'list' | 'unknown';
}

export interface SgwDom {
  readonly configVersion: string;
  /** Ranked selectors; marks nodes with data-sbw-seen. */
  discoverCards(root: ParentNode): CardHandle[];
  /** DOM-only fallback: title, price text, bids, time-left text. */
  readListingHints(card: CardHandle): Partial<Listing>;
  /** Idempotent; re-applying the same Decoration is a no-op. */
  applyDecoration(card: CardHandle, d: Decoration): void;
  clearDecoration(card: CardHandle): void;
  pageKind(url: string): 'search' | 'category' | 'item' | 'favorites' | 'other';
}

export type Decoration =
  | { kind: 'none' }
  | { kind: 'highlight'; label: string; ruleId: string; tone: 'green' | 'amber' | 'blue' }
  /** Collapsed stub; never display:none without a stub. */
  | { kind: 'hide'; ruleId: string; ruleName: string }
  | { kind: 'badge'; badges: Array<{ id: string; text: string; title?: string }> };
