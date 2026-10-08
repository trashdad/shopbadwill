import { appendFileSync, existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Window } from 'happy-dom';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  acquireCaptureLock,
  API_TIMEOUT_MS,
  appendPendingRequest,
  assertLogWithinRules,
  CAPTURE_MAX_REQUESTS,
  CAPTURE_MIN_SPACING_MS,
  checkCaptureUrl,
  HYDRATION_WAIT_MAX_MS,
  hydrationTimeoutMs,
  MAX_STEP_DURATION_MS,
  NAV_TIMEOUT_MS,
  nextAllowedAt,
  PAGE_API_WAIT_MS,
  PENDING_ASSUMED_DURATION_MS,
  QUIET_DOM_MAX_MS,
  readRequestLog,
  type RequestLogEntry,
  SCREENSHOT_TIMEOUT_MS,
} from '../../../scripts/capture-fixtures';
import { isJwtLike, SANITIZER_VERSION } from '../../../scripts/sanitize-fixtures';

// Committed S-1 fixtures live in test/fixtures/sgw/{json,html}/. The raw,
// unsanitized captures beside them (raw/) are git-ignored and never read here.
const SGW_DIR = path.resolve(import.meta.dirname, '../../fixtures/sgw');

const ManifestEntry = z
  .object({
    file: z.string().regex(/^(json\/[\w.-]+\.json|html\/[\w.-]+\.html)$/),
    fixture: z.string().regex(/^[\w.-]+$/),
    kind: z.enum(['json', 'html']),
    endpoint: z.string().optional(),
    page: z.enum(['home', 'item', 'search', 'favorites', 'help']).optional(),
    layout: z.enum(['grid', 'list']).optional(),
    loggedIn: z.boolean(),
    source: z.enum(['anonymous', 'user']),
    method: z.enum(['capture-fixtures:api', 'capture-fixtures:render', 'capture-fixtures:page-xhr', 'user-devtools']),
    urlPattern: z.string().regex(/^(GET|POST) https:\/\/(shopgoodwill\.com|buyerapi\.shopgoodwill\.com)\//),
    requestBody: z.unknown().optional(),
    status: z.number().int(),
    capturedAt: z.iso.datetime(),
    requestLogSeq: z.number().int().positive().nullable(),
    sanitizerVersion: z.string(),
    notes: z.string().optional(),
  })
  .strict();

const Manifest = z
  .object({
    schemaVersion: z.literal(1),
    sanitizerVersion: z.string(),
    salt: z.literal('local-secret'),
    fixtures: z.array(ManifestEntry),
  })
  .strict();

function listFixtures(): string[] {
  const out: string[] = [];
  for (const dir of ['json', 'html']) {
    const abs = path.join(SGW_DIR, dir);
    if (!existsSync(abs)) continue;
    for (const f of readdirSync(abs)) out.push(`${dir}/${f}`);
  }
  return out.sort();
}

const manifest = Manifest.parse(JSON.parse(readFileSync(path.join(SGW_DIR, 'manifest.json'), 'utf8')));
const files = listFixtures();
const read = (rel: string): string => readFileSync(path.join(SGW_DIR, rel), 'utf8');

describe('fixtures manifest', () => {
  it('lists every fixture file exactly once, and nothing else', () => {
    const listed = manifest.fixtures.map((e) => e.file).sort();
    expect(new Set(listed).size).toBe(listed.length);
    expect(listed).toEqual(files);
    expect(files.length).toBeGreaterThan(0);
  });

  it('records provenance for every entry with the current sanitizer version', () => {
    expect(manifest.sanitizerVersion).toBe(SANITIZER_VERSION);
    for (const e of manifest.fixtures) {
      expect(e.sanitizerVersion, e.file).toBe(SANITIZER_VERSION);
      expect(e.file, e.file).toBe(`${e.kind}/${e.fixture}.${e.kind}`);
      if (e.source === 'anonymous') {
        expect(e.loggedIn, e.file).toBe(false);
        expect(e.requestLogSeq, e.file).not.toBeNull();
        expect(e.method, e.file).not.toBe('user-devtools');
      } else {
        expect(e.method, e.file).toBe('user-devtools');
        expect(e.requestLogSeq, e.file).toBeNull();
      }
      if (e.kind === 'json') expect(e.endpoint, e.file).toBeDefined();
      if (e.kind === 'html') expect(e.page, e.file).toBeDefined();
    }
  });

  it('every JSON fixture is well-formed JSON', () => {
    for (const f of files.filter((x) => x.endsWith('.json'))) {
      expect(() => JSON.parse(read(f)) as unknown, f).not.toThrow();
    }
  });

  it('every HTML fixture is a well-formed, script-free document', () => {
    for (const f of files.filter((x) => x.endsWith('.html'))) {
      const html = read(f);
      expect(html.startsWith('<!DOCTYPE html>'), f).toBe(true);
      expect(html.match(/<html[\s>]/g)?.length, f).toBe(1);
      expect(html.trimEnd().endsWith('</html>'), f).toBe(true);
      expect(html, f).not.toMatch(/<script[\s>]/i);
      expect(html, f).not.toMatch(/<iframe[\s>]/i);
      expect(html, f).not.toMatch(/\son[a-z]+\s*=/i);
      const window = new Window({ settings: { disableJavaScriptEvaluation: true, disableJavaScriptFileLoading: true, disableCSSFileLoading: true } });
      const doc = new window.DOMParser().parseFromString(html, 'text/html');
      expect(doc.body.children.length, f).toBeGreaterThan(0);
      void window.happyDOM.close();
    }
  });

  it('no fixture or log carries a secret, a JWT or a real image host', () => {
    for (const f of [...files, 'manifest.json', 'request-log.json']) {
      const text = read(f);
      expect(text, f).not.toMatch(/eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*/);
      expect(text, f).not.toMatch(/["'\s](authorization|cookie|set-cookie|x-azure-ref)["']?\s*:/i);
      // Image URLs, not bare host names: the request log keeps per-host counts of blocked requests.
      expect(text, f).not.toMatch(/https?:\/\/[^\s"'<>]*(shopgoodwillimages|azureedge\.net)/i);
      for (const token of text.match(/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g) ?? []) {
        expect(isJwtLike(token), `${f}: ${token}`).toBe(false);
      }
    }
  });

  it('holds the anonymous S-1 fixtures', () => {
    const names = new Set(manifest.fixtures.map((e) => e.fixture));
    for (const name of [
      'search-grid-p1',
      'search-list-p1',
      'search-empty',
      'item-detail-open',
      'item-detail-closed',
      'item-detail-pickup',
      'get-current-time',
      'item-page-logged-out',
      'search-malformed-200',
    ]) {
      expect(names.has(name), name).toBe(true);
    }
  });

  it('holds the help-center evidence behind the S-1 verdicts (docs/spikes/S-1.md)', () => {
    const names = new Set(manifest.fixtures.map((e) => e.fixture));
    for (const name of ['help-center-list', 'help-answer-last-second-bids', 'help-answer-new-account-15-items', 'help-answer-ended-early']) {
      expect(names.has(name), name).toBe(true);
    }
  });

  it('every anonymous fixture points at the logged request that produced it', () => {
    const log = JSON.parse(read('request-log.json')) as RequestLogEntry[];
    for (const e of manifest.fixtures.filter((x) => x.source === 'anonymous')) {
      const hit = log.find((l) => l.seq === e.requestLogSeq);
      expect(hit, `${e.file} -> #${String(e.requestLogSeq)}`).toBeDefined();
      if (hit === undefined) continue;
      expect(e.capturedAt, e.file).toBe(new Date(hit.sentAtMs).toISOString());
      // A direct read's URL is the logged URL; a page's own XHR is logged under the page it rendered.
      if (e.method === 'capture-fixtures:api') expect(e.urlPattern, e.file).toBe(`${hit.method} ${hit.url}`);
      if (e.method === 'capture-fixtures:page-xhr') expect(hit.kind, e.file).toBe('render');
    }
  });

  // USER STEP S-1 captures (docs/USER-STEPS/S-1.md); asserted once stage 2 lands them.
  it.todo('holds the USER STEP fixtures: favorites-open, saved-searches, show-bid-modal, calculate-shipping');
  it.todo('holds the USER STEP DOM captures: search grid and list, favorites page, logged-in item page');
});

describe('request log (S-1 exit criterion 5)', () => {
  const log = JSON.parse(read('request-log.json')) as RequestLogEntry[];

  it(`has at most ${String(CAPTURE_MAX_REQUESTS)} requests, each starting >= ${String(CAPTURE_MIN_SPACING_MS / 1000)} s after the previous one ended`, () => {
    expect(log.length).toBeGreaterThan(0);
    expect(() => {
      assertLogWithinRules(log);
    }).not.toThrow();
  });

  it('sent no cookie and no Authorization header, and only allowed read URLs', () => {
    for (const e of log) {
      expect(e.sent.hadCookieHeader, `#${String(e.seq)}`).toBe(false);
      expect(e.sent.hadAuthorizationHeader, `#${String(e.seq)}`).toBe(false);
      expect(checkCaptureUrl(e.url, e.method), `#${String(e.seq)} ${e.url}`).toMatchObject({ ok: true });
    }
  });

  it('the page-initiated buyerapi calls during renders were reads only', () => {
    for (const e of log) {
      for (const call of e.pageInitiated?.buyerapi ?? []) {
        expect(call.path, `#${String(e.seq)}`).not.toMatch(/PlaceBid|AddToFavorite|RemoveItemFromFavoriteList|\/Save\b|SignIn|Login/i);
      }
    }
  });
});

describe('capture log crash-safety and single instance (fix round 1, I3)', () => {
  const tempLog = (): string => path.join(mkdtempSync(path.join(tmpdir(), 'sbw-capture-')), 'request-log.jsonl');
  const pending = { seq: 1, stepId: 'clock', kind: 'api', method: 'POST', url: 'https://buyerapi.shopgoodwill.com/api/Dashboard/GetCurrentTime', sentAtMs: 1_000_000 } as const;

  it('counts a pending line with no completion as a sent request, for the cap and for the spacing', () => {
    const file = tempLog();
    appendPendingRequest(file, pending);
    const log = readRequestLog(file);
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ seq: 1, stepId: 'clock', pending: true, status: null, sentAtMs: 1_000_000 });
    expect(nextAllowedAt(log)).toBe(1_000_000 + PENDING_ASSUMED_DURATION_MS + CAPTURE_MIN_SPACING_MS);
    expect(() => {
      assertLogWithinRules(log);
    }).not.toThrow();
    // The next request numbers itself after the crashed one.
    appendPendingRequest(file, { ...pending, seq: 2, sentAtMs: nextAllowedAt(log) });
    expect(readRequestLog(file).map((e) => e.seq)).toEqual([1, 2]);
  });

  it('assumes a crashed request ran for the longest a step can take (fix round 2, N4)', () => {
    expect(PENDING_ASSUMED_DURATION_MS).toBe(MAX_STEP_DURATION_MS);
    expect(MAX_STEP_DURATION_MS).toBe(NAV_TIMEOUT_MS + PAGE_API_WAIT_MS + HYDRATION_WAIT_MAX_MS + QUIET_DOM_MAX_MS + SCREENSHOT_TIMEOUT_MS);
    expect(MAX_STEP_DURATION_MS).toBeGreaterThanOrEqual(API_TIMEOUT_MS);
    // A step's own hydration timeout can never exceed the cap the spacing assumes.
    expect(hydrationTimeoutMs({ id: 'x', kind: 'render', url: 'https://shopgoodwill.com/', out: 'x', timeoutMs: 600_000 })).toBe(HYDRATION_WAIT_MAX_MS);
    expect(hydrationTimeoutMs({ id: 'x', kind: 'render', url: 'https://shopgoodwill.com/', out: 'x' })).toBeLessThanOrEqual(HYDRATION_WAIT_MAX_MS);
  });

  it('a completed entry supersedes its own pending line', () => {
    const file = tempLog();
    appendPendingRequest(file, pending);
    const done: RequestLogEntry = {
      ...pending,
      endedAtMs: 1_000_400,
      status: 200,
      sent: { hadCookieHeader: false, hadAuthorizationHeader: false, origin: null, userAgent: 'UA' },
      outFiles: ['api/clock.json'],
    };
    appendFileSync(file, `${JSON.stringify(done)}\n`);
    const log = readRequestLog(file);
    expect(log).toHaveLength(1);
    expect(log[0]?.pending).toBeUndefined();
    expect(log[0]?.endedAtMs).toBe(1_000_400);
    expect(nextAllowedAt(log)).toBe(1_000_400 + CAPTURE_MIN_SPACING_MS);
  });

  it('refuses a second capture while the lock file exists, and says how to clear a stale lock', () => {
    const lock = path.join(path.dirname(tempLog()), 'capture.lock');
    const release = acquireCaptureLock(lock);
    expect(existsSync(lock)).toBe(true);
    expect(() => acquireCaptureLock(lock)).toThrow(/already running/);
    expect(() => acquireCaptureLock(lock)).toThrow(/delete .*capture\.lock/);
    release();
    expect(existsSync(lock)).toBe(false);
    acquireCaptureLock(lock)();
  });
});

describe('capture guard', () => {
  it.each([
    ['GET', 'https://shopgoodwill.com/robots.txt'],
    ['GET', 'https://shopgoodwill.com/'],
    ['GET', 'https://shopgoodwill.com/item/279250057'],
    ['GET', 'https://shopgoodwill.com/help'],
    ['POST', 'https://buyerapi.shopgoodwill.com/api/Search/ItemListing'],
    ['GET', 'https://buyerapi.shopgoodwill.com/api/ItemDetail/GetItemDetailModelByItemId/279250057'],
    ['POST', 'https://buyerapi.shopgoodwill.com/api/Dashboard/GetCurrentTime'],
    ['GET', 'https://buyerapi.shopgoodwill.com/api/HelpCenter/GetQuestionAnswer?q=i-tried-bidding-on-an-item-in-the-last-second'],
  ])('allows %s %s', (method, url) => {
    expect(checkCaptureUrl(url, method)).toMatchObject({ ok: true });
  });

  it.each([
    ['GET', 'https://shopgoodwill.com/categories/listing?st=pyrex&p=1', 'robots.txt'],
    ['GET', 'https://shopgoodwill.com/categories/listing', 'robots.txt'],
    ['GET', 'https://shopgoodwill.com/shopgoodwill/favorites', 'robots.txt'],
    ['GET', 'https://shopgoodwill.com/checkout/cart', 'robots.txt'],
    ['GET', 'https://shopgoodwill.com/home-preview/x', 'robots.txt'],
    ['GET', 'https://shopgoodwill.com/signin', 'sign-in'],
    ['GET', 'https://shopgoodwill.com/item/1?st=x', 'robots.txt'],
    ['POST', 'https://buyerapi.shopgoodwill.com/api/ItemBid/PlaceBid', 'write'],
    ['GET', 'https://buyerapi.shopgoodwill.com/api/Favorite/AddToFavorite?itemId=1', 'write'],
    ['GET', 'https://buyerapi.shopgoodwill.com/api/Favorite/RemoveItemFromFavoriteList?itemId=1', 'write'],
    ['POST', 'https://buyerapi.shopgoodwill.com/api/Favorite/Save', 'write'],
    ['POST', 'https://buyerapi.shopgoodwill.com/api/SignIn/Login', 'session'],
    ['POST', 'https://buyerapi.shopgoodwill.com/api/SignIn/RefreshToken', 'session'],
    ['POST', 'https://buyerapi.shopgoodwill.com/api/itemDetail/CalculateShipping', 'allow-list'],
    ['GET', 'https://buyerapi.shopgoodwill.com/api/ItemBid/ShowBidModal?itemId=1', 'allow-list'],
    ['POST', 'https://buyerapi.shopgoodwill.com/api/Favorite/GetAllFavoriteItemsByType?Type=open', 'allow-list'],
    ['GET', 'https://buyerapi.shopgoodwill.com/api/HelpCenter/GetQuestionAnswer?q=x&token=y', 'query'],
    ['GET', 'https://buyerapi.shopgoodwill.com/api/HelpCenter/GetQuestionAnswer?q=<script>', 'query'],
    ['GET', 'https://buyerapi.shopgoodwill.com/api/ItemDetail/GetItemDetailModelByItemId/1?x=1', 'query'],
    ['GET', 'https://buyerapi.shopgoodwill.com/api/Search/ItemListing', 'method'],
    ['DELETE', 'https://buyerapi.shopgoodwill.com/api/Search/ItemListing', 'method'],
    ['GET', 'http://shopgoodwill.com/', 'https'],
    ['GET', 'https://evil.example/item/1', 'host'],
  ])('refuses %s %s (%s)', (method, url) => {
    expect(checkCaptureUrl(url, method)).toMatchObject({ ok: false });
  });
});
