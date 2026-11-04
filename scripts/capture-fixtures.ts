// S-1 (T-07) anonymous, read-only capture of shopgoodwill.com (SGW) fixtures.
//
// This is the ONLY code allowed to send requests to SGW for Task 0, and it is
// built to be a light, considerate guest (PLAN §4 S-1, §7.2, controller rulings):
//
//   - at most CAPTURE_MAX_REQUESTS (25) counted requests in total, across runs:
//     the cap is enforced against the persisted request log, not per process;
//   - at least CAPTURE_MIN_SPACING_MS (120 s, robots.txt `Crawl-delay: 120`)
//     between the END of one request and the START of the next;
//   - deny-by-default URL guard (`checkCaptureUrl`): no `/shopgoodwill/*`
//     account pages, no `/checkout/`, no `/categories/listing` search pages
//     (robots.txt disallows them), no write or sign-in endpoints;
//   - never logs in, never writes, sends buyerapi reads with
//     `credentials: 'omit'` (no cookies), and uses the browser's own default
//     user agent (no spoofing);
//   - page renders block images, media, fonts and every third-party host
//     (ads, analytics, reCAPTCHA), so a render costs SGW only its own app files;
//   - stops for good (writes a STOPPED marker) on 403/429/5xx or any sign of a
//     challenge. It never solves or bypasses a CAPTCHA;
//   - crash-safe: a `pending` line is logged BEFORE each request is sent, so a
//     crash or kill still counts it toward the cap and the spacing;
//   - single instance: raw/capture.lock is created exclusively (`wx`) for the
//     whole run; a second run refuses to start and says how to clear a stale lock.
//
// Usage: drop step files (see CaptureStep) into test/fixtures/sgw/raw/queue/,
// then run in the FOREGROUND:
//
//   pnpm exec tsx scripts/capture-fixtures.ts once
//
// `once` runs every queued step in name order (waiting out the 120 s spacing
// between them, computed from the persisted log) and exits when the queue is
// empty. `serve` keeps polling the queue instead and exits after
// SERVE_IDLE_EXIT_MS without work; prefer `once`, so no capture browser can
// outlive the session that started it.
//
// Everything this script writes goes to test/fixtures/sgw/raw/ (git-ignored).
// scripts/sanitize-fixtures.ts turns raw captures into committed fixtures.
import { createHash, generateKeyPairSync } from 'node:crypto';
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const CAPTURE_MAX_REQUESTS = 25;
export const CAPTURE_MIN_SPACING_MS = 120_000;

// Every timeout a step can spend, so a crashed request's spacing can assume the worst case.
/** page.goto (render and text steps). */
export const NAV_TIMEOUT_MS = 60_000;
/** Waiting for the page's own buyerapi reply (render steps with waitForApi). */
export const PAGE_API_WAIT_MS = 30_000;
/** Waiting for the hydration selector; a step's own timeoutMs is capped at the max. */
export const HYDRATION_WAIT_DEFAULT_MS = 20_000;
export const HYDRATION_WAIT_MAX_MS = 30_000;
/** The DOM-quiet wait (1.5 s without mutations) gives up after this long. */
export const QUIET_DOM_MAX_MS = 15_000;
export const SCREENSHOT_TIMEOUT_MS = 15_000;
/** One API read is aborted after this long (and still logged). */
export const API_TIMEOUT_MS = 30_000;
/** The longest any step can run: a render that hits every timeout in turn (an API step is shorter). */
export const MAX_STEP_DURATION_MS = NAV_TIMEOUT_MS + PAGE_API_WAIT_MS + HYDRATION_WAIT_MAX_MS + QUIET_DOM_MAX_MS + SCREENSHOT_TIMEOUT_MS;

export const SGW_SITE_HOST = 'shopgoodwill.com';
export const SGW_API_HOST = 'buyerapi.shopgoodwill.com';

// ---------------------------------------------------------------------------
// URL guard (pure; unit-tested in test/unit/scripts/fixtures-manifest.test.ts)
// ---------------------------------------------------------------------------

export type GuardResult = { ok: true; kind: 'site' | 'api' } | { ok: false; reason: string };

/** Paths robots.txt disallows or that are account/checkout/search pages. */
const SITE_DENY: ReadonlyArray<[RegExp, string]> = [
  [/^\/shopgoodwill(\/|$)/i, 'account pages (/shopgoodwill/*) are disallowed by robots.txt'],
  [/^\/checkout(\/|$)/i, '/checkout/ is disallowed by robots.txt'],
  [/^\/home-preview(\/|$)/i, '/home-preview/ is disallowed by robots.txt'],
  [/^\/categories\/listing/i, 'search pages (/categories/listing?st=) are disallowed by robots.txt'],
  [/^\/(signin|sign-in|login|register|signup)(\/|$)/i, 'sign-in pages are never loaded'],
];

