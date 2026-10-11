// `pnpm serve-fake-site`: the fake SGW search page for the Chromium E2E (T-39).
// Binds 127.0.0.1:8789 (env SBW_FAKE_SITE_PORT) and serves the committed
// sanitized fixture test/fixtures/sgw/html/search-grid-logged-out.html with the
// real Angular replaced by a minimal script that performs the same XHR the real
// page performs (POST buyerapi Search/ItemListing with the body built from the
// URL) and renders the rows into the site's own card markup, so the MAIN-world
// api-tap path is exercised. The page is served for /categories/listing*; GET /
// answers a plain health line (Playwright's webServer probes it). It never
// reads test/fixtures/sgw/raw/.
//
// The search body defaults and the URL-parameter map come from
// src/adapters/sgw/config.ts, the same data the real page uses.
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { SGW_SEARCH_BODY_DEFAULTS, SGW_SEARCH_URL_PARAMS } from '../src/adapters/sgw/config';

export const SEARCH_API = 'https://buyerapi.shopgoodwill.com/api/Search/ItemListing';
export const SEARCH_PATH_PREFIX = '/categories/listing';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURE_HTML = path.join(ROOT, 'test/fixtures/sgw/html/search-grid-logged-out.html');

export interface FakeSite {
  url: string;
  close(): Promise<void>;
}
export interface FakeSiteOptions {
  /** 0 picks a free port. Default 8789. */
  port?: number;
  host?: string;
}

/**
 * The replacement for the real Angular app: the same search XHR (body built
 * from the URL like the site's buildSearchQueryString), the same rendered card
 * component, and SPA paging through history.pushState, exactly as the Angular
 * router navigates. Plain JS, no libraries, DOM nodes only (never innerHTML).
 */
export function fakeSiteScript(apiUrl: string = SEARCH_API): string {
  const defaults = JSON.stringify(SGW_SEARCH_BODY_DEFAULTS);
  const params = JSON.stringify(SGW_SEARCH_URL_PARAMS);
  return `(function () {
  'use strict';
  if (window.__sbwFakeSiteInstalled) return;
  window.__sbwFakeSiteInstalled = true;
  document.documentElement.setAttribute('data-sbw-fake-site', '1');
  var API = ${JSON.stringify(apiUrl)};
  var DEFAULTS = ${defaults};
  var PARAMS = ${params};
  var PAGE_SIZE = 40;

  function el(tag, attrs, text) {
    var n = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) { n.setAttribute(k, attrs[k]); });
    if (text !== undefined && text !== null) n.textContent = text;
    return n;
  }

  // The search body the real site sends: defaults plus the URL params it knows.
  function body() {
    var b = JSON.parse(JSON.stringify(DEFAULTS));
    var q = new URLSearchParams(window.location.search);
    q.forEach(function (value, key) {
      var field = PARAMS[key];
      if (!field || !(field in b)) return;
      var def = b[field];
      if (typeof def === 'boolean') b[field] = value === 'true';
      else if (typeof def === 'number') b[field] = Number(value);
      else if (def === 'true' || def === 'false') b[field] = value === 'true' ? 'true' : 'false';
      else if (/^\\d+$/.test(def)) b[field] = /^\\d+$/.test(value) ? String(Number(value)) : '';
      else b[field] = value;
    });
    b.pageSize = '40';
    return b;
  }

  function money(n) {
    return '$' + Number(n).toFixed(2).replace(/\\.00$/, '');
  }

  // Naive Pacific wall time, like the site's own rows (October fixtures: PDT).
  function timeLeft(naive) {
    var ms = Date.parse(naive + '-07:00');
    if (!isFinite(ms)) return '';
    var left = ms - Date.now();
    if (left <= 0) return 'Ended';
    var m = Math.floor(left / 60000);
    if (m < 60) return m + 'm';
    var h = Math.floor(m / 60);
    m = m % 60;
    if (h < 24) return h + 'h ' + m + 'm';
    var d = Math.floor(h / 24);
    return d + 'd ' + (h % 24) + 'h';
  }

  function card(row) {
    var cell = el('div', { class: 'p-col-12 item-col p-md-4 ng-star-inserted' });
    var host = el('app-home-product-items');
    var root = el('div', { class: 'feat-item ng-star-inserted' });
    var imgA = el('a', { 'aria-hidden': 'true', tabindex: '-1', href: '/item/' + row.itemId });
    var figure = el('figure', { class: 'figure-bg position-relative' });
    figure.append(el('img', { loading: 'lazy', class: 'feat-item_img cursor-pointer', alt: row.title, src: 'https://img.test/fake-' + row.itemId + '.jpg' }));
    imgA.append(figure);
    var info = el('div', { class: 'feat-item_info' });
    var grow = el('div', { class: 'flex-grow-1' });
    grow.append(
      el('a', { class: 'feat-item_name ng-star-inserted', title: row.title, id: String(row.itemId), href: '/item/' + row.itemId }, row.title),
      el('p', { class: 'feat-item_price' }, ' ' + money(row.currentPrice) + ' '),
    );
    var heartBox = el('div', { class: 'ml-3' });
    var heart = el('a', { href: '#', tooltipposition: 'top', 'aria-label': 'Add to your Favorites list', class: 'p-element btn-heart ng-star-inserted', 'aria-describedby': String(row.itemId) });
    heart.append(el('img', { loading: 'lazy', alt: 'Add to Favorites', class: 'img-fluid w-100', src: 'https://img.test/heart.jpg' }));
    heartBox.append(heart);
    info.append(grow, heartBox);
    var bottom = el('ul', { class: 'feat-item_bottom ng-star-inserted' });
    bottom.append(el('li', { class: 'ng-star-inserted' }, ' Bids: ' + row.numBids));
    bottom.append(el('li', { class: 'ng-star-inserted' }, 'Time remaining: ' + timeLeft(row.endTime)));
    var qb = el('li', { class: 'ng-star-inserted' });
    qb.append(el('a', { href: '#', 'aria-label': 'Quick Bid', title: 'Quick Bid', 'aria-describedby': String(row.itemId) }, 'Quick Bid'));
    bottom.append(qb);
    root.append(imgA, info, bottom);
    host.append(root);
    cell.append(host);
    return cell;
  }

  function updatePaginator(rootClass, page, pageCount, total) {
    var pag = document.querySelector('.' + rootClass + ' .p-paginator');
    if (!pag) return;
    var span = pag.querySelector('.p-paginator-left-content span');
    if (span) {
      var from = total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
      span.textContent = ' Showing ' + from + ' to ' + Math.min(page * PAGE_SIZE, total) + ' of ' + total + ' entries ';
    }
    var pages = pag.querySelector('.p-paginator-pages');
    if (!pages) return;
    pages.replaceChildren();
    for (var p = 1; p <= pageCount; p++) {
      var b = el('button', { type: 'button', class: 'p-ripple p-element p-paginator-page p-paginator-element p-link ng-star-inserted' + (p === page ? ' p-highlight' : '') });
      if (p === page) b.setAttribute('aria-current', 'true');
      b.append(document.createTextNode(' ' + p + ' '));
      pages.append(b);
    }
  }

  function render(json) {
    var rows = json.searchResults.items;
    var total = json.searchResults.itemCount;
    var page = Number(json.page) || 1;
    var grid = document.querySelector('.p-dataview-content .p-grid');
    if (!grid) return;
    grid.replaceChildren();
    rows.forEach(function (row) { grid.append(card(row)); });
    var pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
    updatePaginator('p-paginator-top', page, pageCount, total);
    updatePaginator('p-paginator-bottom', page, pageCount, total);
    var content = document.querySelector('.p-dataview-content');
    if (content) content.dataset.page = String(page);
  }

  function load() {
    return fetch(API, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body()),
    }).then(function (r) {
      if (!r.ok) throw new Error('search answered ' + r.status);
      return r.json();
    }).then(render).catch(function (e) {
      document.documentElement.setAttribute('data-sbw-fake-error', String(e));
    });
  }

  // SPA navigation: the paginator buttons push a new URL (like the Angular
  // router) and re-run the search; popstate serves back/forward.
  function navigate(changes) {
    var q = new URLSearchParams(window.location.search);
    Object.keys(changes).forEach(function (k) {
      var v = changes[k];
      if (v === null || v === '') q.delete(k);
      else q.set(k, v);
    });
    var next = window.location.pathname + (q.toString() ? '?' + q.toString() : '');
    window.history.pushState({}, '', next);
    void load();
  }

  document.addEventListener('click', function (e) {
    var t = e.target;
    if (!t || !t.closest) return;
    var b = t.closest('button.p-paginator-page');
    if (!b) return;
    e.preventDefault();
    var page = Number(b.textContent.trim());
    if (!isFinite(page) || page < 1) return;
    navigate({ p: String(page) });
  });
  window.addEventListener('popstate', function () {
    void load();
  });

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { void load(); });
  else void load();
})();`;
}

