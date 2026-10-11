// T-32 (Opus check): the overlay's Why? dialog in a real Chromium.
//
// Loads the built extension (.output/chrome-mv3, from `pnpm build`) and serves
// the sanitized search fixture as https://shopgoodwill.com/... from this
// process (route.fulfill). Nothing reaches the network: every other request is
// aborted, DNS resolves nothing and the proxy is a dead local port. The page
// makes one search call itself (to the fulfilled buyerapi route), so the
// MAIN-world tap feeds the overlay, and the real background evaluates the rules
// seeded into storage.local.
//
// Every way to open Why? (stub, dim chip, hovered tools, handle-opened tools on
// a highlighted card, a revealed card) meets a change while the dialog is open:
// the card hidden or collapsed, its rule turned off or renamed, an Angular-style
// re-render, the results hidden by the page, the kill switch, the hide style.
// After each change an open dialog must be on screen (modal, a box, on top at
// its centre), or there is none and a real click reaches the page. Once it is
// closed, focus must be on a visible control.
//
// Closed shadow roots are reached through CDP (DOM.getDocument with pierce).
// Every click, hover and key is a real (trusted) input event.
//
// Run: pnpm build && pnpm test:e2e:chromium -- overlay-why
// (CI runs it on `pnpm build:test`; SBW_CHROME_EXTENSION_DIR picks a build.)
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium, expect, test, type BrowserContext, type CDPSession, type Page, type Route, type Worker } from '@playwright/test';

import type { Rule } from '../../../src/domain/rules/schema';
import { defaultSettings } from '../../../src/domain/settings/defaults';
import type { Settings } from '../../../src/domain/settings/schema';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
/** SBW_CHROME_EXTENSION_DIR, else the newer of the production build and CI's test build (`pnpm build:test`). */
function extensionDir(): string {
  const fromEnv = process.env.SBW_CHROME_EXTENSION_DIR;
  if (fromEnv !== undefined && fromEnv !== '') return path.resolve(fromEnv);
  const built = ['.output/chrome-mv3', '.output/chrome-mv3-test']
    .map((d) => path.join(ROOT, d))
    .filter((d) => existsSync(path.join(d, 'manifest.json')))
    .sort((x, y) => statSync(path.join(y, 'manifest.json')).mtimeMs - statSync(path.join(x, 'manifest.json')).mtimeMs);
  return built[0] ?? path.join(ROOT, '.output/chrome-mv3');
}
const EXTENSION = extensionDir();
const FIX = path.join(ROOT, 'test/fixtures/sgw');
const HTML = readFileSync(path.join(FIX, 'html/search-grid-logged-out.html'), 'utf8');
interface SearchJson {
  searchResults: { items: Array<Record<string, unknown>>; itemCount: number };
}
const SEARCH_JSON = JSON.parse(readFileSync(path.join(FIX, 'json/search-grid-p1.json'), 'utf8')) as SearchJson;
const PAGE_URL = 'https://shopgoodwill.com/categories/listing?st=pyrex&p=1';
const SEARCH_API = 'https://buyerapi.shopgoodwill.com/api/Search/ItemListing';
const BEARER = 'eyJhbGciOiJIUzI1NiJ9.eyJCdXllcklkIjoiMSJ9.c2lnbmF0dXJl';
const CORS = {
  'access-control-allow-origin': 'https://shopgoodwill.com',
  'access-control-allow-credentials': 'true',
  'access-control-allow-headers': 'authorization, content-type',
  'access-control-allow-methods': 'POST, OPTIONS',
};

// ── rules: one keyword token per card title ──────────────────────────────────

const A = 0; // hidden by HIDE_A
const B = 1; // highlighted by GLOW_B
const C = 2; // hidden by HIDE_C (the revealed-card paths)
const token = (i: number): string => `sbwcard${String(i)}x`;
function rule(id: string, name: string, action: Rule['action'], cardIndex: number, extra: Partial<Rule> = {}): Rule {
  return {
    id,
    name,
    enabled: true,
    action,
    all: [{ kind: 'keyword', mode: 'any', terms: [token(cardIndex)], wholeWord: true, regex: false, fields: ['title'] }],
    createdAt: 1,
    updatedAt: 1,
    ...extra,
  };
}
const HIDE_A = rule('e2e-hide-a', 'Hide A', 'hide', A);
const GLOW_B = rule('e2e-glow-b', 'Glow B', 'highlight', B, { tone: 'green' });
const HIDE_B = rule('e2e-hide-b', 'Hide B', 'hide', B);
const HIDE_C = rule('e2e-hide-c', 'Hide C', 'hide', C);
const RULES = [HIDE_A, GLOW_B, HIDE_C];
const off = (r: Rule): Rule => ({ ...r, enabled: false, updatedAt: 2 });

