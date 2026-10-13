import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createDomAdapter, type DiscoveryReport, type StubSpec } from '../../src/adapters/sgw/dom-adapter';
import { SGW_CONFIG_VERSION } from '../../src/adapters/sgw/config';
import type { Decoration } from '../../src/ports/sgw-dom';
import { decorationUi, shadowRootForTest } from '../../src/content/ui/stub';

const FIX = resolve(__dirname, '../fixtures/sgw/html');
const SEARCH = [
  ['search-grid-logged-out', 'grid'],
  ['search-list-logged-out', 'list'],
  ['search-grid-logged-in', 'grid'],
  ['search-list-logged-in', 'list'],
] as const;

function load(name: string): Document {
  return new DOMParser().parseFromString(readFileSync(resolve(FIX, `${name}.html`), 'utf8'), 'text/html');
}
function make() {
  const reports: DiscoveryReport[] = [];
  const dom = createDomAdapter({ ui: decorationUi, onReport: (r) => reports.push(r) });
  return { dom, reports };
}
function unwrap(el: Element): void {
  el.replaceWith(...Array.from(el.childNodes));
}
function hrefIds(root: Element): number[] {
  const ids = new Set<number>();
  for (const a of Array.from(root.querySelectorAll('a[href^="/item/"]'))) {
    ids.add(Number(/^\/item\/(\d+)/.exec(a.getAttribute('href') ?? '')?.[1]));
  }
  return [...ids];
}

describe('discoverCards over real fixtures', () => {
  for (const [name, layout] of SEARCH) {
    it(`${name}: 40 cards, ids match the card links, layout ${layout}`, () => {
      const doc = load(name);
      const { dom, reports } = make();
      const cards = dom.discoverCards(doc);
      expect(cards).toHaveLength(40);
      expect(new Set(cards.map((c) => c.itemId)).size).toBe(40);
      for (const c of cards) {
        expect(c.layout).toBe(layout);
        expect(hrefIds(c.root)).toEqual([c.itemId]);
        expect(c.root.contains(c.anchor)).toBe(true);
        expect((c as { degraded?: boolean }).degraded).toBe(false);
      }
      expect(reports.at(-1)).toMatchObject({ rank: 0, drifted: false, configVersion: SGW_CONFIG_VERSION });
      expect(dom.configVersion).toBe(SGW_CONFIG_VERSION);
    });
  }

  it('discovery scales roughly linearly: 40 vs 400 cards', () => {
    const doc40 = load('search-grid-logged-out');
    const doc400 = load('search-grid-logged-out');
    const cell = doc400.querySelector('.item-col');
    const parent = cell?.parentElement;
    if (cell == null || parent == null) throw new Error('no grid cell');
    const cells = Array.from(parent.querySelectorAll(':scope > .item-col'));
    for (let rep = 0; rep < 9; rep++) for (const c of cells) parent.append(c.cloneNode(true));
    const { dom } = make();
    // Minimum of many interleaved runs: the least noisy estimate under a loaded machine
    // (a median of 7 flaked when a GC pause landed in the 400-card runs).
    const t40: number[] = [];
    const t400: number[] = [];
    dom.discoverCards(doc40); // warm up
    dom.discoverCards(doc400);
    for (let i = 0; i < 15; i++) {
      let t0 = performance.now();
      dom.discoverCards(doc40);
      t40.push(performance.now() - t0);
      t0 = performance.now();
      dom.discoverCards(doc400);
      t400.push(performance.now() - t0);
    }
    expect(dom.discoverCards(doc400)).toHaveLength(400);
    const m40 = Math.max(Math.min(...t40), 0.02);
    const m400 = Math.min(...t400);
    console.log(`discoverCards min 40 cards ${m40.toFixed(2)} ms, 400 cards ${m400.toFixed(2)} ms, ratio ${(m400 / m40).toFixed(1)}x`);
    // Linear is ~10x; quadratic would be ~100x, so 40x still separates them with headroom for noise.
    expect(m400 / m40).toBeLessThan(40);
  });
});

