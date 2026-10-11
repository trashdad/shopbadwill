// T-60: the live SGW canary. Nightly (see .github/workflows/canary.yml) it makes
// at most 3 anonymous, read-only requests (4 with the single allowed retry) and checks
// that SGW's API schemas and item-page selectors still match ours:
//
//   1. POST Search/ItemListing   { searchText: 'pyrex', page 1 }   (S-1 verified query shape)
//   2. GET  ItemDetail/GetItemDetailModelByItemId/<first result>
//   3. one rendered https://shopgoodwill.com/item/<id> (Playwright Chromium) for item-page selectors
//
// Considerate-use rules (PLAN standing rules, controller rulings R1 to R3):
//   - no cookies, no Authorization header, honest User-Agent, no login, no writes;
//   - at least 120 s (robots.txt Crawl-delay) between requests, measured from the end of one
//     request to the start of the next, including across runs via the state file;
//   - never a search page (/categories/listing?st=) or /shopgoodwill/*: every URL goes through the
//     deny-by-default guard from capture-fixtures.ts (checkCaptureUrl) BEFORE it is sent;
//   - at most one run per 12 h (the lock) and at most 4 requests per rolling 24 h (the budget).
//     `force` bypasses the lock only; the budget and the spacing still apply;
//   - 403/429 or a challenge page stops the run at once (no retry): inconclusive.
//
// Outcomes:
//   pass          every check matched.
//   drift         SGW answered, but a schema or selector no longer matches (or a non-transient
//                 HTTP error such as 404/400). Exit code 1; the workflow opens/updates the issue.
//   inconclusive  only network errors, timeouts, 5xx, 403/429 or a challenge. THRESHOLD: a request
//                 is retried once after 120 s (one retry per run, which keeps the run at 4 requests);
//                 if it still fails it is "inconclusive": logged as a warning, exit code 0, and NO
//                 drift issue. A pure network failure is never drift.
//   skipped       the lock or the daily budget refused the run. Exit code 0.
//
// Results and failures name the check and the path (`itemDetail: bidHistory.bidComplete: ...`),
// never a response body.
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SgwApiError } from '../src/ports/errors';
import { SGW_API_BASE, SGW_ENDPOINTS, SGW_ORIGIN, SGW_SEARCH_BODY_DEFAULTS, SGW_SELECTORS } from '../src/adapters/sgw/config';
import { normalizeItemDetail, normalizeSearch } from '../src/adapters/sgw/normalize';
import { CAPTURE_MIN_SPACING_MS, checkCaptureUrl } from './capture-fixtures';

// ── Constants (brief / rulings R1 to R3) ────────────────────────────────────

export const CANARY_QUERY = 'pyrex';
export const CANARY_MIN_SPACING_MS = CAPTURE_MIN_SPACING_MS; // 120 s
export const CANARY_RUN_INTERVAL_MS = 12 * 60 * 60 * 1000; // lock: one run per 12 h
export const CANARY_DAY_MS = 24 * 60 * 60 * 1000;
export const CANARY_MAX_REQUESTS_PER_DAY = 4;
export const CANARY_REQUESTS_PER_RUN = 3;
export const CANARY_MAX_RETRIES = 1;
export const CANARY_API_TIMEOUT_MS = 30_000;
export const CANARY_ISSUE_TITLE = 'SGW drift detected';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const DEFAULT_STATE_FILE = path.join(ROOT, 'canary-state', 'state.json');
export const DEFAULT_RESULT_FILE = path.join(ROOT, 'canary-out', 'result.json');

// ── Types ───────────────────────────────────────────────────────────────────

export type CanaryStatus = 'pass' | 'drift' | 'inconclusive' | 'skipped';

export interface CanaryFailure {
  /** Which check failed: `search`, `itemDetail`, `itemPage`. */
  check: string;
  /** Where: a response field path (`searchResults.items[0].itemId`) or a selector key (`SGW_SELECTORS.item.title`). */
  path: string;
  /** Short reason, never a response body. */
  message: string;
}

export interface CanaryResult {
  status: CanaryStatus;
  startedAt: string;
  requestsMade: number;
  failures: CanaryFailure[];
  inconclusive: CanaryFailure[];
  reason?: string;
}

