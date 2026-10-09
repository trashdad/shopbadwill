import fc from 'fast-check';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_CAPS } from '../../../../src/domain/settings/defaults';
import {
  fallbackDecision,
  preflight,
  PREFLIGHT_LEAD_MS,
  SESSION_MARGIN_AFTER_END_MS,
  type PreflightContext,
  type PreflightResult,
} from '../../../../src/domain/snipe/preflight';
import { EffectSchema, type Effect, type Snipe, type SnipeState } from '../../../../src/domain/snipe/types';
import type { ItemDetail } from '../../../../src/domain/types';

const HOUR = 3_600_000;
const END = '2026-10-09T23:42:00.000Z'; // 7:42 PM ET, 4:42 PM PT
const END_MS = Date.UTC(2026, 9, 9, 23, 42);
const NOW = END_MS - PREFLIGHT_LEAD_MS;
const TZ = 'America/New_York';

function snipe(over: Partial<Snipe> = {}): Snipe {
  return {
    id: 's1',
    itemId: 279250057,
    title: 'Pyrex bowl',
    endTime: END,
    endTimeAtArm: END,
    maxBid: 2000,
    leadMs: 8000,
    fallback: 'early-proxy',
    dryRun: false,
    state: 'armed',
    armedAt: NOW - 24 * HOUR,
    attempt: {},
    history: [],
    ...over,
  };
}

function detail(over: Partial<ItemDetail> = {}): ItemDetail {
  return {
    itemId: 279250057,
    title: 'Pyrex bowl',
    currentPrice: 1000,
    startingMinimumBid: 500,
    numBids: 3,
    endTime: END,
    endTimeRaw: '2026-10-09T16:42:00',
    sellerId: 1,
    pickupOnly: false,
    source: 'api',
    observedAt: NOW,
    minimumBid: 1100,
    bidIncrement: 100,
    serverTime: '2026-10-09T23:27:00.000Z',
    serverTimeRaw: '2026-10-09T16:27:00',
    isClosed: false,
    isHighBidder: false,
    inWatchlist: null,
    bidHistory: [],
    ...over,
  };
}

function ctx(over: Partial<PreflightContext> = {}): PreflightContext {
  return {
    now: NOW,
    timeZone: TZ,
    session: { state: 'ok', token: { expiresAt: END_MS + 20 * 24 * HOUR } },
    clockOffset: { offsetMs: 1300, rttMs: 150, confidence: 'low' },
    keepAwake: 'not-required',
    detail: detail(),
    caps: { limits: { ...DEFAULT_CAPS }, others: [], spentToday: 0 },
    ...over,
  };
}

const kinds = (effects: readonly Effect[]): string[] => effects.map((e) => e.kind);
const proxies = (effects: readonly Effect[]) =>
  effects.filter((e): e is Extract<Effect, { kind: 'applyFallbackProxy' }> => e.kind === 'applyFallbackProxy');
const bids = (effects: readonly Effect[]) =>
  effects.filter((e) => e.kind === 'applyFallbackProxy' || e.kind === 'placeBid');

/** Narrow to the failure variant that carries a fallback decision. */
function failed(r: PreflightResult) {
  if (r.ok || r.reason === 'not-armed') throw new Error(`expected a preflight failure, got ${JSON.stringify(r)}`);
  return r;
}

const NO_CLOCK = { clockOffset: null };

afterEach(() => {
  vi.restoreAllMocks();
});

// ── Tests first (task card) ────────────────────────────────────────────────

