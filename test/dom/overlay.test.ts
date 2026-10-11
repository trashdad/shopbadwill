// T-32: the content overlay (ISOLATED world) over the real search-page
// fixtures, with a fake background (FakeMessaging) and a fake storage area.
//
// Browser behaviour happy-dom does not model is emulated explicitly:
//  - `isTrusted`: happy-dom leaves it undefined; trusted events get it defined.
//  - Enter on a focused native <button> fires a (trusted) click.
//  - Tab moves focus to the next tabbable control unless a handler prevents it.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { SGW_CONFIG_VERSION } from '../../src/adapters/sgw/config';
import { NONCE_ATTR, TAP_SOURCE } from '../../src/content/api-tap.main';
import { startOverlay, type Overlay } from '../../src/content/sgw-overlay';
import { BADGES, loadBadges, type CardBadge } from '../../src/content/ui/badge-registry';
import { uiRootForTest } from '../../src/content/ui/shadow';
import { PAGE_CSS, TOOLS_CSS } from '../../src/content/ui/styles';
import { shadowRootForTest } from '../../src/content/ui/stub';
import type { MatchResult, Rule } from '../../src/domain/rules/schema';
import { defaultSettings } from '../../src/domain/settings/defaults';
import type { Settings } from '../../src/domain/settings/schema';
import { formatDual, parsePacific } from '../../src/domain/time/pacific';
import type { Listing } from '../../src/domain/types';
import { FakeMessaging } from '../fakes/ports/fake-messaging';
import { FakeStorage } from '../fakes/ports/fake-storage';

// 2026-10-07 12:00 PDT. The search fixture rows end 2026-10-07 ~20:00 PT, the same day.
const NOW = Date.UTC(2026, 9, 7, 19, 0, 0);
const SEARCH_URL = 'https://shopgoodwill.com/categories/listing?st=pyrex&p=1';
const ITEM_URL = 'https://shopgoodwill.com/item/694349278';
const SEARCH_API = 'https://buyerapi.shopgoodwill.com/api/Search/ItemListing';
const BEARER = 'eyJhbGciOiJIUzI1NiJ9.eyJCdXllcklkIjoiMSJ9.c2lnbmF0dXJl';
const DETAIL = "title contains 'pyrex' (whole word)";

const ROOT = resolve(__dirname, '../..');
const FIX = resolve(ROOT, 'test/fixtures/sgw');

interface SearchJson {
  searchResults: { items: Array<Record<string, unknown>>; itemCount: number };
  [k: string]: unknown;
}
const SEARCH_JSON = JSON.parse(readFileSync(resolve(FIX, 'json/search-grid-p1.json'), 'utf8')) as SearchJson;
const EMPTY_JSON = JSON.parse(readFileSync(resolve(FIX, 'json/search-empty.json'), 'utf8')) as SearchJson;

function rule(id: string, name: string, action: Rule['action'], tone?: Rule['tone']): Rule {
  return { id, name, enabled: true, action, ...(tone ? { tone } : {}), all: [], createdAt: 1, updatedAt: 1 };
}
const HIDE = rule('r-hide', 'No pyrex', 'hide');
const HL = rule('r-hl', 'Cheap glass', 'highlight', 'green');

function hit(itemId: number, r: Rule, details: string[] = [DETAIL]): MatchResult {
  return {
    itemId,
    decision: r.action,
    matched: [
      {
        ruleId: r.id,
        action: r.action,
        reasons: details.map((detail, i) => ({ ruleId: r.id, conditionIndex: i, field: 'title', detail })),
      },
    ],
    unknownConditions: 0,
  };
}
const none = (itemId: number): MatchResult => ({ itemId, decision: 'none', matched: [], unknownConditions: 0 });

// ── page fixture ────────────────────────────────────────────────────────────

function fixtureDoc(name: string): Document {
  return new DOMParser().parseFromString(readFileSync(resolve(FIX, `html/${name}.html`), 'utf8'), 'text/html');
}
function loadFixture(name: string): number[] {
  const parsed = fixtureDoc(name);
  document.body.replaceChildren(...Array.from(parsed.body.childNodes).map((n) => document.importNode(n, true)));
  return cardIds();
}
function cardIds(): number[] {
  return Array.from(document.querySelectorAll('app-home-product-items a.feat-item_name')).map((a) => Number(a.id));
}
/** The grid's results container (parent of the `.item-col` cells). */
function gridContainer(doc: Document = document): Element {
  const parent = doc.querySelector('.item-col')?.parentElement;
  if (parent == null) throw new Error('no grid container');
  return parent;
}
/** An Angular-style re-render: the result cells are rebuilt from the template (fresh nodes, none of ours). */
function rerenderCards(name = 'search-grid-logged-in'): void {
  const fresh = Array.from(gridContainer(fixtureDoc(name)).childNodes).map((n) => document.importNode(n, true));
  gridContainer().replaceChildren(...fresh);
}

function searchBody(ids: number[], patch: (row: Record<string, unknown>, i: number) => void = () => undefined): SearchJson {
  const body = structuredClone(SEARCH_JSON);
  const rows = SEARCH_JSON.searchResults.items;
  body.searchResults.items = ids.map((id, i) => {
    const row = structuredClone(rows[i % rows.length] ?? {});
    row['itemId'] = id;
    patch(row, i);
    return row;
  });
  body.searchResults.itemCount = ids.length;
  return body;
}

function post(data: unknown, source: unknown = window): void {
  const ev = new MessageEvent('message', { data });
  Object.defineProperty(ev, 'source', { value: source });
  window.dispatchEvent(ev);
}
function tapSearch(o: Overlay, body: unknown, url = SEARCH_API): void {
  post({ source: TAP_SOURCE, nonce: o.nonce, kind: 'response', url, status: 200, body });
}

// ── events ──────────────────────────────────────────────────────────────────

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function click(el: Element, isTrusted: boolean): void {
  const ev = new MouseEvent('click', { bubbles: true, composed: true, cancelable: true });
  Object.defineProperty(ev, 'isTrusted', { value: isTrusted });
  el.dispatchEvent(ev);
}
function key(el: Element, k: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const ev = new KeyboardEvent('keydown', { key: k, bubbles: true, composed: true, cancelable: true, ...init });
  Object.defineProperty(ev, 'isTrusted', { value: true });
  el.dispatchEvent(ev);
  return ev;
}
function tabbables(root: ParentNode): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>('button, input, a[href], [tabindex]')).filter(
    (el) => !(el as HTMLButtonElement).disabled && el.tabIndex >= 0 && el.closest('[hidden]') === null,
  );
}
/** A browser's Enter on a focused native button: keydown, then (unless prevented) a trusted click. */
function pressEnter(el: HTMLElement): void {
  const ev = key(el, 'Enter');
  if (!ev.defaultPrevented && el instanceof HTMLButtonElement && !el.disabled) click(el, true);
}
/** A browser's Tab inside one shadow root: keydown on the focused control, then (unless prevented) focus moves on. */
function pressTab(root: ShadowRoot, shiftKey = false): void {
  const active = root.activeElement as HTMLElement | null;
  if (active === null) throw new Error('nothing focused');
  const ev = key(active, 'Tab', { shiftKey });
  if (ev.defaultPrevented) return;
  const list = tabbables(root);
  const i = list.indexOf(active);
  list[(i + (shiftKey ? -1 : 1) + list.length) % list.length]?.focus();
}

// ── overlay queries ─────────────────────────────────────────────────────────