/** Persisted between runs (workflow artifact). Timestamps are epoch ms. */
export interface CanaryState {
  /** Start of every run that made requests. */
  runs: number[];
  /** START of every request. */
  requests: number[];
  /** END of the most recent request (spacing is measured from it). */
  lastRequestEndedAt: number;
}

export interface PageCheckResult {
  status: number;
  /** True when a CAPTCHA or block page was seen. */
  challenged: boolean;
  /** Item-page selector key -> whether any of its selectors matched. */
  matched: Record<string, boolean>;
}

export interface CanaryOptions {
  /** Base URL for buyerapi (default SGW_API_BASE); tests point it at the fake server. */
  apiBase: string;
  /** Origin for item pages (default SGW_ORIGIN). */
  siteOrigin: string;
  stateFile: string;
  force: boolean;
  userAgent: string;
  fetchFn: typeof fetch;
  renderItemPage: (url: string) => Promise<PageCheckResult>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  log: (line: string) => void;
}

// ── Item-page selector checks ───────────────────────────────────────────────

/** The item-page selector groups the canary requires (SGW_SELECTORS.item keys). */
export const ITEM_PAGE_CHECK_KEYS = ['root', 'title', 'biddingControl', 'timeLeft', 'tabs', 'description'] as const;

export function itemPageSelectors(): Record<string, readonly string[]> {
  const out: Record<string, readonly string[]> = {};
  for (const k of ITEM_PAGE_CHECK_KEYS) out[k] = SGW_SELECTORS.item[k];
  return out;
}

// ── Guard ───────────────────────────────────────────────────────────────────

/** Throws unless the (real-host) URL passes the deny-by-default capture guard. */
export function assertAllowed(realUrl: string, method: string): void {
  const g = checkCaptureUrl(realUrl, method);
  if (!g.ok) throw new Error(`canary guard refused ${method} ${realUrl}: ${g.reason}`);
}

/** Maps a real SGW URL onto the configured bases (tests use a local fake server). */
function actualUrl(realUrl: string, opts: Pick<CanaryOptions, 'apiBase' | 'siteOrigin'>): string {
  if (realUrl.startsWith(SGW_API_BASE)) return opts.apiBase + realUrl.slice(SGW_API_BASE.length);
  if (realUrl.startsWith(SGW_ORIGIN + '/')) return opts.siteOrigin + realUrl.slice(SGW_ORIGIN.length);
  throw new Error(`canary: URL is not an SGW URL: ${realUrl}`);
}

// ── State (the lock and the budget) ─────────────────────────────────────────

export function emptyState(): CanaryState {
  return { runs: [], requests: [], lastRequestEndedAt: 0 };
}

export function loadState(file: string, now: number): CanaryState {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return emptyState();
  }
  const o = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const nums = (v: unknown): number[] => (Array.isArray(v) ? v.filter((x): x is number => typeof x === 'number' && Number.isFinite(x)) : []);
  const ended = typeof o['lastRequestEndedAt'] === 'number' && Number.isFinite(o['lastRequestEndedAt']) ? o['lastRequestEndedAt'] : 0;
  // Keep a little more than the 24 h window; anything in the future is clock noise and is kept (conservative).
  return {
    runs: nums(o['runs']).filter((t) => now - t < CANARY_DAY_MS),
    requests: nums(o['requests']).filter((t) => now - t < CANARY_DAY_MS),
    lastRequestEndedAt: ended,
  };
}

export function saveState(file: string, s: CanaryState): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(s));
  renameSync(tmp, file);
}

// ── Request helper ──────────────────────────────────────────────────────────

class Blocked extends Error {}
class Transient extends Error {}
class Drift extends Error {
  constructor(
    readonly failure: CanaryFailure,
  ) {
    super(failure.message);
  }
}

function describeError(e: unknown): string {
  if (e instanceof Error) return `${e.name}: ${e.message}`.slice(0, 200);
  return 'unknown error';
}

function firstSchemaFailure(check: string, e: SgwApiError): CanaryFailure {
  // parseSgw messages are `<label>: <path>: <reason>[; ...]`, built from field paths and zod reasons only.
  const msg = e.message.slice(0, 300);
  const parts = msg.split(': ');
  const pathPart = parts.length >= 3 ? (parts[1] ?? '(root)') : '(root)';
  return { check, path: pathPart, message: msg };
}

// ── The run ─────────────────────────────────────────────────────────────────

