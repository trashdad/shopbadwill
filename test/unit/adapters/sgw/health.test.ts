// T-30: SgwHealth. Fakes only (FakeSgwApi as the request spy, FakeClock,
// FakeStorage, FakeAuditLog); no network.
// Rulings: R1 shipping-quote format probe, R2 unknown never fails the report,
// R3 recovery audit, R4 at most 2 requests and 0 under 6 h, R5 no live network.
import { describe, expect, it } from 'vitest';

import { SGW_CONFIG_VERSION } from '../../../../src/adapters/sgw/config';
import { isUnknownCheck, SgwHealthAdapter, UNKNOWN_PREFIX } from '../../../../src/adapters/sgw/health';
import { Repo } from '../../../../src/domain/storage/repo';
import { STORAGE_KEYS } from '../../../../src/domain/storage/schema';
import type { ItemDetail, Listing, SgwSessionState } from '../../../../src/domain/types';
import { FakeAuditLog } from '../../../fakes/ports/fake-audit-log';
import { FakeClock } from '../../../fakes/ports/fake-clock';
import { FakeSgwApi } from '../../../fakes/ports/fake-sgw-api';
import { FakeStorage } from '../../../fakes/ports/fake-storage';

const T0 = Date.UTC(2026, 9, 9, 12, 0, 0);
const H = 3_600_000;
const MIN = 60_000;

const listing: Listing = {
  itemId: 111,
  title: 'Lamp',
  currentPrice: 500,
  startingMinimumBid: 100,
  numBids: 1,
  endTime: '2026-10-10T12:00:00.000Z',
  endTimeRaw: '2026-10-10T05:00:00',
  sellerId: 7,
  source: 'api',
  observedAt: T0,
};
const detail: ItemDetail = {
  ...listing,
  pickupOnly: false,
  minimumBid: 600,
  bidIncrement: 100,
  serverTime: '2026-10-09T12:00:00.000Z',
  serverTimeRaw: '2026-10-09T05:00:00',
  isClosed: false,
  isHighBidder: null,
  inWatchlist: null,
  bidHistory: [],
};

interface Opts {
  offsetMs?: number | null;
  session?: SgwSessionState;
  dom?: { drifted: boolean; rank?: number | null; count?: number } | null;
  shipping?: unknown;
}

function setup(o: Opts = {}) {
  const clock = new FakeClock(T0);
  const repo = new Repo({ local: new FakeStorage(), session: new FakeStorage() }, clock);
  const api = new FakeSgwApi({ clock });
  api.listings = [listing];
  api.details.set(111, detail);
  const audit = new FakeAuditLog(clock);
  const state = {
    offsetMs: o.offsetMs === undefined ? 12 : o.offsetMs,
    session: o.session ?? 'ok',
    dom: o.dom === undefined ? { drifted: false } : o.dom,
    shipping: o.shipping,
  };
  const build = (): SgwHealthAdapter =>
    new SgwHealthAdapter({
      repo,
      clock,
      api,
      audit,
      sgwClock: {
        offset: () =>
          state.offsetMs === null
            ? null
            : {
                offsetMs: state.offsetMs,
                rttMs: 50,
                samples: 3,
                confidence: 'high',
              },
      },
      session: { state: () => Promise.resolve(state.session) },
      domReport: () =>
        Promise.resolve(
          state.dom === null
            ? null
            : {
                configVersion: SGW_CONFIG_VERSION,
                rank: state.dom.rank ?? 0,
                strategy: 'x',
                count: state.dom.count ?? 40,
                unreadable: 0,
                drifted: state.dom.drifted,
              },
        ),
      shippingReply: () => Promise.resolve(state.shipping),
    });
  const health = build();
  const requests = () => api.calls.length;
  return { clock, repo, api, audit, health, state, requests, build };
}

type Checked = {
  checks: Array<{ name: string; ok: boolean; detail?: string }>;
};
function must<T>(v: T | undefined | null): T {
  if (v === undefined || v === null) throw new Error('expected a value');
  return v;
}
const named = (r: Checked, n: string) => r.checks.find((c) => c.name === n);

