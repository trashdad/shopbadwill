// T-60: the canary against the fake SGW server only. No live network, no real sleeping, no browser.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  assertAllowed,
  CANARY_MIN_SPACING_MS,
  CANARY_RUN_INTERVAL_MS,
  ITEM_PAGE_CHECK_KEYS,
  runCanary,
  type CanaryOptions,
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
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'canary-'));
  clock = T0;
  void fetch(`${sgw.url}/__log`, { method: 'DELETE' });
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

  it('refuses to run twice within 12 h, even with a restart, and runs again after 12 h', async () => {
    const o = opts();
    expect((await runCanary(o)).status).toBe('pass');
    const before = sent.length;
    clock += 60 * 60 * 1000;
    const again = await runCanary(o);
    expect(again.status).toBe('skipped');
    expect(again.reason).toMatch(/locked/);
    expect(sent.length).toBe(before);

    clock = T0 + CANARY_RUN_INTERVAL_MS + 1000;
    const next = await runCanary(o);
    // 12 h later the lock is open, but the 24 h budget (3 used + 3 needed > 4) still refuses.
    expect(next.status).toBe('skipped');
    expect(next.reason).toMatch(/daily budget/);

    clock = T0 + 24 * 60 * 60 * 1000 + 10 * 60 * 1000;
    expect((await runCanary(o)).status).toBe('pass');
  });

  it('force bypasses the 12 h lock but not the daily budget', async () => {
    await runCanary(opts());
    clock += 60 * 60 * 1000;
    const forced = await runCanary(opts({ force: true }));
    expect(forced.status).toBe('skipped');
    expect(forced.reason).toMatch(/daily budget/);
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
});

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