/** Write, session or account endpoints: never called, even if a later rule would allow them. */
const API_DENY = /\/(PlaceBid|AddToFavorite|RemoveItemFromFavoriteList|Save|SignIn|Login|Logout|RefreshToken|RevokeToken|Register|Delete\w*|Update\w*)(\/|$|\?)/i;

/** The only SGW site paths this script may load. */
const SITE_ALLOW: readonly RegExp[] = [
  /^\/robots\.txt$/,
  /^\/$/,
  /^\/item\/\d+$/,
  // SGW help/FAQ content pages (read once for the S-1 "last-second bids" check).
  /^\/(help|faq|faqs|customer-service|customer-care|support|about\/faq)(\/[\w-]+)*$/i,
];

/** The only buyerapi reads this script may make: path, methods, and the exact query string allowed ('' = none). */
const API_ALLOW: ReadonlyArray<[RegExp, ReadonlyArray<'GET' | 'POST'>, RegExp]> = [
  [/^\/api\/Search\/ItemListing$/i, ['POST'], /^$/],
  [/^\/api\/ItemDetail\/GetItemDetailModelByItemId\/\d+$/i, ['GET'], /^$/],
  [/^\/api\/Dashboard\/GetCurrentTime$/i, ['GET', 'POST'], /^$/],
  // One help-center answer by its slug (S-1 "last-second bids" and new-account cap checks).
  [/^\/api\/HelpCenter\/GetQuestionAnswer$/i, ['GET'], /^\?q=[a-z0-9-]{1,80}$/],
];

export function checkCaptureUrl(rawUrl: string, method: string = 'GET'): GuardResult {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { ok: false, reason: 'not an absolute URL' };
  }
  const m = method.toUpperCase();
  if (m !== 'GET' && m !== 'POST') return { ok: false, reason: `method ${m} is never used` };
  if (url.protocol !== 'https:') return { ok: false, reason: 'only https is allowed' };
  if (url.username || url.password) return { ok: false, reason: 'credentials in URL' };
  if (url.port !== '') return { ok: false, reason: 'non-default port' };
  const p = url.pathname;

  if (url.hostname === SGW_SITE_HOST) {
    for (const [re, reason] of SITE_DENY) if (re.test(p)) return { ok: false, reason };
    if (url.searchParams.has('st')) return { ok: false, reason: 'search query (?st=) pages are disallowed by robots.txt' };
    if (m !== 'GET') return { ok: false, reason: 'site pages are only read with GET' };
    if (url.search !== '') return { ok: false, reason: 'site pages are loaded without a query string' };
    if (!SITE_ALLOW.some((re) => re.test(p))) return { ok: false, reason: `site path ${p} is not on the allow-list` };
    return { ok: true, kind: 'site' };
  }

  if (url.hostname === SGW_API_HOST) {
    if (API_DENY.test(p + url.search)) return { ok: false, reason: 'write, session or account endpoint' };
    const rule = API_ALLOW.find(([re]) => re.test(p));
    if (rule === undefined) return { ok: false, reason: `api path ${p} is not on the allow-list` };
    if (!rule[1].includes(m)) return { ok: false, reason: `${m} is not allowed for ${p}` };
    if (!rule[2].test(url.search)) return { ok: false, reason: `query string ${url.search} is not allowed for ${p}` };
    return { ok: true, kind: 'api' };
  }

  return { ok: false, reason: `host ${url.hostname} is not SGW` };
}

// ---------------------------------------------------------------------------
// Request log and spacing (pure parts unit-tested)
// ---------------------------------------------------------------------------

export interface RequestLogEntry {
  seq: number; // 1-based, counts toward CAPTURE_MAX_REQUESTS
  stepId: string;
  kind: 'text' | 'render' | 'api';
  method: 'GET' | 'POST';
  url: string;
  sentAtMs: number;
  endedAtMs: number;
  status: number | null;
  error?: string;
  /** What the browser actually sent on the counted request. */
  sent: { hadCookieHeader: boolean; hadAuthorizationHeader: boolean; origin: string | null; userAgent: string | null };
  /** Requests the page itself made while rendering (renders only). */
  pageInitiated?: {
    sgwFirstParty: number; // documents, scripts, styles, XHR to shopgoodwill.com
    buyerapi: Array<{ method: string; path: string; status: number | null }>;
    blockedByType: Record<string, number>;
    blockedThirdPartyHosts: Record<string, number>;
    corsPreflights: number;
  };
  observations?: Record<string, unknown>;
  outFiles: string[];
  note?: string;
  /** Logged as about to be sent, but its completion never was (crash or kill). Counted as sent. */
  pending?: true;
}

/** A request with no logged completion is assumed to have run as long as any step can (spacing after a crash). */
export const PENDING_ASSUMED_DURATION_MS = MAX_STEP_DURATION_MS;