function pageRoot(): ShadowRoot {
  const host = document.querySelector('shopbadwill-badge');
  if (host?.shadowRoot == null) throw new Error('no page UI host');
  return host.shadowRoot;
}
const norm = (s: string | null | undefined): string => (s ?? '').replace(/\s+/g, ' ').trim();
const barText = (): string => norm(pageRoot().querySelector('[role="status"]')?.textContent);
function cardRoot(id: number): Element {
  const root = document.querySelector(`a.feat-item_name[id="${String(id)}"]`)?.closest('app-home-product-items');
  if (root == null) throw new Error(`no card ${String(id)}`);
  return root;
}
function stubRow(id: number): Element | null {
  const prev = cardRoot(id).previousElementSibling;
  return prev?.hasAttribute('data-sbw-stub') === true ? prev : null;
}
function stubShow(id: number): HTMLButtonElement {
  const btn = shadowRootForTest(stubRow(id)?.querySelector('sbw-stub') ?? null)?.querySelector('button');
  if (btn == null) throw new Error('no stub Show button');
  return btn;
}
function closedRoot(host: Element | null | undefined): ShadowRoot {
  const root = uiRootForTest(host ?? null);
  if (root === undefined) throw new Error('no closed UI root');
  return root;
}
const stubWhyRoot = (id: number): ShadowRoot => closedRoot(stubRow(id)?.querySelector('[data-sbw-why]'));
const toolsRoot = (id: number): ShadowRoot => closedRoot(cardRoot(id).querySelector('[data-sbw-tools]'));
const isHidden = (id: number): boolean => /display:\s*none/.test(cardRoot(id).getAttribute('style') ?? '');
const count = (sel: string): number => document.querySelectorAll(sel).length;
function button(root: ParentNode, action: string): HTMLButtonElement {
  const b = root.querySelector<HTMLButtonElement>(`button[data-action="${action}"]`);
  if (b === null) throw new Error(`no button ${action}`);
  return b;
}
/** Every open `<dialog>`, including those in closed shadow roots. */
function openDialogs(root: ParentNode = document): HTMLDialogElement[] {
  const out: HTMLDialogElement[] = [];
  const visit = (node: ParentNode): void => {
    for (const d of Array.from(node.querySelectorAll('dialog'))) {
      if (d instanceof HTMLDialogElement && d.open) out.push(d);
    }
    for (const el of Array.from(node.querySelectorAll('*'))) {
      const sr = el.shadowRoot ?? uiRootForTest(el) ?? shadowRootForTest(el);
      if (sr != null) visit(sr);
    }
  };
  visit(root);
  return out;
}
/** An ancestor (shadow hosts included) is `display:none` or `hidden`. */
function insideHidden(el: Element): boolean {
  let n: Node | null = el;
  while (n !== null) {
    if (n instanceof HTMLElement && (n.hidden || /display:\s*none/i.test(n.getAttribute('style') ?? ''))) return true;
    const parent: Node | null = n.parentNode;
    n = parent instanceof ShadowRoot ? parent.host : parent;
  }
  return false;
}
/** The closed root of the document-level host the Why? dialog of `id` is rendered into. */
function modalRoot(id: number): ShadowRoot {
  return closedRoot(document.querySelector(`sbw-why-modal[data-sbw-why-modal="${String(id)}"]`));
}
/** The focused element, through every shadow root (closed ones too). */
function deepActive(): Element | null {
  let a: Element | null = document.activeElement;
  while (a !== null) {
    const r = a.shadowRoot ?? uiRootForTest(a) ?? shadowRootForTest(a);
    if (r?.activeElement == null) break;
    a = r.activeElement;
  }
  return a;
}
function sentOf(m: FakeMessaging, type: string): unknown[] {
  return m.sent.filter((s) => s.type === type).map((s) => s.payload);
}

// ── setup ───────────────────────────────────────────────────────────────────

let current: Overlay | null = null;

afterEach(() => {
  current?.stop();
  current = null;
  document.body.replaceChildren();
  for (const host of Array.from(document.querySelectorAll('sbw-why-modal'))) host.remove();
  document.documentElement.removeAttribute(NONCE_ATTR);
  vi.restoreAllMocks();
});

interface SetupOpts {
  fixture?: string;
  url?: string;
  settings?: Settings;
  rules?: Rule[];
  badges?: readonly CardBadge[];
  settleMs?: number;
  noReplyMs?: number;
  debounceMs?: number;
  retryMs?: number;
  /** Raw `sbw:settings` record (overrides `settings`), e.g. an invalid one. */
  rawSettings?: unknown;
  /** Every storage read rejects (e.g. the extension context is going away). */
  storageGetThrows?: boolean;
  /** Runs on the loaded fixture before the overlay starts. */
  prepare?: () => void;
}

async function setup(opts: SetupOpts = {}) {
  const ids = loadFixture(opts.fixture ?? 'search-grid-logged-in');
  opts.prepare?.();
  const loc = { href: opts.url ?? SEARCH_URL };
  const storage = new FakeStorage();
  storage.seed({
    'sbw:settings': 'rawSettings' in opts ? opts.rawSettings : (opts.settings ?? defaultSettings()),
    'sbw:rules': opts.rules ?? [HIDE, HL],
  });
  const decisions = new Map<number, MatchResult>();
  /** Message types whose background handler throws. */
  const fail = new Set<string>();
  const m = new FakeMessaging();
  const ack = (type: string) => () => {
    if (fail.has(type)) throw new Error(`${type} failed`);
    return undefined;
  };
  m.handle('page.listings', ack('page.listings'));
  m.handle('page.token', ack('page.token'));
  m.handle('page.domHealth', ack('page.domHealth'));
  m.handle('rules.evaluate', ({ listings }) => {
    if (fail.has('rules.evaluate')) throw new Error('background not ready');
    return listings.map((l: Listing) => decisions.get(l.itemId) ?? none(l.itemId));
  });
  m.handle('quick.favorite', ack('quick.favorite'));
  m.handle('quick.track', ack('quick.track'));
  m.handle('quick.hideSeller', ack('quick.hideSeller'));
  m.handle('quick.hideKeyword', ack('quick.hideKeyword'));
  m.handle('rules.disable', ack('rules.disable'));
  const overlay = startOverlay({
    win: window,
    messaging: m,
    storage:
      opts.storageGetThrows === true
        ? { get: () => Promise.reject(new Error('storage unavailable')), onChanged: (cb) => storage.onChanged(cb) }
        : storage,
    getUrl: () => loc.href,
    now: () => NOW,
    debounceMs: opts.debounceMs ?? 10,
    settleMs: opts.settleMs ?? 40,
    noReplyMs: opts.noReplyMs ?? 60,
    retryMs: opts.retryMs ?? 30,
    badges: opts.badges ?? [],
  });
  current = overlay;
  await overlay.ready;
  return {
    ids,
    m,
    fail,
    storage,
    overlay,
    loc,
    decide(id: number, r: Rule, details?: string[]): void {
      decisions.set(id, hit(id, r, details));
    },
    /** A result matching several rules; `decision` per the engine's precedence. */
    decideAll(id: number, decision: MatchResult['decision'], matchedRules: Rule[]): void {
      decisions.set(id, {
        itemId: id,
        decision,
        matched: matchedRules.map((r) => ({
          ruleId: r.id,
          action: r.action,
          reasons: [{ ruleId: r.id, conditionIndex: 0, field: 'title', detail: DETAIL }],
        })),
        unknownConditions: 0,
      });
    },
    /** Tap-relays a search reply for every card on the page and waits for the decorations. */
    async feed(patch?: (row: Record<string, unknown>, i: number) => void): Promise<void> {
      tapSearch(overlay, searchBody(ids, patch));
      await overlay.scan();
      await tick();
    },
  };
}

// ── tests ───────────────────────────────────────────────────────────────────