describe('preflight: the task card tests', () => {
  it("a failure with fallback 'early-proxy' produces an applyFallbackProxy effect", () => {
    const r = failed(preflight(snipe({ fallback: 'early-proxy' }), ctx(NO_CLOCK)));
    expect(r.reason).toBe('clock');
    expect(proxies(r.effects)).toEqual([{ kind: 'applyFallbackProxy', snipeId: 's1', amount: 2000 }]);
    expect(r.fallback?.applied).toBe('early-proxy');
    expect(r.state).toBe('fallback-applied');
    expect(r.outcome).toBe('fallback-proxy-placed');
    expect(kinds(r.effects)).not.toContain('placeBid');
  });

  it('dry run: the early proxy is an audit entry only (no bid effect)', () => {
    const r = failed(preflight(snipe({ fallback: 'early-proxy', dryRun: true }), ctx(NO_CLOCK)));
    expect(bids(r.effects)).toEqual([]);
    expect(r.fallback?.effects.map((e) => e.kind)).toEqual(['audit']);
    const audit = r.fallback?.effects[0];
    expect(audit?.kind === 'audit' && audit.entry).toMatchObject({
      actor: 'snipe',
      kind: 'snipe.fallback',
      dryRun: true,
      details: { requested: 'early-proxy', applied: 'early-proxy', amount: 2000 },
    });
    expect(r.outcome).toBe('dry-run');
    expect(r.state).toBe('resolved');
    expect(r.detail).toMatch(/would have placed your max \$20\.00/);
  });

  it("fallback 'skip' produces outcome 'skipped'", () => {
    const r = failed(preflight(snipe({ fallback: 'skip' }), ctx(NO_CLOCK)));
    expect(r.outcome).toBe('skipped');
    expect(r.state).toBe('resolved');
    expect(r.fallback?.applied).toBe('skip');
    expect(bids(r.effects)).toEqual([]);
  });

  it("fallback 'skip' in a dry run is also 'skipped'", () => {
    const r = failed(preflight(snipe({ fallback: 'skip', dryRun: true }), ctx(NO_CLOCK)));
    expect(r.outcome).toBe('skipped');
    expect(bids(r.effects)).toEqual([]);
  });

  it('passes when every check passes: audit and notify only, no bid', () => {
    const r = preflight(snipe(), ctx());
    expect(r.ok).toBe(true);
    expect(kinds(r.effects)).toEqual(['audit', 'notify']);
    if (!r.ok) return;
    expect(r.warnings).toEqual([]);
  });
});

// ── R1: session ────────────────────────────────────────────────────────────

describe('R1: session at T-15', () => {
  it.each(['expired', 'logged-out'] as const)("'%s' fails as auth and a 'skip' fallback gives 'skipped'", (state) => {
    const r = failed(preflight(snipe({ fallback: 'skip' }), ctx({ session: { state, token: null } })));
    expect(r.reason).toBe('auth');
    expect(r.failures[0]).toMatchObject({ reason: 'auth', cause: state });
    expect(r.fallback?.applied).toBe('skip');
    expect(r.outcome).toBe('skipped');
    expect(bids(r.effects)).toEqual([]);
  });

  it.each(['expired', 'logged-out'] as const)(
    "'%s' with 'early-proxy' degrades to skip with a clear reason: never a bid with a rejected session",
    (state) => {
      // Even when the token record is still held and unexpired.
      const token = { expiresAt: END_MS + 20 * 24 * HOUR };
      const r = failed(preflight(snipe({ fallback: 'early-proxy' }), ctx({ session: { state, token } })));
      expect(r.reason).toBe('auth');
      expect(bids(r.effects)).toEqual([]);
      expect(r.fallback).toMatchObject({ requested: 'early-proxy', applied: 'skip', degradedBecause: 'auth' });
      expect(r.outcome).toBe('skipped');
      expect(r.state).toBe('resolved');
      expect(r.detail).toMatch(/needs a valid ShopGoodwill session/);
    },
  );

  it('no saved token fails as auth', () => {
    const r = failed(preflight(snipe(), ctx({ session: { state: 'ok', token: null } })));
    expect(r.failures[0]).toMatchObject({ reason: 'auth', cause: 'no-token' });
    expect(bids(r.effects)).toEqual([]);
  });

  it("'expiring' passes when exp is at least the auction end + 5 min", () => {
    const token = { expiresAt: END_MS + SESSION_MARGIN_AFTER_END_MS };
    expect(preflight(snipe(), ctx({ session: { state: 'expiring', token } })).ok).toBe(true);
  });

  it("'expiring' fails as auth when exp is before the auction end + 5 min", () => {
    const token = { expiresAt: END_MS + SESSION_MARGIN_AFTER_END_MS - 1 };
    const r = failed(preflight(snipe(), ctx({ session: { state: 'expiring', token } })));
    expect(r.failures[0]).toMatchObject({ reason: 'auth', cause: 'expires-before-end' });
    expect(bids(r.effects)).toEqual([]);
    expect(r.fallback?.degradedBecause).toBe('auth');
  });

  it('the margin is measured from the later of the armed end and the fresh detail end', () => {
    const token = { expiresAt: END_MS + SESSION_MARGIN_AFTER_END_MS };
    const later = new Date(END_MS + 60_000).toISOString();
    const r = failed(
      preflight(snipe(), ctx({ session: { state: 'expiring', token }, detail: detail({ endTime: later }) })),
    );
    expect(r.failures[0]?.cause).toBe('expires-before-end');
  });

  it('auth plus another failure: auth decides, so early-proxy still never bids', () => {
    const r = failed(
      preflight(snipe(), ctx({ session: { state: 'expired', token: null }, clockOffset: null, keepAwake: 'not-held' })),
    );
    expect(r.failures.map((f) => f.reason)).toEqual(['auth', 'clock', 'keep-awake']);
    expect(bids(r.effects)).toEqual([]);
  });
});

