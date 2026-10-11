// T-39: the overlay end to end in a real Chromium, on the TEST build
// (.output/chrome-mv3-test: SBW_TEST=1). The full user arc:
//
//   rules created in the options UI
//     → the fake SGW search page (served by scripts/serve-fake-site.ts on
//       127.0.0.1:8789; Playwright route answers https://shopgoodwill.com/**
//       by fetching the fake site with the Host header `sgw.test`)
//     → highlights, stubs and the hidden bar
//     → Why?
//     → undo (the bar's Show)
//     → an SPA page change (the fake site's paginator: pushState + the same
//       search XHR to the fake buyerapi on 127.0.0.1:8787, through the route)
//       after which everything is still correct
//     → the kill switch (the popup's one kill control: one click turns it on),
//       which clears the decorations.
//
// Every request is either fulfilled by the route from a local fake server or
// aborted. Anything else is recorded; the test fails if a request to a host
// beyond the known set was ever attempted. The background's own base URLs are
// overridden to the fake servers through the real `sbw:test:baseUrl` test hook
// (called from the options page), so no request from the extension can leave
// the machine either.
//
// The fake buyerapi clock is pinned to 2026-10-08T00:00:00 Pacific, so the
// open-auction set (and therefore which cards are on page 1 and page 2) is
// fixed forever: page 1 holds "Pyrex lot #1 vintage" (watch rule: never
// decorated), the five Fiesta lots (highlight) and the one Lodge-titled cast
// iron (hide); page 2 holds three Fiesta lots and eight Lodge lots.
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { expect, test, type BrowserContext, type Page, type Route, type Worker } from '@playwright/test';

import { pacificNaiveToEpoch } from '../../fakes/fake-sgw-server/clock';
import {
  action,
  cardById,
  clickNode,
  escapeAndCheck,
  expectOnScreenOrClosed,
  find,
  host,
  launchExtension,
  openDialogs,
  testExtensionDir,
  type Opened,
} from './fixtures';
import { decideRequest, FAKE_BUYERAPI, FAKE_GOOGLE } from './network';

const SEARCH_URL = 'https://shopgoodwill.com/categories/listing?layout=grid&p=1';

// Card ids on page 1 (clock pinned to 2026-10-08T00:00:00 PT, sort by end time).
const PYREX = '280000000'; // "Pyrex lot #1 vintage" — watch rule: no decoration
const FIESTA = '280000001'; // "Fiesta lot #2" — highlight
const LODGE = '279250311'; // "Heavy Cast Iron Skillet 12 inch Lodge (Local Pickup Only)" — hide
// Page 2.
const FIESTA_2 = '280000037'; // "Fiesta lot #38"
const LODGE_2 = '280000086'; // "Lodge lot #87"

let context: BrowserContext;
let worker: Worker;
let siteHits = 0; // requests answered by the fake site server (through the route)
let buyerHits = 0; // requests answered by the fake buyerapi (through the route)
/** Requests to hosts beyond the known set: the spec fails unless this stays empty. */
const unexpected: string[] = [];

async function fulfil(route: Route): Promise<void> {
  const req = route.request();
  const decision = decideRequest(req.url());
  if (decision.action === 'continue') {
    await route.continue();
    return;
  }
  if (decision.action === 'abort') {
    if (decision.unexpected) unexpected.push(req.url());
    await route.abort();
    return;
  }
  if (decision.bucket === 'site') siteHits += 1;
  if (decision.bucket === 'buyerapi') buyerHits += 1;
  const res = await route.fetch({
    url: decision.url,
    method: req.method(),
    headers: decision.bucket === 'site' ? { ...req.headers(), host: 'sgw.test' } : req.headers(),
    postData: req.postData() ?? undefined,
  });
  await route.fulfill({ response: res });
}

/** Pins the fake buyerapi clock so the open-auction set (and the page split) never drifts. */
async function pinBuyerApiClock(): Promise<void> {
  const res = await fetch(`${FAKE_BUYERAPI}/__scenario`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ reset: true, serverNowMs: pacificNaiveToEpoch('2026-10-08T00:00:00') }),
  });
  expect(res.status).toBe(200);
}

interface ChromeStorageClear {
  chrome: { storage: { local: { clear(): Promise<void> } } };
}
async function clearStorage(): Promise<void> {
  await worker.evaluate(async () => {
    await (globalThis as unknown as ChromeStorageClear).chrome.storage.local.clear();
  });
}

interface ChromePort {
  onMessage: { addListener(cb: (m: unknown) => void): void };
  postMessage(m: unknown): void;
  disconnect(): void;
}
interface ChromeRuntime {
  chrome: { runtime: { connect(info: { name: string }): ChromePort } };
}
interface HookReply {
  ok: boolean;
  value?: unknown;
  error?: string;
}