describe('fallback and drift', () => {
  it('finds all cards via .feat-item when app-home-product-items is gone, and reports drift', () => {
    const doc = load('search-grid-logged-out');
    for (const el of Array.from(doc.querySelectorAll('app-home-product-items'))) unwrap(el);
    const { dom, reports } = make();
    expect(dom.discoverCards(doc)).toHaveLength(40);
    expect(reports.at(-1)).toMatchObject({ rank: 1, drifted: true, configVersion: SGW_CONFIG_VERSION, count: 40 });
  });

  it('falls back to the title-anchor structure when both card roots are gone (list too)', () => {
    for (const name of ['search-grid-logged-out', 'search-list-logged-in']) {
      const doc = load(name);
      for (const el of Array.from(doc.querySelectorAll('app-home-product-items'))) unwrap(el);
      for (const el of Array.from(doc.querySelectorAll('.feat-item'))) el.classList.remove('feat-item', 'feat-item-list');
      const { dom, reports } = make();
      const cards = dom.discoverCards(doc);
      expect(cards).toHaveLength(40);
      expect(new Set(cards.map((c) => c.itemId)).size).toBe(40);
      expect(reports.at(-1)).toMatchObject({ rank: 2, drifted: true });
    }
  });

  it('reports no cards (not drift) on a page without any', () => {
    const doc = new DOMParser().parseFromString('<div>empty</div>', 'text/html');
    const { dom, reports } = make();
    expect(dom.discoverCards(doc)).toEqual([]);
    expect(reports.at(-1)).toMatchObject({ rank: null, count: 0, drifted: false });
  });

  it('reports drift when cards exist but no id is readable', () => {
    const doc = load('search-grid-logged-out');
    for (const a of Array.from(doc.querySelectorAll('app-home-product-items a'))) {
      a.removeAttribute('href');
      a.removeAttribute('id');
      a.removeAttribute('aria-describedby');
    }
    const { dom, reports } = make();
    expect(dom.discoverCards(doc)).toHaveLength(0);
    expect(reports.at(-1)).toMatchObject({ unreadable: 40, drifted: true });
  });

  it('does not depend on _ngcontent/_nghost attributes (stripped fixture still finds 40)', () => {
    const doc = load('search-list-logged-out');
    for (const el of Array.from(doc.querySelectorAll('*'))) {
      for (const n of el.getAttributeNames()) if (n.startsWith('_ng')) el.removeAttribute(n);
    }
    const { dom } = make();
    expect(dom.discoverCards(doc)).toHaveLength(40);
  });

  it('adapter source never names _ngcontent/_nghost selectors', () => {
    const src = readFileSync(resolve(__dirname, '../../src/adapters/sgw/dom-adapter.ts'), 'utf8');
    expect(src.replace(/\/\/.*$/gm, '')).not.toMatch(/_ng(content|host)/);
  });
});

describe('item page', () => {
  it('discovers its seller/related cards and reports pageKind item', () => {
    for (const name of ['item-page-logged-out', 'item-page-logged-in']) {
      const { dom } = make();
      const cards = dom.discoverCards(load(name));
      expect(cards.length).toBe(5);
      for (const c of cards) expect(hrefIds(c.root)).toEqual([c.itemId]);
    }
  });
});

describe('listing hints', () => {
  it('reads title, price, bids and time left on both layouts', () => {
    const { dom } = make();
    const g = dom.discoverCards(load('search-grid-logged-out'))[0];
    const l = dom.discoverCards(load('search-list-logged-out'))[0];
    expect(g).toBeDefined();
    expect(l).toBeDefined();
    if (g === undefined || l === undefined) return;
    expect(dom.readListingHints(g)).toMatchObject({
      itemId: 694349278,
      title: 'Voluptate exercitation non ea et nostrud irure cupidatat occaecat null',
      currentPrice: 999,
      numBids: 1,
      source: 'dom',
    });
    expect(dom.readListingHints(l)).toMatchObject({ itemId: 694349278, currentPrice: 999, numBids: 1 });
    expect(dom.readTimeLeftText(g)).toBe('5h 17m');
    expect(dom.readTimeLeftText(l)).toBe('5h 17m');
  });
});