describe('tap input (untrusted)', () => {
  it('sets the nonce on <html> synchronously at start', () => {
    loadFixture('search-grid-logged-in');
    const storage = new FakeStorage();
    const overlay = startOverlay({ win: window, messaging: new FakeMessaging(), storage, getUrl: () => SEARCH_URL, badges: [] });
    current = overlay;
    expect(document.documentElement.getAttribute(NONCE_ATTR)).toBe(overlay.nonce);
    expect(overlay.nonce.length).toBeGreaterThanOrEqual(16);
  });

  it('forwards a relayed bearer as page.token, and search replies as page.listings with source "tap"', async () => {
    const { m, overlay, ids } = await setup();
    post({ source: TAP_SOURCE, nonce: overlay.nonce, kind: 'token', bearer: BEARER });
    expect(sentOf(m, 'page.token')).toEqual([{ bearer: BEARER, capturedAt: NOW }]);

    tapSearch(overlay, searchBody(ids));
    await overlay.scan();
    const [payload] = sentOf(m, 'page.listings') as Array<{ url: string; listings: Listing[]; capturedAt: number }>;
    expect(payload?.url).toBe(SEARCH_URL);
    expect(payload?.capturedAt).toBe(NOW);
    expect(payload?.listings.map((l) => l.itemId)).toEqual(ids);
    expect(payload?.listings.every((l) => l.source === 'tap')).toBe(true);
  });

  it('drops a wrong nonce, a foreign source, a non-buyerapi url, a non-JWT token and a malformed body', async () => {
    const { m, overlay, ids } = await setup();
    const body = searchBody(ids);
    post({ source: TAP_SOURCE, nonce: 'wrong', kind: 'response', url: SEARCH_API, status: 200, body });
    post({ source: TAP_SOURCE, nonce: overlay.nonce, kind: 'response', url: SEARCH_API, status: 200, body }, null);
    post({ source: TAP_SOURCE, nonce: overlay.nonce, kind: 'response', url: 'https://evil.test/api/Search/ItemListing', status: 200, body });
    post({ source: TAP_SOURCE, nonce: overlay.nonce, kind: 'token', bearer: 'not a jwt' });
    post({ source: TAP_SOURCE, nonce: overlay.nonce, kind: 'response', url: SEARCH_API, status: 200, body: { searchResults: 'nope' } });
    post({ source: TAP_SOURCE, nonce: overlay.nonce, kind: 'response', url: SEARCH_API, status: 500, body });
    post('a string');
    await overlay.scan();
    expect(sentOf(m, 'page.token')).toEqual([]);
    expect(sentOf(m, 'page.listings')).toEqual([]);
    expect(sentOf(m, 'rules.evaluate')).toEqual([]);
  });

  it('a text/html title with <script> renders as text', async () => {
    const evil = '<script>window.__sbwPwned = 1</script><img src=x onerror="window.__sbwPwned=2"><b>Pyrex</b>';
    const evilRule = rule('r-evil', '<b>bold</b><script>1</script>', 'hide');
    const s = await setup({ rules: [evilRule, HL] });
    const id = s.ids[0] ?? 0;
    s.decide(id, evilRule, [`title contains '<script>'`]);
    s.decide(s.ids[1] ?? 0, HL);
    await s.feed((row, i) => {
      if (i <= 1) row['title'] = evil;
    });

    // Stub (T-27) shows the rule name as text.
    const stubText = norm(shadowRootForTest(stubRow(id)?.querySelector('sbw-stub') ?? null)?.textContent);
    expect(stubText).toContain('<b>bold</b><script>1</script>');

    // The Why? dialog shows the (hostile) title, rule name and reason as text.
    const why = stubWhyRoot(id);
    click(button(why, 'why'), true);
    await tick();
    const whyModal = modalRoot(id);
    const dialog = whyModal.querySelector('[role="dialog"]');
    expect(norm(dialog?.textContent)).toContain(evil);
    expect(norm(dialog?.textContent)).toContain("title contains '<script>'");

    const tools = toolsRoot(s.ids[1] ?? 0);
    click(button(tools, 'why'), true);
    await tick();
    const toolsDialog = openDialogs().find((d) => d.getRootNode() !== whyModal);
    expect(norm(toolsDialog?.textContent)).toContain(evil);
    const toolsDialogRoot = toolsDialog?.getRootNode();

    for (const r of [why, whyModal, tools, pageRoot(), ...(toolsDialogRoot instanceof ShadowRoot ? [toolsDialogRoot] : [])]) {
      expect(r.querySelector('script, img, b')).toBeNull();
    }
    expect(document.querySelectorAll('script').length).toBe(0);
    expect((window as unknown as { __sbwPwned?: number }).__sbwPwned).toBeUndefined();
  });
});

describe('decorations', () => {
  it('hides and highlights per rules.evaluate, with the rule name on the stub', async () => {
    const s = await setup();
    const [a, b, c] = s.ids as [number, number, number];
    s.decide(a, HIDE);
    s.decide(b, HL);
    await s.feed();
    expect(isHidden(a)).toBe(true);
    expect(norm(shadowRootForTest(stubRow(a)?.querySelector('sbw-stub') ?? null)?.textContent)).toContain('No pyrex');
    expect(isHidden(b)).toBe(false);
    expect(cardRoot(b).querySelector('[data-sbw-label]')).not.toBeNull();
    expect(stubRow(c)).toBeNull();
    expect(cardRoot(c).querySelector('[data-sbw-label]')).toBeNull();
    // Every card gets exactly one tools row.
    expect(count('[data-sbw-tools]')).toBe(40);
  });

  it('is idempotent under three re-renders', async () => {
    const s = await setup();
    const hidden = s.ids.slice(0, 3);
    for (const id of hidden) s.decide(id, HIDE);
    s.decide(s.ids[5] ?? 0, HL);
    s.decide(s.ids[6] ?? 0, HL);
    await s.feed();
    const snapshot = () => ({
      stubs: count('[data-sbw-stub]'),
      labels: count('[data-sbw-label]'),
      tools: count('[data-sbw-tools]'),
      hidden: hidden.map(isHidden),
      bar: barText(),
    });
    const first = snapshot();
    expect(first).toEqual({ stubs: 3, labels: 2, tools: 40, hidden: [true, true, true], bar: '3 hidden · Show' });

    // Three re-scans of an unchanged page: no DOM change at all, no new evaluation.
    const records: MutationRecord[] = [];
    const mo = new MutationObserver((r) => records.push(...r));
    mo.observe(document.body, { childList: true, subtree: true, attributes: true, characterData: true });
    for (let i = 0; i < 3; i++) await s.overlay.scan();
    await tick();
    records.push(...mo.takeRecords());
    mo.disconnect();
    expect(records).toEqual([]);
    expect(snapshot()).toEqual(first);

    // Three SPA re-renders (fresh card nodes): same decorations, no duplicates, still one evaluation.
    for (let i = 0; i < 3; i++) {
      rerenderCards();
      await vi.waitFor(() => {
        expect(snapshot()).toEqual(first);
      });
      await s.overlay.scan();
      expect(snapshot()).toEqual(first);
    }
    expect(sentOf(s.m, 'rules.evaluate')).toHaveLength(1);
  });

  it('never decorates an item page (its related cards included)', async () => {
    const s = await setup({ fixture: 'item-page-logged-in', url: ITEM_URL });
    for (const id of s.ids) s.decide(id, HIDE);
    expect(s.ids.length).toBe(5);
    await s.feed();
    expect(count('[data-sbw-stub], [data-sbw-label], [data-sbw-tools]')).toBe(0);
    expect(sentOf(s.m, 'rules.evaluate')).toEqual([]);
    expect(sentOf(s.m, 'page.domHealth')).toEqual([]);
    expect(barText()).toBe('ShopBadwill ready');
  });

  it('a card without tap data is never hidden (unknown never holds)', async () => {
    const s = await setup();
    for (const id of s.ids) s.decide(id, HIDE);
    tapSearch(s.overlay, searchBody(s.ids.slice(0, 10)));
    await s.overlay.scan();
    expect(s.ids.filter(isHidden)).toEqual(s.ids.slice(0, 10));
    const [evaluated] = sentOf(s.m, 'rules.evaluate') as Array<{ listings: Listing[] }>;
    expect(evaluated?.listings.map((l) => l.itemId)).toEqual(s.ids.slice(0, 10));
  });

  it('makes zero requests to SGW (no fetch, no XHR)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const xhrSpy = vi.spyOn(XMLHttpRequest.prototype, 'open');
    const s = await setup({ badges: BADGES });
    s.decide(s.ids[0] ?? 0, HIDE);
    await s.feed();
    click(button(toolsRoot(s.ids[1] ?? 0), 'actions'), true);
    await tick();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(xhrSpy).not.toHaveBeenCalled();
  });
});

describe('hidden bar, stubs and undo', () => {
  it('hidden count matches', async () => {
    const s = await setup();
    const hidden = s.ids.slice(0, 5);
    for (const id of hidden) s.decide(id, HIDE);
    s.decide(s.ids[7] ?? 0, HL);
    await s.feed();
    expect(barText()).toBe('5 hidden · Show');
    expect(s.ids.filter(isHidden)).toEqual(hidden);
    expect(count('[data-sbw-stub]')).toBe(5);

    // Show one card from its stub.
    click(stubShow(hidden[0] ?? 0), true);
    await tick();
    expect(isHidden(hidden[0] ?? 0)).toBe(false);
    expect(barText()).toBe('4 hidden · Show');

    // Show the rest from the bar; then hide them all again.
    click(button(pageRoot(), 'show-all'), true);
    await tick();
    expect(s.ids.filter(isHidden)).toEqual([]);
    expect(barText()).toBe('5 shown · Hide again');
    click(button(pageRoot(), 'hide-again'), true);
    await tick();
    expect(s.ids.filter(isHidden)).toEqual(hidden);
    expect(barText()).toBe('5 hidden · Show');
    expect(count('[data-sbw-stub]')).toBe(5);
  });

  it('a revealed card stays revealed across an SPA re-render of the same page', async () => {
    const s = await setup();
    const id = s.ids[2] ?? 0;
    s.decide(id, HIDE);
    await s.feed();
    click(stubShow(id), true);
    await tick();
    rerenderCards();
    await vi.waitFor(() => {
      expect(count('[data-sbw-tools]')).toBe(40);
    });
    await s.overlay.scan();
    expect(isHidden(id)).toBe(false);
    expect(barText()).toBe('1 shown · Hide again');
  });

  it('degraded (structural fallback) cards are never hidden or counted', async () => {
    const s = await setup({
      prepare: () => {
        for (const el of Array.from(document.querySelectorAll('app-home-product-items'))) {
          el.replaceWith(...Array.from(el.childNodes));
        }
        for (const el of Array.from(document.querySelectorAll('.feat-item'))) el.classList.remove('feat-item');
      },
    });
    s.decide(s.ids[0] ?? 0, HIDE);
    await s.feed();
    expect(count('[data-sbw-stub]')).toBe(0);
    expect(count('[data-sbw-hidden]')).toBe(0);
    expect(count('[data-sbw-label]')).toBe(1); // "Would hide: No pyrex"
    expect(barText()).toBe('ShopBadwill: nothing hidden');
  });

  it('stop() restores the page exactly', async () => {
    let before = '';
    const s = await setup({
      prepare: () => {
        before = gridContainer().outerHTML;
      },
    });
    for (const id of s.ids.slice(0, 4)) s.decide(id, HIDE);
    s.decide(s.ids[9] ?? 0, HL);
    await s.feed();
    click(stubShow(s.ids[0] ?? 0), true);
    await tick();
    expect(gridContainer().outerHTML).not.toBe(before);
    s.overlay.stop();
    current = null;
    expect(gridContainer().outerHTML).toBe(before);
    expect(document.querySelector('shopbadwill-badge')).toBeNull();
  });
});

