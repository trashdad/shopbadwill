// T-27: SgwDom over SGW's rendered pages. Ranked card discovery, DOM-only
// listing hints, idempotent and fully reversible decorations, pageKind.
//
// Rules this file keeps:
//  - Selectors come from config.ts only, and never touch the build-specific
//    Angular scoping attributes.
//  - Hide never removes a site node: it sets an inline `display:none` on the
//    card (original `style` attribute saved in data-sbw-style0) and inserts our
//    stub before it. clearDecoration restores the attribute exactly and removes
//    only nodes we created (data-sbw-stub / data-sbw-label).
//  - Our UI is injected (DecorationUi, implemented in src/content/ui/stub.ts)
//    because src/adapters may not import src/content.
import { parseCents } from '../../domain/money';
import type { Listing } from '../../domain/types';
import type { CardHandle, Decoration, SgwDom } from '../../ports/sgw-dom';
import { SGW_CONFIG_VERSION, SGW_ORIGIN, SGW_PAGE_PATTERNS, SGW_SELECTORS } from './config';

export interface StubSpec {
  ruleId: string;
  ruleName: string;
  itemId: number;
  /** Called when the user presses "Show" on the stub. */
  onShow: () => void;
}
export interface LabelChip {
  text: string;
  title?: string;
  tone?: 'green' | 'amber' | 'blue';
}
export interface LabelSpec {
  chips: LabelChip[];
}
/** Our own UI factories. Must render text only (never markup) inside a Shadow DOM. */
export interface DecorationUi {
  createStub(doc: Document, spec: StubSpec): Element;
  createLabel(doc: Document, spec: LabelSpec): Element;
}

export interface DiscoveryReport {
  configVersion: string;
  /** Index of the ranked strategy that produced the cards; null when none did. */
  rank: number | null;
  /** What was queried at that rank. */
  strategy: string | null;
  count: number;
  /** Cards found but no item id readable. */
  unreadable: number;
  /** A fallback rank was needed, or ids were unreadable: the site markup moved on from configVersion. */
  drifted: boolean;
}

export interface DomAdapterOptions {
  ui: DecorationUi;
  /** Called after every discoverCards with the outcome; `drifted` is the signal to surface in Health. */
  onReport?: (report: DiscoveryReport) => void;
}

export interface SgwDomAdapter extends SgwDom {
  readonly lastReport: DiscoveryReport | null;
  /** Time-left text from the card ("5h 17m"), null when absent. Not a Listing field. */
  readTimeLeftText(card: CardHandle): string | null;
}

const A_SEEN = 'data-sbw-seen';
const A_DECO = 'data-sbw-deco';
const A_HIDDEN = 'data-sbw-hidden';
const A_HILITE = 'data-sbw-highlight';
const A_REVEALED = 'data-sbw-revealed';
const A_STYLE0 = 'data-sbw-style0';
const A_STUB = 'data-sbw-stub';
const A_LABEL = 'data-sbw-label';

const SC = SGW_SELECTORS.card;
const ROOT0 = SC.root[0];
const ROOT1 = SC.root[1];
const TITLE0 = SC.title[0];
const BOTTOM0 = SC.bottom[0];
const LIST_ROOT = SGW_SELECTORS.cardList.root[0];
const ID_FROM_HREF = new RegExp(SC.itemIdFromHref);
const PAGE_RE = {
  item: new RegExp(SGW_PAGE_PATTERNS.item),
  favorites: new RegExp(SGW_PAGE_PATTERNS.favorites),
  search: new RegExp(SGW_PAGE_PATTERNS.search),
  category: new RegExp(SGW_PAGE_PATTERNS.category),
} as const;
const TONE_COLOR = { green: '#1e7e34', amber: '#b35c00', blue: '#1a5fb4' } as const;