function searchBodyFor(ids: number[]): SearchJson {
  const rows = SEARCH_JSON.searchResults.items;
  const body = structuredClone(SEARCH_JSON);
  body.searchResults.items = ids.map((itemId, i) => ({
    ...structuredClone(rows[i % rows.length] ?? {}),
    itemId,
    title: `Opus check card ${String(i)} ${token(i)}`,
  }));
  body.searchResults.itemCount = ids.length;
  return body;
}

// ── browser ─────────────────────────────────────────────────────────────────

let context: BrowserContext;
let worker: Worker;
let searchBody = '{}';
let searchCalls = 0;
/** Requests aborted (never sent): anything but the fixture page and the search reply. */
let blocked: string[] = [];

async function fulfil(route: Route): Promise<void> {
  const req = route.request();
  const url = req.url();
  if (url.startsWith('https://shopgoodwill.com/') && req.resourceType() === 'document') {
    await route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: HTML });
    return;
  }
  if (url === SEARCH_API) {
    if (req.method() === 'OPTIONS') {
      await route.fulfill({ status: 204, headers: CORS });
      return;
    }
    searchCalls += 1;
    await route.fulfill({ status: 200, contentType: 'application/json', headers: CORS, body: searchBody });
    return;
  }
  blocked.push(url);
  await route.abort();
}


test.beforeAll(async () => {
  if (!existsSync(path.join(EXTENSION, 'manifest.json'))) {
    throw new Error(`No Chrome build at ${EXTENSION}. Run \`pnpm build\` first.`);
  }
  context = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    headless: true,
    viewport: { width: 1280, height: 800 },
    args: [
      `--disable-extensions-except=${EXTENSION}`,
      `--load-extension=${EXTENSION}`,
      // Fail closed: no name resolves and any proxied request hits a dead port.
      '--host-resolver-rules=MAP * ~NOTFOUND',
      '--proxy-server=http://127.0.0.1:9',
    ],
  });
  await context.route('**/*', fulfil);
  worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
});

test.afterAll(async () => {
  await context.close();
});

interface ChromeLike {
  chrome: { storage: { local: { set(items: Record<string, unknown>): Promise<void> } } };
}
async function seed(items: Record<string, unknown>): Promise<void> {
  await worker.evaluate(async (v) => {
    await (globalThis as unknown as ChromeLike).chrome.storage.local.set(v);
  }, items);
}

interface Opened {
  page: Page;
  cdp: CDPSession;
  /** Item ids of the result cards, in page order. */
  ids: number[];
}

/** Seeds rules and settings, opens the fixture search page and lets the page make its one search call. */
async function openSearch(rules: Rule[], settings: Settings = defaultSettings()): Promise<Opened> {
  searchCalls = 0;
  blocked = [];
  await seed({ 'sbw:rules': rules, 'sbw:settings': settings });
  const page = await context.newPage();
  if (process.env.SBW_E2E_CONSOLE === '1') {
    page.on('console', (m) => {
      console.log(`[page ${m.type()}] ${m.text()}`);
    });
  }
  await page.goto(PAGE_URL);
  await page.waitForSelector('html[data-sbw-nonce]', { state: 'attached' });
  const ids = await page.$$eval('app-home-product-items a.feat-item_name', (as) => as.map((a) => Number(a.id)));
  searchBody = JSON.stringify(searchBodyFor(ids));
  const status = await page.evaluate(
    async ({ url, bearer }) => {
      const r = await fetch(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
        body: '{}',
      });
      await r.text();
      return r.status;
    },
    { url: SEARCH_API, bearer: BEARER },
  );
  expect(status).toBe(200);
  const cdp = await context.newCDPSession(page);
  await cdp.send('DOM.enable');
  return { page, cdp, ids };
}