describe('Why? popover', () => {
  it('Why? text equals MatchReason.detail (stub and tools row)', async () => {
    const s = await setup();
    const [a, b] = s.ids as [number, number];
    const details = ["title contains 'pyrex' (whole word)", 'price is $4.00 (at most $5.00)'];
    s.decide(a, HIDE, details);
    s.decide(b, HL, ['bids: 0 (at most 1)']);
    await s.feed();

    click(button(stubWhyRoot(a), 'why'), true);
    await tick();
    const stub = modalRoot(a);
    expect(Array.from(stub.querySelectorAll('[role="dialog"] li[data-reason]')).map((li) => li.textContent)).toEqual(details);

    const tools = toolsRoot(b);
    click(button(tools, 'why'), true);
    await tick();
    const toolsDialog = openDialogs().find((d) => d.getRootNode() !== stub);
    expect(Array.from(toolsDialog?.querySelectorAll('li[data-reason]') ?? []).map((li) => li.textContent)).toEqual([
      'bids: 0 (at most 1)',
    ]);
  });

  it('cards that matched nothing have no Why? button', async () => {
    const s = await setup();
    await s.feed();
    expect(toolsRoot(s.ids[0] ?? 0).querySelector('button[data-action="why"]')).toBeNull();
  });
});

describe('keyboard', () => {
  it('stubs and bar are operable with Tab/Enter', async () => {
    const s = await setup();
    const hidden = s.ids.slice(0, 3);
    for (const id of hidden) s.decide(id, HIDE);
    await s.feed();

    // Stub: its Show control is a tabbable native button; Enter reveals the card.
    const show = stubShow(hidden[0] ?? 0);
    expect(tabbables(show.getRootNode() as ShadowRoot)).toContain(show);
    show.focus();
    pressEnter(show);
    await tick();
    expect(isHidden(hidden[0] ?? 0)).toBe(false);
    expect(barText()).toBe('2 hidden · Show');

    // Bar: Show is tabbable; Enter reveals the rest; then Hide again is focusable and works.
    const showAll = button(pageRoot(), 'show-all');
    expect(tabbables(pageRoot())).toContain(showAll);
    showAll.focus();
    pressEnter(showAll);
    await tick();
    expect(s.ids.filter(isHidden)).toEqual([]);
    const again = button(pageRoot(), 'hide-again');
    again.focus();
    pressEnter(again);
    await tick();
    expect(s.ids.filter(isHidden)).toEqual(hidden);
  });

  it('the Why? popover opens with Enter, traps Tab and closes on Escape, returning focus', async () => {
    const s = await setup();
    const id = s.ids[0] ?? 0;
    s.decide(id, HIDE, ['a', 'b']);
    await s.feed();
    const root = stubWhyRoot(id);
    const why = button(root, 'why');
    expect(tabbables(root)).toContain(why);
    const showModal = vi.spyOn(HTMLDialogElement.prototype, 'showModal');
    why.focus();
    pressEnter(why);
    await tick();
    // The dialog lives in its own closed host on the document (fix round 4).
    const modal = modalRoot(id);
    const dialog = modal.querySelector<HTMLElement>('[role="dialog"]');
    expect(dialog).not.toBeNull();
    // A native modal <dialog> (top layer, inert page, native Escape).
    expect(dialog).toBeInstanceOf(HTMLDialogElement);
    expect((dialog as HTMLDialogElement).open).toBe(true);
    expect(showModal).toHaveBeenCalledTimes(1);
    expect(why.getAttribute('aria-expanded')).toBe('true');
    // Focus moved into the dialog.
    expect(dialog?.contains(modal.activeElement)).toBe(true);
    const inside = tabbables(dialog ?? modal);
    expect(inside.length).toBeGreaterThan(0);
    // Tab from the last control wraps to the first; Shift+Tab from the first wraps to the last.
    inside[inside.length - 1]?.focus();
    pressTab(modal);
    expect(modal.activeElement).toBe(inside[0]);
    pressTab(modal, true);
    expect(modal.activeElement).toBe(inside[inside.length - 1]);
    // Escape closes and returns focus to Why?.
    key(modal.activeElement as HTMLElement, 'Escape');
    await tick();
    expect(document.querySelector('sbw-why-modal')).toBeNull();
    expect(root.activeElement).toBe(why);
    expect(why.getAttribute('aria-expanded')).toBe('false');

    // The browser closing it natively (Escape via 'cancel', or close()) syncs the state too.
    pressEnter(why);
    await tick();
    const again = modalRoot(id).querySelector('dialog');
    expect(again?.open).toBe(true);
    again?.close();
    await tick();
    expect(document.querySelector('sbw-why-modal')).toBeNull();
    expect(why.getAttribute('aria-expanded')).toBe('false');
    expect(root.activeElement).toBe(why);
  });

  it('"Disable rule" in the Why? dialog sends rules.disable on a trusted click only', async () => {
    const s = await setup();
    const id = s.ids[0] ?? 0;
    s.decide(id, HIDE);
    await s.feed();
    click(button(stubWhyRoot(id), 'why'), true);
    await tick();
    const root = modalRoot(id);
    const disable = button(root, 'disable-rule');
    expect(disable.getAttribute('data-rule-id')).toBe('r-hide');
    disable.click();
    click(disable, false);
    await tick();
    expect(sentOf(s.m, 'rules.disable')).toEqual([]);
    click(disable, true);
    await vi.waitFor(() => {
      expect(sentOf(s.m, 'rules.disable')).toEqual([{ ruleId: 'r-hide' }]);
    });
    await vi.waitFor(() => {
      expect(norm(root.querySelector('[data-why-status]')?.textContent)).toMatch(/turned off/i);
    });
  });
});

