// Shared harness for the Chromium E2E specs (T-32's overlay-why.spec.ts moved
// its launch/CDP plumbing here; T-39's overlay.spec.ts uses the same pieces).
//
// - `extensionDir()`: the newest existing build (prod or test) — what
//   overlay-why needs. `testExtensionDir()`: the TEST build (.output/chrome-mv3-test,
//   rebuilt from the current sources each run), which overlay.spec needs
//   (fake-server host permission, test hooks). `SBW_CHROME_EXTENSION_DIR`
//   overrides either.
// - `launchExtension()`: a persistent context with the extension loaded and a
//   fail-closed network (no name resolves, any proxied request hits a dead
//   port). Callers add their own `context.route` policy on top.
// - CDP helpers: closed shadow roots are reached through DOM.getDocument with
//   pierce; every click, hover and key sent with them is a real (trusted)
//   input event.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium, expect, type BrowserContext, type CDPSession, type Page, type Worker } from '@playwright/test';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
export const FIX = path.join(ROOT, 'test/fixtures/sgw');
export const HTML = readFileSync(path.join(FIX, 'html/search-grid-logged-out.html'), 'utf8');
export const PAGE_URL = 'https://shopgoodwill.com/categories/listing?st=pyrex&p=1';
export const SEARCH_API = 'https://buyerapi.shopgoodwill.com/api/Search/ItemListing';
export const CORS = {
  'access-control-allow-origin': 'https://shopgoodwill.com',
  'access-control-allow-credentials': 'true',
  'access-control-allow-headers': 'authorization, content-type',
  'access-control-allow-methods': 'POST, OPTIONS',
};

/** SBW_CHROME_EXTENSION_DIR, else the newer of the production build and CI's test build (`pnpm build:test`). */
export function extensionDir(): string {
  const fromEnv = process.env.SBW_CHROME_EXTENSION_DIR;
  if (fromEnv !== undefined && fromEnv !== '') return path.resolve(fromEnv);
  const built = ['.output/chrome-mv3', '.output/chrome-mv3-test']
    .map((d) => path.join(ROOT, d))
    .filter((d) => existsSync(path.join(d, 'manifest.json')))
    .sort((x, y) => statSync(path.join(y, 'manifest.json')).mtimeMs - statSync(path.join(x, 'manifest.json')).mtimeMs);
  return built[0] ?? path.join(ROOT, '.output/chrome-mv3');
}

/** The TEST build (.output/chrome-mv3-test), rebuilt with SBW_TEST=1 so it always reflects the working tree (T-39). */
export function testExtensionDir(): string {
  const fromEnv = process.env.SBW_CHROME_EXTENSION_DIR;
  if (fromEnv !== undefined && fromEnv !== '') return path.resolve(fromEnv);
  buildTestExtension();
  return path.join(ROOT, '.output/chrome-mv3-test');
}

/** `pnpm build:test` (chrome): SBW_TEST=1, mode "test" (never replaces a prod build). */
function buildTestExtension(): void {
  const wxtCli = path.join(ROOT, 'node_modules', 'wxt', 'bin', 'wxt.mjs');
  const result = spawnSync(process.execPath, [wxtCli, 'build', '--mode', 'test'], {
    cwd: ROOT,
    env: { ...process.env, SBW_TEST: '1' },
    stdio: 'inherit',
  });
  if (result.status !== 0) throw new Error(`building the test extension failed (exit ${String(result.status)})`);
  if (!existsSync(path.join(ROOT, '.output/chrome-mv3-test', 'manifest.json'))) {
    throw new Error('the test extension build produced no .output/chrome-mv3-test/manifest.json');
  }
}

export interface ExtensionHandle {
  context: BrowserContext;
  worker: Worker;
}

/**
 * The fail-closed browser: the unpacked extension loaded, no hostname resolves
 * and any proxied request hits a dead port. The caller routes every request.
 */
export async function launchExtension(extension: string): Promise<ExtensionHandle> {
  if (!existsSync(path.join(extension, 'manifest.json'))) {
    throw new Error(`No Chrome build at ${extension}. Run \`pnpm build\` (or \`pnpm build:test\`) first.`);
  }
  const context = await chromium.launchPersistentContext('', {
    channel: 'chromium',
    headless: true,
    viewport: { width: 1280, height: 800 },
    args: [
      `--disable-extensions-except=${extension}`,
      `--load-extension=${extension}`,
      // Fail closed: no name resolves and any proxied request hits a dead port.
      '--host-resolver-rules=MAP * ~NOTFOUND',
      '--proxy-server=http://127.0.0.1:9',
    ],
  });
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  return { context, worker };
}

interface ChromeLike {
  chrome: { storage: { local: { set(items: Record<string, unknown>): Promise<void> } } };
}

/** Seeds storage.local through the service worker. */
export async function seed(worker: Worker, items: Record<string, unknown>): Promise<void> {
  await worker.evaluate(async (v) => {
    await (globalThis as unknown as ChromeLike).chrome.storage.local.set(v);
  }, items);
}