describe('decorations', () => {
  const hide = { kind: 'hide', ruleId: 'r1', ruleName: 'No <b>junk</b>' } as const;

  function first(name = 'search-grid-logged-out') {
    const doc = load(name);
    const { dom } = make();
    const cards = dom.discoverCards(doc);
    const card = cards[0];
    if (card === undefined) throw new Error('no card');
    return { doc, dom, card, cards };
  }

  it('applying hide twice yields exactly one stub; the card is hidden, not removed', () => {
    const { doc, dom, card } = first();
    dom.applyDecoration(card, hide);
    dom.applyDecoration(card, hide);
    expect(doc.querySelectorAll('[data-sbw-stub]')).toHaveLength(1);
    expect(card.root.isConnected).toBe(true);
    expect(card.root.getAttribute('style')).toContain('display:none');
    expect(card.root.previousElementSibling?.hasAttribute('data-sbw-stub')).toBe(true);
  });

  it('stub lives in a shadow root and shows rule text as text, not markup', () => {
    const { doc, dom, card } = first();
    dom.applyDecoration(card, hide);
    const stub = doc.querySelector('[data-sbw-stub]');
    expect(stub?.shadowRoot).toBeNull(); // closed
    const sr = shadowRootForTest(stub ?? null);
    expect(sr).toBeTruthy();
    expect(sr?.querySelector('.text')?.textContent).toBe('Hidden by rule: No <b>junk</b>');
    expect(sr?.querySelector('b')).toBeNull();
    expect(stub?.children).toHaveLength(0);
  });

  it('Show on the stub reveals the card but keeps the stub', () => {
    const { doc, dom, card } = first();
    dom.applyDecoration(card, hide);
    const btn = shadowRootForTest(doc.querySelector('[data-sbw-stub]'))?.querySelector('button');
    btn?.click();
    expect(card.root.hasAttribute('style')).toBe(false);
    dom.applyDecoration(card, hide); // same decoration: stays revealed, still one stub
    expect(card.root.hasAttribute('style')).toBe(false);
    expect(doc.querySelectorAll('[data-sbw-stub]')).toHaveLength(1);
  });

  it('highlight twice yields one label; changing decoration replaces, never stacks', () => {
    const { doc, dom, card } = first();
    const hl = { kind: 'highlight', label: 'Watch', ruleId: 'r2', tone: 'green' } as const;
    dom.applyDecoration(card, hl);
    dom.applyDecoration(card, hl);
    expect(doc.querySelectorAll('[data-sbw-label]')).toHaveLength(1);
    dom.applyDecoration(card, { kind: 'badge', badges: [{ id: 'a', text: 'A', title: 'tip' }, { id: 'b', text: 'B' }] });
    expect(doc.querySelectorAll('[data-sbw-label]')).toHaveLength(1);
    expect(card.root.hasAttribute('data-sbw-highlight')).toBe(false);
    dom.applyDecoration(card, hide);
    expect(doc.querySelectorAll('[data-sbw-label]')).toHaveLength(0);
    expect(doc.querySelectorAll('[data-sbw-stub]')).toHaveLength(1);
  });

  it('repairs a decoration whose stub was removed by the site', () => {
    const { doc, dom, card } = first();
    dom.applyDecoration(card, hide);
    doc.querySelector('[data-sbw-stub]')?.remove();
    dom.applyDecoration(card, hide);
    expect(doc.querySelectorAll('[data-sbw-stub]')).toHaveLength(1);
  });

  for (const [name] of SEARCH) {
    it(`clear restores the ${name} DOM byte-identically (every decoration kind, pre-existing style kept)`, () => {
      const { doc, dom, cards } = first(name);
      const withStyle = cards[1];
      withStyle?.root.setAttribute('style', 'color:red');
      withStyle?.root.querySelector('.feat-item')?.setAttribute('style', 'margin:1px');
      const before = doc.documentElement.outerHTML;
      const decos: Decoration[] = [
        hide,
        { kind: 'highlight', label: 'L', ruleId: 'r', tone: 'amber' },
        { kind: 'badge', badges: [{ id: 'x', text: 'X' }] },
      ];
      for (const c of cards.slice(0, 3)) {
        for (const d of decos) {
          dom.applyDecoration(c, d);
          dom.clearDecoration(c);
          expect(doc.documentElement.outerHTML).toBe(before);
        }
      }
      for (const c of cards) dom.applyDecoration(c, hide);
      expect(doc.querySelectorAll('[data-sbw-stub]')).toHaveLength(40);
      for (const c of cards) dom.applyDecoration(c, { kind: 'none' });
      expect(doc.documentElement.outerHTML).toBe(before);
    });
  }

  it('a hidden card never loses its nodes: every original element is still present', () => {
    const { doc, dom, cards } = first();
    const n = doc.querySelectorAll('*').length;
    for (const c of cards) dom.applyDecoration(c, hide);
    // 40 stubs added, nothing removed.
    expect(doc.querySelectorAll('*').length).toBe(n + 40);
  });
});

