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
//   - at most one run per 12 h (the lock). That is the daily cap (at most two runs a day).
//     Each run makes at most 4 requests: the 3 checks plus one retry. There is no rolling
//     24 h budget, so a nightly run is not skipped because yesterday's requests are still
//     inside a 24 h window. `force` bypasses the lock only; the per-run cap and the spacing still apply;
//   - 403/429 or a challenge page stops the run at once (no retry): inconclusive.
//
// Outcomes:
//   pass          every check matched.
//   drift         SGW answered with valid JSON (or a rendered page) that no longer matches, or a
//                 non-transient HTTP error such as 404/400. Exit code 1; the workflow opens or
//                 updates the issue only when the set of failing checks changed.
//   inconclusive  network errors, timeouts, 5xx, 403/429, a challenge page, 401/408, a 200 whose
//                 body is HTML or not JSON (a maintenance page), or a 200 carrying SGW's own error
//                 marker (null categoryListModel, `status: false`). THRESHOLD: a network error or 5xx
//                 is retried once after 120 s (one retry per run, which keeps the run at 4 requests);
//                 401/408 and a non-JSON/HTML 200 are inconclusive immediately, with no retry.
//                 Logged as a warning, exit code 0, and NO drift issue. A pure network failure is never drift.
//   skipped       the lock refused the run, or the state file exists but is unreadable (fail
//                 closed: treated as locked, rewritten as a lock that starts now). Exit code 0, ::warning::.
//
// Results and failures name the check, the path and the reason (`itemDetail: bidHistory.bidComplete: ...`),
// never a response body or a value from it. Log lines are single lines with URLs redacted
// (an item URL would name the item id, and the logs of a public repo are public).
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SgwApiError } from '../src/ports/errors';
import { SGW_API_BASE, SGW_ENDPOINTS, SGW_ORIGIN, SGW_SEARCH_BODY_DEFAULTS, SGW_SELECTORS } from '../src/adapters/sgw/config';
import { normalizeItemDetail, normalizeSearch } from '../src/adapters/sgw/normalize';
import { formatPath } from '../src/adapters/sgw/schemas';
import { CAPTURE_MIN_SPACING_MS, checkCaptureUrl } from './capture-fixtures';

// ── Constants (brief / rulings R1 to R3) ────────────────────────────────────

export const CANARY_QUERY = 'pyrex';
export const CANARY_MIN_SPACING_MS = CAPTURE_MIN_SPACING_MS; // 120 s
export const CANARY_RUN_INTERVAL_MS = 12 * 60 * 60 * 1000; // lock: one run per 12 h
export const CANARY_DAY_MS = 24 * 60 * 60 * 1000;
export const CANARY_REQUESTS_PER_RUN = 3;
export const CANARY_MAX_RETRIES = 1;
/** Checks plus the single retry. Counted per run, not across a rolling day. */
export const CANARY_MAX_REQUESTS_PER_RUN = CANARY_REQUESTS_PER_RUN + CANARY_MAX_RETRIES;
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

/** Runner clocks are NTP-synced; a state timestamp further ahead than this is not trusted. */
export const CANARY_STATE_MAX_FUTURE_MS = 10 * 60 * 1000;

export type StateRead = { ok: true; state: CanaryState } | { ok: false; reason: string };

/**
 * Reads the lock. Only a MISSING file is a first run (empty state). A file that exists but is
 * unreadable, mis-shaped, or dated in the future is `ok: false`, and the caller must treat it as
 * locked (fail closed), never as "no previous run".
 */