describe('SgwHealth.run', () => {
  it('anonymous: all good makes one search + one detail on the background lane and stores the report', async () => {
    const t = setup();
    const r = await t.health.run('anonymous');
    expect(r.ok).toBe(true);
    expect(r.configVersion).toBe(SGW_CONFIG_VERSION);
    expect(r.checkedAt).toBe(T0);
    expect(r.checks.map((c) => c.name)).toEqual(['search-schema', 'detail-schema', 'card-selectors', 'clock']);
    expect(t.api.calls.map((c) => [c.method, c.args[1]])).toEqual([
      ['search', 'background'],
      ['itemDetail', 'background'],
    ]);
    expect(await t.health.last()).toEqual(r);
    expect(await t.repo.find(STORAGE_KEYS.runtimeHealth)).toEqual(r);
  });

  it('schema drift: ok:false with the failing check named', async () => {
    const t = setup();
    t.api.failNext('search', 'schema');
    const r = await t.health.run('anonymous');
    expect(r.ok).toBe(false);
    expect(named(r, 'search-schema')?.ok).toBe(false);
    expect(named(r, 'detail-schema')).toBeDefined();
    expect(named(r, 'clock')?.ok).toBe(true);
  });

  it('detail schema drift is named too', async () => {
    const t = setup();
    t.api.failNext('itemDetail', 'schema');
    const r = await t.health.run('anonymous');
    expect(r.ok).toBe(false);
    expect(named(r, 'detail-schema')?.ok).toBe(false);
    expect(named(r, 'search-schema')?.ok).toBe(true);
  });

  it('passes again after a good report (recovery re-probes once the throttle passes)', async () => {
    const t = setup();
    t.api.failNext('search', 'schema');
    expect((await t.health.run('anonymous')).ok).toBe(false);
    t.clock.advance(11 * MIN);
    const r = await t.health.run('anonymous');
    expect(r.ok).toBe(true);
    expect(t.audit.kinds).toEqual(['health.fail', 'health.recovered']);
  });

  it('uses the cache: no new requests when a good report under 6 h exists', async () => {
    const t = setup();
    await t.health.run('anonymous');
    expect(t.requests()).toBe(2);
    t.clock.advance(5 * H);
    const r = await t.health.run('anonymous');
    expect(t.requests()).toBe(2);
    expect(r.ok).toBe(true);
    t.clock.advance(1 * H + MIN);
    await t.health.run('anonymous');
    expect(t.requests()).toBe(4);
  });

  it('a failing report is not re-probed more often than every 10 min', async () => {
    const t = setup();
    t.api.failNext('search', 'schema');
    await t.health.run('anonymous');
    const n = t.requests();
    t.clock.advance(5 * MIN);
    const r = await t.health.run('anonymous');
    expect(t.requests()).toBe(n);
    expect(r.ok).toBe(false);
  });

  it('never more than 2 requests per run', async () => {
    const t = setup();
    t.clock.advance(7 * H);
    await t.health.run('full');
    expect(t.requests()).toBeLessThanOrEqual(2);
  });

  it('R2: scheduler paused or over budget gives unknown, not fail and not a clean ok', async () => {
    const t = setup();
    t.api.failNext('search', 'paused');
    t.api.failNext('itemDetail', 'budget');
    const r = await t.health.run('anonymous');
    expect(r.ok).toBe(true);
    const s = named(r, 'search-schema');
    const d = named(r, 'detail-schema');
    expect(isUnknownCheck(must(s))).toBe(true);
    expect(isUnknownCheck(must(d))).toBe(true);
    expect(s?.detail?.startsWith(UNKNOWN_PREFIX)).toBe(true);
    // unknown is retried on the next run (it is not cached as good)
    const before = t.requests();
    t.clock.advance(11 * MIN);
    const r2 = await t.health.run('anonymous');
    expect(t.requests()).toBe(before + 2);
    expect(isUnknownCheck(must(named(r2, 'search-schema')))).toBe(false);
  });

  it('R2: network errors are unknown; an empty search leaves detail unknown at a cost of one request', async () => {
    const t = setup();
    t.api.listings = [];
    const r = await t.health.run('anonymous');
    expect(t.requests()).toBe(1);
    expect(isUnknownCheck(must(named(r, 'detail-schema')))).toBe(true);
    expect(r.ok).toBe(true);
    const u = setup();
    u.api.failNext('search', 'network');
    expect(isUnknownCheck(must(named(await u.health.run('anonymous'), 'search-schema')))).toBe(true);
  });

  it('card selectors: drift or zero cards is unknown and never fails the report; no report is unknown', async () => {
    const drift = setup({ dom: { drifted: true, rank: 2 } });
    const r = await drift.health.run('anonymous');
    expect(r.ok).toBe(true);
    expect(isUnknownCheck(must(named(r, 'card-selectors')))).toBe(true);
    expect(named(r, 'card-selectors')?.detail).toContain('drift');
    const empty = await setup({ dom: { drifted: false, count: 0 } }).health.run('anonymous');
    expect(empty.ok).toBe(true);
    expect(isUnknownCheck(must(named(empty, 'card-selectors')))).toBe(true);
    const none = setup({ dom: null });
    const r2 = await none.health.run('anonymous');
    expect(r2.ok).toBe(true);
    expect(isUnknownCheck(must(named(r2, 'card-selectors')))).toBe(true);
  });

  it('clock: |offset| over 5 min fails, exactly 5 min passes, no samples is unknown', async () => {
    expect(named(await setup({ offsetMs: 300_001 }).health.run('anonymous'), 'clock')?.ok).toBe(false);
    expect((await setup({ offsetMs: -300_001 }).health.run('anonymous')).ok).toBe(false);
    expect(named(await setup({ offsetMs: 300_000 }).health.run('anonymous'), 'clock')?.ok).toBe(true);
    const r = await setup({ offsetMs: null }).health.run('anonymous');
    expect(r.ok).toBe(true);
    expect(isUnknownCheck(must(named(r, 'clock')))).toBe(true);
  });

  it('session: only in full mode; expired and logged-out fail', async () => {
    const anon = await setup({ session: 'expired' }).health.run('anonymous');
    expect(named(anon, 'session')).toBeUndefined();
    expect(anon.ok).toBe(true);
    for (const s of ['expired', 'logged-out'] as const) {
      const r = await setup({ session: s }).health.run('full');
      expect(r.ok).toBe(false);
      expect(named(r, 'session')?.ok).toBe(false);
    }
    for (const s of ['ok', 'expiring'] as const) {
      const r = await setup({ session: s }).health.run('full');
      expect(r.ok).toBe(true);
      expect(named(r, 'session')?.ok).toBe(true);
    }
  });

  it('full mode re-reads the session even when the schema checks are cached', async () => {
    const t = setup();
    await t.health.run('anonymous');
    t.state.session = 'expired';
    const r = await t.health.run('full');
    expect(t.requests()).toBe(2);
    expect(r.ok).toBe(false);
  });

  it('R1: a cached shipping reply is format-checked without any request', async () => {
    const t = setup({
      shipping: '<div>Shipping: $5.00<br>Handling: $1.00<br>Total Shipping and Handling: $6.00</div>',
    });
    const r = await t.health.run('anonymous');
    expect(named(r, 'detail-schema')?.ok).toBe(true);
    expect(t.api.calls.some((c) => c.method === 'shippingQuote')).toBe(false);

    const bad = setup({ shipping: 'Postage is now free!' });
    const rb = await bad.health.run('anonymous');
    expect(rb.ok).toBe(false);
    expect(named(rb, 'detail-schema')?.ok).toBe(false);
    expect(named(rb, 'detail-schema')?.detail).toContain('shipping-quote');
  });
});