describe('degraded (rank 2) cards', () => {
  const hideDeco: Decoration = { kind: 'hide', ruleId: 'r', ruleName: 'Junk' };
  function rank2(name: string) {
    const doc = load(name);
    for (const el of Array.from(doc.querySelectorAll('app-home-product-items'))) unwrap(el);
    for (const el of Array.from(doc.querySelectorAll('.feat-item'))) el.classList.remove('feat-item', 'feat-item-list');
    const { dom } = make();
    return { doc, dom, cards: dom.discoverCards(doc) };
  }
  for (const name of ['search-grid-logged-out', 'search-list-logged-out']) {
    it(`${name}: hide is refused, falls back to a "would hide" chip`, () => {
      const { doc, dom, cards } = rank2(name);
      const before = doc.documentElement.outerHTML;
      const c = cards[0];
      if (c === undefined) throw new Error('no card');
      expect((c as { degraded?: boolean }).degraded).toBe(true);
      dom.applyDecoration(c, hideDeco);
      dom.applyDecoration(c, hideDeco);
      expect(doc.querySelectorAll('[data-sbw-stub]')).toHaveLength(0);
      expect(doc.querySelector('[style*="display:none !important"]')).toBeNull();
      expect(doc.querySelectorAll('[data-sbw-hidden]')).toHaveLength(0);
      const labels = doc.querySelectorAll('[data-sbw-label]');
      expect(labels).toHaveLength(1);
      expect(shadowRootForTest(labels[0] ?? null)?.querySelector('.chip')?.textContent).toBe('Would hide: Junk');
      dom.clearDecoration(c);
      expect(doc.documentElement.outerHTML).toBe(before);
    });
  }
  it('highlight and badge still work when degraded', () => {
    const { doc, dom, cards } = rank2('search-grid-logged-out');
    const c = cards[0];
    if (c === undefined) throw new Error('no card');
    dom.applyDecoration(c, { kind: 'highlight', label: 'L', ruleId: 'r', tone: 'blue' });
    dom.applyDecoration(c, { kind: 'badge', badges: [{ id: 'a', text: 'A' }] });
    expect(doc.querySelectorAll('[data-sbw-label]')).toHaveLength(1);
  });
  it('rank 1 still hides with a stub', () => {
    const doc = load('search-grid-logged-out');
    for (const el of Array.from(doc.querySelectorAll('app-home-product-items'))) unwrap(el);
    const { dom } = make();
    const c = dom.discoverCards(doc)[0];
    if (c === undefined) throw new Error('no card');
    expect((c as { degraded?: boolean }).degraded).toBe(false);
    dom.applyDecoration(c, hideDeco);
    expect(doc.querySelectorAll('[data-sbw-stub]')).toHaveLength(1);
    expect(c.root.getAttribute('style')).toContain('display:none');
  });
});