export async function runCanary(opts: CanaryOptions): Promise<CanaryResult> {
  const startedMs = opts.now();
  const result: CanaryResult = {
    status: 'pass',
    startedAt: new Date(startedMs).toISOString(),
    requestsMade: 0,
    failures: [],
    inconclusive: [],
  };
  const state = loadState(opts.stateFile, startedMs);

  // Lock: one run per 12 h. `force` bypasses only this check.
  const lastRun = state.runs.length > 0 ? Math.max(...state.runs) : 0;
  if (!opts.force && lastRun > 0 && startedMs - lastRun < CANARY_RUN_INTERVAL_MS) {
    const hrs = ((startedMs - lastRun) / 3_600_000).toFixed(1);
    result.status = 'skipped';
    result.reason = `locked: last run ${hrs} h ago (minimum 12 h); set force to override`;
    opts.log(result.reason);
    return result;
  }
  // Budget: at most 4 requests per rolling 24 h; force does not bypass it.
  if (state.requests.length + CANARY_REQUESTS_PER_RUN > CANARY_MAX_REQUESTS_PER_DAY) {
    result.status = 'skipped';
    result.reason = `daily budget: ${String(state.requests.length)} requests in the last 24 h, a run needs ${String(CANARY_REQUESTS_PER_RUN)} (cap ${String(CANARY_MAX_REQUESTS_PER_DAY)})`;
    opts.log(result.reason);
    return result;
  }

  state.runs.push(startedMs);
  saveState(opts.stateFile, state);
  let retriesUsed = 0;

  /** Waits out the 120 s spacing, records the request BEFORE sending (a crash still counts), runs it. */
  async function spaced<T>(label: string, realUrl: string, method: string, send: (url: string) => Promise<T>): Promise<T> {
    for (;;) {
      assertAllowed(realUrl, method);
      if (state.requests.length >= CANARY_MAX_REQUESTS_PER_DAY) throw new Blocked(`${label}: daily request budget exhausted`);
      const wait = state.lastRequestEndedAt + CANARY_MIN_SPACING_MS - opts.now();
      if (wait > 0) {
        opts.log(`waiting ${String(Math.ceil(wait / 1000))} s before ${label}`);
        await opts.sleep(wait);
      }
      const sentAt = opts.now();
      state.requests.push(sentAt);
      state.lastRequestEndedAt = sentAt; // pending: counts for spacing even if we crash mid-flight
      saveState(opts.stateFile, state);
      result.requestsMade += 1;
      try {
        return await send(actualUrl(realUrl, opts));
      } catch (e) {
        if (e instanceof Transient && retriesUsed < CANARY_MAX_RETRIES && state.requests.length < CANARY_MAX_REQUESTS_PER_DAY) {
          retriesUsed += 1;
          opts.log(`${label}: ${e.message}; retrying once after the 120 s spacing`);
          continue;
        }
        throw e;
      } finally {
        state.lastRequestEndedAt = opts.now();
        saveState(opts.stateFile, state);
      }
    }
  }

  const baseHeaders = { 'user-agent': opts.userAgent, accept: 'application/json' };

  async function getJson(check: string, send: (url: string, signal: AbortSignal) => Promise<Response>, url: string): Promise<unknown> {
    let res: Response;
    try {
      res = await send(url, AbortSignal.timeout(CANARY_API_TIMEOUT_MS));
    } catch (e) {
      throw new Transient(`${check}: network error (${describeError(e)})`);
    }
    if (res.status === 403 || res.status === 429) throw new Blocked(`${check}: HTTP ${String(res.status)} (blocked or rate limited)`);
    if (res.status >= 500) throw new Transient(`${check}: HTTP ${String(res.status)}`);
    if (res.status !== 200) {
      throw new Drift({ check, path: 'http.status', message: `${check}: unexpected HTTP ${String(res.status)}` });
    }
    try {
      return (await res.json()) as unknown;
    } catch {
      // A 200 that is not JSON is not a network blip: SGW answered with something else.
      throw new Drift({ check, path: '(body)', message: `${check}: HTTP 200 but the body is not JSON` });
    }
  }

  let itemId: number | null = null;
  const inconclusive = (check: string, e: unknown): void => {
    const message = e instanceof Error ? e.message.slice(0, 300) : 'unknown error';
    result.inconclusive.push({ check, path: '(network)', message });
    opts.log(`inconclusive: ${message}`);
  };

  try {
    // 1. Search
    const searchUrl = SGW_API_BASE + SGW_ENDPOINTS.search.path;
    try {
      const raw = await spaced('search', searchUrl, 'POST', (url) =>
        getJson('search', (u, signal) =>
          opts.fetchFn(u, {
            method: 'POST',
            headers: { ...baseHeaders, 'content-type': 'application/json' },
            body: JSON.stringify({ ...SGW_SEARCH_BODY_DEFAULTS, searchText: CANARY_QUERY, page: '1' }),
            credentials: 'omit',
            redirect: 'error',
            signal,
          }), url),
      );
      try {
        const n = normalizeSearch(raw, { observedAt: opts.now(), authenticated: false, query: { page: 1 } });
        const first = n.items[0];
        if (first === undefined) {
          result.failures.push({ check: 'search', path: 'searchResults.items', message: `search: no rows for '${CANARY_QUERY}'` });
        } else {
          itemId = first.itemId;
        }
      } catch (e) {
        if (e instanceof SgwApiError) result.failures.push(firstSchemaFailure('search', e));
        else throw e;
      }
    } catch (e) {
      if (e instanceof Drift) result.failures.push(e.failure);
      else throw e;
    }

    // 2. ItemDetail of the first result (only if search worked)
    if (itemId !== null) {
      const id = itemId;
      const detailUrl = SGW_API_BASE + SGW_ENDPOINTS.itemDetail.path.replace('{itemId}', String(id));
      try {
        const raw = await spaced('itemDetail', detailUrl, 'GET', (url) =>
          getJson('itemDetail', (u, signal) => opts.fetchFn(u, { method: 'GET', headers: baseHeaders, credentials: 'omit', redirect: 'error', signal }), url),
        );
        try {
          normalizeItemDetail(raw, { observedAt: opts.now(), authenticated: false });
        } catch (e) {
          if (e instanceof SgwApiError) result.failures.push(firstSchemaFailure('itemDetail', e));
          else throw e;
        }
      } catch (e) {
        if (e instanceof Drift) result.failures.push(e.failure);
        else throw e;
      }

      // 3. One rendered item page
      const pageUrl = `${SGW_ORIGIN}/item/${String(id)}`;
      try {
        const page = await spaced('itemPage', pageUrl, 'GET', async (url) => {
          let r: PageCheckResult;
          try {
            r = await opts.renderItemPage(url);
          } catch (e) {
            throw new Transient(`itemPage: ${describeError(e)}`);
          }
          if (r.challenged || r.status === 403 || r.status === 429) throw new Blocked(`itemPage: HTTP ${String(r.status)} or challenge page`);
          if (r.status >= 500) throw new Transient(`itemPage: HTTP ${String(r.status)}`);
          return r;
        });
        if (page.status !== 200) {
          result.failures.push({ check: 'itemPage', path: 'http.status', message: `itemPage: unexpected HTTP ${String(page.status)}` });
        } else {
          for (const key of ITEM_PAGE_CHECK_KEYS) {
            if (page.matched[key] !== true) {
              result.failures.push({
                check: 'itemPage',
                path: `SGW_SELECTORS.item.${key}`,
                message: `itemPage: no element matches any of ${JSON.stringify(SGW_SELECTORS.item[key])}`,
              });
            }
          }
        }
      } catch (e) {
        if (e instanceof Transient || e instanceof Blocked) inconclusive('itemPage', e);
        else throw e;
      }
    }
  } catch (e) {
    if (e instanceof Transient || e instanceof Blocked) inconclusive('search/itemDetail', e);
    else throw e;
  }

  result.status = result.failures.length > 0 ? 'drift' : result.inconclusive.length > 0 ? 'inconclusive' : 'pass';
  return result;
}