describe('quick actions (closed shadow root, trusted clicks only)', () => {
  const withFavorite = (): Settings => {
    const st = defaultSettings();
    st.overlay.quickFavorite = true;
    return st;
  };

  it('a synthetic (isTrusted: false) click on quick favorite or track sends nothing', async () => {
    const s = await setup({ settings: withFavorite() });
    await s.feed();
    const id = s.ids[3] ?? 0;
    const host = cardRoot(id).querySelector('[data-sbw-tools]');
    expect(host?.shadowRoot).toBeNull(); // closed
    const root = toolsRoot(id);
    click(button(root, 'actions'), true);
    await tick();
    for (const action of ['favorite', 'track']) {
      const b = button(root, action);
      b.click(); // script click: no isTrusted
      click(b, false);
      b.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    }
    await tick();
    expect(sentOf(s.m, 'quick.favorite')).toEqual([]);
    expect(sentOf(s.m, 'quick.track')).toEqual([]);

    click(button(root, 'favorite'), true);
    click(button(root, 'track'), true);
    await tick();
    expect(sentOf(s.m, 'quick.favorite')).toEqual([{ itemId: id }]);
    expect(sentOf(s.m, 'quick.track')).toEqual([{ itemId: id }]);
  });

  it('favorite is offered only when settings.overlay.quickFavorite is on', async () => {
    const s = await setup();
    await s.feed();
    const root = toolsRoot(s.ids[0] ?? 0);
    click(button(root, 'actions'), true);
    await tick();
    expect(root.querySelector('button[data-action="favorite"]')).toBeNull();
    expect(root.querySelector('button[data-action="track"]')).not.toBeNull();
  });

  it('hide seller and hide keyword send quick.* on trusted input only', async () => {
    const s = await setup();
    await s.feed();
    const id = s.ids[4] ?? 0;
    const sellerId = SEARCH_JSON.searchResults.items[4]?.['sellerId'];
    const root = toolsRoot(id);
    click(button(root, 'actions'), true);
    await tick();
    click(button(root, 'hide-seller'), false);
    click(button(root, 'hide-seller'), true);
    const form = root.querySelector('form[data-action="hide-keyword"]');
    const input = form?.querySelector('input');
    if (form == null || input == null) throw new Error('no keyword form');
    input.value = '  pyrex  ';
    const synthetic = new Event('submit', { bubbles: true, cancelable: true });
    form.dispatchEvent(synthetic);
    const trusted = new Event('submit', { bubbles: true, cancelable: true });
    Object.defineProperty(trusted, 'isTrusted', { value: true });
    form.dispatchEvent(trusted);
    await tick();
    expect(trusted.defaultPrevented).toBe(true);
    expect(sentOf(s.m, 'quick.hideSeller')).toEqual([{ sellerId, sellerName: '' }]);
    expect(sentOf(s.m, 'quick.hideKeyword')).toEqual([{ term: 'pyrex' }]);
  });

  it('a failing background call shows a message instead of throwing', async () => {
    const s = await setup();
    await s.feed();
    s.fail.add('quick.track');
    const root = toolsRoot(s.ids[0] ?? 0);
    click(button(root, 'actions'), true);
    await tick();
    click(button(root, 'track'), true);
    await vi.waitFor(() => {
      expect(norm(root.querySelector('[data-quick-status]')?.textContent)).not.toBe('');
    });
  });
});

describe('page lifecycle', () => {
  it('reacts to DOM changes through a debounced MutationObserver that ignores our own nodes', async () => {
    const s = await setup();
    s.decide(s.ids[0] ?? 0, HIDE);
    await s.feed();
    await new Promise((r) => setTimeout(r, 40));
    const scans = s.overlay.scanCount;
    // Our own DOM changes (stub rows removed and re-inserted by Show / Hide again) never trigger a scan.
    click(button(pageRoot(), 'show-all'), true);
    click(button(pageRoot(), 'hide-again'), true);
    expect(isHidden(s.ids[0] ?? 0)).toBe(true);
    await new Promise((r) => setTimeout(r, 40));
    expect(s.overlay.scanCount).toBe(scans);
  });

  it('debounces page mutations: several, each in its own task and closer than debounceMs, give one scan', async () => {
    const s = await setup({ debounceMs: 80 });
    await s.feed();
    await sleep(150);
    const scans = s.overlay.scanCount;
    for (let i = 0; i < 5; i++) {
      gridContainer().append(document.createElement('div'));
      await sleep(15);
    }
    expect(s.overlay.scanCount).toBe(scans); // still quiet: every gap was shorter than debounceMs
    await vi.waitFor(() => {
      expect(s.overlay.scanCount).toBe(scans + 1);
    });
    await sleep(200);
    expect(s.overlay.scanCount).toBe(scans + 1);
  });

  it('a page that never stops changing is still scanned at least every maxWait (4 x debounceMs)', async () => {
    const s = await setup({ debounceMs: 80 });
    await s.feed();
    await sleep(150);
    const scans = s.overlay.scanCount;
    const end = Date.now() + 1000;
    while (Date.now() < end) {
      gridContainer().append(document.createElement('div'));
      await sleep(30);
    }
    // ~1 s of mutations 30 ms apart: a plain debounce would not have scanned yet.
    expect(s.overlay.scanCount - scans).toBeGreaterThanOrEqual(2);
  });

  it('disconnects the observer on pagehide and resumes on a bfcache pageshow', async () => {
    const s = await setup();
    await s.feed();
    window.dispatchEvent(new Event('pagehide'));
    const scans = s.overlay.scanCount;
    gridContainer().append(document.createElement('div'));
    await new Promise((r) => setTimeout(r, 40));
    expect(s.overlay.scanCount).toBe(scans);
    const shown = new Event('pageshow');
    Object.defineProperty(shown, 'persisted', { value: true });
    window.dispatchEvent(shown);
    await vi.waitFor(() => {
      expect(s.overlay.scanCount).toBeGreaterThan(scans);
    });
  });

  it('on wxt:locationchange: leaving search clears everything; returning re-decorates with reveals reset', async () => {
    const s = await setup();
    const id = s.ids[0] ?? 0;
    s.decide(id, HIDE);
    await s.feed();
    click(stubShow(id), true);
    await tick();
    s.loc.href = ITEM_URL;
    s.overlay.onLocationChange(ITEM_URL);
    await s.overlay.scan();
    expect(count('[data-sbw-stub], [data-sbw-label], [data-sbw-tools]')).toBe(0);
    expect(barText()).toBe('ShopBadwill ready');
    s.loc.href = `${SEARCH_URL}&p=2`;
    s.overlay.onLocationChange(s.loc.href);
    await s.overlay.scan();
    expect(isHidden(id)).toBe(true);
    expect(barText()).toBe('1 hidden · Show');
  });

  it('overlay.enabled off: no decorations and no visible bar; the kill switch clears too', async () => {
    const off = defaultSettings();
    off.overlay.enabled = false;
    const s = await setup({ settings: off });
    s.decide(s.ids[0] ?? 0, HIDE);
    await s.feed();
    expect(count('[data-sbw-stub], [data-sbw-tools]')).toBe(0);
    expect(sentOf(s.m, 'rules.evaluate')).toEqual([]);
    expect(barText()).toBe('');
    // The tap keeps feeding the background even with the overlay off.
    expect(sentOf(s.m, 'page.listings')).toHaveLength(1);

    // Turn it on (storage change), then the kill switch broadcast clears it again.
    await s.storage.set({ 'sbw:settings': defaultSettings() });
    await vi.waitFor(() => {
      expect(isHidden(s.ids[0] ?? 0)).toBe(true);
    });
    s.m.broadcast('switches.changed', { killSwitch: true, writesAllowed: {} });
    await s.overlay.scan();
    expect(count('[data-sbw-stub], [data-sbw-label], [data-sbw-tools]')).toBe(0);
    expect(barText()).toBe('ShopBadwill paused (kill switch)');
  });

  it('retries a failed rules.evaluate with backoff, and says so meanwhile', async () => {
    const s = await setup();
    s.decide(s.ids[0] ?? 0, HIDE);
    s.fail.add('rules.evaluate');
    await s.feed();
    expect(isHidden(s.ids[0] ?? 0)).toBe(false);
    expect(barText()).toBe("ShopBadwill couldn't check your rules");
    // Re-scans do not hammer the background: no new attempt before the retry delay.
    await s.overlay.scan();
    expect(sentOf(s.m, 'rules.evaluate')).toHaveLength(1);
    s.fail.delete('rules.evaluate');
    await vi.waitFor(() => {
      expect(isHidden(s.ids[0] ?? 0)).toBe(true);
    });
    expect(barText()).toBe('1 hidden · Show');
  });

  it('a search reply for a new SPA url is recorded for that page (no false layout banner on an empty result)', async () => {
    const s = await setup();
    await s.feed();
    // The SPA moves to a search with no results: the reply can arrive before any re-scan.
    s.loc.href = `${SEARCH_URL}&st=zqxjvw`;
    gridContainer().replaceChildren();
    tapSearch(s.overlay, EMPTY_JSON);
    await new Promise((r) => setTimeout(r, 80));
    await s.overlay.scan();
    expect(pageRoot().querySelector('[role="alert"]')).toBeNull();
  });

  it('re-evaluates when the rules change (broadcast or storage)', async () => {
    const s = await setup();
    await s.feed();
    expect(sentOf(s.m, 'rules.evaluate')).toHaveLength(1);
    s.decide(s.ids[1] ?? 0, HIDE);
    s.m.broadcast('rules.changed', undefined);
    await vi.waitFor(() => {
      expect(isHidden(s.ids[1] ?? 0)).toBe(true);
    });
    expect(sentOf(s.m, 'rules.evaluate')).toHaveLength(2);
    await s.storage.set({ 'sbw:rules': [rule('r-hide', 'Renamed', 'hide'), HL] });
    await vi.waitFor(() => {
      expect(sentOf(s.m, 'rules.evaluate')).toHaveLength(3);
    });
    await vi.waitFor(() => {
      expect(norm(shadowRootForTest(stubRow(s.ids[1] ?? 0)?.querySelector('sbw-stub') ?? null)?.textContent)).toContain('Renamed');
    });
  });
});

