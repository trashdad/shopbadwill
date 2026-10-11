// T-60: the canary against the fake SGW server only. No live network, no real sleeping, no browser.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  assertAllowed,
  buildDriftIssueBody,
  CANARY_DAY_MS,
  CANARY_MIN_SPACING_MS,
  CANARY_RUN_INTERVAL_MS,
  crashLines,
  decideDriftIssueAction,
  failingCheckFingerprint,
  findPreviousStateRunId,
  honestUserAgent,
  ITEM_PAGE_CHECK_KEYS,
  runCanary,
  sanitizeCanaryMessage,
  selectStateRunId,
  shouldOpenDriftIssue,
  syncDriftIssue,
  workflowAnnotations,
  type CanaryOptions,
  type CanaryResult,
  type PageCheckResult,
} from '../../../scripts/canary';
import { checkCaptureUrl } from '../../../scripts/capture-fixtures';
import { startFakeSgw, type FakeSgw } from '../../fakes/fake-sgw-server';

const T0 = Date.UTC(2026, 9, 10, 9, 17, 0);

let sgw: FakeSgw;
let dir: string;
let clock: number;
let sleeps: number[];
let sent: { realish: string; method: string; at: number; headers: Record<string, string> }[];
let pages: string[];

const urlOf = (i: RequestInfo | URL): string => (typeof i === 'string' ? i : i instanceof URL ? i.href : i.url);

async function scenario(patch: Record<string, unknown>): Promise<void> {
  await fetch(`${sgw.url}/__scenario`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) });
}
async function serverLog(): Promise<{ endpoint: string; hasBearer: boolean; body: string }[]> {
  const j = (await (await fetch(`${sgw.url}/__log`)).json()) as { entries: { endpoint: string; hasBearer: boolean; body: string }[] };
  return j.entries;
}

const goodPage = (): PageCheckResult => ({
  status: 200,
  challenged: false,
  matched: Object.fromEntries(ITEM_PAGE_CHECK_KEYS.map((k) => [k, true])),
});

function opts(over: Partial<CanaryOptions> & { render?: () => PageCheckResult | Promise<PageCheckResult> } = {}): CanaryOptions {
  const { render, ...rest } = over;
  return {
    apiBase: `${sgw.url}/api/`,
    siteOrigin: sgw.url,
    stateFile: path.join(dir, 'state.json'),
    force: false,
    userAgent: 'ShopBadwill-canary/test',
    fetchFn: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const headers: Record<string, string> = {};
      new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
      sent.push({ realish: urlOf(input), method: init?.method ?? 'GET', at: clock, headers });
      const r = await fetch(input, init);
      clock += 500; // each request takes 0.5 s of fake time
      return r;
    }),
    renderItemPage: async (url) => {
      pages.push(url);
      sent.push({ realish: url, method: 'GET', at: clock, headers: {} });
      clock += 500;
      return render ? await render() : goodPage();
    },
    sleep: (ms) => {
      sleeps.push(ms);
      clock += ms;
      return Promise.resolve();
    },
    now: () => clock,
    log: () => undefined,
    ...rest,
  };
}

beforeAll(async () => {
  // Pin the fake server's clock so the seeded Oct 2026 auctions are open.
  sgw = await startFakeSgw({ port: 0, scenario: { serverNowMs: Date.UTC(2026, 9, 6, 12) } });
});
afterAll(async () => {
  await sgw.close();
});
beforeEach(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'canary-'));
  clock = T0;
  await fetch(`${sgw.url}/__log`, { method: 'DELETE' });
  sleeps = [];
  sent = [];
  pages = [];
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Wraps fetch so JSON replies for a URL fragment pass through `mutate`. */
function mutating(fragment: string, mutate: (j: Record<string, unknown>) => void): CanaryOptions['fetchFn'] {
  const base = opts().fetchFn;
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const res = await base(input, init);
    if (!urlOf(input).includes(fragment)) return res;
    const j = (await res.json()) as Record<string, unknown>;
    mutate(j);
    return new Response(JSON.stringify(j), { status: res.status, headers: { 'content-type': 'application/json' } });
  });
}