// ── Real run ────────────────────────────────────────────────────────────────

/** Real-browser item page check: Chromium, images/fonts/media/third parties blocked, one navigation. */
export async function renderItemPageWithPlaywright(url: string, userAgentSuffix: string): Promise<PageCheckResult> {
  assertAllowed(url, 'GET');
  const { chromium } = await import('@playwright/test');
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({
      userAgent: `Mozilla/5.0 (compatible; ${userAgentSuffix}) HeadlessChrome/${browser.version()}`,
      serviceWorkers: 'block',
      acceptDownloads: false,
    });
    const hosts = new Set(['shopgoodwill.com', 'buyerapi.shopgoodwill.com']);
    const deniedPath = /^\/(shopgoodwill|home-preview|checkout|categories\/listing)(\/|$)|\/(PlaceBid|AddToFavorite|RemoveItemFromFavoriteList|SignIn|RefreshToken|RevokeToken)(\/|$|\?)/i;
    await context.route('**/*', (route) => {
      const req = route.request();
      let u: URL;
      try {
        u = new URL(req.url());
      } catch {
        return route.abort();
      }
      const type = req.resourceType();
      if (!hosts.has(u.hostname) || ['image', 'media', 'font'].includes(type) || deniedPath.test(u.pathname)) return route.abort();
      return route.continue();
    });
    const page = await context.newPage();
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    const status = response?.status() ?? 0;
    const challenged = (await page.locator('iframe[src*="recaptcha/api2/bframe"], iframe[src*="hcaptcha"]').count()) > 0;
    if (status !== 200 || challenged) return { status, challenged, matched: {} };
    const sels = itemPageSelectors();
    // Wait for the Angular app to render the title (the last of the key parts), then look at each group.
    await page.locator((sels['title'] ?? [])[0] ?? 'app-detail').first().waitFor({ timeout: 30_000 }).catch(() => undefined);
    const matched: Record<string, boolean> = {};
    for (const [key, list] of Object.entries(sels)) {
      let ok = false;
      for (const s of list) {
        if ((await page.locator(s).count()) > 0) {
          ok = true;
          break;
        }
      }
      matched[key] = ok;
    }
    return { status, challenged: false, matched };
  } finally {
    await browser.close();
  }
}