/** Calls a test hook from an extension page (the options page), like the Firefox harness does. */
async function callHook(page: Page, name: string, payload: unknown): Promise<HookReply> {
  return page.evaluate(
    async ({ hook, data }) => {
      const chrome = (globalThis as unknown as ChromeRuntime).chrome;
      const reply = await new Promise<HookReply>((resolve) => {
        const port = chrome.runtime.connect({ name: hook });
        const timer = setTimeout(() => {
          port.disconnect();
          resolve({ ok: false, error: `no reply on ${hook} within 10 s` });
        }, 10_000);
        port.onMessage.addListener((m) => {
          clearTimeout(timer);
          port.disconnect();
          resolve(m as HookReply);
        });
        port.postMessage({ payload: data });
      });
      return reply;
    },
    { hook: name, data: payload },
  );
}

async function openOptions(): Promise<Page> {
  const id = new URL(worker.url()).host;
  const page = await context.newPage();
  await page.goto(`chrome-extension://${id}/options.html`);
  await expect(page.locator('h1')).toHaveText('ShopBadwill options');
  await expect(page.locator('#new-rule-button')).toBeVisible();
  return page;
}

/** Creates one rule through the options UI and waits for it to land in the "Your rules" list. */
async function createRule(page: Page, name: string, action: 'highlight' | 'hide' | 'watch', terms: string): Promise<void> {
  await page.locator('#new-rule-button').click();
  await page.locator('#rule-name').fill(name);
  await page.locator('#rule-action').selectOption(action);
  await page.locator('#add-all').click(); // adds condition 0 (a keyword condition by default)
  await page.locator('#cond-all-0-terms').fill(terms);
  await page.locator('form.sbw-editor button[type="submit"]').click();
  await expect(page.getByRole('list', { name: 'Your rules' })).toContainText(name);
  await expect(page.locator('#new-rule-button')).toBeVisible(); // the editor closed
}

/** The CDP view of a page (closed shadow roots are reached through it). */
async function opened(page: Page): Promise<Opened> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('DOM.enable');
  const ids = await page.$$eval('app-home-product-items a.feat-item_name', (as) => as.map((a) => Number(a.id)));
  return { page, cdp, ids };
}