describe('persistence and probe query', () => {
  it('a failing report survives a restart: a fresh adapter over the same storage returns it from last()', async () => {
    const t = setup({ offsetMs: 999_999 });
    const r = await t.health.run('anonymous');
    expect(r.ok).toBe(false);
    const restarted = new SgwHealthAdapter({
      repo: t.repo,
      clock: t.clock,
      api: t.api,
      audit: t.audit,
      sgwClock: { offset: () => null },
      session: { state: () => Promise.resolve('ok') },
      domReport: () => Promise.resolve(null),
    });
    expect(await restarted.last()).toEqual(r);
    expect(await t.repo.find(STORAGE_KEYS.healthReport)).toEqual(r);
  });

  it('the one search uses the fixed known-good query', async () => {
    const t = setup();
    await t.health.run('anonymous');
    expect(t.api.calls[0]?.args[0]).toEqual({
      searchText: 'pyrex',
      categoryIds: [],
      sellerIds: [],
      page: 1,
    });
  });
});

describe('audit transitions', () => {
  it('health.fail only on ok -> fail, not on every failing run; health.recovered on fail -> ok', async () => {
    const t = setup({ offsetMs: 999_999 });
    await t.health.run('anonymous');
    await t.health.run('anonymous');
    expect(t.audit.kinds).toEqual(['health.fail']);
    expect(t.audit.entries[0]?.actor).toBe('health');
    t.state.offsetMs = 5;
    await t.health.run('anonymous');
    expect(t.audit.kinds).toEqual(['health.fail', 'health.recovered']);
    await t.health.run('anonymous');
    expect(t.audit.kinds).toHaveLength(2);
  });

  it('a throwing audit sink does not break run()', async () => {
    const t = setup();
    const h = new SgwHealthAdapter({
      repo: t.repo,
      clock: t.clock,
      api: t.api,
      audit: { append: () => Promise.reject(new Error('boom')) },
      sgwClock: {
        offset: () => ({
          offsetMs: 999_999,
          rttMs: 1,
          samples: 1,
          confidence: 'high',
        }),
      },
      session: { state: () => Promise.resolve('ok') },
      domReport: () => Promise.resolve(null),
    });
    expect((await h.run('anonymous')).ok).toBe(false);
  });
});