/** The hydration wait a render step gets: its own timeoutMs, capped so MAX_STEP_DURATION_MS holds. */
export function hydrationTimeoutMs(step: Extract<CaptureStep, { kind: 'render' }>): number {
  return Math.min(step.timeoutMs ?? HYDRATION_WAIT_DEFAULT_MS, HYDRATION_WAIT_MAX_MS);
}

/** The line written BEFORE a request is sent, so a crash or kill can never leave it uncounted. */
export interface PendingRequest {
  seq: number;
  stepId: string;
  kind: RequestLogEntry['kind'];
  method: RequestLogEntry['method'];
  url: string;
  sentAtMs: number;
}

export function appendPendingRequest(file: string, p: PendingRequest): void {
  appendFileSync(file, `${JSON.stringify({ pending: true, ...p })}\n`);
}

/**
 * Exclusive lock (`wx` create) so two capture processes can never share the
 * log, the cap or the spacing. Returns the release function.
 */
export function acquireCaptureLock(file: string): () => void {
  let fd: number;
  try {
    fd = openSync(file, 'wx');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    let holder = '';
    try {
      holder = readFileSync(file, 'utf8').trim();
    } catch {
      /* removed meanwhile */
    }
    throw new Error(
      `a capture is already running (lock ${file}: ${holder === '' ? 'no details' : holder}). ` +
        `If no capture-fixtures process is running (check Task Manager for node.exe), a previous run crashed: delete ${file} and retry.`,
      { cause: e },
    );
  }
  writeSync(fd, `pid ${String(process.pid)} since ${new Date().toISOString()}\n`);
  closeSync(fd);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    rmSync(file, { force: true });
  };
}

/** Earliest time the next counted request may start. */
export function nextAllowedAt(log: readonly RequestLogEntry[]): number {
  const last = log.at(-1);
  return last === undefined ? 0 : last.endedAtMs + CAPTURE_MIN_SPACING_MS;
}