/** The fixture with the replacement script injected right before </body>. */
export function buildSearchPage(html: string, opts: { apiUrl?: string } = {}): string {
  const at = html.lastIndexOf('</body>');
  if (at === -1) throw new Error('the fixture has no </body>');
  const script = `<script data-sbw-fake-script>${fakeSiteScript(opts.apiUrl)}</script>`;
  return `${html.slice(0, at)}${script}${html.slice(at)}`;
}

export async function startFakeSite(opts: FakeSiteOptions = {}): Promise<FakeSite> {
  const page = buildSearchPage(readFileSync(FIXTURE_HTML, 'utf8'));
  const server: Server = createServer((req, res) => {
    const method = req.method ?? 'GET';
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (method !== 'GET' && method !== 'HEAD') {
      res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Method not allowed on the fake SGW site\n');
      return;
    }
    const head = method === 'HEAD';
    if (url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      res.end(head ? undefined : 'ShopBadwill fake SGW site (T-39 E2E)\n');
      return;
    }
    if (url.pathname.startsWith(SEARCH_PATH_PREFIX)) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(head ? undefined : page);
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Not found in the fake SGW site\n');
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 8789, opts.host ?? '127.0.0.1', resolve);
  });
  const addr = server.address() as AddressInfo;
  return {
    url: `http://${addr.address}:${String(addr.port)}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((e) => {
          if (e) reject(e);
          else resolve();
        });
      }),
  };
}

const isMain = process.argv[1] !== undefined && /serve-fake-site\.ts$/.test(process.argv[1]);
if (isMain) {
  const port = Number(process.env.SBW_FAKE_SITE_PORT ?? 8789);
  const site = await startFakeSite({ port });
  console.log(`fake site listening on ${site.url}`);
  const stop = (): void => {
    void site.close().then(() => process.exit(0));
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}