describe('recordSchemaFailure (the T-36 hook)', () => {
  it('writes a failing report naming the endpoint, audits once, and keeps run() from re-probing for 10 min', async () => {
    const t = setup();
    await t.health.run('anonymous');
    t.clock.advance(MIN);
    await t.health.recordSchemaFailure({
      endpoint: 'search',
      message: 'bad rows',
      at: t.clock.now(),
    });
    const last = await t.health.last();
    expect(last?.ok).toBe(false);
    expect(named(must(last), 'search-schema')?.ok).toBe(false);
    expect(named(must(last), 'search-schema')?.detail).toContain('bad rows');
    expect(named(must(last), 'clock')).toBeDefined();
    expect(t.audit.kinds).toEqual(['health.fail']);
    await t.health.recordSchemaFailure({
      endpoint: 'search',
      message: 'again',
      at: t.clock.now(),
    });
    expect(t.audit.kinds).toEqual(['health.fail']);
    const n = t.requests();
    await t.health.run('anonymous');
    expect(t.requests()).toBe(n);
  });

  it('works with no earlier report; other endpoints land on detail-schema; flagSchemaFailure never throws', async () => {
    const t = setup();
    await t.health.recordSchemaFailure({
      endpoint: 'favorites',
      message: 'x',
      at: T0,
    });
    const last = await t.health.last();
    expect(last?.ok).toBe(false);
    expect(named(must(last), 'detail-schema')?.detail).toContain('favorites');
    expect(() => {
      t.health.flagSchemaFailure({ endpoint: 'search', message: 'y', at: T0 });
    }).not.toThrow();
  });
});