async function closePage(o: Opened): Promise<void> {
  // Zero extra SGW requests: the page's own search call, and nothing else to any shopgoodwill.com host.
  expect(searchCalls).toBe(1);
  expect(blocked.filter((u) => /(^|\.)shopgoodwill\.com$/.test(new URL(u).hostname))).toEqual([]);
  await o.cdp.detach();
  await o.page.close();
}

function id(o: Opened, index: number): string {
  const v = o.ids[index];
  if (v === undefined) throw new Error(`no card ${String(index)}`);
  return String(v);
}
const card = (o: Opened, index: number) => o.page.locator(`app-home-product-items:has(a.feat-item_name[id="${id(o, index)}"])`);

// ── CDP: closed shadow roots ────────────────────────────────────────────────

interface DomNode {
  nodeName: string;
  backendNodeId: number;
  attributes?: string[];
  children?: DomNode[];
  shadowRoots?: DomNode[];
}
function attr(n: DomNode, name: string): string | undefined {
  const a = n.attributes ?? [];
  for (let i = 0; i + 1 < a.length; i += 2) if (a[i] === name) return a[i + 1];
  return undefined;
}
function* walk(n: DomNode): Generator<DomNode> {
  yield n;
  for (const c of n.children ?? []) yield* walk(c);
  for (const s of n.shadowRoots ?? []) yield* walk(s);
}
async function tree(o: Opened): Promise<DomNode> {
  const { root } = await o.cdp.send('DOM.getDocument', { depth: -1, pierce: true });
  return root;
}
/** The first node matching `pred` inside the subtree of the first node matching `scope`. */
async function find(o: Opened, scope: (n: DomNode) => boolean, pred: (n: DomNode) => boolean): Promise<DomNode> {
  for (const s of walk(await tree(o))) {
    if (!scope(s)) continue;
    for (const n of walk(s)) if (n !== s && pred(n)) return n;
  }
  throw new Error('node not found');
}
const host = (tag: string, name: string, value: string) => (n: DomNode) => n.nodeName === tag && attr(n, name) === value;
const action = (a: string) => (n: DomNode) => n.nodeName === 'BUTTON' && attr(n, 'data-action') === a;

const stubRow = (o: Opened, i: number) => host('SBW-STUB-ROW', 'data-sbw-stub', id(o, i));
const toolsHost = (o: Opened, i: number) => host('SBW-TOOLS', 'data-sbw-tools', id(o, i));
const openDialog = (n: DomNode): boolean => n.nodeName === 'DIALOG' && attr(n, 'open') !== undefined;

async function centre(o: Opened, n: DomNode): Promise<{ x: number; y: number }> {
  await o.cdp.send('DOM.scrollIntoViewIfNeeded', { backendNodeId: n.backendNodeId });
  const { model } = await o.cdp.send('DOM.getBoxModel', { backendNodeId: n.backendNodeId });
  const q = model.border.map((v) => v);
  const x = ((q[0] ?? 0) + (q[2] ?? 0) + (q[4] ?? 0) + (q[6] ?? 0)) / 4;
  const y = ((q[1] ?? 0) + (q[3] ?? 0) + (q[5] ?? 0) + (q[7] ?? 0)) / 4;
  return { x, y };
}
async function clickNode(o: Opened, n: DomNode): Promise<void> {
  const p = await centre(o, n);
  await o.page.mouse.click(p.x, p.y);
}
async function hoverNode(o: Opened, n: DomNode): Promise<void> {
  const p = await centre(o, n);
  await o.page.mouse.move(p.x, p.y);
}
async function call<T>(o: Opened, backendNodeId: number, fn: string): Promise<T> {
  const { object } = await o.cdp.send('DOM.resolveNode', { backendNodeId });
  const objectId = object.objectId;
  if (objectId === undefined) throw new Error('node not resolvable');
  try {
    const { result } = await o.cdp.send('Runtime.callFunctionOn', { objectId, functionDeclaration: fn, returnByValue: true });
    return result.value as T;
  } finally {
    await o.cdp.send('Runtime.releaseObject', { objectId });
  }
}