describe('selector drift', () => {
  it('reports card-selector health once per page and per change', async () => {
    const s = await setup();
    await s.feed();
    for (let i = 0; i < 3; i++) await s.overlay.scan();
    expect(sentOf(s.m, 'page.domHealth')).toEqual([
      { url: SEARCH_URL, configVersion: SGW_CONFIG_VERSION, pageKind: 'search', cardsFound: 40, fallbackUsed: false },
    ]);
    // The primary card selector disappears: one more report, with the fallback flagged.
    for (const el of Array.from(document.querySelectorAll('app-home-product-items'))) el.replaceWith(...Array.from(el.childNodes));
    await s.overlay.scan();
    await s.overlay.scan();
    expect(sentOf(s.m, 'page.domHealth')).toHaveLength(2);
    expect(sentOf(s.m, 'page.domHealth')[1]).toMatchObject({ cardsFound: 40, fallbackUsed: true });
  });

  it('zero cards on a search page: "SGW layout changed, filters paused" banner and no decorations', async () => {
    const s = await setup({
      settleMs: 250,
      prepare: () => {
        gridContainer().replaceChildren();
      },
    });
    for (const id of s.ids) s.decide(id, HIDE);
    tapSearch(s.overlay, searchBody(s.ids));
    await s.overlay.scan();
    // Not before the page had time to settle: no banner and no early zero-card health report.
    expect(pageRoot().querySelector('[role="alert"]')).toBeNull();
    expect(sentOf(s.m, 'page.domHealth')).toEqual([]);
    await vi.waitFor(() => {
      expect(norm(pageRoot().querySelector('[role="alert"]')?.textContent)).toBe('SGW layout changed, filters paused');
    });
    // Folded into the pill (never a box over SGW's header).
    expect(pageRoot().querySelector('[role="alert"]')?.closest('.pill')).not.toBeNull();
    expect(pageRoot().querySelectorAll('.pill')).toHaveLength(1);
    expect(count('[data-sbw-stub], [data-sbw-label], [data-sbw-tools]')).toBe(0);
    expect(sentOf(s.m, 'page.domHealth')).toEqual([
      { url: SEARCH_URL, configVersion: SGW_CONFIG_VERSION, pageKind: 'search', cardsFound: 0, fallbackUsed: false },
    ]);
  });

  it('no banner when the search itself returned no results', async () => {
    const s = await setup({
      prepare: () => {
        gridContainer().replaceChildren();
      },
    });
    tapSearch(s.overlay, EMPTY_JSON);
    await new Promise((r) => setTimeout(r, 80));
    await s.overlay.scan();
    expect(pageRoot().querySelector('[role="alert"]')).toBeNull();
    // An empty search is not drift: no zero-card health report either.
    expect(sentOf(s.m, 'page.domHealth')).toEqual([]);
  });

  it('with no search reply yet, the zero-card verdict waits for the reply or noReplyMs, not just settleMs', async () => {
    const s = await setup({
      settleMs: 40,
      noReplyMs: 400,
      prepare: () => {
        gridContainer().replaceChildren();
      },
    });
    await sleep(150); // past settleMs, before noReplyMs
    await s.overlay.scan();
    expect(pageRoot().querySelector('[role="alert"]')).toBeNull();
    expect(sentOf(s.m, 'page.domHealth')).toEqual([]);
    await vi.waitFor(() => {
      expect(norm(pageRoot().querySelector('[role="alert"]')?.textContent)).toBe('SGW layout changed, filters paused');
    });
    expect(sentOf(s.m, 'page.domHealth')).toEqual([
      { url: SEARCH_URL, configVersion: SGW_CONFIG_VERSION, pageKind: 'search', cardsFound: 0, fallbackUsed: false },
    ]);
  });

  it('a search reply arriving after settle (before noReplyMs) decides the verdict at once', async () => {
    const s = await setup({
      settleMs: 40,
      noReplyMs: 5000,
      prepare: () => {
        gridContainer().replaceChildren();
      },
    });
    await sleep(100);
    expect(pageRoot().querySelector('[role="alert"]')).toBeNull();
    tapSearch(s.overlay, searchBody(s.ids));
    await s.overlay.scan();
    expect(norm(pageRoot().querySelector('[role="alert"]')?.textContent)).toBe('SGW layout changed, filters paused');
  });
});

describe('card badge registry', () => {
  it('loads every badges/*.tsx module, skipping malformed and duplicate ones', () => {
    const Component = () => null;
    const found = loadBadges({
      './badges/b.tsx': { badge: { id: 'b', order: 2, Component } },
      './badges/a.tsx': { badge: { id: 'a', order: 1, Component } },
      './badges/dup.tsx': { badge: { id: 'a', order: 3, Component } },
      './badges/bad.tsx': { badge: { id: 'Bad Id', order: 1, Component } },
      './badges/none.tsx': {},
    });
    expect(found.map((b) => b.id)).toEqual(['a', 'b']);
    expect(BADGES.map((b) => b.id)).toContain('end-time');
  });

  it('mounts each badge per card; a throwing badge does not break the others', async () => {
    const seen: number[] = [];
    const ok: CardBadge = {
      id: 'probe',
      order: 1,
      Component: (p) => {
        seen.push(p.itemId);
        return null;
      },
    };
    const broken: CardBadge = {
      id: 'broken',
      order: 0,
      Component: () => {
        throw new Error('badge bug');
      },
    };
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const s = await setup({ badges: [broken, ok, ...BADGES] });
    await s.feed();
    expect(new Set(seen)).toEqual(new Set(s.ids));
    expect(count('[data-sbw-tools]')).toBe(40);
  });

  it('the dual-time badge shows the end time in Pacific and the user zone', async () => {
    const s = await setup({ badges: BADGES });
    await s.feed();
    const raw = String(SEARCH_JSON.searchResults.items[0]?.['endTime']);
    const expected = `Ends ${formatDual(parsePacific(raw), 'America/New_York')}`;
    const badge = toolsRoot(s.ids[0] ?? 0).querySelector('[data-badge="end-time"]');
    expect(norm(badge?.textContent)).toBe(expected);
    expect(expected).toMatch(/PT · .*ET/);
  });
});

describe('static checks', () => {
  function files(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const p = join(dir, name);
      return statSync(p).isDirectory() ? files(p) : /\.(ts|tsx)$/.test(p) ? [p] : [];
    });
  }

  it('no innerHTML (or any HTML-string sink) anywhere in the overlay sources', () => {
    const sources = [...files(resolve(ROOT, 'src/content')), resolve(ROOT, 'src/entrypoints/sgw.content.ts')];
    expect(sources.length).toBeGreaterThan(5);
    const sink = /\b(innerHTML|outerHTML|insertAdjacentHTML|dangerouslySetInnerHTML|createContextualFragment)\b|document\.write/;
    const offenders = sources.filter((f) => sink.test(readFileSync(f, 'utf8').replace(/\/\/.*$/gm, '')));
    expect(offenders).toEqual([]);
  });
});