describe('fix round 1', () => {
  const H24 = 24 * H;

  it('probe age survives a restart: a fresh adapter reuses a good probe under 6 h and re-probes (2 requests) after 7 h', async () => {
    const t = setup();
    await t.health.run('anonymous');
    t.clock.advance(5 * H);
    await t.health.run('anonymous'); // cache hit refreshes checkedAt but must not refresh probedAt
    expect(t.requests()).toBe(2);
    t.clock.advance(2 * H);
    const restarted = t.build();
    await restarted.run('anonymous');
    expect(t.requests()).toBe(4);
    expect((await t.repo.find(STORAGE_KEYS.healthProbe))?.probedAt).toBe(t.clock.now());
  });

  it('a failing report in a fresh adapter re-probes after 10 min, not before', async () => {
    const t = setup();
    t.api.failNext('search', 'schema');
    await t.health.run('anonymous');
    const n = t.requests();
    t.clock.advance(5 * MIN);
    await t.build().run('anonymous');
    expect(t.requests()).toBe(n);
    t.clock.advance(6 * MIN);
    const r = await t.build().run('anonymous');
    expect(t.requests()).toBe(n + 2);
    expect(r.ok).toBe(true);
  });

  it('sticky: a favorites failure stays failing through good search/detail probes until recordSchemaSuccess(favorites)', async () => {
    const t = setup();
    await t.health.run('anonymous');
    await t.health.recordSchemaFailure({
      endpoint: 'favorites',
      message: 'rows changed',
      at: t.clock.now(),
    });
    t.clock.advance(7 * H);
    const r = await t.health.run('full');
    expect(t.requests()).toBe(4);
    expect(r.ok).toBe(false);
    expect(named(r, 'detail-schema')?.ok).toBe(false);
    expect(named(r, 'detail-schema')?.detail).toContain('favorites');
    expect(named(r, 'search-schema')?.ok).toBe(true);
    await t.health.recordSchemaSuccess('search'); // a different endpoint clears nothing
    expect((await t.health.last())?.ok).toBe(false);
    await t.health.recordSchemaSuccess('favorites');
    const after = await t.health.last();
    expect(after?.ok).toBe(true);
    expect((await t.repo.find(STORAGE_KEYS.healthProbe))?.sticky).toEqual([]);
    expect(t.audit.kinds).toContain('health.recovered');
  });

  it('sticky search failure is cleared by a full run that probes search successfully, not by an anonymous one', async () => {
    const t = setup();
    await t.health.recordSchemaFailure({
      endpoint: 'search',
      message: 'bad',
      at: T0,
    });
    t.clock.advance(11 * MIN);
    expect((await t.health.run('anonymous')).ok).toBe(false);
    t.clock.advance(11 * MIN);
    const r = await t.health.run('full');
    expect(r.ok).toBe(true);
  });

  it('a sticky favorites failure is never cleared by a full probe of search and detail', async () => {
    const t = setup();
    await t.health.recordSchemaFailure({
      endpoint: 'favorites',
      message: 'bad',
      at: T0,
    });
    t.clock.advance(11 * MIN);
    expect((await t.health.run('full')).ok).toBe(false);
  });

  it('recordSchemaFailure with no earlier report fills the other checks as unknown and costs no request', async () => {
    const t = setup();
    await t.health.recordSchemaFailure({
      endpoint: 'search',
      message: 'bad',
      at: T0,
    });
    const last = must(await t.health.last());
    expect(last.ok).toBe(false);
    expect(isUnknownCheck(must(named(last, 'detail-schema')))).toBe(true);
    expect(named(last, 'search-schema')?.ok).toBe(false);
    await t.health.run('anonymous');
    expect(t.requests()).toBe(0);
  });

  it('escalation: a schema check with no good probe in over 24 h fails as stale; not before', async () => {
    const t = setup();
    await t.health.run('anonymous');
    t.clock.advance(H24 - H);
    t.api.failNext('search', 'paused');
    t.api.failNext('itemDetail', 'paused');
    const early = await t.health.run('anonymous');
    expect(early.ok).toBe(true);
    t.clock.advance(2 * H);
    t.api.failNext('search', 'paused');
    t.api.failNext('itemDetail', 'paused');
    const late = await t.health.run('anonymous');
    expect(late.ok).toBe(false);
    expect(named(late, 'search-schema')?.detail).toContain('stale: no successful probe in 24h');
    expect(named(late, 'detail-schema')?.ok).toBe(false);
  });

  it('empty search, unknown clock and unknown cards are never escalated to stale', async () => {
    const t = setup({ offsetMs: null, dom: null });
    t.api.listings = [];
    await t.health.run('anonymous');
    t.clock.advance(3 * H24);
    const r = await t.health.run('anonymous');
    expect(r.ok).toBe(true);
  });

  it('concurrent run() calls make at most 2 requests in total', async () => {
    const t = setup();
    await Promise.all([t.health.run('anonymous'), t.health.run('anonymous')]);
    expect(t.requests()).toBe(2);
  });

  it('a throwing shippingReply is ignored', async () => {
    const t = setup();
    const h = new SgwHealthAdapter({
      repo: t.repo,
      clock: t.clock,
      api: t.api,
      audit: t.audit,
      sgwClock: { offset: () => null },
      session: { state: () => Promise.resolve('ok') },
      domReport: () => Promise.resolve(null),
      shippingReply: () => Promise.reject(new Error('storage down')),
    });
    expect((await h.run('anonymous')).ok).toBe(true);
  });

  it('a shipping failure combined with a real detail failure keeps both, and the real one survives a throttled rerun', async () => {
    const t = setup({ shipping: 'Postage is now free!' });
    t.api.failNext('itemDetail', 'schema');
    const r = await t.health.run('anonymous');
    const d = must(named(r, 'detail-schema'));
    expect(d.ok).toBe(false);
    expect(d.detail).toContain('schema:');
    expect(d.detail).toContain('shipping-quote');
    t.clock.advance(MIN);
    const again = must(named(await t.health.run('anonymous'), 'detail-schema'));
    expect(again.ok).toBe(false);
    expect(again.detail).toContain('schema:');
    expect(again.detail?.match(/shipping-quote/g)).toHaveLength(1);
    t.state.shipping = undefined;
    t.clock.advance(11 * MIN);
    expect((await t.health.run('anonymous')).ok).toBe(true);
  });
});