export function loadState(file: string, now: number): StateRead {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { ok: true, state: emptyState() };
    return { ok: false, reason: 'cannot read' };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'not JSON' };
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ok: false, reason: 'not an object' };
  const o = raw as Record<string, unknown>;
  const isTime = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x) && x >= 0;
  const runs = o['runs'];
  const requests = o['requests'];
  const ended = o['lastRequestEndedAt'];
  if (!Array.isArray(runs) || !runs.every(isTime)) return { ok: false, reason: 'bad runs' };
  if (!Array.isArray(requests) || !requests.every(isTime)) return { ok: false, reason: 'bad requests' };
  if (!isTime(ended)) return { ok: false, reason: 'bad lastRequestEndedAt' };
  const latest = Math.max(ended, ...runs, ...requests);
  if (latest > now + CANARY_STATE_MAX_FUTURE_MS) return { ok: false, reason: 'timestamp in the future' };
  // Prune history so the file stays small. The lock reads `runs` (12 h) and spacing reads
  // `lastRequestEndedAt`, which is not pruned. The per-run request cap does not use this history.
  return {
    ok: true,
    state: {
      runs: runs.filter((t) => now - t < CANARY_DAY_MS),
      requests: requests.filter((t) => now - t < CANARY_DAY_MS),
      lastRequestEndedAt: ended,
    },
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
/** Inconclusive immediately: no retry, and not drift. */
class InconclusiveNow extends Error {}
class Drift extends Error {
  constructor(
    readonly failure: CanaryFailure,
  ) {
    super(failure.message);
  }
}

/** Any absolute URL becomes `<url>`: Playwright and guard errors name `/item/<id>`, and logs are public. */
export function redactUrls(text: string): string {
  return text.replace(/\b(?:https?|wss?):\/\/[^\s"'<>)]+/gi, '<url>');
}

/** One line, no control characters (so it cannot start a workflow command), no URLs. */
export function safeLogLine(text: string): string {
  // eslint-disable-next-line no-control-regex
  return redactUrls(text).replace(/[\u0000-\u001F\u007F]+/g, ' ');
}

function describeError(e: unknown): string {
  if (e instanceof Error) return safeLogLine(`${e.name}: ${e.message}`).slice(0, 200);
  return 'unknown error';
}

function zodIssuesOf(cause: unknown): { path: PropertyKey[]; message: string }[] | null {
  if (typeof cause !== 'object' || cause === null) return null;
  const issues = (cause as { issues?: unknown }).issues;
  if (!Array.isArray(issues)) return null;
  const out: { path: PropertyKey[]; message: string }[] = [];
  for (const i of issues) {
    if (typeof i !== 'object' || i === null) return null;
    const { path: p, message } = i as { path?: unknown; message?: unknown };
    if (!Array.isArray(p) || typeof message !== 'string') return null;
    out.push({ path: p as PropertyKey[], message });
  }
  return out;
}

function joinPath(base: string, sub: string): string {
  if (base === '') return sub;
  if (sub === '(root)') return base;
  return sub.startsWith('[') ? `${base}${sub}` : `${base}.${sub}`;
}

/**
 * A drift failure from an `SgwApiError('schema')`: the field path and the reason, never a value.
 * parseSgw errors carry the ZodError (zod 4 reasons name types and schema rules only). The other
 * schema errors come from normalize.ts value checks, `<label>: <reason>: <raw value>`, so the
 * raw value (a time, a price) is dropped.
 */
function schemaFailure(check: string, e: SgwApiError): CanaryFailure {
  const sep = e.message.indexOf(': ');
  const label = sep >= 0 ? e.message.slice(0, sep) : check;
  const under = label === check ? '' : label.startsWith(`${check}.`) ? label.slice(check.length + 1) : label;
  const issues = zodIssuesOf(e.cause);
  if (issues !== null && issues.length > 0) {
    const shown = issues.slice(0, 3).map((i) => `${joinPath(under, formatPath(i.path))}: ${i.message}`);
    const more = issues.length > 3 ? ` (+${String(issues.length - 3)} more)` : '';
    const first = issues[0];
    return {
      check,
      path: joinPath(under, formatPath(first?.path ?? [])),
      message: `${check}: ${shown.join('; ')}${more}`.slice(0, 300),
    };
  }
  const reason = sep >= 0 ? (e.message.slice(sep + 2).split(': ')[0] ?? 'invalid') : 'invalid';
  const where = under === '' ? '(root)' : under;
  return { check, path: where, message: `${check}: ${where}: ${reason}`.slice(0, 300) };
}

/**
 * A normalizer error on a 200 reply: `schema` is drift. SGW's own error markers (`server`, such as
 * a null categoryListModel or `status: false`, and `auth`) are inconclusive, and only the kind is
 * kept because their message can quote SGW text. Anything else is a bug and is rethrown as is.
 */
function driftOrInconclusive(check: string, e: unknown): unknown {
  if (!(e instanceof SgwApiError)) return e;
  if (e.kind === 'schema') return new Drift(schemaFailure(check, e));
  return new InconclusiveNow(`${check}: SGW reported an error in a 200 reply (${e.kind})`);
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
  // Every log line is one line with no URL: GitHub Actions logs of a public repo are public, and a
  // line that starts with `::` would be read as a workflow command.
  const log = (line: string): void => {
    opts.log(safeLogLine(line));
  };

  const loaded = loadState(opts.stateFile, startedMs);
  if (!loaded.ok) {
    // Fail closed: a lock we cannot read is "locked now", never "no previous run", and `force`
    // does not override it. Rewrite it as a lock that starts now so the job heals in 12 h.
    saveState(opts.stateFile, { runs: [startedMs], requests: [], lastRequestEndedAt: startedMs });
    result.status = 'skipped';
    result.reason = `state file unreadable (${loaded.reason}); treated as locked for 12 h, no requests made`;
    log(result.reason);
    return result;
  }
  const state = loaded.state;

  // Lock: one run per 12 h. `force` bypasses only this check. Open at exactly 12 h (`<`, not `<=`).
  const lastRun = state.runs.length > 0 ? Math.max(...state.runs) : 0;
  if (!opts.force && lastRun > 0 && startedMs - lastRun < CANARY_RUN_INTERVAL_MS) {
    const hrs = ((startedMs - lastRun) / 3_600_000).toFixed(1);
    result.status = 'skipped';
    result.reason = `locked: last run ${hrs} h ago (minimum 12 h); set force to override`;
    log(result.reason);
    return result;
  }

  state.runs.push(startedMs);
  saveState(opts.stateFile, state);
  let retriesUsed = 0;

  /** Waits out the 120 s spacing, records the request BEFORE sending (a crash still counts), runs it. */
  async function spaced<T>(label: string, realUrl: string, method: string, send: (url: string) => Promise<T>): Promise<T> {
    for (;;) {
      assertAllowed(realUrl, method);
      if (result.requestsMade >= CANARY_MAX_REQUESTS_PER_RUN) {
        throw new Blocked(`${label}: per-run request cap of ${String(CANARY_MAX_REQUESTS_PER_RUN)} exhausted`);
      }
      const wait = state.lastRequestEndedAt + CANARY_MIN_SPACING_MS - opts.now();
      if (wait > 0) {
        log(`waiting ${String(Math.ceil(wait / 1000))} s before ${label}`);
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
        if (e instanceof Transient && retriesUsed < CANARY_MAX_RETRIES && result.requestsMade < CANARY_MAX_REQUESTS_PER_RUN) {
          retriesUsed += 1;
          log(`${label}: ${e.message}; retrying once after the 120 s spacing`);
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
    if (res.status === 401 || res.status === 408) throw new InconclusiveNow(`${check}: HTTP ${String(res.status)} (inconclusive)`);
    if (res.status >= 500) throw new Transient(`${check}: HTTP ${String(res.status)}`);
    if (res.status !== 200) {
      throw new Drift({ check, path: 'http.status', message: `${check}: unexpected HTTP ${String(res.status)}` });
    }
    const contentType = res.headers.get('content-type') ?? '';
    if (/text\/html/i.test(contentType)) {
      // A maintenance or challenge page, not a schema. Do not parse it as JSON.
      throw new InconclusiveNow(`${check}: HTTP 200 HTML (maintenance or challenge page)`);
    }
    try {
      return (await res.json()) as unknown;
    } catch {
      throw new InconclusiveNow(`${check}: HTTP 200 but the body is not JSON`);
    }
  }

  let itemId: number | null = null;
  const inconclusive = (check: string, e: unknown): void => {
    const message = e instanceof Error ? safeLogLine(e.message).slice(0, 300) : 'unknown error';
    result.inconclusive.push({ check, path: '(network)', message });
    log(`inconclusive: ${message}`);
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
        throw driftOrInconclusive('search', e);
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
          throw driftOrInconclusive('itemDetail', e);
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
          if (r.status === 401 || r.status === 408) throw new InconclusiveNow(`itemPage: HTTP ${String(r.status)} (inconclusive)`);
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
        if (e instanceof Transient || e instanceof Blocked || e instanceof InconclusiveNow) inconclusive('itemPage', e);
        else throw e;
      }
    }
  } catch (e) {
    if (e instanceof Transient || e instanceof Blocked || e instanceof InconclusiveNow) inconclusive('search/itemDetail', e);
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
  // ASCII only: a header value must be a ByteString, so a character such as U+2264 would make fetch throw.
  return `ShopBadwill-canary/1 (+${where}; nightly read-only schema check, max ${String(CANARY_MAX_REQUESTS_PER_RUN)} requests/run, max 2 runs/day)`;
}

/** Strip C0 controls, DEL and newlines, and break `@mentions` with a zero-width space. */
export function sanitizeCanaryMessage(text: string): string {
  let out = '';
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (code <= 31 || code === 127) continue;
    out += code === 64 ? '@\u200B' : ch;
  }
  return out;
}

export function shouldOpenDriftIssue(status: CanaryStatus): boolean {
  return status === 'drift';
}

/** Sorted unique check names. The same set on the next night does not get a new comment. */
export function failingCheckFingerprint(failures: readonly { check: string }[]): string {
  const checks = new Set<string>();
  for (const f of failures) {
    const clean = f.check.replace(/[^a-zA-Z0-9_-]/g, '');
    if (clean !== '') checks.add(clean);
  }
  return [...checks].sort().join(',');
}

export function readDriftFingerprint(text: string): string | null {
  // A fresh regex each call: a shared /g pattern keeps lastIndex and skips later reads.
  const mark = /<!-- canary-fingerprint:([a-zA-Z0-9_-]*(?:,[a-zA-Z0-9_-]+)*) -->/g;
  let last: string | null = null;
  for (const match of text.matchAll(mark)) last = match[1] ?? null;
  return last;
}

export function latestDriftFingerprint(issue: { body: string; comments: readonly { body: string }[] }): string | null {
  for (let i = issue.comments.length - 1; i >= 0; i--) {
    const comment = issue.comments[i];
    if (comment === undefined) continue;
    const fp = readDriftFingerprint(comment.body);
    if (fp !== null) return fp;
  }
  return readDriftFingerprint(issue.body);
}

export function decideDriftIssueAction(input: {
  status: CanaryStatus;
  failures: readonly { check: string }[];
  existing: { body: string; comments: readonly { body: string }[] } | null;
}): 'create' | 'comment' | 'silent' {
  if (!shouldOpenDriftIssue(input.status)) return 'silent';
  if (input.existing === null) return 'create';
  const next = failingCheckFingerprint(input.failures);
  return latestDriftFingerprint(input.existing) === next ? 'silent' : 'comment';
}

function issueCell(text: string): string {
  return sanitizeCanaryMessage(text).replaceAll('|', ' ');
}

export function buildDriftIssueBody(result: CanaryResult, runUrl: string): string {
  const fp = failingCheckFingerprint(result.failures);
  const rows = result.failures.map((f) => `| \`${issueCell(f.check)}\` | \`${issueCell(f.path)}\` | ${issueCell(f.message)} |`);
  return [
    'The nightly SGW canary found that SGW no longer matches our schemas or selectors.',
    '',
    `Run: ${sanitizeCanaryMessage(runUrl)}`,
    `Time: ${sanitizeCanaryMessage(result.startedAt)}`,
    '',
    '| check | path | detail |',
    '| --- | --- | --- |',
    ...rows,
    '',
    'No response bodies are recorded here. Fix the adapter (src/adapters/sgw/*) and re-capture fixtures (S-1).',
    '',
    `<!-- canary-fingerprint:${fp} -->`,
  ].join('\n');
}

/** Workflow-command data: sanitized (no CR/LF), then `%` escaped so `%0A` in a message stays literal. */
function commandData(text: string): string {
  return sanitizeCanaryMessage(text).replaceAll('%', '%25');
}

export function workflowAnnotations(
  result: Pick<CanaryResult, 'failures' | 'inconclusive'> & Partial<Pick<CanaryResult, 'status' | 'reason'>>,
): string[] {
  const lines: string[] = [];
  if (result.status === 'skipped' && result.reason !== undefined) {
    lines.push(`::warning::${commandData(`SGW canary skipped: ${result.reason}`)}`);
  }
  for (const f of result.failures) {
    lines.push(`::error::${commandData(`SGW drift: ${f.check} ${f.path}: ${f.message}`)}`);
  }
  for (const f of result.inconclusive) {
    lines.push(`::warning::${commandData(`SGW canary inconclusive: ${f.check}: ${f.message}`)}`);
  }
  return lines;
}

// ── The lock artifact (workflow step "Find previous canary state") ─────────

export const CANARY_STATE_ARTIFACT = 'canary-state';

/**
 * The run id of the newest unexpired `canary-state` artifact in a `GET .../actions/artifacts`
 * reply, or '' when there is none (a first run; an expired one is older than the 12 h lock and
 * cannot be downloaded). Anything unexpected throws, so the step fails and the canary does not
 * run without its lock.
 */
export function selectStateRunId(raw: unknown): string {
  if (typeof raw !== 'object' || raw === null) throw new Error('canary: artifact list is not an object');
  const list = (raw as { artifacts?: unknown }).artifacts;
  if (!Array.isArray(list)) throw new Error('canary: artifact list has no artifacts array');
  let best: { id: number; created: number } | null = null;
  for (const item of list) {
    if (typeof item !== 'object' || item === null) throw new Error('canary: artifact entry is not an object');
    const a = item as { name?: unknown; expired?: unknown; created_at?: unknown; workflow_run?: unknown };
    if (a.name !== CANARY_STATE_ARTIFACT) continue;
    if (a.expired === true) continue;
    if (a.expired !== false) throw new Error('canary: artifact has no expired flag');
    const run = (typeof a.workflow_run === 'object' && a.workflow_run !== null ? a.workflow_run : {}) as {
      id?: unknown;
      repository_id?: unknown;
      head_repository_id?: unknown;
    };
    // A fork PR's own workflow could upload an artifact with this name; only this repo's runs hold the lock.
    if (typeof run.repository_id === 'number' && typeof run.head_repository_id === 'number' && run.head_repository_id !== run.repository_id) continue;
    const id = run.id;
    if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0) throw new Error('canary: live canary-state artifact has no valid run id');
    const created = typeof a.created_at === 'string' ? Date.parse(a.created_at) : Number.NaN;
    if (!Number.isFinite(created)) throw new Error('canary: live canary-state artifact has no valid created_at');
    if (best === null || created > best.created || (created === best.created && id > best.id)) best = { id, created };
  }
  return best === null ? '' : String(best.id);
}

export function findPreviousStateRunId(repo: string, gh: (args: readonly string[]) => string): string {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw new Error('canary: GITHUB_REPOSITORY is not owner/name');
  const text = gh(['api', `repos/${repo}/actions/artifacts?name=${CANARY_STATE_ARTIFACT}&per_page=100`]);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('canary: artifact list is not JSON');
  }
  return selectStateRunId(parsed);
}

/** What a crash prints: one redacted message line, then the stack frames (file paths only). */
export function crashLines(e: unknown): string[] {
  const lines = [`canary: crashed: ${describeError(e)}`];
  if (e instanceof Error && typeof e.stack === 'string') {
    for (const l of e.stack.split(/\r?\n/)) if (/^\s+at /.test(l)) lines.push(redactUrls(l));
  }
  return lines;
}

interface ListedIssue {
  number: number;
  title: string;
}

function parseIssueList(raw: string): ListedIssue[] {
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error('canary: gh issue list was not an array');
  const out: ListedIssue[] = [];
  for (const item of parsed) {
    if (typeof item !== 'object' || item === null) continue;
    const o = item as Record<string, unknown>;
    if (typeof o['number'] !== 'number' || typeof o['title'] !== 'string') continue;
    out.push({ number: o['number'], title: o['title'] });
  }
  return out;
}

function parseIssueView(raw: string): { body: string; comments: { body: string }[] } {
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== 'object' || parsed === null) throw new Error('canary: gh issue view was not an object');
  const o = parsed as Record<string, unknown>;
  const body = typeof o['body'] === 'string' ? o['body'] : '';
  const comments: { body: string }[] = [];
  if (Array.isArray(o['comments'])) {
    for (const c of o['comments']) {
      if (typeof c !== 'object' || c === null) continue;
      const bodyText = (c as Record<string, unknown>)['body'];
      comments.push({ body: typeof bodyText === 'string' ? bodyText : '' });
    }
  }
  return { body, comments };
}

export function syncDriftIssue(opts: {
  result: CanaryResult;
  runUrl: string;
  bodyFile: string;
  gh: (args: readonly string[]) => string;
}): 'created' | 'commented' | 'unchanged' | 'not-drift' {
  if (!shouldOpenDriftIssue(opts.result.status)) return 'not-drift';
  const listed = parseIssueList(opts.gh([
    'issue', 'list', '--state', 'open',
    '--search', '"SGW drift detected" in:title',
    '--json', 'number,title',
  ]));
  const found = listed.find((issue) => issue.title === CANARY_ISSUE_TITLE);
  const writeBody = (): void => {
    mkdirSync(path.dirname(opts.bodyFile), { recursive: true });
    writeFileSync(opts.bodyFile, buildDriftIssueBody(opts.result, opts.runUrl));
  };
  if (found === undefined) {
    writeBody();
    opts.gh(['issue', 'create', '--title', CANARY_ISSUE_TITLE, '--body-file', opts.bodyFile]);
    return 'created';
  }
  const existing = parseIssueView(opts.gh(['issue', 'view', String(found.number), '--json', 'body,comments']));
  const action = decideDriftIssueAction({ status: opts.result.status, failures: opts.result.failures, existing });
  if (action !== 'comment') return 'unchanged';
  writeBody();
  opts.gh(['issue', 'comment', String(found.number), '--body-file', opts.bodyFile]);
  return 'commented';
}

function writeOutputs(result: CanaryResult, resultFile: string): void {
  mkdirSync(path.dirname(resultFile), { recursive: true });
  writeFileSync(resultFile, JSON.stringify(result, null, 2));
  const out = process.env['GITHUB_OUTPUT'];
  if (out !== undefined && out !== '') appendFileSync(out, `status=${result.status}\n`);
  const summary = process.env['GITHUB_STEP_SUMMARY'];
  if (summary !== undefined && summary !== '' && existsSync(path.dirname(summary))) {
    const lines = [`### SGW canary: ${result.status}`, `Requests made: ${String(result.requestsMade)}`];
    if (result.reason !== undefined) lines.push(sanitizeCanaryMessage(result.reason));
    for (const f of result.failures) {
      lines.push(`- DRIFT \`${sanitizeCanaryMessage(f.check)}\` \`${sanitizeCanaryMessage(f.path)}\`: ${sanitizeCanaryMessage(f.message)}`);
    }
    for (const f of result.inconclusive) {
      lines.push(`- inconclusive \`${sanitizeCanaryMessage(f.check)}\`: ${sanitizeCanaryMessage(f.message)}`);
    }
    appendFileSync(summary, lines.join('\n') + '\n');
  }
}

function workflowRunUrl(): string {
  const server = process.env['GITHUB_SERVER_URL'] ?? 'https://github.com';
  const repo = process.env['GITHUB_REPOSITORY'] ?? '';
  const id = process.env['GITHUB_RUN_ID'] ?? '';
  return `${server}/${repo}/actions/runs/${id}`;
}

function isCanaryResult(v: unknown): v is CanaryResult {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  const status = o['status'];
  return (status === 'pass' || status === 'drift' || status === 'inconclusive' || status === 'skipped')
    && typeof o['startedAt'] === 'string'
    && typeof o['requestsMade'] === 'number'
    && Array.isArray(o['failures'])
    && Array.isArray(o['inconclusive']);
}

function syncIssueFromDisk(resultFile: string): void {
  const parsed: unknown = JSON.parse(readFileSync(resultFile, 'utf8'));
  if (!isCanaryResult(parsed)) throw new Error(`canary: ${resultFile} is not a canary result`);
  const outcome = syncDriftIssue({
    result: parsed,
    runUrl: workflowRunUrl(),
    bodyFile: path.join(path.dirname(resultFile), 'issue.md'),
    gh: (args) => execFileSync('gh', [...args], { encoding: 'utf8' }),
  });
  console.log(`canary: drift issue ${outcome}`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const arg = (name: string): string | undefined => {
    const i = args.indexOf(name);
    return i >= 0 ? args[i + 1] : undefined;
  };
  if (args.includes('--sync-issue')) {
    syncIssueFromDisk(arg('--result') ?? DEFAULT_RESULT_FILE);
    return;
  }
  if (args.includes('--find-state')) {
    // Workflow step "Find previous canary state". Any error exits non-zero and fails the step.
    const out = process.env['GITHUB_OUTPUT'];
    if (out === undefined || out === '') throw new Error('canary: --find-state needs GITHUB_OUTPUT');
    const id = findPreviousStateRunId(process.env['GITHUB_REPOSITORY'] ?? '', (a) => execFileSync('gh', [...a], { encoding: 'utf8' }));
    appendFileSync(out, `run_id=${id}\n`);
    console.log(`canary: previous state ${id === '' ? 'none (first run)' : `from run ${id}`}`);
    return;
  }
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
  for (const line of workflowAnnotations(result)) console.log(line);
  process.exit(result.status === 'drift' ? 1 : 0);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e: unknown) => {
    for (const line of crashLines(e)) console.error(line);
    process.exit(2);
  });
}