describe('fix round 1: settings fail closed, memory, layout, dim', () => {
  it('kill switch fails closed: unreadable settings at start pause the overlay until good settings arrive', async () => {
    const s = await setup({ rawSettings: { schemaVersion: 1, junk: true } });
    s.decide(s.ids[0] ?? 0, HIDE);
    await s.feed();
    expect(count('[data-sbw-stub], [data-sbw-tools]')).toBe(0);
    expect(sentOf(s.m, 'rules.evaluate')).toEqual([]);
    expect(barText()).toBe('ShopBadwill paused (settings unreadable)');
    // The tap still feeds the background.
    expect(sentOf(s.m, 'page.listings')).toHaveLength(1);
    await s.storage.set({ 'sbw:settings': defaultSettings() });
    await vi.waitFor(() => {
      expect(isHidden(s.ids[0] ?? 0)).toBe(true);
    });
  });

  it('absent settings (nothing stored yet) mean the defaults, not a pause', async () => {
    const s = await setup({ rawSettings: undefined });
    s.decide(s.ids[0] ?? 0, HIDE);
    await s.feed();
    expect(isHidden(s.ids[0] ?? 0)).toBe(true);
  });

  it('an unreadable settings change keeps the last good settings, unless it says the kill switch is on', async () => {
    const s = await setup();
    s.decide(s.ids[0] ?? 0, HIDE);
    await s.feed();
    await s.storage.set({ 'sbw:settings': { schemaVersion: 2, overlay: 'a newer shape' } });
    await s.overlay.scan();
    expect(isHidden(s.ids[0] ?? 0)).toBe(true);
    expect(barText()).toBe('1 hidden · Show');
    await s.storage.set({ 'sbw:settings': { schemaVersion: 2, killSwitch: true } });
    await vi.waitFor(() => {
      expect(barText()).toBe('ShopBadwill paused (kill switch)');
    });
    expect(count('[data-sbw-stub], [data-sbw-tools]')).toBe(0);
  });

  it('evicting a listing also drops its evaluation', async () => {
    const s = await setup();
    await s.feed();
    expect(s.overlay.memory()).toEqual({ listings: 40, results: 40, failed: 0 });
    const others = Array.from({ length: 1000 }, (_, i) => 100_000_000 + i);
    tapSearch(s.overlay, searchBody(others));
    await s.overlay.scan();
    expect(s.overlay.memory()).toEqual({ listings: 1000, results: 0, failed: 0 });
  });

  it('evicting a listing also drops its failure record', async () => {
    const s = await setup({ retryMs: 60_000 });
    s.fail.add('rules.evaluate');
    await s.feed();
    expect(s.overlay.memory()).toEqual({ listings: 40, results: 0, failed: 40 });
    const others = Array.from({ length: 1000 }, (_, i) => 100_000_000 + i);
    tapSearch(s.overlay, searchBody(others));
    await s.overlay.scan();
    expect(s.overlay.memory()).toEqual({ listings: 1000, results: 0, failed: 0 });
  });

  it('the tools row takes no card height: a small handle; the panel opens on hover, focus or the handle', async () => {
    expect(TOOLS_CSS).toMatch(/:host\s*\{[^}]*height:\s*0/);
    const s = await setup({ badges: BADGES });
    await s.feed();
    const root = toolsRoot(s.ids[0] ?? 0);
    const handle = button(root, 'tools');
    expect(handle.getAttribute('aria-expanded')).toBe('false');
    expect(root.querySelector('.panel [data-badge="end-time"]')).not.toBeNull();
    expect(root.querySelector('.panel button[data-action="actions"]')).not.toBeNull();
    click(handle, true);
    await tick();
    expect(handle.getAttribute('aria-expanded')).toBe('true');
    expect(root.querySelector('.tools')?.classList.contains('open')).toBe(true);
  });

  it('the pill sits bottom-left (clear of SGW\'s bottom-right controls) and collapses to a small dot and back', async () => {
    expect(PAGE_CSS).toMatch(/\.pill\s*\{[^}]*\bleft:\s*12px/);
    expect(PAGE_CSS).not.toMatch(/\.pill\s*\{[^}]*\bright:/);
    const s = await setup();
    s.decide(s.ids[0] ?? 0, HIDE);
    await s.feed();
    click(button(pageRoot(), 'collapse-pill'), true);
    await tick();
    const dot = button(pageRoot(), 'expand-pill');
    expect(dot.getAttribute('aria-label')).toBe('ShopBadwill: 1 hidden. Show the status');
    expect(pageRoot().querySelector('button[data-action="show-all"]')).toBeNull();
    // Still collapsed after a re-render.
    await s.overlay.scan();
    expect(pageRoot().querySelector('button[data-action="expand-pill"]')).not.toBeNull();
    click(dot, true);
    await tick();
    expect(barText()).toBe('1 hidden · Show');
  });

  it("hideStyle 'dim': the card stays, faded, under a 'Hidden by <rule> · Show' chip; count and undo work", async () => {
    const dim = defaultSettings();
    dim.overlay.hideStyle = 'dim';
    const s = await setup({ settings: dim });
    const id = s.ids[1] ?? 0;
    s.decide(id, HIDE);
    await s.feed();
    expect(isHidden(id)).toBe(false);
    expect(cardRoot(id).getAttribute('style') ?? '').toMatch(/opacity:\s*0\.3/);
    const chip = closedRoot(stubRow(id)?.querySelector('[data-sbw-chip]'));
    expect(norm(chip.querySelector('[role="note"]')?.textContent)).toBe('Hidden by No pyrex · Show');
    expect(stubRow(id)?.querySelector('[data-sbw-why]')).not.toBeNull();
    expect(barText()).toBe('1 hidden · Show');
    click(button(chip, 'show-card'), true);
    await tick();
    expect(cardRoot(id).getAttribute('style') ?? '').not.toMatch(/opacity/);
    expect(barText()).toBe('1 shown · Hide again');
  });

  it("switching hideStyle to 'dim' in settings re-applies the hides", async () => {
    const s = await setup();
    const id = s.ids[1] ?? 0;
    s.decide(id, HIDE);
    await s.feed();
    expect(isHidden(id)).toBe(true);
    const dim = defaultSettings();
    dim.overlay.hideStyle = 'dim';
    const states: string[] = [];
    const mo = new MutationObserver(() => {
      states.push(cardRoot(id).getAttribute('style') ?? '');
    });
    mo.observe(cardRoot(id), { attributes: true, attributeFilter: ['style'] });
    await s.storage.set({ 'sbw:settings': dim });
    await vi.waitFor(() => {
      expect(cardRoot(id).getAttribute('style') ?? '').toMatch(/opacity:\s*0\.3/);
    });
    mo.disconnect();
    expect(isHidden(id)).toBe(false);
    expect(count('[data-sbw-stub]')).toBe(1);
    // Straight from collapsed to dimmed: the card is never shown plainly in between.
    expect(states.filter((st) => !/display:\s*none|opacity/.test(st))).toEqual([]);
  });
});

describe('fix round 2', () => {
  it('N1: the tools-panel Why? dialog lives outside the hover-only panel, which stays forced open while it is open', async () => {
    const s = await setup();
    const id = s.ids[2] ?? 0;
    s.decide(id, HL);
    await s.feed();
    const root = toolsRoot(id);
    const tools = (): Element | null => root.querySelector('.tools');
    expect(tools()?.classList.contains('open')).toBe(false);
    click(button(root, 'why'), true);
    await tick();
    const dialog = openDialogs()[0];
    if (dialog === undefined) throw new Error('no dialog');
    expect(dialog.open).toBe(true);
    // Its visibility never depends on the hover/focus panel or the card...
    expect(dialog.closest('.panel')).toBeNull();
    expect(insideHidden(dialog)).toBe(false);
    const dialogHost = dialog.getRootNode();
    expect(dialogHost).toBeInstanceOf(ShadowRoot);
    if (!(dialogHost instanceof ShadowRoot)) throw new Error('dialog is not in a shadow root');
    expect(cardRoot(id).contains(dialogHost.host)).toBe(false);
    expect(dialogHost.host.shadowRoot).toBeNull();
    // ...and the panel (with the Why? button focus returns to) is forced visible meanwhile.
    expect(tools()?.classList.contains('open')).toBe(true);
    expect(button(root, 'why').getAttribute('aria-expanded')).toBe('true');
    // Clicking plain text inside the dialog keeps it open.
    const heading = dialog.querySelector('.pop-h');
    if (heading == null) throw new Error('no heading');
    click(heading, true);
    await tick();
    expect(dialog.open).toBe(true);
    // Closing releases the panel and returns focus to Why?.
    const dialogRoot = dialog.getRootNode();
    if (!(dialogRoot instanceof ShadowRoot || dialogRoot instanceof Document)) throw new Error('dialog has no root');
    click(button(dialogRoot, 'close-why'), true);
    await tick();
    expect(openDialogs()).toEqual([]);
    expect(root.querySelector('dialog')).toBeNull();
    expect(tools()?.classList.contains('open')).toBe(false);
    expect(root.activeElement).toBe(button(root, 'why'));
    expect(button(root, 'why').getAttribute('aria-expanded')).toBe('false');
  });

  it('watch-only matches are never decorated (a match-everything watch rule paints nothing); highlight still does', async () => {
    const everything = rule('sbw-match-everything', 'Match everything', 'watch');
    const s = await setup({ rules: [everything, HIDE, HL] });
    for (const id of s.ids) s.decide(id, everything);
    const hl = s.ids[3] ?? 0;
    const hidden = s.ids[4] ?? 0;
    s.decideAll(hl, 'highlight', [HL, everything]);
    s.decideAll(hidden, 'hide', [HIDE, everything]);
    await s.feed();
    expect(count('[data-sbw-label]')).toBe(1);
    expect(cardRoot(hl).querySelector('[data-sbw-label]')).not.toBeNull();
    expect(count('[data-sbw-stub]')).toBe(1);
    expect(isHidden(hidden)).toBe(true);
    expect(barText()).toBe('1 hidden · Show');
    // No Why? either on a watch-only card.
    expect(toolsRoot(s.ids[0] ?? 0).querySelector('button[data-action="why"]')).toBeNull();
    expect(toolsRoot(hl).querySelector('button[data-action="why"]')).not.toBeNull();
  });

  it.each(['disabled', 'deleted'] as const)(
    'N2: a previous-generation hide whose rule was %s locally is dropped even when re-evaluation fails',
    async (how) => {
      const s = await setup({ retryMs: 60_000 });
      const a = s.ids[0] ?? 0;
      const b = s.ids[1] ?? 0;
      s.decide(a, HIDE);
      s.decide(b, HL);
      await s.feed();
      expect(isHidden(a)).toBe(true);
      s.fail.add('rules.evaluate');
      const next = how === 'disabled' ? [{ ...HIDE, enabled: false }, HL] : [HL];
      await s.storage.set({ 'sbw:rules': next });
      await vi.waitFor(() => {
        expect(isHidden(a)).toBe(false);
      });
      expect(count('[data-sbw-stub]')).toBe(0);
      // The highlight's rule is still enabled: its (stale) decoration stays.
      expect(cardRoot(b).querySelector('[data-sbw-label]')).not.toBeNull();
    },
  );

  it('N2: "Disable rule" then a failing re-evaluation never leaves "Hidden by rule: Unnamed rule"', async () => {
    const s = await setup({ retryMs: 60_000 });
    const a = s.ids[0] ?? 0;
    s.decide(a, HIDE);
    await s.feed();
    s.fail.add('rules.evaluate');
    // What the background does on rules.disable: store the rule disabled, broadcast rules.changed.
    await s.storage.set({ 'sbw:rules': [{ ...HIDE, enabled: false }, HL] });
    s.m.broadcast('rules.changed', undefined);
    await vi.waitFor(() => {
      expect(isHidden(a)).toBe(false);
    });
    expect(count('[data-sbw-stub]')).toBe(0);
  });

  it('N3: an unreadable settings record does not clear a broadcast kill override', async () => {
    const s = await setup();
    s.decide(s.ids[0] ?? 0, HIDE);
    await s.feed();
    s.m.broadcast('switches.changed', { killSwitch: true, writesAllowed: {} });
    await s.overlay.scan();
    expect(barText()).toBe('ShopBadwill paused (kill switch)');
    await s.storage.set({ 'sbw:settings': { schemaVersion: 2, junk: true } });
    await s.overlay.scan();
    await tick();
    expect(barText()).toBe('ShopBadwill paused (kill switch)');
    expect(count('[data-sbw-stub], [data-sbw-tools]')).toBe(0);
  });

  it('N4: a storage read that throws pauses the overlay (fail closed); the tap still feeds the background', async () => {
    const s = await setup({ storageGetThrows: true });
    s.decide(s.ids[0] ?? 0, HIDE);
    await s.feed();
    expect(barText()).toBe('ShopBadwill paused (settings unreadable)');
    expect(count('[data-sbw-stub], [data-sbw-tools]')).toBe(0);
    expect(sentOf(s.m, 'rules.evaluate')).toEqual([]);
    expect(sentOf(s.m, 'page.listings')).toHaveLength(1);
  });
});