// ── R2: price ──────────────────────────────────────────────────────────────

describe('R2: price check (integer cents)', () => {
  it('currentPrice equal to maxBid fails as price and does NOT apply the fallback', () => {
    // minimumBid == currentPrice (a no-bid item): R2 alone decides, as the controller ruled.
    const d = detail({ currentPrice: 1000, minimumBid: 1000, numBids: 0 });
    const r = failed(preflight(snipe({ maxBid: 1000 }), ctx({ detail: d })));
    expect(r.failures[0]).toMatchObject({ reason: 'price', cause: 'at-or-above-max' });
    expect(r.reason).toBe('price');
    expect(r.fallback).toBeNull();
    expect(bids(r.effects)).toEqual([]);
    expect(r.outcome).toBe('skipped');
    expect(r.state).toBe('resolved');
  });

  it('currentPrice above maxBid fails as price', () => {
    const r = failed(preflight(snipe({ maxBid: 999 }), ctx({ detail: detail({ currentPrice: 1000 }) })));
    expect(r.failures[0]).toMatchObject({ reason: 'price', cause: 'at-or-above-max' });
    expect(r.fallback).toBeNull();
  });

  it('one cent below maxBid passes', () => {
    const r = preflight(snipe({ maxBid: 1001 }), ctx({ detail: detail({ currentPrice: 1000, minimumBid: 1001 }) }));
    expect(r.ok).toBe(true);
  });

  it('a next acceptable bid above maxBid is also nothing to win', () => {
    const r = failed(preflight(snipe({ maxBid: 1050 }), ctx({ detail: detail({ currentPrice: 1000, minimumBid: 1100 }) })));
    expect(r.failures[0]).toMatchObject({ reason: 'price', cause: 'minimum-above-max' });
    expect(r.fallback).toBeNull();
  });

  it('price wins over fallback-applying failures: still no fallback', () => {
    const r = failed(
      preflight(
        snipe({ maxBid: 1000 }),
        ctx({ detail: detail({ currentPrice: 1500 }), clockOffset: null, keepAwake: 'not-held' }),
      ),
    );
    expect(r.reason).toBe('price');
    expect(r.failures.map((f) => f.reason)).toEqual(['price', 'clock', 'keep-awake']);
    expect(r.fallback).toBeNull();
    expect(bids(r.effects)).toEqual([]);
  });

  it('property: price >= max never yields a bid effect, whatever else fails', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 100_000 }),
        fc.integer({ min: 0, max: 100_000 }),
        fc.boolean(),
        fc.constantFrom('early-proxy', 'skip' as const),
        (max, extra, clockBad, fallback) => {
          const r = failed(
            preflight(
              snipe({ maxBid: max, fallback }),
              ctx({ detail: detail({ currentPrice: max + extra, minimumBid: max + extra }), clockOffset: clockBad ? null : ctx().clockOffset }),
            ),
          );
          expect(r.reason).toBe('price');
          expect(r.fallback).toBeNull();
          expect(bids(r.effects)).toEqual([]);
        },
      ),
    );
  });

  it('a closed auction is ended: no fallback', () => {
    const r = failed(preflight(snipe(), ctx({ detail: detail({ isClosed: true }), clockOffset: null })));
    expect(r.reason).toBe('ended');
    expect(r.outcome).toBe('ended');
    expect(r.fallback).toBeNull();
    expect(bids(r.effects)).toEqual([]);
  });
});