/** Throws when the log breaks the cap or spacing rules (used before every request and by the log test). */
export function assertLogWithinRules(log: readonly RequestLogEntry[]): void {
  if (log.length > CAPTURE_MAX_REQUESTS) throw new Error(`request log has ${String(log.length)} requests (cap ${String(CAPTURE_MAX_REQUESTS)})`);
  log.forEach((e, i) => {
    if (e.seq !== i + 1) throw new Error(`request log seq ${String(e.seq)} at position ${String(i + 1)}`);
    const prev = log[i - 1];
    if (prev !== undefined && e.sentAtMs - prev.endedAtMs < CAPTURE_MIN_SPACING_MS) {
      throw new Error(`request ${String(e.seq)} started ${String(e.sentAtMs - prev.endedAtMs)} ms after request ${String(prev.seq)} ended`);
    }
    if (e.sent.hadCookieHeader || e.sent.hadAuthorizationHeader) throw new Error(`request ${String(e.seq)} sent a cookie or authorization header`);
  });
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

export type CaptureStep =
  | { id: string; kind: 'text'; url: string; out: string; note?: string }
  | {
      id: string;
      kind: 'render';
      url: string;
      out: string;
      /** CSS selector that signals hydration; a timeout keeps a "skeleton-only" capture. */
      waitFor?: string;
      /** Substring of a buyerapi URL the page itself requests; the capture waits for that response. */
      waitForApi?: string;
      timeoutMs?: number;
      note?: string;
    }
  | { id: string; kind: 'api'; method: 'GET' | 'POST'; url: string; body?: unknown; out: string; note?: string }
  | { id: string; kind: 'stop' };

export function parseStep(json: unknown): CaptureStep {
  if (typeof json !== 'object' || json === null) throw new Error('step must be an object');
  const s = json as Record<string, unknown>;
  const id = s.id;
  if (typeof id !== 'string' || !/^[\w.-]{1,64}$/.test(id)) throw new Error('step.id must match [\\w.-]{1,64}');
  if (s.kind === 'stop') return { id, kind: 'stop' };
  if (typeof s.url !== 'string') throw new Error('step.url must be a string');
  if (typeof s.out !== 'string' || !/^[\w.-]{1,80}$/.test(s.out)) throw new Error('step.out must match [\\w.-]{1,80}');
  const note = typeof s.note === 'string' ? s.note : undefined;
  if (s.kind === 'text') return { id, kind: 'text', url: s.url, out: s.out, ...(note === undefined ? {} : { note }) };
  if (s.kind === 'render') {
    return {
      id,
      kind: 'render',
      url: s.url,
      out: s.out,
      ...(typeof s.waitFor === 'string' ? { waitFor: s.waitFor } : {}),
      ...(typeof s.waitForApi === 'string' ? { waitForApi: s.waitForApi } : {}),
      ...(typeof s.timeoutMs === 'number' ? { timeoutMs: s.timeoutMs } : {}),
      ...(note === undefined ? {} : { note }),
    };
  }
  if (s.kind === 'api') {
    if (s.method !== 'GET' && s.method !== 'POST') throw new Error('api step.method must be GET or POST');
    return {
      id,
      kind: 'api',
      method: s.method,
      url: s.url,
      out: s.out,
      ...('body' in s ? { body: s.body } : {}),
      ...(note === undefined ? {} : { note }),
    };
  }
  throw new Error(`unknown step.kind ${String(s.kind)}`);
}

// ---------------------------------------------------------------------------
// Live session (not unit-tested; exercised once by the S-1 capture)
// ---------------------------------------------------------------------------

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const RAW_DIR = path.join(ROOT, 'test', 'fixtures', 'sgw', 'raw');
const QUEUE_DIR = path.join(RAW_DIR, 'queue');
const DONE_DIR = path.join(QUEUE_DIR, 'done');
const REJECTED_DIR = path.join(QUEUE_DIR, 'rejected');
const LOG_FILE = path.join(RAW_DIR, 'request-log.jsonl');
const STOPPED_FILE = path.join(RAW_DIR, 'STOPPED');
const LOCK_FILE = path.join(RAW_DIR, 'capture.lock');
const EXT_DIR = path.join(RAW_DIR, '.capture-ext');
const PROFILE_DIR = path.join(RAW_DIR, '.capture-profile');

/** `serve` gives up after this long with an empty queue. */
const SERVE_IDLE_EXIT_MS = 15 * 60 * 1000;

function log(msg: string): void {
  console.log(`[capture ${new Date().toISOString()}] ${msg}`);
}

/**
 * Reads the raw JSON-lines log, one entry per seq. A completed entry
 * supersedes its pending line; a pending line with no completion is counted
 * as a sent request (cap and spacing). Entries from before the `had*Header`
 * rename (S-1 requests 1-8) are normalized.
 */
export function readRequestLog(file: string = LOG_FILE): RequestLogEntry[] {
  if (!existsSync(file)) return [];
  type LegacySent = { hadCookieHeader?: boolean; hadAuthorizationHeader?: boolean; cookie?: boolean; authorization?: boolean; origin: string | null; userAgent: string | null };
  const completed = new Map<number, RequestLogEntry>();
  const pending = new Map<number, PendingRequest>();
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (line.trim() === '') continue;
    const raw = JSON.parse(line) as (PendingRequest & { pending: true }) | (Omit<RequestLogEntry, 'sent'> & { sent: LegacySent; pending?: undefined });
    if (raw.pending === true) {
      pending.set(raw.seq, { seq: raw.seq, stepId: raw.stepId, kind: raw.kind, method: raw.method, url: raw.url, sentAtMs: raw.sentAtMs });
      continue;
    }
    const { cookie, authorization, hadCookieHeader, hadAuthorizationHeader, ...sent } = raw.sent;
    completed.set(raw.seq, {
      ...raw,
      sent: { ...sent, hadCookieHeader: hadCookieHeader ?? cookie ?? false, hadAuthorizationHeader: hadAuthorizationHeader ?? authorization ?? false },
    });
  }
  const seqs = [...new Set([...completed.keys(), ...pending.keys()])].sort((a, b) => a - b);
  return seqs.map((seq): RequestLogEntry => {
    const done = completed.get(seq);
    if (done !== undefined) return done;
    const p = pending.get(seq) as PendingRequest;
    return {
      ...p,
      endedAtMs: p.sentAtMs + PENDING_ASSUMED_DURATION_MS,
      status: null,
      error: 'no completion logged (crash or kill): counted as sent',
      sent: { hadCookieHeader: false, hadAuthorizationHeader: false, origin: null, userAgent: null },
      outFiles: [],
      pending: true,
    };
  });
}

function isFirstPartyHost(host: string): boolean {
  return host === SGW_SITE_HOST || host.endsWith(`.${SGW_SITE_HOST}`);
}

/**
 * A minimal unpacked MV3 extension whose page is the origin of buyerapi reads:
 * the same origin class the shipped extension's background uses (PLAN §1.7),
 * with host permission (no CORS), `credentials: 'omit'` and the browser's UA.
 * A fixed `key` pins the extension id so no background worker is needed.
 */
function writeCaptureExtension(): string {
  mkdirSync(EXT_DIR, { recursive: true });
  const keyFile = path.join(EXT_DIR, 'key.der.b64');
  let derB64: string;
  if (existsSync(keyFile)) {
    derB64 = readFileSync(keyFile, 'utf8').trim();
  } else {
    const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    derB64 = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
    writeFileSync(keyFile, derB64);
  }
  const manifest = {
    manifest_version: 3,
    name: 'ShopBadwill S-1 capture origin',
    version: '0.0.1',
    key: derB64,
    host_permissions: [`https://${SGW_API_HOST}/*`],
  };
  writeFileSync(path.join(EXT_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2));
  writeFileSync(path.join(EXT_DIR, 'api.html'), '<!doctype html><meta charset="utf-8"><title>capture origin</title>');
  const hex = createHash('sha256').update(Buffer.from(derB64, 'base64')).digest('hex').slice(0, 32);
  return hex.replace(/[0-9a-f]/g, (c) => String.fromCharCode(97 + parseInt(c, 16)));
}