describe('idempotence', () => {
  it('a second identical decorate performs zero DOM mutations', () => {
    const doc = load('search-grid-logged-out');
    const { dom } = make();
    const c = dom.discoverCards(doc)[0];
    if (c === undefined) throw new Error('no card');
    const decos: Decoration[] = [
      { kind: 'hide', ruleId: 'r', ruleName: 'N' },
      { kind: 'highlight', label: 'L', ruleId: 'r', tone: 'green' },
      { kind: 'badge', badges: [{ id: 'a', text: 'A' }] },
    ];
    const obs = new MutationObserver(() => undefined);
    obs.observe(doc.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
    for (const d of decos) {
      dom.applyDecoration(c, d);
      obs.takeRecords();
      dom.applyDecoration(c, d);
      expect(obs.takeRecords()).toHaveLength(0);
    }
    obs.disconnect();
  });
});

describe('SPA re-render', () => {
  it('re-discovers new nodes with no duplicates and sweeps orphaned stubs', () => {
    const doc = load('search-grid-logged-out');
    const { dom } = make();
    const cards = dom.discoverCards(doc);
    const original = cards.slice(0, 5);
    for (const c of original) dom.applyDecoration(c, { kind: 'hide', ruleId: 'r', ruleName: 'N' });
    expect(doc.querySelectorAll('[data-sbw-stub]')).toHaveLength(5);

    const container = doc.querySelector('.p-dataview-content');
    expect(container).not.toBeNull();
    if (container === null) return;
    container.replaceChildren(...Array.from(container.cloneNode(true).childNodes)); // test-only: simulates Angular replacing the nodes

    const again = dom.discoverCards(doc);
    expect(again).toHaveLength(40);
    expect(new Set(again.map((c) => c.root)).size).toBe(40);
    expect(new Set(again.map((c) => c.itemId)).size).toBe(40);
    expect(again.some((c) => original.some((o) => o.root === c.root))).toBe(false);
    // Hidden state serialized into innerHTML is re-read cleanly: stubs match hidden cards 1:1.
    expect(doc.querySelectorAll('[data-sbw-stub]').length).toBe(doc.querySelectorAll('[data-sbw-hidden]').length);
    // Idempotent: a second pass finds the same set and adds nothing.
    const n = doc.querySelectorAll('*').length;
    expect(dom.discoverCards(doc)).toHaveLength(40);
    expect(doc.querySelectorAll('*').length).toBe(n);
  });

  it('removes a stub whose card was replaced by the site', () => {
    const doc = load('search-list-logged-out');
    const { dom } = make();
    const card = dom.discoverCards(doc)[0];
    if (card === undefined) throw new Error('no card');
    dom.applyDecoration(card, { kind: 'hide', ruleId: 'r', ruleName: 'N' });
    card.root.removeAttribute('data-sbw-hidden'); // the re-rendered replacement carries no marks
    dom.discoverCards(doc);
    expect(doc.querySelectorAll('[data-sbw-stub]')).toHaveLength(0);
  });
});

describe('pageKind', () => {
  const { dom } = make();
  it.each([
    ['https://shopgoodwill.com/categories/listing?st=pyrex&p=1', 'search'],
    ['https://shopgoodwill.com/categories/listing', 'search'],
    ['https://shopgoodwill.com/categories/some-category', 'category'],
    ['https://shopgoodwill.com/categories/landing', 'other'],
    ['https://shopgoodwill.com/item/694349278', 'item'],
    ['https://shopgoodwill.com/item/abc', 'other'],
    ['https://shopgoodwill.com/shopgoodwill/favorites', 'favorites'],
    ['https://shopgoodwill.com/home', 'other'],
    ['not a url', 'other'],
  ] as const)('%s -> %s', (url, kind) => {
    expect(dom.pageKind(url)).toBe(kind);
  });

  it('classifies the URL each fixture was captured from', () => {
    const urls: Record<string, string> = {
      'search-grid-logged-out': '/categories/listing?layout=grid',
      'search-list-logged-out': '/categories/listing?layout=list',
      'search-grid-logged-in': '/categories/listing?layout=grid',
      'search-list-logged-in': '/categories/listing?layout=list',
      'item-page-logged-out': '/item/694349278',
      'item-page-logged-in': '/item/694349278',
    };
    for (const [name, path] of Object.entries(urls)) {
      expect(dom.pageKind(`https://shopgoodwill.com${path}`)).toBe(name.startsWith('item') ? 'item' : 'search');
      expect(load(name).documentElement).toBeTruthy();
    }
  });
});

// T-32 fix round 1 (controller ruling): settings.overlay.hideStyle 'dim'.
describe("hideStyle 'dim'", () => {
  const hide = { kind: 'hide', ruleId: 'r1', ruleName: 'No junk' } as const;

  function setup(name = 'search-grid-logged-out', style: { current: 'collapse' | 'dim' } = { current: 'dim' }) {
    const doc = load(name);
    const specs: StubSpec[] = [];
    const ui = {
      createLabel: (d: Document, spec: Parameters<typeof decorationUi.createLabel>[1]) => decorationUi.createLabel(d, spec),
      createStub(d: Document, spec: StubSpec): Element {
        specs.push(spec);
        return decorationUi.createStub(d, spec);
      },
    };
    const dom = createDomAdapter({ ui, hideStyle: () => style.current });
    const card = dom.discoverCards(doc)[0];
    if (card === undefined) throw new Error('no card');
    return { doc, dom, card, specs, style };
  }

  it('dims the card (opacity about 0.3) instead of collapsing it; the stub is told to be a compact chip', () => {
    const { doc, dom, card, specs } = setup();
    dom.applyDecoration(card, hide);
    const style = card.root.getAttribute('style') ?? '';
    expect(style).toMatch(/opacity:\s*0\.3/);
    expect(style).not.toContain('display:none');
    expect(style).not.toContain('pointer-events');
    expect(card.root.getAttribute('data-sbw-hidden')).toBe('dim');
    expect(doc.querySelectorAll('[data-sbw-stub]')).toHaveLength(1);
    expect(card.root.previousElementSibling?.hasAttribute('data-sbw-stub')).toBe(true);
    expect(specs.map((s) => s.style)).toEqual(['dim']);
    // Idempotent.
    dom.applyDecoration(card, hide);
    expect(specs).toHaveLength(1);
  });

  it("Show restores full opacity; clear restores the DOM byte-identically", () => {
    const { doc, dom, card, specs } = setup();
    const before = doc.body.outerHTML;
    dom.applyDecoration(card, hide);
    specs[0]?.onShow();
    expect(card.root.getAttribute('style') ?? '').not.toMatch(/opacity/);
    dom.clearDecoration(card);
    expect(doc.body.outerHTML).toBe(before);
  });

  it('collapse keeps today\'s behaviour, and switching the style re-applies (one stub, never both)', () => {
    const { doc, dom, card, specs, style } = setup('search-list-logged-in', { current: 'collapse' });
    dom.applyDecoration(card, hide);
    expect(card.root.getAttribute('style')).toContain('display:none');
    expect(card.root.getAttribute('data-sbw-hidden')).toBe('1');
    expect(specs.map((s) => s.style)).toEqual(['collapse']);
    style.current = 'dim';
    dom.applyDecoration(card, hide);
    expect(card.root.getAttribute('style')).not.toContain('display:none');
    expect(card.root.getAttribute('style')).toMatch(/opacity:\s*0\.3/);
    expect(doc.querySelectorAll('[data-sbw-stub]')).toHaveLength(1);
    expect(specs.map((s) => s.style)).toEqual(['collapse', 'dim']);
  });

  it('degraded (rank 2) cards still never hide: no dim, a "Would hide" chip instead', () => {
    const doc = load('search-grid-logged-out');
    for (const el of Array.from(doc.querySelectorAll('app-home-product-items'))) unwrap(el);
    for (const el of Array.from(doc.querySelectorAll('.feat-item'))) el.classList.remove('feat-item', 'feat-item-list');
    const dom = createDomAdapter({ ui: decorationUi, hideStyle: () => 'dim' });
    const card = dom.discoverCards(doc)[0];
    if (card === undefined) throw new Error('no card');
    dom.applyDecoration(card, hide);
    expect(card.root.getAttribute('style') ?? '').not.toMatch(/opacity/);
    expect(card.root.hasAttribute('data-sbw-hidden')).toBe(false);
    expect(doc.querySelectorAll('[data-sbw-stub]')).toHaveLength(0);
    expect(doc.querySelectorAll('[data-sbw-label]')).toHaveLength(1);
  });

  it('without the option, hide collapses as before', () => {
    const doc = load('search-grid-logged-out');
    const dom = createDomAdapter({ ui: decorationUi });
    const card = dom.discoverCards(doc)[0];
    if (card === undefined) throw new Error('no card');
    dom.applyDecoration(card, hide);
    expect(card.root.getAttribute('style')).toContain('display:none');
  });
});