export function honestUserAgent(): string {
  const repo = process.env['GITHUB_REPOSITORY'];
  const where = repo !== undefined && repo !== '' ? `https://github.com/${repo}` : 'https://github.com/';
  return `ShopBadwill-canary/1 (+${where}; nightly read-only schema check, 3 requests/day)`;
}

function writeOutputs(result: CanaryResult, resultFile: string): void {
  mkdirSync(path.dirname(resultFile), { recursive: true });
  writeFileSync(resultFile, JSON.stringify(result, null, 2));
  const out = process.env['GITHUB_OUTPUT'];
  if (out !== undefined && out !== '') appendFileSync(out, `status=${result.status}\n`);
  const summary = process.env['GITHUB_STEP_SUMMARY'];
  if (summary !== undefined && summary !== '' && existsSync(path.dirname(summary))) {
    const lines = [`### SGW canary: ${result.status}`, `Requests made: ${String(result.requestsMade)}`];
    if (result.reason !== undefined) lines.push(result.reason);
    for (const f of result.failures) lines.push(`- DRIFT \`${f.check}\` \`${f.path}\`: ${f.message}`);
    for (const f of result.inconclusive) lines.push(`- inconclusive \`${f.check}\`: ${f.message}`);
    appendFileSync(summary, lines.join('\n') + '\n');
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const arg = (name: string): string | undefined => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const force = args.includes('--force') || process.env['CANARY_FORCE'] === 'true';
  const stateFile = arg('--state') ?? DEFAULT_STATE_FILE;
  const resultFile = arg('--result') ?? DEFAULT_RESULT_FILE;
  const ua = honestUserAgent();
  const result = await runCanary({
    apiBase: SGW_API_BASE,
    siteOrigin: SGW_ORIGIN,
    stateFile,
    force,
    userAgent: ua,
    fetchFn: fetch,
    renderItemPage: (url) => renderItemPageWithPlaywright(url, ua.split(' (')[0] ?? 'ShopBadwill-canary/1'),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    now: () => Date.now(),
    log: (l) => { console.log(`canary: ${l}`); },
  });
  writeOutputs(result, resultFile);
  console.log(`canary: ${result.status}${result.reason ? ` (${result.reason})` : ''}; ${String(result.requestsMade)} request(s)`);
  for (const f of result.failures) console.log(`::error::SGW drift: ${f.check} ${f.path}: ${f.message}`);
  for (const f of result.inconclusive) console.log(`::warning::SGW canary inconclusive: ${f.check}: ${f.message}`);
  process.exit(result.status === 'drift' ? 1 : 0);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e: unknown) => {
    console.error(e);
    process.exit(2);
  });
}