// ── R3: clock ──────────────────────────────────────────────────────────────

describe('R3: clock check through assessClock', () => {
  it.each([
    ['no-offset', null],
    ['no-offset', { offsetMs: 0, rttMs: 100, samples: 0, confidence: 'none' as const }],
    ['bad-rtt', { offsetMs: 0, rttMs: 2001, samples: 3, confidence: 'high' as const }],
    ['clock-skew', { offsetMs: 300_001, rttMs: 100, samples: 3, confidence: 'high' as const }],
    ['clock-skew', { offsetMs: -300_001, rttMs: 100, samples: 3, confidence: 'high' as const }],
  ])('%s fails as clock and applies the fallback', (cause, clockOffset) => {
    const r = failed(preflight(snipe({ fallback: 'early-proxy' }), ctx({ clockOffset })));
    expect(r.reason).toBe('clock');
    expect(r.failures[0]).toMatchObject({ reason: 'clock', cause });
    expect(r.fallback?.applied).toBe('early-proxy');
    expect(proxies(r.effects)).toHaveLength(1);
  });

  it('the edges assessClock allows pass (rtt 2 s, offset exactly 5 min)', () => {
    const clockOffset = { offsetMs: 300_000, rttMs: 2000, samples: 1, confidence: 'low' as const };
    expect(preflight(snipe(), ctx({ clockOffset })).ok).toBe(true);
  });
});

// ── R4: early-proxy amount and caps ────────────────────────────────────────

describe('R4: the early proxy amount is exactly maxBid and must pass the caps', () => {
  it('property: applyFallbackProxy.amount === Snipe.maxBid', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 5000 }), (max) => {
        const r = failed(
          preflight(snipe({ maxBid: max }), ctx({ clockOffset: null, detail: detail({ currentPrice: 0, minimumBid: 0 }) })),
        );
        expect(proxies(r.effects)).toEqual([{ kind: 'applyFallbackProxy', snipeId: 's1', amount: max }]);
      }),
    );
  });

  it('a cap that blocks maxBid fails preflight as cap and degrades early-proxy to skip', () => {
    const limits = { ...DEFAULT_CAPS, perItemMax: 1999 };
    const r = failed(preflight(snipe({ maxBid: 2000 }), ctx({ caps: { limits, others: [], spentToday: 0 } })));
    expect(r.reason).toBe('cap');
    expect(r.failures[0]?.cause).toBe('per-item');
    expect(r.fallback).toMatchObject({ requested: 'early-proxy', applied: 'skip', degradedBecause: 'cap' });
    expect(r.outcome).toBe('skipped');
    expect(bids(r.effects)).toEqual([]);
  });

  it('another failure plus a cap violation: the cap still blocks the early proxy', () => {
    const r = failed(
      preflight(snipe({ maxBid: 2000 }), ctx({ clockOffset: null, caps: { limits: DEFAULT_CAPS, others: [], spentToday: 9000 } })),
    );
    expect(r.failures.map((f) => f.reason)).toEqual(['clock', 'cap']);
    expect(r.fallback?.degradedBecause).toBe('cap');
    expect(bids(r.effects)).toEqual([]);
  });

  it('an unreadable item cannot get an early proxy: the caps check fails closed without detail', () => {
    const r = failed(preflight(snipe(), ctx({ detail: null, clockOffset: null })));
    expect(r.reason).toBe('clock');
    expect(r.fallback?.degradedBecause).toBe('cap');
    expect(bids(r.effects)).toEqual([]);
  });

  it('exposure from other open snipes counts', () => {
    const other = snipe({ id: 's2', itemId: 2, maxBid: 19_000 });
    const r = failed(preflight(snipe(), ctx({ caps: { limits: DEFAULT_CAPS, others: [other], spentToday: 0 } })));
    expect(r.failures[0]).toMatchObject({ reason: 'cap', cause: 'exposure' });
  });
});