interface DialogState {
  modal: boolean;
  visible: boolean;
  width: number;
  height: number;
  /** elementFromPoint at the dialog's centre is the dialog (or its shadow host). */
  onTop: boolean;
  heading: string;
  rules: string[];
}
const DIALOG_STATE = `function () {
  const r = this.getBoundingClientRect();
  const root = this.getRootNode();
  const host = root instanceof ShadowRoot ? root.host : null;
  const hit = r.width > 0 ? document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2) : null;
  const text = (e) => (e ? e.textContent : '').replace(/\\s+/g, ' ').trim();
  return {
    modal: this.matches(':modal'),
    visible: this.checkVisibility(),
    width: r.width,
    height: r.height,
    onTop: hit !== null && (hit === this || hit === host),
    heading: text(this.querySelector('.pop-h')),
    rules: Array.from(this.querySelectorAll('.rule'), text),
  };
}`;

async function openDialogs(o: Opened): Promise<DialogState[]> {
  const out: DialogState[] = [];
  for (const n of walk(await tree(o))) {
    if (openDialog(n)) out.push(await call<DialogState>(o, n.backendNodeId, DIALOG_STATE));
  }
  return out;
}

/** A real click on a probe at the top-right corner reaches the page (it is not inert). It leaves focus where it is. */
async function pageTakesClicks(o: Opened): Promise<boolean> {
  const clicks = (): Promise<number> =>
    o.page.evaluate(() => {
      let p = document.getElementById('sbw-e2e-probe');
      if (p === null) {
        const el = document.createElement('div');
        el.id = 'sbw-e2e-probe';
        el.setAttribute('style', 'position:fixed;top:0;right:0;width:24px;height:24px;z-index:2147483647;background:#f0f');
        el.dataset.clicks = '0';
        // A press on a non-focusable element would blur the focused control.
        el.addEventListener('mousedown', (e) => {
          e.preventDefault();
        });
        el.addEventListener('click', () => {
          el.dataset.clicks = String(Number(el.dataset.clicks) + 1);
        });
        document.documentElement.append(el);
        p = el;
      }
      return Number(p.dataset.clicks);
    });
  const before = await clicks();
  const vp = o.page.viewportSize() ?? { width: 1280, height: 800 };
  await o.page.mouse.click(vp.width - 12, 12);
  return (await clicks()) === before + 1;
}

/** The invariant: every open dialog is on screen; with none open, the page takes clicks. */
async function expectOnScreenOrClosed(o: Opened, label: string): Promise<DialogState[]> {
  const dialogs = await openDialogs(o);
  for (const d of dialogs) {
    expect(d.modal && d.visible && d.width > 0 && d.height > 0 && d.onTop, `${label}: open dialog not on screen: ${JSON.stringify(d)}`).toBe(true);
  }
  if (dialogs.length === 0) expect(await pageTakesClicks(o), `${label}: no dialog, yet the page is inert`).toBe(true);
  return dialogs;
}

interface Focus {
  /** Tag of document.activeElement (our shadow host), or null for the body. */
  host: string | null;
  attrs: Record<string, string>;
  /** data-action of the focused control inside the host's shadow root. */
  action: string | null;
  visible: boolean;
}
async function focused(o: Opened): Promise<Focus> {
  const { result } = await o.cdp.send('Runtime.evaluate', {
    expression: 'document.activeElement === document.body ? null : document.activeElement',
  });
  if (result.objectId === undefined) return { host: null, attrs: {}, action: null, visible: false };
  const { node } = await o.cdp.send('DOM.describeNode', { objectId: result.objectId, depth: 1, pierce: true });
  await o.cdp.send('Runtime.releaseObject', { objectId: result.objectId });
  const a: Record<string, string> = {};
  const list = node.attributes ?? [];
  for (let i = 0; i + 1 < list.length; i += 2) a[list[i] ?? ''] = list[i + 1] ?? '';
  const shadow = node.shadowRoots?.[0];
  if (shadow === undefined) {
    return { host: node.nodeName.toLowerCase(), attrs: a, action: a['data-action'] ?? null, visible: true };
  }
  const inner = await call<{ action: string | null; visible: boolean } | null>(
    o,
    shadow.backendNodeId,
    `function () {
      let el = this.activeElement;
      while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;
      return el ? { action: el.getAttribute('data-action'), visible: el.checkVisibility() } : null;
    }`,
  );
  return { host: node.nodeName.toLowerCase(), attrs: a, action: inner?.action ?? null, visible: inner?.visible ?? false };
}