describe('fix round 2', () => {
  it('a schema check that was never good escalates to stale once firstSeenAt is over 24 h old', async () => {
    const t = setup();
    t.api.failNext('search', 'paused');
    t.api.failNext('itemDetail', 'paused');
    const first = await t.health.run('anonymous');
    expect(first.ok).toBe(true);
    expect((await t.repo.find(STORAGE_KEYS.healthProbe))?.firstSeenAt).toBe(T0);
    t.clock.advance(23 * H);
    t.api.listings = [];
    t.api.failNext('search', 'paused');
    expect((await t.build().run('anonymous')).ok).toBe(true);
    expect((await t.repo.find(STORAGE_KEYS.healthProbe))?.firstSeenAt).toBe(T0);
    t.clock.advance(2 * H);
    t.api.failNext('search', 'paused');
    const late = await t.build().run('anonymous');
    expect(late.ok).toBe(false);
    expect(named(late, 'search-schema')?.detail).toContain('stale: no successful probe in 24h');
  });

  it('firstSeenAt is also set by recordSchemaFailure', async () => {
    const t = setup();
    await t.health.recordSchemaFailure({ endpoint: 'favorites', message: 'x', at: T0 });
    expect((await t.repo.find(STORAGE_KEYS.healthProbe))?.firstSeenAt).toBe(T0);
  });

  it('with two sticky endpoints, recordSchemaSuccess clears only the one named', async () => {
    const t = setup();
    await t.health.run('anonymous');
    await t.health.recordSchemaFailure({ endpoint: 'favorites', message: 'a', at: t.clock.now() });
    await t.health.recordSchemaFailure({ endpoint: 'showBidModal', message: 'b', at: t.clock.now() });
    await t.health.recordSchemaSuccess('favorites');
    const mid = must(await t.health.last());
    expect(mid.ok).toBe(false);
    expect(named(mid, 'detail-schema')?.detail).toContain('showBidModal');
    expect(named(mid, 'detail-schema')?.detail).not.toContain('favorites');
    expect((await t.repo.find(STORAGE_KEYS.healthProbe))?.sticky.map((x) => x.endpoint)).toEqual(['showBidModal']);
    await t.health.recordSchemaSuccess('showBidModal');
    expect(must(await t.health.last()).ok).toBe(true);
  });
});