describe('fix round 3', () => {
  it('an open tools Why? stays visible when its card is collapsed', async () => {
    const s = await setup();
    const id = s.ids[0] ?? 0;
    s.decide(id, HIDE);
    await s.feed();
    click(stubShow(id), true);
    await tick();
    expect(isHidden(id)).toBe(false);
    click(button(toolsRoot(id), 'why'), true);
    await tick();
    expect(openDialogs()).toHaveLength(1);

    click(button(pageRoot(), 'hide-again'), true);
    await tick();
    expect(isHidden(id)).toBe(true);
    const open = openDialogs();
    // The modal is still there, and no ancestor (the collapsed card) hides it.
    expect(open).toHaveLength(1);
    const dialog = open[0];
    if (dialog === undefined) throw new Error('no dialog');
    expect(insideHidden(dialog)).toBe(false);
    const root = dialog.getRootNode();
    if (!(root instanceof ShadowRoot || root instanceof Document)) throw new Error('dialog has no root');
    click(button(root, 'close-why'), true);
    await tick();
    expect(openDialogs()).toEqual([]);
    expect(document.querySelector('sbw-why-modal')).toBeNull();
  });

  it('the Why? heading names the decoration on the card when a stale hide has fallen back to highlight', async () => {
    const s = await setup({ retryMs: 60_000 });
    const id = s.ids[0] ?? 0;
    s.decideAll(id, 'hide', [HIDE, HL]);
    await s.feed();
    expect(isHidden(id)).toBe(true);
    s.fail.add('rules.evaluate');
    await s.storage.set({ 'sbw:rules': [{ ...HIDE, enabled: false }, HL] });
    await vi.waitFor(() => {
      expect(isHidden(id)).toBe(false);
    });
    expect(cardRoot(id).hasAttribute('data-sbw-highlight')).toBe(true);
    click(button(toolsRoot(id), 'why'), true);
    await tick();
    const dialog = openDialogs()[0];
    expect(norm(dialog?.querySelector('.pop-h')?.textContent)).toBe('Why this listing is highlighted');
  });
});

describe('Opus check (fix round 4)', () => {
  it('the stub Why? dialog is on the document too, so the page hiding its results cannot hide it', async () => {
    const s = await setup();
    const id = s.ids[0] ?? 0;
    s.decide(id, HIDE);
    await s.feed();
    click(button(stubWhyRoot(id), 'why'), true);
    await tick();
    const dialog = openDialogs()[0];
    if (dialog === undefined) throw new Error('no dialog');
    const root = dialog.getRootNode();
    if (!(root instanceof ShadowRoot)) throw new Error('dialog is not in a shadow root');
    expect(root.host.parentElement).toBe(document.documentElement);
    expect(root.host.shadowRoot).toBeNull(); // closed
    // The page hides its results (a loading state, a responsive layout swap).
    gridContainer().setAttribute('style', 'display:none');
    expect(insideHidden(dialog)).toBe(false);
    // Escape: Why? and the card are hidden, so focus goes to the page pill.
    key(button(root, 'close-why'), 'Escape');
    await tick();
    expect(openDialogs()).toEqual([]);
    expect(pageRoot().activeElement).toBe(button(pageRoot(), 'show-all'));
  });

  it('closing a tools Why? after its card collapsed focuses the stub Why? of that card', async () => {
    const s = await setup();
    const id = s.ids[0] ?? 0;
    s.decide(id, HIDE);
    await s.feed();
    click(stubShow(id), true);
    await tick();
    click(button(toolsRoot(id), 'why'), true);
    await tick();
    click(button(pageRoot(), 'hide-again'), true);
    await tick();
    expect(isHidden(id)).toBe(true);
    click(button(modalRoot(id), 'close-why'), true);
    await tick();
    expect(openDialogs()).toEqual([]);
    expect(deepActive()).toBe(button(stubWhyRoot(id), 'why'));
  });

  it('a Why? dialog that goes away while focused (its rule turned off) leaves focus on the card tools handle', async () => {
    const s = await setup();
    const id = s.ids[0] ?? 0;
    s.decide(id, HIDE);
    await s.feed();
    click(button(stubWhyRoot(id), 'why'), true);
    await tick();
    expect(openDialogs()).toHaveLength(1);
    s.decideAll(id, 'none', []);
    await s.storage.set({ 'sbw:rules': [{ ...HIDE, enabled: false }, HL] });
    await vi.waitFor(() => {
      expect(isHidden(id)).toBe(false);
      expect(openDialogs()).toEqual([]);
    });
    await vi.waitFor(() => {
      expect(deepActive()).toBe(button(toolsRoot(id), 'tools'));
    });
  });

  it('while a stale hide shows as a highlight, the body lists only the rules that still count', async () => {
    const s = await setup({ retryMs: 60_000 });
    const id = s.ids[0] ?? 0;
    s.decideAll(id, 'hide', [HIDE, HL]);
    await s.feed();
    s.fail.add('rules.evaluate');
    await s.storage.set({ 'sbw:rules': [{ ...HIDE, enabled: false }, HL] });
    await vi.waitFor(() => {
      expect(isHidden(id)).toBe(false);
    });
    click(button(toolsRoot(id), 'why'), true);
    await tick();
    const dialog = openDialogs()[0];
    expect(norm(dialog?.querySelector('.pop-h')?.textContent)).toBe('Why this listing is highlighted');
    expect(Array.from(dialog?.querySelectorAll('.rule') ?? [], (p) => norm(p.textContent))).toEqual(['Highlight rule: Cheap glass']);
    expect(Array.from(dialog?.querySelectorAll('[data-action="disable-rule"]') ?? [], (b) => b.getAttribute('data-rule-id'))).toEqual(['r-hl']);
  });
});