export type Ctx = {
  context: import('@playwright/test').BrowserContext;
  apiPage: import('@playwright/test').Page;
};

class StopCapture extends Error {}

const QUIET_DOM_JS = `new Promise((resolve) => {
  let timer;
  const cap = setTimeout(finish, ${String(QUIET_DOM_MAX_MS)});
  const mo = new MutationObserver(() => { clearTimeout(timer); timer = setTimeout(finish, 1500); });
  function finish() { mo.disconnect(); clearTimeout(timer); clearTimeout(cap); resolve(true); }
  timer = setTimeout(finish, 1500);
  mo.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
})`;

const RECAPTCHA_DOM_JS = `({
  scripts: [...document.querySelectorAll('script[src*="recaptcha"]')].map((s) => s.getAttribute('src')),
  iframes: document.querySelectorAll('iframe[src*="recaptcha"]').length,
  badge: document.querySelectorAll('.grecaptcha-badge').length,
})`;

const CHALLENGE_FRAMES = 'iframe[src*="recaptcha/api2/bframe"], iframe[src*="hcaptcha"], iframe[title*="challenge" i]';

/**
 * Returns why the capture must stop, or null. Any 403/429/5xx-other-than-500
 * stops it (500 is a documented ItemListing answer to a malformed body). For
 * API and text bodies, a block-page phrase near the top also stops it; for
 * rendered pages only a visible challenge frame or a block-page title does,
 * so ordinary page copy cannot trigger a false stop.
 */
export function looksChallenged(
  status: number | null,
  kind: 'api' | 'text' | 'render',
  signals: { bodyText?: string; title?: string; challengeFrames?: number },
): string | null {
  if (status === 403 || status === 429) return `HTTP ${String(status)}`;
  if (status !== null && status > 500) return `HTTP ${String(status)}`;
  if ((signals.challengeFrames ?? 0) > 0) return 'visible challenge frame';
  if (signals.title !== undefined && /access denied|blocked|attention required|just a moment|captcha|are you a robot/i.test(signals.title)) {
    return `challenge page title "${signals.title}"`;
  }
  if (kind !== 'render' && signals.bodyText !== undefined && /the request is blocked|access denied|are you a robot|captcha/i.test(signals.bodyText.slice(0, 2000))) {
    return 'block page text';
  }
  return null;
}