describe('fallbackDecision (the only fallback rule; T-80 calls it too)', () => {
  const OK = { ok: true, violations: [] };

  it('early-proxy with a usable session and passing caps places exactly maxBid', () => {
    const d = fallbackDecision(snipe({ maxBid: 4321 }), { reason: 'clock', detail: 'x.', caps: OK });
    expect(d?.effects.map((e) => e.kind)).toEqual(['applyFallbackProxy', 'audit']);
    expect(d && proxies(d.effects)).toEqual([{ kind: 'applyFallbackProxy', snipeId: 's1', amount: 4321 }]);
    expect(d).toMatchObject({ state: 'fallback-applied', outcome: 'fallback-proxy-placed', applied: 'early-proxy' });
  });

  it("reason 'auth' never bids, even with passing caps", () => {
    const d = fallbackDecision(snipe(), { reason: 'auth', detail: 'x.', caps: OK });
    expect(d).toMatchObject({ applied: 'skip', degradedBecause: 'auth', outcome: 'skipped' });
    expect(d && bids(d.effects)).toEqual([]);
  });

  it('failing caps never bid', () => {
    const d = fallbackDecision(snipe(), { reason: 'network', detail: 'x.', caps: { ok: false, violations: ['per-day: y'] } });
    expect(d).toMatchObject({ applied: 'skip', degradedBecause: 'cap', outcome: 'skipped' });
    expect(d?.detail).toMatch(/per-day: y/);
    expect(d && bids(d.effects)).toEqual([]);
  });

  it.each(['armed', 'waking', 'verified'] as const)('applies in the pre-fire state %s', (state) => {
    expect(fallbackDecision(snipe({ state }), { reason: 'clock', detail: 'x.', caps: OK })).not.toBeNull();
  });

  it.each(['draft', 'fallback-applied', 'firing', 'sent', 'resolved', 'killed'] as const)(
    'returns null in state %s (a bid may already be out, or the snipe is gone)',
    (state: SnipeState) => {
      expect(fallbackDecision(snipe({ state }), { reason: 'clock', detail: 'x.', caps: OK })).toBeNull();
    },
  );
});

// ── Other checks ───────────────────────────────────────────────────────────