/** Opens the fixture search page: navigation, overlay nonce, card ids, a CDP session with the DOM enabled. */
export async function openFixturePage(page: Page): Promise<{ cdp: CDPSession; ids: number[] }> {
  await page.goto(PAGE_URL);
  await page.waitForSelector('html[data-sbw-nonce]', { state: 'attached' });
  const ids = await page.$$eval('app-home-product-items a.feat-item_name', (as) => as.map((a) => Number(a.id)));
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('DOM.enable');
  return { cdp, ids };
}

// ── CDP: closed shadow roots ────────────────────────────────────────────────

export interface DomNode {
  nodeName: string;
  backendNodeId: number;
  attributes?: string[];
  children?: DomNode[];
  shadowRoots?: DomNode[];
}

export function attr(n: DomNode, name: string): string | undefined {
  const a = n.attributes ?? [];
  for (let i = 0; i + 1 < a.length; i += 2) if (a[i] === name) return a[i + 1];
  return undefined;
}

export function* walk(n: DomNode): Generator<DomNode> {
  yield n;
  for (const c of n.children ?? []) yield* walk(c);
  for (const s of n.shadowRoots ?? []) yield* walk(s);
}

export interface Opened {
  page: Page;
  cdp: CDPSession;
  /** Item ids of the result cards, in page order. */
  ids: number[];
}

export function id(o: Opened, index: number): string {
  const v = o.ids[index];
  if (v === undefined) throw new Error(`no card ${String(index)}`);
  return String(v);
}

export const card = (o: Opened, index: number) => o.page.locator(`app-home-product-items:has(a.feat-item_name[id="${id(o, index)}"])`);
export const cardById = (page: Page, itemId: number | string) =>
  page.locator(`app-home-product-items:has(a.feat-item_name[id="${String(itemId)}"])`);

export async function tree(o: Opened): Promise<DomNode> {
  const { root } = await o.cdp.send('DOM.getDocument', { depth: -1, pierce: true });
  return root;
}

/** The first node matching `pred` inside the subtree of the first node matching `scope`. */
export async function find(o: Opened, scope: (n: DomNode) => boolean, pred: (n: DomNode) => boolean): Promise<DomNode> {
  for (const s of walk(await tree(o))) {
    if (!scope(s)) continue;
    for (const n of walk(s)) if (n !== s && pred(n)) return n;
  }
  throw new Error('node not found');
}

export const host = (tag: string, name: string, value: string) => (n: DomNode) => n.nodeName === tag && attr(n, name) === value;
export const action = (a: string) => (n: DomNode) => n.nodeName === 'BUTTON' && attr(n, 'data-action') === a;
export const openDialog = (n: DomNode): boolean => n.nodeName === 'DIALOG' && attr(n, 'open') !== undefined;

export async function centre(o: Opened, n: DomNode): Promise<{ x: number; y: number }> {
  await o.cdp.send('DOM.scrollIntoViewIfNeeded', { backendNodeId: n.backendNodeId });
  const { model } = await o.cdp.send('DOM.getBoxModel', { backendNodeId: n.backendNodeId });
  const q = model.border.map((v) => v);
  const x = ((q[0] ?? 0) + (q[2] ?? 0) + (q[4] ?? 0) + (q[6] ?? 0)) / 4;
  const y = ((q[1] ?? 0) + (q[3] ?? 0) + (q[5] ?? 0) + (q[7] ?? 0)) / 4;
  return { x, y };
}

export async function clickNode(o: Opened, n: DomNode): Promise<void> {
  const p = await centre(o, n);
  await o.page.mouse.click(p.x, p.y);
}

export async function hoverNode(o: Opened, n: DomNode): Promise<void> {
  const p = await centre(o, n);
  await o.page.mouse.move(p.x, p.y);
}

export async function call<T>(o: Opened, backendNodeId: number, fn: string): Promise<T> {
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

export interface DialogState {
  modal: boolean;
  visible: boolean;
  width: number;
  height: number;
  /** elementFromPoint at the dialog's centre is the dialog (or its shadow host). */
  onTop: boolean;
  heading: string;
  rules: string[];
}

export const DIALOG_STATE = `function () {
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

export async function openDialogs(o: Opened): Promise<DialogState[]> {
  const out: DialogState[] = [];
  for (const n of walk(await tree(o))) {
    if (openDialog(n)) out.push(await call<DialogState>(o, n.backendNodeId, DIALOG_STATE));
  }
  return out;
}

/** A real click on a probe at the top-right corner reaches the page (it is not inert). It leaves focus where it is. */
export async function pageTakesClicks(o: Opened): Promise<boolean> {
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
export async function expectOnScreenOrClosed(o: Opened, label: string): Promise<DialogState[]> {
  const dialogs = await openDialogs(o);
  for (const d of dialogs) {
    expect(d.modal && d.visible && d.width > 0 && d.height > 0 && d.onTop, `${label}: open dialog not on screen: ${JSON.stringify(d)}`).toBe(true);
  }
  if (dialogs.length === 0) expect(await pageTakesClicks(o), `${label}: no dialog, yet the page is inert`).toBe(true);
  return dialogs;
}

export interface Focus {
  /** Tag of document.activeElement (our shadow host), or null for the body. */
  host: string | null;
  attrs: Record<string, string>;
  /** data-action of the focused control inside the host's shadow root. */
  action: string | null;
  visible: boolean;
}

export async function focused(o: Opened): Promise<Focus> {
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
export async function escapeAndCheck(o: Opened, label: string): Promise<Focus> {
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