describe('canary against the fake SGW server', () => {
  it('passes on the fixtures with exactly 3 anonymous requests, 120 s apart', async () => {
    const r = await runCanary(opts());
    expect(r.failures).toEqual([]);
    expect(r.status).toBe('pass');
    expect(r.requestsMade).toBe(3);
    expect(sent.map((s) => s.method)).toEqual(['POST', 'GET', 'GET']);
    expect(sent[0]?.realish).toContain('Search/ItemListing');
    expect(sent[1]?.realish).toContain('ItemDetail/GetItemDetailModelByItemId/');
    expect(pages).toHaveLength(1);
    expect(pages[0]).toMatch(/\/item\/\d+$/);
    const log = await serverLog();
    expect(log.map((e) => e.endpoint.toLowerCase())).toEqual(['search/itemlisting', 'itemdetail/getitemdetailmodelbyitemid']);
    for (const e of log) expect(e.hasBearer).toBe(false);
    for (const s of sent) {
      expect(s.headers['cookie']).toBeUndefined();
      expect(s.headers['authorization']).toBeUndefined();
    }
    expect((JSON.parse(log[0]?.body ?? '{}') as { searchText: string }).searchText).toBe('pyrex');
  });

  it('enforces 120 s between the end of one request and the start of the next', async () => {
    await runCanary(opts());
    // Requests start at 0 s, then >= 120.5 s, then >= 241 s apart from each previous end.
    for (let i = 1; i < sent.length; i++) {
      const prev = sent[i - 1];
      const cur = sent[i];
      expect((cur?.at ?? 0) - ((prev?.at ?? 0) + 500)).toBeGreaterThanOrEqual(CANARY_MIN_SPACING_MS);
    }
    expect(sleeps).toHaveLength(2);
    for (const s of sleeps) expect(s).toBeGreaterThanOrEqual(CANARY_MIN_SPACING_MS);
  });

  it('fails and reports the path on a renamed field, without the response body', async () => {
    const r = await runCanary(
      opts({
        fetchFn: mutating('ItemDetail', (j) => {
          j['currentPriceX'] = j['currentPrice'];
          delete j['currentPrice'];
        }),
      }),
    );
    expect(r.status).toBe('drift');
    const f = r.failures.find((x) => x.check === 'itemDetail');
    expect(f).toBeDefined();
    expect(f?.path).toContain('currentPrice');
    expect(f?.message).toContain('currentPrice');
    expect(JSON.stringify(r)).not.toContain('"description"');
  });

  it('reports a renamed search field and stops (no ItemDetail or page request)', async () => {
    const r = await runCanary(
      opts({
        fetchFn: mutating('Search/ItemListing', (j) => {
          const sr = j['searchResults'] as Record<string, unknown>;
          sr['rows'] = sr['items'];
          delete sr['items'];
        }),
      }),
    );
    expect(r.status).toBe('drift');
    expect(r.failures[0]?.check).toBe('search');
    expect(r.failures[0]?.path).toContain('items');
    expect(r.requestsMade).toBe(1);
    expect(pages).toHaveLength(0);
  });

  it('reports a missing item-page selector by its config key', async () => {
    const r = await runCanary(
      opts({ render: () => ({ ...goodPage(), matched: { ...goodPage().matched, title: false } }) }),
    );
    expect(r.status).toBe('drift');
    expect(r.failures).toHaveLength(1);
    expect(r.failures[0]).toMatchObject({ check: 'itemPage', path: 'SGW_SELECTORS.item.title' });
  });

  it('refuses to run twice within 12 h, even with a restart, and runs again at exactly 12 h', async () => {
    const o = opts();
    expect((await runCanary(o)).status).toBe('pass');
    const before = sent.length;
    clock += 60 * 60 * 1000;
    const again = await runCanary(o);
    expect(again.status).toBe('skipped');
    expect(again.reason).toMatch(/locked/);
    expect(again.requestsMade).toBe(0);
    expect(sent.length).toBe(before);

    // The lock is `< 12 h`, so it is open at exactly 12 h. The previous run's
    // requests must not refuse this one.
    clock = T0 + CANARY_RUN_INTERVAL_MS;
    const next = await runCanary(o);
    expect(next.status).toBe('pass');
    expect(next.requestsMade).toBe(3);
  });

  it('opens the lock at exactly 12 h even when the previous run already made 4 requests', async () => {
    writeFileSync(
      path.join(dir, 'state.json'),
      JSON.stringify({
        runs: [T0],
        requests: [T0, T0 + 1, T0 + 2, T0 + 3],
        lastRequestEndedAt: T0,
      }),
    );
    clock = T0 + CANARY_RUN_INTERVAL_MS - 1;
    const locked = await runCanary(opts());
    expect(locked.status).toBe('skipped');
    expect(locked.reason).toMatch(/locked/);
    expect(locked.requestsMade).toBe(0);

    clock = T0 + CANARY_RUN_INTERVAL_MS;
    const opened = await runCanary(opts());
    expect(opened.status).toBe('pass');
    expect(opened.requestsMade).toBe(3);
  });

  it('allows a run that starts 24 h ± a few minutes after the previous one', async () => {
    const early = T0 + CANARY_DAY_MS - 3 * 60 * 1000;
    const late = T0 + CANARY_DAY_MS + 4 * 60 * 1000;

    expect((await runCanary(opts())).status).toBe('pass');
    clock = early;
    const under = await runCanary(opts());
    expect(under.status).toBe('pass');
    expect(under.requestsMade).toBe(3);

    // Fresh state so the late case is measured from its own previous run.
    rmSync(path.join(dir, 'state.json'));
    clock = T0;
    expect((await runCanary(opts())).status).toBe('pass');
    clock = late;
    const over = await runCanary(opts());
    expect(over.status).toBe('pass');
    expect(over.requestsMade).toBe(3);
  });

  it('force bypasses the 12 h lock and still makes the run', async () => {
    await runCanary(opts());
    clock += 60 * 60 * 1000;
    const forced = await runCanary(opts({ force: true }));
    expect(forced.status).toBe('pass');
    expect(forced.requestsMade).toBe(3);
  });

  it('force with a clean budget still waits out the spacing from the previous request', async () => {
    writeFileSync(
      path.join(dir, 'state.json'),
      JSON.stringify({ runs: [T0 - 3600_000], requests: [T0 - 60_000], lastRequestEndedAt: T0 - 60_000 }),
    );
    const r = await runCanary(opts({ force: true }));
    expect(r.status).toBe('pass');
    expect(sleeps[0]).toBe(60_000);
  });

  it('retries a 5xx once after 120 s; a persistent 5xx is inconclusive, never drift', async () => {
    await scenario({ errors: { 'Search/ItemListing': { status: 503 } } });
    const r = await runCanary(opts());
    await scenario({ reset: true, serverNowMs: Date.UTC(2026, 9, 6, 12) });
    expect(r.status).toBe('inconclusive');
    expect(r.failures).toEqual([]);
    expect(r.requestsMade).toBe(2);
    expect(sleeps).toEqual([CANARY_MIN_SPACING_MS]);
    expect(pages).toHaveLength(0);
  });

  it('recovers when the retry succeeds (4 requests that day)', async () => {
    await scenario({ errors: { 'Search/ItemListing': { status: 503, times: 1 } } });
    const r = await runCanary(opts());
    await scenario({ reset: true, serverNowMs: Date.UTC(2026, 9, 6, 12) });
    expect(r.status).toBe('pass');
    expect(r.requestsMade).toBe(4);
    const state = JSON.parse(readFileSync(path.join(dir, 'state.json'), 'utf8')) as { requests: number[] };
    expect(state.requests).toHaveLength(4);
  });

  it('treats a network failure as inconclusive', async () => {
    const r = await runCanary(
      opts({
        fetchFn: (() => Promise.reject(new TypeError('fetch failed'))),
      }),
    );
    expect(r.status).toBe('inconclusive');
    expect(r.failures).toEqual([]);
    expect(r.requestsMade).toBe(2);
  });

  it('stops at once on 429 or 403 without retrying', async () => {
    await scenario({ name: 'rate-limited' });
    const r = await runCanary(opts());
    await scenario({ reset: true, serverNowMs: Date.UTC(2026, 9, 6, 12) });
    expect(r.status).toBe('inconclusive');
    expect(r.requestsMade).toBe(1);
    expect(sleeps).toEqual([]);
  });

  it('a challenge page is inconclusive, not drift', async () => {
    const r = await runCanary(opts({ render: () => ({ status: 200, challenged: true, matched: {} }) }));
    expect(r.status).toBe('inconclusive');
    expect(r.failures).toEqual([]);
  });

  it('a 5xx on ItemDetail is inconclusive after one retry and does not fetch the page', async () => {
    await scenario({ errors: { 'ItemDetail/GetItemDetailModelByItemId': { status: 502 } } });
    const r = await runCanary(opts());
    await scenario({ reset: true, serverNowMs: Date.UTC(2026, 9, 6, 12) });
    expect(r.status).toBe('inconclusive');
    expect(r.failures).toEqual([]);
    expect(r.requestsMade).toBe(3);
    expect(pages).toHaveLength(0);
    expect(sleeps).toHaveLength(2);
    for (const s of sleeps) expect(s).toBeGreaterThanOrEqual(CANARY_MIN_SPACING_MS);
  });

  it('treats an HTML 200 as inconclusive, not drift', async () => {
    const r = await runCanary(opts({ fetchFn: htmlish(200, '<!DOCTYPE html><html><body>Down for maintenance</body></html>', 'text/html; charset=utf-8') }));
    expect(r.status).toBe('inconclusive');
    expect(r.failures).toEqual([]);
    expect(r.requestsMade).toBe(1);
    expect(pages).toHaveLength(0);
  });

  it('treats a non-JSON 200 as inconclusive, not drift', async () => {
    const r = await runCanary(opts({ fetchFn: htmlish(200, 'be right back', 'text/plain') }));
    expect(r.status).toBe('inconclusive');
    expect(r.failures).toEqual([]);
    expect(r.requestsMade).toBe(1);
  });

  it('treats 401 and 408 as inconclusive and does not retry them', async () => {
    for (const status of [401, 408]) {
      rmSync(path.join(dir, 'state.json'), { force: true });
      clock = T0;
      sleeps.length = 0;
      sent.length = 0;
      await scenario({ errors: { 'Search/ItemListing': { status } } });
      const r = await runCanary(opts());
      await scenario({ reset: true, serverNowMs: Date.UTC(2026, 9, 6, 12) });
      expect(r.status, String(status)).toBe('inconclusive');
      expect(r.failures, String(status)).toEqual([]);
      expect(r.requestsMade, String(status)).toBe(1);
      expect(sleeps, String(status)).toEqual([]);
    }
  });

  it('treats an item-page 401 as inconclusive, not drift', async () => {
    const r = await runCanary(opts({ render: () => ({ status: 401, challenged: false, matched: {} }) }));
    expect(r.status).toBe('inconclusive');
    expect(r.failures).toEqual([]);
  });

  it('keeps a schema mismatch on valid JSON as drift', async () => {
    const r = await runCanary(
      opts({
        fetchFn: mutating('ItemDetail', (j) => {
          j['titleX'] = j['title'];
          delete j['title'];
        }),
      }),
    );
    expect(r.status).toBe('drift');
    expect(r.failures.some((f) => f.check === 'itemDetail')).toBe(true);
    expect(r.inconclusive).toEqual([]);
  });

  it('still treats HTTP 400 as drift', async () => {
    await scenario({ errors: { 'Search/ItemListing': { status: 400 } } });
    const r = await runCanary(opts());
    await scenario({ reset: true, serverNowMs: Date.UTC(2026, 9, 6, 12) });
    expect(r.status).toBe('drift');
    expect(r.failures[0]?.path).toBe('http.status');
    expect(r.requestsMade).toBe(1);
  });

  it('sends the exact User-Agent and never sets Origin, Cookie, or Authorization', async () => {
    const prev = process.env['GITHUB_REPOSITORY'];
    // Honest about the real caps: 4 requests per run (with the retry) and the 12 h lock (2 runs a day).
    const ua = 'ShopBadwill-canary/1 (+https://github.com/example/shopbadwill; nightly read-only schema check, max 4 requests/run, max 2 runs/day)';
    const fallback = 'ShopBadwill-canary/1 (+https://github.com/; nightly read-only schema check, max 4 requests/run, max 2 runs/day)';
    try {
      process.env['GITHUB_REPOSITORY'] = 'example/shopbadwill';
      expect(honestUserAgent()).toBe(ua);
      // A header value must be a ByteString: a non-ASCII character such as U+2264 makes fetch throw.
      expect(honestUserAgent()).toMatch(/^[\x20-\x7E]+$/);
      delete process.env['GITHUB_REPOSITORY'];
      expect(honestUserAgent()).toBe(fallback);
    } finally {
      if (prev === undefined) delete process.env['GITHUB_REPOSITORY'];
      else process.env['GITHUB_REPOSITORY'] = prev;
    }

    const r = await runCanary(opts({ userAgent: ua }));
    expect(r.status).toBe('pass');
    const api = sent.filter((s) => s.headers['user-agent'] !== undefined);
    expect(api.length).toBeGreaterThanOrEqual(2);
    for (const s of sent) {
      expect(s.headers['origin']).toBeUndefined();
      expect(s.headers['cookie']).toBeUndefined();
      expect(s.headers['authorization']).toBeUndefined();
    }
    for (const s of api) expect(s.headers['user-agent']).toBe(ua);
  });
});