describe('other preflight checks', () => {
  it('keep-awake not held fails and applies the fallback', () => {
    const r = failed(preflight(snipe(), ctx({ keepAwake: 'not-held' })));
    expect(r.failures[0]).toMatchObject({ reason: 'keep-awake', cause: 'not-held' });
    expect(proxies(r.effects)).toHaveLength(1);
  });

  it.each(['held', 'not-required'] as const)('keep-awake %s passes', (keepAwake) => {
    expect(preflight(snipe(), ctx({ keepAwake })).ok).toBe(true);
  });

  it('an unreadable item alone passes with a warning (T-60 re-checks price and caps)', () => {
    const r = preflight(snipe(), ctx({ detail: null }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.warnings).toHaveLength(1);
    expect(bids(r.effects)).toEqual([]);
  });

  it('a detail for another item is treated as unreadable', () => {
    const r = preflight(snipe(), ctx({ detail: detail({ itemId: 1, currentPrice: 99_999 }) }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.warnings).toHaveLength(1);
  });

  it.each(['draft', 'waking', 'fallback-applied', 'sent', 'resolved', 'killed'] as const)(
    'a snipe in state %s is not preflighted: no effects at all',
    (state) => {
      const r = preflight(snipe({ state }), ctx({ clockOffset: null }));
      expect(r).toMatchObject({ ok: false, reason: 'not-armed', effects: [] });
    },
  );

  it('failure effects: audit the preflight, then the fallback, then one notification', () => {
    const r = failed(preflight(snipe(), ctx(NO_CLOCK)));
    expect(kinds(r.effects)).toEqual(['audit', 'applyFallbackProxy', 'audit', 'notify']);
    const n = r.effects.at(-1);
    expect(n?.kind === 'notify' && n.title).toBe('Early bid: Pyrex bowl');
  });

  it('the success notification names the max and both end times', () => {
    const r = preflight(snipe(), ctx());
    const n = r.effects.find((e) => e.kind === 'notify');
    expect(n?.kind === 'notify' && n.message).toMatch(/\$20\.00/);
    expect(n?.kind === 'notify' && n.message).toMatch(/4:42 PM PT · 7:42 PM ET/);
  });
});

// ── R6: determinism ────────────────────────────────────────────────────────

function deepFreeze<T>(v: T): T {
  if (v !== null && typeof v === 'object') {
    for (const k of Object.keys(v)) deepFreeze((v as Record<string, unknown>)[k]);
    Object.freeze(v);
  }
  return v;
}

describe('R6: preflight is pure and deterministic', () => {
  const cases: [string, Partial<Snipe>, Partial<PreflightContext>][] = [
    ['pass', {}, {}],
    ['clock + early-proxy', {}, NO_CLOCK],
    ['auth + skip', { fallback: 'skip' }, { session: { state: 'expired', token: null } }],
    ['price', { maxBid: 900 }, {}],
    ['dry run', { dryRun: true }, NO_CLOCK],
  ];

  it.each(cases)('%s: same inputs give equal results, inputs untouched, no clock reads', (_name, s, c) => {
    const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => {
      throw new Error('preflight read the clock');
    });
    const a = preflight(deepFreeze(snipe(s)), deepFreeze(ctx(c)));
    const b = preflight(snipe(s), ctx(c));
    expect(a).toEqual(b);
    expect(nowSpy).not.toHaveBeenCalled();
  });

  it('every effect it emits is a valid frozen Effect', () => {
    for (const [, s, c] of cases) {
      for (const e of preflight(snipe(s), ctx(c)).effects) expect(() => EffectSchema.parse(e)).not.toThrow();
    }
  });

  it('property: never placeBid; at most one applyFallbackProxy, only when every guard allows it', () => {
    fc.assert(
      fc.property(
        fc.record({
          fallback: fc.constantFrom('early-proxy', 'skip' as const),
          dryRun: fc.boolean(),
          maxBid: fc.integer({ min: 0, max: 30_000 }),
          price: fc.integer({ min: 0, max: 30_000 }),
          session: fc.constantFrom('ok', 'expiring', 'expired', 'logged-out' as const),
          token: fc.boolean(),
          clockBad: fc.boolean(),
          keepAwake: fc.constantFrom('held', 'not-held', 'not-required' as const),
          readable: fc.boolean(),
          spent: fc.integer({ min: 0, max: 20_000 }),
        }),
        (p) => {
          const s = snipe({ fallback: p.fallback, dryRun: p.dryRun, maxBid: p.maxBid });
          const d = p.readable ? detail({ currentPrice: p.price, minimumBid: p.price }) : null;
          const r = preflight(
            s,
            ctx({
              session: { state: p.session, token: p.token ? { expiresAt: END_MS + 20 * 24 * HOUR } : null },
              clockOffset: p.clockBad ? null : ctx().clockOffset,
              keepAwake: p.keepAwake,
              detail: d,
              caps: { limits: DEFAULT_CAPS, others: [], spentToday: p.spent },
            }),
          );
          expect(kinds(r.effects)).not.toContain('placeBid');
          const placed = proxies(r.effects);
          expect(placed.length).toBeLessThanOrEqual(1);
          if (placed.length === 1) {
            expect(placed[0]?.amount).toBe(p.maxBid);
            expect(p.fallback).toBe('early-proxy');
            expect(p.dryRun).toBe(false);
            expect(p.session === 'ok' || p.session === 'expiring').toBe(true);
            expect(p.token).toBe(true);
            expect(d).not.toBeNull();
            expect(p.price).toBeLessThan(p.maxBid);
            expect(p.maxBid).toBeLessThanOrEqual(DEFAULT_CAPS.perItemMax);
          }
        },
      ),
    );
  });
});
