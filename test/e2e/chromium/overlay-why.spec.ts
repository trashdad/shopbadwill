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
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { expect, test, type BrowserContext, type Route, type Worker } from '@playwright/test';

import type { Rule } from '../../../src/domain/rules/schema';
import { defaultSettings } from '../../../src/domain/settings/defaults';
import type { Settings } from '../../../src/domain/settings/schema';
import {
  CORS,
  HTML,
  ROOT,
  SEARCH_API,
  action,
  attr,
  card,
  clickNode,
  escapeAndCheck,
  expectOnScreenOrClosed,
  extensionDir,
  find,
  host,
  hoverNode,
  id,
  launchExtension,
  openDialogs,
  openFixturePage,
  seed,
  type DomNode,
  type Opened,
} from './fixtures';

const EXTENSION = extensionDir();
interface SearchJson {
  searchResults: { items: Array<Record<string, unknown>>; itemCount: number };
}
const SEARCH_JSON = JSON.parse(readFileSync(path.join(ROOT, 'test/fixtures/sgw/json/search-grid-p1.json'), 'utf8')) as SearchJson;
const BEARER = 'eyJhbGciOiJIUzI1NiJ9.eyJCdXllcklkIjoiMSJ9.c2lnbmF0dXJl';

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
  ({ context, worker } = await launchExtension(EXTENSION));
  await context.route('**/*', fulfil);
});

test.afterAll(async () => {
  await context.close();
});

/** Seeds rules and settings, opens the fixture search page and lets the page make its one search call. */
async function openSearch(rules: Rule[], settings: Settings = defaultSettings()): Promise<Opened> {
  searchCalls = 0;
  blocked = [];
  await seed(worker, { 'sbw:rules': rules, 'sbw:settings': settings });
  const page = await context.newPage();
  if (process.env.SBW_E2E_CONSOLE === '1') {
    page.on('console', (m) => {
      console.log(`[page ${m.type()}] ${m.text()}`);
    });
  }
  const { cdp, ids } = await openFixturePage(page);
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
  return { page, cdp, ids };
}

async function closePage(o: Opened): Promise<void> {
  // Zero extra SGW requests: the page's own search call, and nothing else to any shopgoodwill.com host.
  expect(searchCalls).toBe(1);
  expect(blocked.filter((u) => /(^|\.)shopgoodwill\.com$/.test(new URL(u).hostname))).toEqual([]);
  await o.cdp.detach();
  await o.page.close();
}

// ── CDP: closed shadow roots ────────────────────────────────────────────────

const stubRow = (o: Opened, i: number) => host('SBW-STUB-ROW', 'data-sbw-stub', id(o, i));
const toolsHost = (o: Opened, i: number) => host('SBW-TOOLS', 'data-sbw-tools', id(o, i));
const openDialog = (n: DomNode): boolean => n.nodeName === 'DIALOG' && attr(n, 'open') !== undefined;

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
    await seed(worker, { 'sbw:settings': { ...defaultSettings(), killSwitch: true } });
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
    await seed(worker, { 'sbw:settings': dim });
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
    await seed(worker, { 'sbw:rules': [off(HIDE_A), GLOW_B, HIDE_C] });
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
    await seed(worker, { 'sbw:rules': [...RULES, HIDE_B] });
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
    await seed(worker, { 'sbw:rules': [HIDE_A, off(GLOW_B), HIDE_C] });
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
    await seed(worker, { 'sbw:settings': defaultSettings() });
    await decorated(o); // the same page and rules decorate once it is off
    await closePage(o);
  });

  test('revealed card: tools Why?, then its hide rule is renamed', async () => {
    const o = await openSearch(RULES);
    await decorated(o);
    await revealByStub(o, C);
    await openToolsWhyByHandle(o, C);
    await seed(worker, { 'sbw:rules': [HIDE_A, GLOW_B, { ...HIDE_C, name: 'Hide C renamed', updatedAt: 2 }] });
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