/** Closes the open dialog with a real Escape and checks the page is usable and focus is on a visible control. */
async function escapeAndCheck(o: Opened, label: string): Promise<Focus> {
  if ((await openDialogs(o)).length > 0) await o.page.keyboard.press('Escape');
  await expect.poll(async () => (await openDialogs(o)).length, { message: `${label}: Escape closes the dialog` }).toBe(0);
  // A dialog that went away while focused hands focus on after the overlay's pass: poll briefly.
  let f = await focused(o);
  await expect
    .poll(
      async () => {
        f = await focused(o);
        return f.host !== null && f.visible;
      },
      { message: `${label}: focus went nowhere`, timeout: 2000 },
    )
    .toBe(true);
  expect(await pageTakesClicks(o), `${label}: page inert after close`).toBe(true);
  return f;
}

// ── ways to open Why? ───────────────────────────────────────────────────────

async function openStubWhy(o: Opened, i: number): Promise<void> {
  await clickNode(o, await find(o, stubRow(o, i), action('why')));
  await expect.poll(async () => (await openDialogs(o)).length).toBe(1);
}
async function openToolsWhyByHover(o: Opened, i: number): Promise<void> {
  await hoverNode(o, await find(o, toolsHost(o, i), action('tools')));
  await clickNode(o, await find(o, toolsHost(o, i), action('why')));
  await o.page.mouse.move(640, 790); // away from the card: the hover panel would close
  await expect.poll(async () => (await openDialogs(o)).length).toBe(1);
}
async function openToolsWhyByHandle(o: Opened, i: number): Promise<void> {
  await clickNode(o, await find(o, toolsHost(o, i), action('tools')));
  await o.page.mouse.move(640, 790);
  await clickNode(o, await find(o, toolsHost(o, i), action('why')));
  await o.page.mouse.move(640, 790);
  await expect.poll(async () => (await openDialogs(o)).length).toBe(1);
}
async function revealByStub(o: Opened, i: number): Promise<void> {
  await clickNode(o, await find(o, stubRow(o, i), (n) => n.nodeName === 'BUTTON' && attr(n, 'data-action') === undefined));
  await expect(card(o, i)).toHaveAttribute('data-sbw-revealed', '1');
}
async function decorated(o: Opened): Promise<void> {
  await expect(card(o, A)).toHaveAttribute('data-sbw-hidden', /.+/);
  await expect(card(o, B)).toHaveAttribute('data-sbw-highlight', 'green');
  await expect(card(o, C)).toHaveAttribute('data-sbw-hidden', /.+/);
}

// ── page changes ────────────────────────────────────────────────────────────

/** An Angular-style re-render: the results container's children are rebuilt from the template. */
async function rerender(o: Opened): Promise<void> {
  await o.page.evaluate((html) => {
    const fresh = new DOMParser().parseFromString(html, 'text/html').querySelector('.item-col')?.parentElement;
    const live = document.querySelector('.item-col')?.parentElement;
    if (fresh == null || live == null) throw new Error('no results container');
    live.replaceChildren(...Array.from(fresh.childNodes, (n) => document.importNode(n, true)));
  }, HTML);
}
/** The page hides its results (a loading state, or a responsive layout swap). */
async function hideResults(o: Opened, hidden: boolean): Promise<void> {
  await o.page.evaluate((h) => {
    const live = document.querySelector('.item-col')?.parentElement;
    if (live == null) throw new Error('no results container');
    if (h) live.setAttribute('style', 'display:none');
    else live.removeAttribute('style');
  }, hidden);
}

// ── tests ───────────────────────────────────────────────────────────────────