/** Fetch stub that records the call and answers with a fixed body (maintenance pages). */
function htmlish(status: number, body: string, contentType: string): CanaryOptions['fetchFn'] {
  return (input, init) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => {
      headers[k] = v;
    });
    sent.push({ realish: urlOf(input), method: init?.method ?? 'GET', at: clock, headers });
    clock += 500;
    return Promise.resolve(new Response(body, { status, headers: { 'content-type': contentType } }));
  };
}

describe('canary URL guard', () => {
  it('refuses search pages, account pages, writes and foreign hosts', () => {
    for (const [url, method] of [
      ['https://shopgoodwill.com/categories/listing?st=pyrex', 'GET'],
      ['https://shopgoodwill.com/categories/listing', 'GET'],
      ['https://shopgoodwill.com/shopgoodwill/mybids', 'GET'],
      ['https://shopgoodwill.com/checkout/cart', 'GET'],
      ['https://shopgoodwill.com/item/123?st=x', 'GET'],
      ['https://buyerapi.shopgoodwill.com/api/ItemBid/PlaceBid', 'POST'],
      ['https://buyerapi.shopgoodwill.com/api/SignIn/RefreshToken', 'POST'],
      ['https://example.com/item/1', 'GET'],
    ] as const) {
      expect(() => { assertAllowed(url, method); }, url).toThrow(/guard refused/);
    }
  });

  it('every request of a run maps to an allowed real-SGW URL', async () => {
    const seen: string[] = [];
    const o = opts();
    const api = o.apiBase;
    const inner = o.fetchFn;
    await runCanary({
      ...o,
      fetchFn: ((input: RequestInfo | URL, init?: RequestInit) => {
        seen.push(`${init?.method ?? 'GET'} https://buyerapi.shopgoodwill.com/api/${urlOf(input).slice(api.length)}`);
        return inner(input, init);
      }),
      renderItemPage: (url) => {
        seen.push(`GET ${url.replace(sgw.url, 'https://shopgoodwill.com')}`);
        return Promise.resolve(goodPage());
      },
    });
    expect(seen).toHaveLength(3);
    for (const line of seen) {
      const [method, url] = line.split(' ') as [string, string];
      expect(checkCaptureUrl(url, method).ok, line).toBe(true);
      expect(url).not.toMatch(/categories\/listing|\/shopgoodwill\//);
    }
  });
});

/**
 * Every step of the job, named or not. An unnamed step (`- uses: ...`, `- run: ...`) is keyed by
 * its first line, so a token added to `pnpm install` cannot hide from the GH_TOKEN test.
 */
function workflowSteps(yml: string): { name: string; body: string }[] {
  const steps: { name: string; body: string }[] = [];
  let current: { name: string; body: string } | null = null;
  let inSteps = false;
  for (const line of yml.split(/\r?\n/)) {
    if (/^ {4}steps:\s*$/.test(line)) {
      inSteps = true;
      continue;
    }
    if (!inSteps) continue;
    const start = /^ {6}- (.*)$/.exec(line);
    if (start) {
      if (current) steps.push(current);
      const first = start[1] ?? '';
      const named = /^name: (.*)$/.exec(first);
      current = { name: named ? (named[1] ?? '') : first, body: `${line}\n` };
      continue;
    }
    if (current) {
      const named = /^ {8}name: (.*)$/.exec(line);
      if (named) current.name = named[1] ?? current.name;
      current.body += `${line}\n`;
    }
  }
  if (current) steps.push(current);
  return steps;
}

/** The shell text of a step's `run:` (block or inline), or null when it has none. */
function runText(body: string): string | null {
  const lines = body.split('\n');
  const i = lines.findIndex((l) => /^ {6}(- | {2})run:/.test(l));
  if (i < 0) return null;
  const out = [(lines[i] ?? '').replace(/^.*?run:\s*/, '')];
  for (const l of lines.slice(i + 1)) {
    if (/^ {8}\S/.test(l) || /^ {6}- /.test(l)) break;
    out.push(l);
  }
  return out.join('\n');
}

describe('canary workflow and gitignore', () => {
  const yml = readFileSync(new URL('../../../.github/workflows/canary.yml', import.meta.url), 'utf8');
  const steps = workflowSteps(yml);

  it('finds the lock through the tested --find-state helper, and skips the canary when a restore does not yield state.json', () => {
    const find = steps.find((s) => s.name === 'Find previous canary state');
    // The artifact choice lives in selectStateRunId (unit-tested below); any gh or parse error fails the step.
    expect(runText(find?.body ?? '')?.trim()).toBe('pnpm exec tsx scripts/canary.ts --find-state');
    expect(find?.body).not.toContain('continue-on-error');
    expect(yml).toMatch(/\[ ! -f canary-state\/state\.json \]/);
    const run = steps.find((s) => s.name === 'Run canary');
    expect(run?.body).toContain("steps.gate.outputs.skip == 'false'");
  });

  it('sets GH_TOKEN only on the steps that call gh', () => {
    const beforeSteps = yml.split('\n    steps:')[0] ?? '';
    expect(beforeSteps).not.toContain('GH_TOKEN');
    // Unnamed steps (checkout, pnpm install, playwright install) are in the list too.
    expect(steps.some((s) => s.name.startsWith('run: pnpm install'))).toBe(true);
    const tokenSteps = steps.filter((s) => s.body.includes('GH_TOKEN')).map((s) => s.name);
    expect(tokenSteps.sort()).toEqual(['Find previous canary state', 'Open or update the drift issue']);
  });

  it('does not leave the token in .git/config for later steps (checkout persist-credentials: false)', () => {
    const checkout = steps.find((s) => s.name.startsWith('uses: actions/checkout@'));
    expect(checkout?.body).toMatch(/^ {10}persist-credentials: false$/m);
  });

  it('never interpolates ${{ }} into a run: script (values reach the shell through env only)', () => {
    const runs = steps.map((s) => ({ name: s.name, text: runText(s.body) })).filter((s) => s.text !== null);
    expect(runs.length).toBeGreaterThanOrEqual(5);
    for (const s of runs) expect(s.text, s.name).not.toContain('${{');
  });

  it('fails the job on any canary crash, even one after status was written, unless it is drift', () => {
    const crash = steps.find((s) => s.name === 'Fail the job if the canary crashed');
    expect(crash?.body).toContain("if: steps.canary.outcome == 'failure' && steps.canary.outputs.status != 'drift'");
  });

  it('gates the drift issue step on status drift and syncs through the canary script', () => {
    const issue = steps.find((s) => s.name === 'Open or update the drift issue');
    expect(issue?.body).toContain("steps.canary.outputs.status == 'drift'");
    expect(issue?.body).toContain('--sync-issue');
    const fail = steps.find((s) => s.name === 'Fail the job on drift');
    expect(fail?.body).toContain("steps.canary.outputs.status == 'drift'");
  });

  it('ignores canary-state and canary-out', () => {
    const text = readFileSync(new URL('../../../.gitignore', import.meta.url), 'utf8');
    expect(text).toMatch(/^canary-state\/$/m);
    expect(text).toMatch(/^canary-out\/$/m);
  });
});

function driftResult(checks: string[]): CanaryResult {
  return {
    status: 'drift',
    startedAt: '2026-10-10T09:17:00.000Z',
    requestsMade: checks.length,
    failures: checks.map((check) => ({ check, path: `${check}.field\n`, message: `broke @${check}\r\nnext` })),
    inconclusive: [],
  };
}

describe('canary message sanitizing and drift issue', () => {
  it('strips control characters and newlines and neuters mentions', () => {
    const raw = 'hello\nthere\r\n@shopbadwill\u0000\u0007\u007F done';
    const clean = sanitizeCanaryMessage(raw);
    expect(clean).toBe('hellothere@\u200Bshopbadwill done');
    for (const ch of clean) {
      const code = ch.codePointAt(0) ?? 0;
      expect(code).toBeGreaterThan(31);
      expect(code).not.toBe(127);
    }
  });

  it('sanitizes workflow annotations so a message cannot break the command or mention someone', () => {
    const lines = workflowAnnotations({
      failures: [{ check: 'search', path: 'a\nb', message: 'ping @maintainer\nmore' }],
      inconclusive: [{ check: 'itemDetail', path: '(network)', message: 'HTTP 503\r@ops' }],
    });
    expect(lines).toEqual([
      '::error::SGW drift: search ab: ping @\u200Bmaintainermore',
      '::warning::SGW canary inconclusive: itemDetail: HTTP 503@\u200Bops',
    ]);
    for (const line of lines) expect(line).not.toMatch(/[\r\n]/);
  });

  it('opens an issue only for drift', () => {
    expect(shouldOpenDriftIssue('drift')).toBe(true);
    expect(shouldOpenDriftIssue('pass')).toBe(false);
    expect(shouldOpenDriftIssue('inconclusive')).toBe(false);
    expect(shouldOpenDriftIssue('skipped')).toBe(false);
  });

  it('fingerprints the set of failing checks, ignoring order and repeats', () => {
    expect(failingCheckFingerprint([
      { check: 'itemPage' },
      { check: 'search' },
      { check: 'search' },
    ])).toBe('itemPage,search');
  });

  it('puts a sanitized body and a fingerprint comment in the issue', () => {
    const body = buildDriftIssueBody(driftResult(['itemDetail', 'search']), 'https://github.com/acme/shopbadwill/actions/runs/9');
    expect(body).toContain('<!-- canary-fingerprint:itemDetail,search -->');
    expect(body).toContain('@\u200BitemDetail');
    expect(body).toContain('@\u200Bsearch');
    expect(body).not.toContain('@itemDetail');
    expect(body).not.toContain('@search');
    const row = body.split('\n').find((line) => line.includes('itemDetail'));
    expect(row).toBe('| `itemDetail` | `itemDetail.field` | broke @\u200BitemDetailnext |');
  });

  it('does not comment when the set of failing checks is unchanged since the last comment', () => {
    const current = driftResult(['search']);
    const older = buildDriftIssueBody(driftResult(['itemPage']), 'https://example.test/1');
    const latest = buildDriftIssueBody(current, 'https://example.test/2');
    expect(decideDriftIssueAction({
      status: 'drift',
      failures: current.failures,
      existing: { body: older, comments: [{ body: 'thanks' }, { body: latest }] },
    })).toBe('silent');
  });

  it('comments when the set of failing checks changes, and creates when there is no issue', () => {
    const current = driftResult(['itemDetail', 'search']);
    const previous = buildDriftIssueBody(driftResult(['search']), 'https://example.test/1');
    expect(decideDriftIssueAction({
      status: 'drift',
      failures: current.failures,
      existing: { body: previous, comments: [] },
    })).toBe('comment');
    expect(decideDriftIssueAction({
      status: 'drift',
      failures: current.failures,
      existing: null,
    })).toBe('create');
    expect(decideDriftIssueAction({
      status: 'inconclusive',
      failures: [],
      existing: null,
    })).toBe('silent');
  });

  it('creates, comments, or stays quiet through the gh wrapper', () => {
    const bodyFile = path.join(dir, 'issue.md');
    const calls: string[][] = [];
    const gh = (args: readonly string[]): string => {
      calls.push([...args]);
      const cmd = args[1];
      if (cmd === 'list') return '[]';
      return '';
    };
    expect(syncDriftIssue({
      result: driftResult(['search']),
      runUrl: 'https://github.com/acme/shopbadwill/actions/runs/9',
      bodyFile,
      gh,
    })).toBe('created');
    expect(calls.some((c) => c[1] === 'create')).toBe(true);
    expect(readFileSync(bodyFile, 'utf8')).toContain('<!-- canary-fingerprint:search -->');
    expect(readFileSync(bodyFile, 'utf8')).toContain('@\u200Bsearch');

    calls.length = 0;
    const same = driftResult(['search']);
    const sameBody = buildDriftIssueBody(same, 'https://github.com/acme/shopbadwill/actions/runs/9');
    const quiet = (args: readonly string[]): string => {
      calls.push([...args]);
      if (args[1] === 'list') return JSON.stringify([{ number: 7, title: 'SGW drift detected' }]);
      if (args[1] === 'view') return JSON.stringify({ body: sameBody, comments: [] });
      return '';
    };
    expect(syncDriftIssue({ result: same, runUrl: 'https://github.com/acme/shopbadwill/actions/runs/10', bodyFile, gh: quiet })).toBe('unchanged');
    expect(calls.some((c) => c[1] === 'comment')).toBe(false);

    calls.length = 0;
    const changed = driftResult(['itemDetail']);
    const talk = (args: readonly string[]): string => {
      calls.push([...args]);
      if (args[1] === 'list') return JSON.stringify([{ number: 7, title: 'SGW drift detected' }, { number: 8, title: 'other' }]);
      if (args[1] === 'view') return JSON.stringify({ body: sameBody, comments: [{ body: 'note' }] });
      return '';
    };
    expect(syncDriftIssue({ result: changed, runUrl: 'https://github.com/acme/shopbadwill/actions/runs/11', bodyFile, gh: talk })).toBe('commented');
    expect(calls.some((c) => c[1] === 'comment' && c[2] === '7')).toBe(true);

    expect(syncDriftIssue({
      result: { ...same, status: 'inconclusive' },
      runUrl: 'https://example.test',
      bodyFile,
      gh: () => {
        throw new Error('gh must not be called');
      },
    })).toBe('not-drift');
  });
});

describe('Opus check+fix: fail closed, no SGW values in output', () => {
  it.each([
    ['garbage', 'not json {'],
    ['an empty file', ''],
    ['a wrong shape', '{}'],
    ['a non-number entry', JSON.stringify({ runs: ['x'], requests: [], lastRequestEndedAt: 0 })],
    ['a far-future run', JSON.stringify({ runs: [T0 + 30 * CANARY_DAY_MS], requests: [], lastRequestEndedAt: 0 })],
    ['a far-future spacing mark', JSON.stringify({ runs: [], requests: [], lastRequestEndedAt: T0 + 30 * CANARY_DAY_MS })],
  ])('treats a state file with %s as locked: no requests, and the lock reopens 12 h later', async (_label, text) => {
    const file = path.join(dir, 'state.json');
    writeFileSync(file, text);
    const r = await runCanary(opts());
    expect(r.status).toBe('skipped');
    expect(r.reason).toMatch(/state file unreadable/);
    expect(r.requestsMade).toBe(0);
    expect(sent).toEqual([]);
    expect(await serverLog()).toEqual([]);
    // Rewritten as a lock that started now, so it heals: the next run 12 h later proceeds.
    const reset = JSON.parse(readFileSync(file, 'utf8')) as { runs: number[] };
    expect(reset.runs).toEqual([T0]);
    clock = T0 + CANARY_RUN_INTERVAL_MS;
    const next = await runCanary(opts());
    expect(next.status).toBe('pass');
    expect(next.requestsMade).toBe(3);
  });

  it('force does not run on an unreadable lock', async () => {
    writeFileSync(path.join(dir, 'state.json'), 'not json {');
    const r = await runCanary(opts({ force: true }));
    expect(r.status).toBe('skipped');
    expect(r.requestsMade).toBe(0);
    expect(sent).toEqual([]);
  });

  it('a missing state file is still a first run', async () => {
    const r = await runCanary(opts());
    expect(r.status).toBe('pass');
    expect(r.requestsMade).toBe(3);
  });

  it('drops the raw SGW value from a normalizer failure but keeps the path', async () => {
    const r = await runCanary(
      opts({
        fetchFn: mutating('ItemDetail', (j) => {
          j['endTime'] = '9999-99-99T99:98:97';
        }),
      }),
    );
    expect(r.status).toBe('drift');
    const f = r.failures.find((x) => x.check === 'itemDetail');
    expect(f?.path).toBe('endTime');
    expect(f?.message).toMatch(/not a Pacific time/);
    expect(JSON.stringify(r)).not.toContain('9999-99-99');
    expect(JSON.stringify(r)).not.toContain('99:98:97');
    expect(buildDriftIssueBody(r, 'https://example.test/1')).not.toContain('9999-99-99');
  });

  it('keeps the row prefix on a search row failure', async () => {
    const r = await runCanary(
      opts({
        fetchFn: mutating('Search/ItemListing', (j) => {
          const sr = j['searchResults'] as { items: Record<string, unknown>[] };
          const row = sr.items[0];
          if (row) row['itemId'] = 'not-a-number';
        }),
      }),
    );
    expect(r.status).toBe('drift');
    expect(r.failures[0]).toMatchObject({ check: 'search', path: 'searchResults.items[0].itemId' });
    expect(r.failures[0]?.message).toContain('searchResults.items[0].itemId: Invalid input');
    expect(JSON.stringify(r)).not.toContain('not-a-number');
  });

  it('an SGW server-error marker on a 200 (null categoryListModel) is inconclusive, not drift', async () => {
    const r = await runCanary(
      opts({
        fetchFn: mutating('Search/ItemListing', (j) => {
          j['categoryListModel'] = null;
        }),
      }),
    );
    expect(r.status).toBe('inconclusive');
    expect(r.failures).toEqual([]);
    expect(r.requestsMade).toBe(1);
  });

  it('keeps the item URL (and so the item id) out of results and logs when the page render fails', async () => {
    const lines: string[] = [];
    const r = await runCanary(
      opts({
        log: (l) => {
          lines.push(l);
        },
        render: () => {
          throw new Error('page.goto: net::ERR_CONNECTION_RESET at https://shopgoodwill.com/item/987654321\nCall log:\n  - navigating to "https://shopgoodwill.com/item/987654321"');
        },
      }),
    );
    expect(r.status).toBe('inconclusive');
    const all = JSON.stringify(r) + lines.join('\n') + workflowAnnotations(r).join('\n');
    expect(all).not.toContain('987654321');
    expect(all).toContain('ERR_CONNECTION_RESET');
    for (const l of lines) expect(l).not.toMatch(/[\r\n]/);
  });

  it('escapes % in workflow commands and warns on a skipped run', () => {
    expect(workflowAnnotations({
      failures: [{ check: 'search', path: 'p', message: '100%0A::error::x' }],
      inconclusive: [],
    })).toEqual(['::error::SGW drift: search p: 100%250A::error::x']);
    expect(workflowAnnotations({
      status: 'skipped',
      reason: 'state file unreadable (not JSON); locked for 12 h',
      failures: [],
      inconclusive: [],
    })).toEqual(['::warning::SGW canary skipped: state file unreadable (not JSON); locked for 12 h']);
  });
});

describe('Opus check+fix: choosing the lock artifact', () => {
  const art = (id: number, created: string, expired = false, name = 'canary-state'): Record<string, unknown> => ({
    name,
    expired,
    created_at: created,
    workflow_run: { id, repository_id: 1, head_repository_id: 1 },
  });

  it('a successful empty list is a first run', () => {
    expect(selectStateRunId({ total_count: 0, artifacts: [] })).toBe('');
  });

  it('only expired artifacts are a first run (older than the lock, cannot be downloaded)', () => {
    expect(selectStateRunId({ artifacts: [art(5, '2026-10-01T09:00:00Z', true)] })).toBe('');
  });

  it('picks the newest unexpired artifact, whatever the list order', () => {
    expect(selectStateRunId({
      artifacts: [
        art(10, '2026-10-08T09:20:00Z'),
        art(12, '2026-10-09T09:20:00Z'),
        art(99, '2026-10-10T09:20:00Z', true),
        art(11, '2026-10-08T21:20:00Z'),
        art(77, '2026-10-10T10:00:00Z', false, 'something-else'),
      ],
    })).toBe('12');
  });

  it('ignores a canary-state artifact from a fork PR run (it could carry a forged lock)', () => {
    const fork = { ...art(50, '2026-10-10T09:00:00Z'), workflow_run: { id: 50, repository_id: 1, head_repository_id: 999 } };
    expect(selectStateRunId({ artifacts: [fork, art(12, '2026-10-09T09:20:00Z')] })).toBe('12');
    expect(selectStateRunId({ artifacts: [fork] })).toBe('');
  });

  it.each([
    ['no artifacts array', { message: 'Bad credentials' }],
    ['not an object', null],
    ['a live artifact without a run id', { artifacts: [{ name: 'canary-state', expired: false, created_at: '2026-10-09T09:20:00Z', workflow_run: null }] }],
    ['a non-integer run id', { artifacts: [{ name: 'canary-state', expired: false, created_at: '2026-10-09T09:20:00Z', workflow_run: { id: '1; rm -rf /' } }] }],
    ['a missing expired flag', { artifacts: [{ name: 'canary-state', created_at: '2026-10-09T09:20:00Z', workflow_run: { id: 3 } }] }],
    ['an unreadable created_at', { artifacts: [{ name: 'canary-state', expired: false, created_at: 'yesterday', workflow_run: { id: 4 } }] }],
  ])('fails closed on %s', (_label, raw) => {
    expect(() => selectStateRunId(raw)).toThrow(/canary/);
  });

  it('asks gh for the canary-state artifacts and lets a gh failure fail the step', () => {
    const calls: string[][] = [];
    const id = findPreviousStateRunId('acme/shopbadwill', (args) => {
      calls.push([...args]);
      return JSON.stringify({ artifacts: [art(42, '2026-10-09T09:20:00Z')] });
    });
    expect(id).toBe('42');
    expect(calls).toEqual([['api', 'repos/acme/shopbadwill/actions/artifacts?name=canary-state&per_page=100']]);
    const ghDown = (): string => {
      throw new Error('gh: HTTP 502');
    };
    expect(() => findPreviousStateRunId('acme/shopbadwill', ghDown)).toThrow(/502/);
    expect(() => findPreviousStateRunId('acme/shopbadwill', () => '<html>')).toThrow(/canary/);
    expect(() => findPreviousStateRunId('acme/x y', () => '{"artifacts":[]}')).toThrow(/canary/);
  });
});

describe('Opus check+fix: crash output', () => {
  it('prints one redacted message line plus stack frames, never a URL or a raw newline from the message', () => {
    const e = new Error('canary guard refused GET https://shopgoodwill.com/item/555666777: nope\n::error::injected');
    const lines = crashLines(e);
    expect(lines[0]).toMatch(/^canary: crashed: Error: canary guard refused GET <url>/);
    expect(lines.join('\n')).not.toContain('555666777');
    expect(lines.some((l) => l.startsWith('::'))).toBe(false);
    for (const l of lines.slice(1)) expect(l).toMatch(/^\s+at /);
  });
});