async function runApi(ctx: Ctx, step: Extract<CaptureStep, { kind: 'api' }>, seq: number): Promise<Omit<RequestLogEntry, 'seq' | 'stepId' | 'kind'>> {
  const outDir = path.join(RAW_DIR, 'api');
  mkdirSync(outDir, { recursive: true });
  let sentHeaders: Record<string, string> = {};
  let preflights = 0;
  const onRequest = (req: import('@playwright/test').Request): void => {
    if (req.method() === 'OPTIONS') preflights++;
    if (req.url() === step.url && req.method() === step.method) {
      void req.allHeaders().then((h) => {
        sentHeaders = h;
      });
    }
  };
  ctx.context.on('request', onRequest);
  const sentAtMs = Date.now();
  let result: { status: number; headers: Record<string, string>; text: string; rttMs: number } | null = null;
  let error: string | undefined;
  try {
    result = await ctx.apiPage.evaluate(
      async ({ url, method, body, hasBody, timeoutMs }) => {
        const t0 = performance.now();
        const init: RequestInit = { method, credentials: 'omit', cache: 'no-store', signal: AbortSignal.timeout(timeoutMs) };
        if (hasBody) {
          init.headers = { 'Content-Type': 'application/json' };
          init.body = JSON.stringify(body);
        }
        const r = await fetch(url, init);
        const text = await r.text();
        const headers: Record<string, string> = {};
        r.headers.forEach((v, k) => {
          headers[k] = v;
        });
        return { status: r.status, headers, text, rttMs: performance.now() - t0 };
      },
      { url: step.url, method: step.method, body: step.body ?? null, hasBody: step.body !== undefined, timeoutMs: API_TIMEOUT_MS },
    );
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  const endedAtMs = Date.now();
  await new Promise((r) => setTimeout(r, 250)); // let allHeaders() settle
  ctx.context.off('request', onRequest);
  const file = path.join(outDir, `${step.out}.json`);
  writeFileSync(
    file,
    JSON.stringify(
      {
        seq,
        request: { method: step.method, url: step.url, body: step.body ?? null, sentHeaders },
        response: result === null ? null : { status: result.status, headers: result.headers, rttMs: result.rttMs, bodyText: result.text },
        sentAtMs,
        endedAtMs,
        error,
      },
      null,
      2,
    ),
  );
  const challenged = result === null ? null : looksChallenged(result.status, 'api', { bodyText: result.text });
  const entry: Omit<RequestLogEntry, 'seq' | 'stepId' | 'kind'> = {
    method: step.method,
    url: step.url,
    sentAtMs,
    endedAtMs,
    status: result?.status ?? null,
    ...(error === undefined ? {} : { error }),
    sent: {
      hadCookieHeader: 'cookie' in sentHeaders,
      hadAuthorizationHeader: 'authorization' in sentHeaders,
      origin: sentHeaders.origin ?? null,
      userAgent: sentHeaders['user-agent'] ?? null,
    },
    observations: { corsPreflights: preflights, bytes: result?.text.length ?? 0, dateHeader: result?.headers.date ?? null },
    outFiles: [path.relative(RAW_DIR, file).split(path.sep).join('/')],
    ...(step.note === undefined ? {} : { note: step.note }),
  };
  if (challenged !== null) throw Object.assign(new StopCapture(`stopping: ${challenged} on ${step.url}`), { entry });
  return entry;
}

async function runPage(
  ctx: Ctx,
  step: Extract<CaptureStep, { kind: 'render' | 'text' }>,
): Promise<Omit<RequestLogEntry, 'seq' | 'stepId' | 'kind'>> {
  const outDir = path.join(RAW_DIR, 'pages', step.out);
  mkdirSync(path.join(outDir, 'buyerapi'), { recursive: true });
  mkdirSync(path.join(outDir, 'js'), { recursive: true });
  // Every page step starts as a fresh anonymous visitor: no cookies from earlier steps.
  await ctx.context.clearCookies();
  const page = await ctx.context.newPage();
  const blockedByType: Record<string, number> = {};
  const blockedThirdPartyHosts: Record<string, number> = {};
  const thirdPartyUrls: string[] = [];
  const buyerapi: Array<{ method: string; path: string; status: number | null }> = [];
  let sgwFirstParty = 0;
  let corsPreflights = 0;
  const pending: Array<Promise<void>> = [];
  let navHeaders: Record<string, string> = {};
  let bodyCounter = 0;

  await page.route('**/*', async (route) => {
    const req = route.request();
    let host = '';
    try {
      host = new URL(req.url()).hostname;
    } catch {
      /* data: or blob: */
    }
    const type = req.resourceType();
    if (host !== '' && !isFirstPartyHost(host)) {
      blockedThirdPartyHosts[host] = (blockedThirdPartyHosts[host] ?? 0) + 1;
      if (thirdPartyUrls.length < 200) thirdPartyUrls.push(req.url().slice(0, 300));
      await route.abort('blockedbyclient');
      return;
    }
    if (type === 'image' || type === 'media' || type === 'font') {
      blockedByType[type] = (blockedByType[type] ?? 0) + 1;
      await route.abort('blockedbyclient');
      return;
    }
    // Every request reaching this point is a first-party SGW request; the
    // counted navigation itself passed the guard, page-initiated
    // subresources are the site's own (it decides what its app loads).
    if (host !== SGW_API_HOST && !(req.isNavigationRequest() && req.url() === step.url)) sgwFirstParty++;
    await route.continue();
  });
  page.on('request', (req) => {
    if (req.method() === 'OPTIONS') corsPreflights++;
    if (req.isNavigationRequest() && req.frame() === page.mainFrame() && req.url() === step.url) {
      pending.push(
        req.allHeaders().then((h) => {
          navHeaders = h;
        }),
      );
    }
  });
  page.on('response', (res) => {
    const req = res.request();
    let u: URL;
    try {
      u = new URL(res.url());
    } catch {
      return;
    }
    if (u.hostname === SGW_API_HOST && req.method() !== 'OPTIONS') {
      const rec = { method: req.method(), path: u.pathname + u.search, status: res.status() as number | null };
      buyerapi.push(rec);
      const n = ++bodyCounter;
      pending.push(
        res
          .text()
          .then((text) => {
            const name = `${String(n).padStart(2, '0')}-${u.pathname.replace(/^\/api\//, '').replace(/[^\w]+/g, '_')}.json`;
            writeFileSync(
              path.join(outDir, 'buyerapi', name),
              JSON.stringify(
                { request: { method: req.method(), url: res.url(), postData: req.postData() }, response: { status: res.status(), headers: res.headers(), bodyText: text } },
                null,
                2,
              ),
            );
          })
          .catch(() => undefined),
      );
    } else if (isFirstPartyHost(u.hostname) && req.resourceType() === 'script') {
      pending.push(
        res
          .text()
          .then((text) => {
            // `.js.txt` so ESLint never lints SGW's bundles in the git-ignored raw dir.
            writeFileSync(path.join(outDir, 'js', `${path.basename(u.pathname) || 'index'}.txt`), text);
          })
          .catch(() => undefined),
      );
    }
  });

  const sentAtMs = Date.now();
  let status: number | null = null;
  let error: string | undefined;
  let bodyText = '';
  const observations: Record<string, unknown> = {};
  const apiWait =
    step.kind === 'render' && step.waitForApi !== undefined
      ? page
          .waitForResponse((r) => r.url().includes(step.waitForApi ?? '(none)'), { timeout: PAGE_API_WAIT_MS })
          .then(() => true)
          .catch(() => false)
      : Promise.resolve(true);
  try {
    const resp = await page.goto(step.url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
    status = resp?.status() ?? null;
    if (step.kind === 'text') {
      bodyText = (await resp?.text()) ?? '';
      writeFileSync(path.join(outDir, 'body.txt'), bodyText);
    } else {
      observations.title = await page.title();
      observations.challengeFrames = await page.locator(CHALLENGE_FRAMES).count();
      const early = looksChallenged(status, 'render', { title: observations.title as string, challengeFrames: observations.challengeFrames as number });
      if (early === null) {
        observations.apiSeen = await apiWait;
        if (step.waitFor !== undefined) {
          try {
            await page.waitForSelector(step.waitFor, { timeout: hydrationTimeoutMs(step) });
            observations.hydrated = true;
          } catch {
            observations.hydrated = false; // kept as a "skeleton-only" capture (PLAN §7.2)
          }
        }
        // Wait for the DOM to go quiet (1.5 s without mutations, at most 15 s).
        // In-page code is passed as strings: tsx/esbuild `keepNames` would
        // otherwise inject a `__name` helper that does not exist in the page.
        await page.evaluate(QUIET_DOM_JS);
        bodyText = await page.content();
        observations.recaptchaInDom = await page.evaluate(RECAPTCHA_DOM_JS);
        observations.title = await page.title();
        observations.challengeFrames = await page.locator(CHALLENGE_FRAMES).count();
        writeFileSync(path.join(outDir, 'page.html'), bodyText);
        await page.screenshot({ path: path.join(outDir, 'page.png'), fullPage: true, timeout: SCREENSHOT_TIMEOUT_MS }).catch(() => undefined);
      }
    }
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
  }
  const endedAtMs = Date.now();
  await Promise.allSettled(pending);
  observations.thirdPartyUrlsSample = thirdPartyUrls;
  // Close the tab at once: the app's own timers and pollers must not keep
  // making requests between our spaced steps.
  await page.close();
  const entry: Omit<RequestLogEntry, 'seq' | 'stepId' | 'kind'> = {
    method: 'GET',
    url: step.url,
    sentAtMs,
    endedAtMs,
    status,
    ...(error === undefined ? {} : { error }),
    sent: {
      hadCookieHeader: 'cookie' in navHeaders,
      hadAuthorizationHeader: 'authorization' in navHeaders,
      origin: navHeaders.origin ?? null,
      userAgent: navHeaders['user-agent'] ?? null,
    },
    pageInitiated: { sgwFirstParty, buyerapi, blockedByType, blockedThirdPartyHosts, corsPreflights },
    observations,
    outFiles: [path.relative(RAW_DIR, outDir).split(path.sep).join('/')],
    ...(step.note === undefined ? {} : { note: step.note }),
  };
  const challenged =
    step.kind === 'text'
      ? looksChallenged(status, 'text', { bodyText })
      : looksChallenged(status, 'render', {
          ...(typeof observations.title === 'string' ? { title: observations.title } : {}),
          challengeFrames: typeof observations.challengeFrames === 'number' ? observations.challengeFrames : 0,
        });
  if (challenged !== null) throw Object.assign(new StopCapture(`stopping: ${challenged} on ${step.url}`), { entry });
  return entry;
}

/** Launches the capture browser (headless Chromium, browser-default UA) with the capture-origin extension page open. */
export async function openCaptureSession(): Promise<Ctx> {
  const extId = writeCaptureExtension();
  const { chromium } = await import('@playwright/test');
  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    channel: 'chromium',
    headless: true,
    serviceWorkers: 'block',
    args: [`--disable-extensions-except=${EXT_DIR}`, `--load-extension=${EXT_DIR}`],
  });
  const apiPage = await context.newPage();
  await apiPage.goto(`chrome-extension://${extId}/api.html`);
  log(`browser ready, capture origin chrome-extension://${extId}, UA ${await apiPage.evaluate(() => navigator.userAgent)}`);
  return { context, apiPage };
}