test.describe('Why? dialog: on screen or closed, never an inert page', () => {
  test('stub Why?, then "Disable rule" (the real rules.disable) unhides the card', async () => {
    const o = await openSearch(RULES);
    await decorated(o);
    await openStubWhy(o, A);
    await expectOnScreenOrClosed(o, 'stub open');
    await clickNode(o, await find(o, openDialog, action('disable-rule')));
    await expect(card(o, A)).not.toHaveAttribute('data-sbw-hidden', /.*/);
    const left = await expectOnScreenOrClosed(o, 'after disable');
    const f = await escapeAndCheck(o, 'after disable');
    if (left.length === 0) expect([f.host, f.attrs['data-sbw-tools'], f.action]).toEqual(['sbw-tools', id(o, A), 'tools']);
    await closePage(o);
  });

  test('stub Why?, then the page hides its results', async () => {
    const o = await openSearch(RULES);
    await decorated(o);
    await openStubWhy(o, A);
    await hideResults(o, true);
    const [d] = await expectOnScreenOrClosed(o, 'results hidden');
    expect(d?.heading).toBe('Why this listing is hidden');
    const f = await escapeAndCheck(o, 'results hidden');
    expect(f.host).toBe('shopbadwill-badge'); // the card and its stub are hidden: the page pill
    await hideResults(o, false);
    await closePage(o);
  });

  test('stub Why?, then an Angular-style re-render', async () => {
    const o = await openSearch(RULES);
    await decorated(o);
    await openStubWhy(o, A);
    await rerender(o);
    await expectOnScreenOrClosed(o, 'right after the re-render');
    await decorated(o); // the overlay re-decorated the fresh cards
    await expectOnScreenOrClosed(o, 'after the re-scan');
    await escapeAndCheck(o, 'after the re-scan');
    await closePage(o);
  });

  test('stub Why?, then the kill switch', async () => {
    const o = await openSearch(RULES);
    await decorated(o);
    await openStubWhy(o, A);
    await seed({ 'sbw:settings': { ...defaultSettings(), killSwitch: true } });
    await expect(card(o, A)).not.toHaveAttribute('data-sbw-hidden', /.*/);
    await expectOnScreenOrClosed(o, 'killed');
    await escapeAndCheck(o, 'killed');
    await closePage(o);
  });

  test('stub Why?, then the hide style switches to dim', async () => {
    const o = await openSearch(RULES);
    await decorated(o);
    await openStubWhy(o, A);
    const dim = defaultSettings();
    dim.overlay.hideStyle = 'dim';
    await seed({ 'sbw:settings': dim });
    await expect(card(o, A)).toHaveAttribute('data-sbw-hidden', 'dim');
    await expectOnScreenOrClosed(o, 'dim');
    const f = await escapeAndCheck(o, 'dim');
    expect([f.host, f.attrs['data-sbw-why'], f.action]).toEqual(['sbw-why', id(o, A), 'why']);
    await closePage(o);
  });

  test('dim chip Why?, then its rule is turned off', async () => {
    const dim = defaultSettings();
    dim.overlay.hideStyle = 'dim';
    const o = await openSearch(RULES, dim);
    await expect(card(o, A)).toHaveAttribute('data-sbw-hidden', 'dim');
    await openStubWhy(o, A);
    await expectOnScreenOrClosed(o, 'dim open');
    await seed({ 'sbw:rules': [off(HIDE_A), GLOW_B, HIDE_C] });
    await expect(card(o, A)).not.toHaveAttribute('data-sbw-hidden', /.*/);
    await expectOnScreenOrClosed(o, 'rule off');
    const f = await escapeAndCheck(o, 'rule off');
    expect([f.host, f.attrs['data-sbw-tools'], f.action]).toEqual(['sbw-tools', id(o, A), 'tools']);
    await closePage(o);
  });

  test('hovered tools Why? on a highlighted card, then a new rule hides (collapses) the card', async () => {
    const o = await openSearch(RULES);
    await decorated(o);
    await openToolsWhyByHover(o, B);
    const [before] = await expectOnScreenOrClosed(o, 'hover open');
    expect(before?.heading).toBe('Why this listing is highlighted');
    await seed({ 'sbw:rules': [...RULES, HIDE_B] });
    await expect(card(o, B)).toHaveAttribute('data-sbw-hidden', '1');
    const [after] = await expectOnScreenOrClosed(o, 'collapsed');
    if (after !== undefined) expect(after.heading).toBe('Why this listing is hidden');
    const f = await escapeAndCheck(o, 'collapsed');
    expect([f.host, f.attrs['data-sbw-why'], f.action]).toEqual(['sbw-why', id(o, B), 'why']);
    await closePage(o);
  });

  test('handle-opened tools Why? on a highlighted card, then its rule is turned off', async () => {
    const o = await openSearch(RULES);
    await decorated(o);
    await openToolsWhyByHandle(o, B);
    await expectOnScreenOrClosed(o, 'handle open');
    await seed({ 'sbw:rules': [HIDE_A, off(GLOW_B), HIDE_C] });
    await expect(card(o, B)).not.toHaveAttribute('data-sbw-highlight', /.*/);
    await expectOnScreenOrClosed(o, 'rule off');
    const f = await escapeAndCheck(o, 'rule off');
    expect([f.host, f.attrs['data-sbw-tools']]).toEqual(['sbw-tools', id(o, B)]);
    await closePage(o);
  });

  test('handle-opened tools Why?, then an Angular-style re-render', async () => {
    const o = await openSearch(RULES);
    await decorated(o);
    await openToolsWhyByHandle(o, B);
    await rerender(o);
    await expectOnScreenOrClosed(o, 'right after the re-render');
    await decorated(o);
    await expectOnScreenOrClosed(o, 'after the re-scan');
    await escapeAndCheck(o, 'after the re-scan');
    await closePage(o);
  });

  test('revealed card: tools Why?, then "Hide again" collapses the card', async () => {
    // Without HIDE_A, C is the only hidden card: once it is shown the pill offers "Hide again".
    const o = await openSearch([GLOW_B, HIDE_C]);
    await expect(card(o, C)).toHaveAttribute('data-sbw-hidden', '1');
    await revealByStub(o, C);
    await openToolsWhyByHover(o, C);
    await expectOnScreenOrClosed(o, 'revealed open');
    // The pill sits behind the modal; the page's own script clicks it (as an Angular handler might).
    await o.page.evaluate(() => {
      const b = document.querySelector('shopbadwill-badge')?.shadowRoot?.querySelector<HTMLButtonElement>('[data-action="hide-again"]');
      if (b == null) throw new Error('no Hide again');
      b.click();
    });
    await expect(card(o, C)).toHaveAttribute('data-sbw-hidden', '1');
    await expect(card(o, C)).not.toHaveAttribute('data-sbw-revealed', /.*/);
    await expectOnScreenOrClosed(o, 'collapsed');
    await clickNode(o, await find(o, openDialog, action('close-why')));
    const f = await escapeAndCheck(o, 'collapsed');
    expect([f.host, f.attrs['data-sbw-why'], f.action]).toEqual(['sbw-why', id(o, C), 'why']);
    await closePage(o);
  });

  test('a match-everything watch rule decorates nothing and offers no Why?', async () => {
    const everything: Rule = { ...rule('sbw-match-everything', 'Match everything', 'watch', A), all: [{ kind: 'price', min: 0 }] };
    const o = await openSearch([everything, GLOW_B]);
    await expect(card(o, B)).toHaveAttribute('data-sbw-highlight', 'green'); // evaluated (control)
    await expect(o.page.locator('[data-sbw-hidden]')).toHaveCount(0);
    await expect(o.page.locator('[data-sbw-highlight]')).toHaveCount(1);
    await expect(o.page.locator('sbw-stub-row')).toHaveCount(0);
    await expect(find(o, toolsHost(o, A), action('why'))).rejects.toThrow('node not found');
    await closePage(o);
  });

  test('kill switch on at load: nothing is decorated until it is turned off', async () => {
    const o = await openSearch(RULES, { ...defaultSettings(), killSwitch: true });
    await expect(o.page.locator('shopbadwill-badge [role="status"]')).toHaveText('ShopBadwill paused (kill switch)');
    await o.page.waitForTimeout(500);
    await expect(o.page.locator('[data-sbw-hidden], [data-sbw-highlight], sbw-stub-row')).toHaveCount(0);
    await seed({ 'sbw:settings': defaultSettings() });
    await decorated(o); // the same page and rules decorate once it is off
    await closePage(o);
  });

  test('revealed card: tools Why?, then its hide rule is renamed', async () => {
    const o = await openSearch(RULES);
    await decorated(o);
    await revealByStub(o, C);
    await openToolsWhyByHandle(o, C);
    await seed({ 'sbw:rules': [HIDE_A, GLOW_B, { ...HIDE_C, name: 'Hide C renamed', updatedAt: 2 }] });
    await expect
      .poll(async () => (await openDialogs(o))[0]?.rules ?? [])
      .toEqual(['Hide rule: Hide C renamed']);
    await expect(card(o, C)).toHaveAttribute('data-sbw-revealed', '1');
    await expectOnScreenOrClosed(o, 'renamed');
    const f = await escapeAndCheck(o, 'renamed');
    expect([f.host, f.attrs['data-sbw-tools'], f.action]).toEqual(['sbw-tools', id(o, C), 'why']);
    await closePage(o);
  });
});