function toItemId(s: string | null | undefined): number | null {
  if (s === null || s === undefined || !/^\d+$/.test(s.trim())) return null;
  const n = Number(s.trim());
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

function readItemId(card: Element): number | null {
  for (const sel of SC.itemLink) {
    const href = card.querySelector(sel)?.getAttribute('href');
    const m = href === null || href === undefined ? null : ID_FROM_HREF.exec(href);
    const id = toItemId(m?.[1]);
    if (id !== null) return id;
  }
  for (const [sel, attr] of SC.itemIdAttrs) {
    const id = toItemId(card.querySelector(sel)?.getAttribute(attr));
    if (id !== null) return id;
  }
  return null;
}

function firstMatch(root: ParentNode, selectors: readonly string[]): Element | null {
  for (const s of selectors) {
    const el = root.querySelector(s);
    if (el !== null) return el;
  }
  return null;
}

function styleBase(el: Element): string | null {
  const saved = el.getAttribute(A_STYLE0);
  if (saved === null) return el.getAttribute('style');
  return saved.startsWith('=') ? saved.slice(1) : null;
}

/** Sets an inline style on top of the original, remembering the original `style` attribute once. */
function setStyle(el: Element, css: string): void {
  if (!el.hasAttribute(A_STYLE0)) {
    const orig = el.getAttribute('style');
    el.setAttribute(A_STYLE0, orig === null ? '-' : `=${orig}`);
  }
  const base = styleBase(el);
  el.setAttribute('style', base === null || base === '' ? css : `${base};${css}`);
}

function restoreStyle(el: Element): void {
  const saved = el.getAttribute(A_STYLE0);
  if (saved === null) return;
  if (saved.startsWith('=')) el.setAttribute('style', saved.slice(1));
  else el.removeAttribute('style');
  el.removeAttribute(A_STYLE0);
}

function visualTarget(root: Element): Element {
  return root.matches('.feat-item') ? root : (root.querySelector('.feat-item') ?? root);
}

function stubOf(root: Element): Element | null {
  const prev = root.previousElementSibling;
  return prev?.hasAttribute(A_STUB) === true ? prev : null;
}

function labelOf(anchor: Element): Element | null {
  for (const c of Array.from(anchor.children)) if (c.hasAttribute(A_LABEL)) return c;
  return null;
}

function text(el: Element | null): string {
  return (el?.textContent ?? '').replace(/\s+/g, ' ').trim();
}

export function createDomAdapter(opts: DomAdapterOptions): SgwDomAdapter {
  const { ui } = opts;
  let lastReport: DiscoveryReport | null = null;

  /** One query per rank; the first rank with any hit wins. */
  const strategies: Array<{ name: string; find: (scope: ParentNode) => Element[] }> = [
    { name: ROOT0, find: (s) => Array.from(s.querySelectorAll(ROOT0)) },
    { name: ROOT1, find: (s) => Array.from(s.querySelectorAll(ROOT1)) },
    {
      // Structural last resort: the title anchor's card container.
      name: TITLE0,
      find: (s) => {
        const seen = new Set<Element>();
        for (const a of Array.from(s.querySelectorAll(TITLE0))) {
          // Climb to the first ancestor that also holds the bids/time block.
          let n = a.parentElement;
          while (n !== null && n.querySelector(BOTTOM0) === null) n = n.parentElement;
          if (n !== null) seen.add(n);
        }
        return Array.from(seen);
      },
    },
  ];

  function sweepOrphanStubs(scope: ParentNode): void {
    for (const stub of Array.from(scope.querySelectorAll(`[${A_STUB}]`))) {
      const next = stub.nextElementSibling;
      if (next === null || !next.hasAttribute(A_HIDDEN)) stub.remove();
    }
  }

  function discoverCards(scope: ParentNode): CardHandle[] {
    sweepOrphanStubs(scope);
    let rank: number | null = null;
    let found: Element[] = [];
    for (let i = 0; i < strategies.length; i++) {
      const hits = strategies[i]?.find(scope) ?? [];
      if (hits.length > 0) {
        rank = i;
        found = hits;
        break;
      }
    }
    const listCards = new Set<Element>(Array.from(scope.querySelectorAll(LIST_ROOT)));
    const handles: CardHandle[] = [];
    let unreadable = 0;
    for (const root of found) {
      const itemId = readItemId(root);
      if (itemId === null) {
        unreadable += 1;
        continue;
      }
      root.setAttribute(A_SEEN, '1');
      const inner = visualTarget(root);
      const layout: CardHandle['layout'] = listCards.has(inner) ? 'list' : inner.matches('.feat-item') ? 'grid' : 'unknown';
      const anchor = firstMatch(root, SC.anchor) ?? root;
      handles.push({ itemId, root, anchor, layout });
    }
    lastReport = {
      configVersion: SGW_CONFIG_VERSION,
      rank,
      strategy: rank === null ? null : (strategies[rank]?.name ?? null),
      count: handles.length,
      unreadable,
      drifted: (rank !== null && rank > 0) || unreadable > 0,
    };
    opts.onReport?.(lastReport);
    return handles;
  }

  function readListingHints(card: CardHandle): Partial<Listing> {
    const hints: Partial<Listing> = { itemId: card.itemId, source: 'dom' };
    const title = text(firstMatch(card.root, SC.title));
    if (title !== '') hints.title = title;
    const price = /\$\s*[\d,]+(?:\.\d{1,2})?/.exec(text(firstMatch(card.root, SC.price)));
    if (price !== null) {
      const cents = parseCents(price[0]);
      if (cents !== null) hints.currentPrice = cents;
    }
    const bottoms = Array.from(card.root.querySelectorAll(BOTTOM0)).map((e) => text(e));
    const bids = /Bids:\s*(\d+)/.exec(bottoms.join(' '));
    if (bids?.[1] !== undefined) hints.numBids = Number(bids[1]);
    return hints;
  }

  function readTimeLeftText(card: CardHandle): string | null {
    const labels = [SC.timeLeftLabel.grid, SC.timeLeftLabel.list];
    for (const li of Array.from(card.root.querySelectorAll(`${BOTTOM0} li`))) {
      const t = text(li);
      for (const label of labels) {
        if (t.startsWith(label)) {
          const rest = t.slice(label.length).trim();
          return rest === '' ? null : rest;
        }
      }
    }
    return null;
  }

  function clearDecoration(card: CardHandle): void {
    const root = card.root;
    stubOf(root)?.remove();
    labelOf(card.anchor)?.remove();
    const target = visualTarget(root);
    restoreStyle(root);
    if (target !== root) restoreStyle(target);
    for (const a of [A_DECO, A_HIDDEN, A_HILITE, A_REVEALED]) root.removeAttribute(a);
  }

  function intact(card: CardHandle, d: Decoration): boolean {
    switch (d.kind) {
      case 'hide':
        return stubOf(card.root) !== null;
      case 'highlight':
      case 'badge':
        return labelOf(card.anchor) !== null;
      case 'none':
        return true;
    }
  }

  function applyDecoration(card: CardHandle, d: Decoration): void {
    const root = card.root;
    const current = root.getAttribute(A_DECO);
    if (d.kind === 'none') {
      if (current !== null) clearDecoration(card);
      return;
    }
    const sig = JSON.stringify(d);
    if (current === sig && intact(card, d)) return;
    if (current !== null || stubOf(root) !== null || labelOf(card.anchor) !== null) clearDecoration(card);
    const doc = root.ownerDocument;
    root.setAttribute(A_DECO, sig);
    switch (d.kind) {
      case 'hide': {
        root.setAttribute(A_HIDDEN, '1');
        const stub = ui.createStub(doc, {
          ruleId: d.ruleId,
          ruleName: d.ruleName,
          itemId: card.itemId,
          onShow: () => {
            root.setAttribute(A_REVEALED, '1');
            restoreStyle(root);
          },
        });
        stub.setAttribute(A_STUB, String(card.itemId));
        root.before(stub);
        setStyle(root, 'display:none !important');
        break;
      }
      case 'highlight': {
        root.setAttribute(A_HILITE, d.tone);
        setStyle(visualTarget(root), `outline:3px solid ${TONE_COLOR[d.tone]};outline-offset:-3px`);
        const label = ui.createLabel(doc, { chips: [{ text: d.label, tone: d.tone }] });
        label.setAttribute(A_LABEL, '1');
        card.anchor.append(label);
        break;
      }
      case 'badge': {
        const chips = d.badges.map((b) => (b.title === undefined ? { text: b.text } : { text: b.text, title: b.title }));
        const label = ui.createLabel(doc, { chips });
        label.setAttribute(A_LABEL, '1');
        card.anchor.append(label);
        break;
      }
    }
  }

  function pageKind(url: string): ReturnType<SgwDom['pageKind']> {
    let path: string;
    try {
      path = new URL(url, SGW_ORIGIN).pathname;
    } catch {
      return 'other';
    }
    if (PAGE_RE.item.test(path)) return 'item';
    if (PAGE_RE.favorites.test(path)) return 'favorites';
    if (PAGE_RE.search.test(path)) return 'search';
    if (PAGE_RE.category.test(path)) return 'category';
    return 'other';
  }

  return {
    configVersion: SGW_CONFIG_VERSION,
    get lastReport() {
      return lastReport;
    },
    discoverCards,
    readListingHints,
    readTimeLeftText,
    applyDecoration,
    clearDecoration,
    pageKind,
  };
}