/** Runs one already-guarded step. Exported for the offline smoke check only; `serve` is the entry point. */
export async function runCaptureStep(ctx: Ctx, step: Exclude<CaptureStep, { kind: 'stop' }>, seq: number): Promise<Omit<RequestLogEntry, 'seq' | 'stepId' | 'kind'>> {
  return step.kind === 'api' ? runApi(ctx, step, seq) : runPage(ctx, step);
}

/** Holds raw/capture.lock for the whole run, so a second capture process refuses to start. */
async function serve(mode: 'once' | 'serve'): Promise<void> {
  for (const d of [RAW_DIR, QUEUE_DIR, DONE_DIR, REJECTED_DIR]) mkdirSync(d, { recursive: true });
  const releaseLock = acquireCaptureLock(LOCK_FILE);
  const onSignal = (): void => {
    releaseLock();
    process.exit(130);
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  try {
    await serveLocked(mode);
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    releaseLock();
  }
}

async function serveLocked(mode: 'once' | 'serve'): Promise<void> {
  if (existsSync(STOPPED_FILE)) throw new Error(`refusing to start: ${STOPPED_FILE} exists (${readFileSync(STOPPED_FILE, 'utf8')})`);
  const requestLog = readRequestLog();
  assertLogWithinRules(requestLog);
  log(`log has ${String(requestLog.length)}/${String(CAPTURE_MAX_REQUESTS)} requests`);

  const ctx = await openCaptureSession();
  const { context } = ctx;
  let idleSince = Date.now();
  try {
    for (;;) {
      const files = readdirSync(QUEUE_DIR)
        .filter((f) => f.endsWith('.json'))
        .sort();
      const next = files[0];
      if (next === undefined) {
        if (mode === 'once') {
          log(`queue empty; exiting (log has ${String(readRequestLog().length)}/${String(CAPTURE_MAX_REQUESTS)} requests)`);
          return;
        }
        if (Date.now() - idleSince > SERVE_IDLE_EXIT_MS) {
          log('idle too long; exiting');
          return;
        }
        await new Promise((r) => setTimeout(r, 2000));
        continue;
      }
      const src = path.join(QUEUE_DIR, next);
      let step: CaptureStep;
      try {
        step = parseStep(JSON.parse(readFileSync(src, 'utf8')));
      } catch (e) {
        log(`rejected ${next}: ${e instanceof Error ? e.message : String(e)}`);
        renameSync(src, path.join(REJECTED_DIR, next));
        continue;
      }
      if (step.kind === 'stop') {
        renameSync(src, path.join(DONE_DIR, next));
        log('stop step received');
        return;
      }
      const method = step.kind === 'api' ? step.method : 'GET';
      const guard = checkCaptureUrl(step.url, method);
      if (!guard.ok || (step.kind === 'api') !== (guard.kind === 'api')) {
        log(`rejected ${step.id}: ${guard.ok ? 'step kind does not match host' : guard.reason}`);
        renameSync(src, path.join(REJECTED_DIR, next));
        continue;
      }
      const current = readRequestLog();
      if (current.length >= CAPTURE_MAX_REQUESTS) {
        log(`rejected ${step.id}: cap of ${String(CAPTURE_MAX_REQUESTS)} reached`);
        renameSync(src, path.join(REJECTED_DIR, next));
        continue;
      }
      const waitMs = nextAllowedAt(current) + 1000 - Date.now();
      if (waitMs > 0) {
        log(`step ${step.id}: waiting ${String(Math.ceil(waitMs / 1000))} s for the 120 s spacing`);
        await new Promise((r) => setTimeout(r, waitMs));
      }
      const seq = current.length + 1;
      log(`#${String(seq)} ${step.kind} ${method} ${step.url}`);
      // Counted BEFORE it is sent: a crash or kill from here on can never leave it uncounted.
      appendPendingRequest(LOG_FILE, { seq, stepId: step.id, kind: step.kind, method, url: step.url, sentAtMs: Date.now() });
      let partial: Omit<RequestLogEntry, 'seq' | 'stepId' | 'kind'>;
      let stop: string | null = null;
      try {
        partial = step.kind === 'api' ? await runApi(ctx, step, seq) : await runPage(ctx, step);
      } catch (e) {
        if (e instanceof StopCapture) {
          stop = e.message;
          partial = (e as StopCapture & { entry: Omit<RequestLogEntry, 'seq' | 'stepId' | 'kind'> }).entry;
        } else {
          throw e;
        }
      }
      const entry: RequestLogEntry = { seq, stepId: step.id, kind: step.kind, ...partial };
      appendFileSync(LOG_FILE, JSON.stringify(entry) + '\n');
      renameSync(src, path.join(DONE_DIR, next));
      log(`#${String(seq)} -> ${String(entry.status)} in ${String(entry.endedAtMs - entry.sentAtMs)} ms${entry.error === undefined ? '' : ` (${entry.error})`}`);
      if (stop !== null) {
        writeFileSync(STOPPED_FILE, `${new Date().toISOString()} ${stop}\n`);
        log(stop);
        return;
      }
      idleSince = Date.now();
    }
  } finally {
    await context.close();
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const cmd = process.argv[2];
  if (cmd !== 'once' && cmd !== 'serve') {
    console.error('usage: tsx scripts/capture-fixtures.ts once|serve');
    process.exit(2);
  }
  serve(cmd).catch((e: unknown) => {
    console.error(e);
    process.exit(1);
  });
}