test('rules created in options decorate the fake SGW search page, survive an SPA change, and clear on the kill switch', async () => {
  const pill = (page: Page) => page.locator('shopbadwill-badge [role="status"]');

  await test.step('the base URLs point at the fake servers (sbw:test:baseUrl)', async () => {
    const options = await openOptions();
    const reply = await callHook(options, 'sbw:test:baseUrl', { sgw: FAKE_BUYERAPI, google: FAKE_GOOGLE });
    expect(reply).toEqual({ ok: true, value: { sgw: FAKE_BUYERAPI, google: FAKE_GOOGLE } });
    await options.close();
    // The rewritten background fetch must reach the fake buyerapi. continue()
    // would drop it on the dead proxy and this status would never come back.
    const status = await worker.evaluate(async () => {
      const response = await fetch('https://buyerapi.shopgoodwill.com/__log');
      return response.status;
    });
    expect(status).toBe(200);
  });

  await test.step('rules are created in options: Highlight Fiesta, Hide Lodge, Watch Pyrex', async () => {
    const options = await openOptions();
    await createRule(options, 'Highlight Fiesta', 'highlight', 'Fiesta');
    await createRule(options, 'Hide Lodge', 'hide', 'Lodge');
    await createRule(options, 'Watch Pyrex', 'watch', 'Pyrex');
    // The saved list shows all three, in creation order, on.
    const items = options.getByRole('list', { name: 'Your rules' }).locator('.sbw-rule');
    await expect(items).toHaveCount(3);
    await expect(items.nth(0)).toContainText('Highlight Fiesta');
    await expect(items.nth(1)).toContainText('Hide Lodge');
    await expect(items.nth(2)).toContainText('Watch Pyrex');
    await expect(options.getByRole('list', { name: 'Your rules' }).locator('.sbw-rule[data-enabled="true"]')).toHaveCount(3);
    await options.close();
  });

  const search = await context.newPage();
  const lodgeCard = search.locator(`app-home-product-items:has(a.feat-item_name[id="${LODGE}"])`);
  const pyrexCard = search.locator(`app-home-product-items:has(a.feat-item_name[id="${PYREX}"])`);

  await test.step('the fake SGW search page loads and the overlay decorates it', async () => {
    await search.goto(SEARCH_URL);
    // The fake site's own script (the Angular replacement) hydrated the page.
    await expect(search.locator('html[data-sbw-fake-site]')).toBeAttached();
    await expect(search.locator(`a.feat-item_name[id="${FIESTA}"]`)).toBeAttached();

    // Highlights: the five Fiesta lots on page 1.
    await expect(cardById(search, FIESTA)).toHaveAttribute('data-sbw-highlight', 'green');
    await expect(search.locator('[data-sbw-highlight]')).toHaveCount(5);
    // The hide: the Lodge-titled cast iron is collapsed, its stub row in place.
    await expect(lodgeCard).toHaveAttribute('data-sbw-hidden', '1');
    await expect(search.locator(`sbw-stub-row[data-sbw-stub="${LODGE}"]`)).toHaveCount(1);
    await expect(search.locator('[data-sbw-hidden]')).toHaveCount(1);
    // The watch rule decorates nothing: the Pyrex card carries no decoration.
    await expect(pyrexCard).not.toHaveAttribute('data-sbw-hidden', /.*/);
    await expect(pyrexCard).not.toHaveAttribute('data-sbw-highlight', /.*/);
    // The hidden bar counts the one hidden card and offers Show.
    await expect(pill(search)).toContainText('1 hidden');
    await expect(search.locator('shopbadwill-badge [data-action="show-all"]')).toBeVisible();
  });

  await test.step('Why? explains the hidden card', async () => {
    const o = await opened(search);
    await clickNode(o, await find(o, host('SBW-STUB-ROW', 'data-sbw-stub', LODGE), action('why')));
    await expect.poll(async () => (await openDialogs(o)).length).toBe(1);
    const [d] = await expectOnScreenOrClosed(o, 'why open');
    expect(d?.heading).toBe('Why this listing is hidden');
    expect(d?.rules).toEqual(['Hide rule: Hide Lodge']);
    await escapeAndCheck(o, 'why closed');
  });

  await test.step('undo: the bar Show re-shows the hidden card', async () => {
    await search.locator('shopbadwill-badge [data-action="show-all"]').click();
    await expect(lodgeCard).toHaveAttribute('data-sbw-revealed', '1');
    await expect(lodgeCard).toBeVisible(); // really shown again, not just bookkeeping
    await expect(pill(search)).toContainText('1 shown');
    await expect(search.locator('shopbadwill-badge [data-action="hide-again"]')).toBeVisible();
  });

  await test.step('an SPA page change (the site paginator) re-runs the search and stays correct', async () => {
    await search.locator('.p-paginator-top').getByRole('button', { name: '2', exact: true }).click();
    await expect(search).toHaveURL(/p=2/);
    // Page 2 hydrated: fresh cards, the page-1 ones gone.
    await expect(search.locator(`a.feat-item_name[id="${LODGE_2}"]`)).toBeAttached();
    await expect(search.locator(`a.feat-item_name[id="${PYREX}"]`)).toHaveCount(0);
    // Still correct: three Fiesta lots highlighted, eight Lodge lots hidden, bar updated, nothing revealed.
    await expect(cardById(search, FIESTA_2)).toHaveAttribute('data-sbw-highlight', 'green');
    await expect(search.locator('[data-sbw-highlight]')).toHaveCount(3);
    await expect(search.locator('[data-sbw-hidden]')).toHaveCount(8);
    await expect(search.locator('sbw-stub-row')).toHaveCount(8);
    await expect(search.locator('[data-sbw-revealed]')).toHaveCount(0);
    await expect(pill(search)).toContainText('8 hidden');
  });

  await test.step('the kill switch clears the decorations', async () => {
    // T-86: the popup has one kill control. Kill on is one click ("Stop all
    // automation"); kill off asks first. Alt+Shift+K is the same kill.set, but
    // headless Chromium does not route synthetic keys to extension commands.
    const id = new URL(worker.url()).host;
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${id}/popup.html`);
    const kill = popup.locator('button.kill-button');
    await expect(kill).toHaveCount(1);
    await expect(kill).toContainText('Stop all automation');
    await kill.click();
    await expect(popup.locator('[data-testid="kill-state"]')).toContainText('STOPPED');
    await popup.close();
    // The broadcast reached the search page: every decoration is gone.
    await expect(pill(search)).toHaveText('ShopBadwill paused (kill switch)');
    await expect(search.locator('[data-sbw-hidden], [data-sbw-highlight], sbw-stub-row')).toHaveCount(0);
  });

  await search.close();

  await test.step('no request ever left the machine', () => {
    expect(siteHits, 'the page came from the fake site server').toBeGreaterThanOrEqual(1);
    expect(buyerHits, 'the page search XHR went to the fake buyerapi (initial + SPA)').toBeGreaterThanOrEqual(2);
    expect(unexpected, `unexpected hosts: ${unexpected.join(', ')}`).toEqual([]);
  });
});

test.beforeAll(async () => {
  const dir = testExtensionDir(); // (re)builds .output/chrome-mv3-test from the current sources
  const manifest = JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf8')) as {
    host_permissions?: string[];
  };
  // The test build carries the fake-server host permission (the prod build must not: check-prod-bundle).
  expect(manifest.host_permissions, 'run `pnpm build:test` or clear .output/chrome-mv3-test').toContain('http://127.0.0.1/*');
  ({ context, worker } = await launchExtension(dir));
  await context.route('**/*', fulfil);
  await pinBuyerApiClock();
  await clearStorage(); // the rules must be created in options, from scratch
});

test.afterAll(async () => {
  await context.close();
});
