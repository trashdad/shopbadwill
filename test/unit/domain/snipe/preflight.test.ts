import fc from 'fast-check';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_CAPS } from '../../../../src/domain/settings/defaults';
import {
  fallbackDecision,
  preflight,
  PREFLIGHT_EARLY_SLACK_MS,
  PREFLIGHT_LEAD_MS,
  SESSION_MARGIN_AFTER_END_MS,
  type FallbackInput,
  type PreflightContext,
  type PreflightResult,
} from '../../../../src/domain/snipe/preflight';
import { EffectSchema, type Effect, type Snipe, type SnipeState } from '../../../../src/domain/snipe/types';
import type { ItemDetail } from '../../../../src/domain/types';

const HOUR = 3_600_000;
const END = '2026-10-09T23:42:00.000Z'; // 7:42 PM ET, 4:42 PM PT
const END_MS = Date.UTC(2026, 9, 9, 23, 42);
const NOW = END_MS - 15 * 60_000; // T-15 min, written out (not the constant under test)
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
    writesAllowed: true,
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
  if (r.ok || r.reason === 'not-armed' || r.reason === 'not-due') throw new Error(`expected a preflight failure, got ${JSON.stringify(r)}`);
  return r;
}

const NO_CLOCK = { clockOffset: null };
const iso = (ms: number): string => new Date(ms).toISOString();

describe('constants (pinned)', () => {
  it('preflight runs 15 min before the end, with a 2 min early slack', () => {
    expect(PREFLIGHT_LEAD_MS).toBe(15 * 60_000);
    expect(PREFLIGHT_EARLY_SLACK_MS).toBe(2 * 60_000);
  });

  it('the session must outlive the auction end by 5 min', () => {
    expect(SESSION_MARGIN_AFTER_END_MS).toBe(5 * 60_000);
  });
});

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
    const token = { expiresAt: END_MS + 5 * 60_000 };
    expect(preflight(snipe(), ctx({ session: { state: 'expiring', token } })).ok).toBe(true);
  });

  it("'expiring' fails as auth when exp is before the auction end + 5 min", () => {
    const token = { expiresAt: END_MS + 5 * 60_000 - 1 };
    const r = failed(preflight(snipe(), ctx({ session: { state: 'expiring', token } })));
    expect(r.failures[0]).toMatchObject({ reason: 'auth', cause: 'expires-before-end' });
    expect(bids(r.effects)).toEqual([]);
    expect(r.fallback?.degradedBecause).toBe('auth');
  });

  it('the margin is measured from the later of the armed end and the fresh detail end', () => {
    const token = { expiresAt: END_MS + 5 * 60_000 };
    const later = iso(END_MS + 60_000);
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

// ── Fix round 1: time-based "ended" guard and "not due yet" ────────────────

describe('ended by time: never a fallback after the end', () => {
  it('preflight at end + 1 h with isClosed false: ended, no proxy', () => {
    const r = failed(preflight(snipe({ fallback: 'early-proxy' }), ctx({ now: END_MS + 60 * 60_000 })));
    expect(r.failures[0]).toMatchObject({ reason: 'ended', cause: 'past-end' });
    expect(r.reason).toBe('ended');
    expect(r.fallback).toBeNull();
    expect(bids(r.effects)).toEqual([]);
    expect(r.outcome).toBe('ended');
    expect(r.state).toBe('resolved');
  });

  it('at end + 1 h with a bad clock as well: still ended (no fallback), not clock', () => {
    const r = failed(preflight(snipe(), ctx({ now: END_MS + 60 * 60_000, clockOffset: null })));
    expect(r.failures.map((f) => f.reason)).toEqual(['ended', 'clock']);
    expect(r.fallback).toBeNull();
    expect(bids(r.effects)).toEqual([]);
  });

  it('at end + 1 h with the item unreadable: ended', () => {
    const r = failed(preflight(snipe(), ctx({ now: END_MS + 60 * 60_000, detail: null })));
    expect(r.failures[0]).toMatchObject({ reason: 'ended', cause: 'past-end' });
    expect(r.fallback).toBeNull();
  });

  it("a detail whose endTime is before its own serverTime: ended (SGW's clock), even with the local clock early", () => {
    const d = detail({ endTime: iso(NOW - 60_000), serverTime: iso(NOW) });
    const r = failed(preflight(snipe(), ctx({ detail: d })));
    expect(r.failures[0]).toMatchObject({ reason: 'ended', cause: 'server-past-end' });
    expect(r.fallback).toBeNull();
    expect(bids(r.effects)).toEqual([]);
  });

  it("serverTime exactly at the detail's endTime is ended", () => {
    const r = failed(preflight(snipe(), ctx({ detail: detail({ serverTime: END }) })));
    expect(r.failures[0]).toMatchObject({ reason: 'ended', cause: 'server-past-end' });
  });

  it('the local check uses server time when the clock offset is good: a local clock 60 s fast is not "ended"', () => {
    // Local reads end + 30 s; SGW's clock (local - 60 s) reads end - 30 s.
    const clockOffset = { offsetMs: -60_000, rttMs: 150, confidence: 'low' as const };
    const r = preflight(snipe(), ctx({ now: END_MS + 30_000, clockOffset }));
    expect(r.ok || r.reason !== 'ended').toBe(true);
  });

  it('one millisecond before the end (server time) is not ended', () => {
    const clockOffset = { offsetMs: 0, rttMs: 150, confidence: 'low' as const };
    const r = preflight(snipe(), ctx({ now: END_MS - 1, clockOffset }));
    expect(r.ok || r.reason !== 'ended').toBe(true);
  });
});

describe('not due yet: a preflight that runs early is a no-op', () => {
  it('a preflight run 3 days early: not-due, no effects', () => {
    const r = preflight(snipe(), ctx({ now: END_MS - 3 * 24 * HOUR, clockOffset: null }));
    expect(r).toMatchObject({ ok: false, reason: 'not-due', effects: [] });
  });

  it('due from end - 15 min - 2 min; one millisecond earlier is not due', () => {
    expect(preflight(snipe(), ctx({ now: END_MS - 17 * 60_000 })).ok).toBe(true);
    const early = preflight(snipe(), ctx({ now: END_MS - 17 * 60_000 - 1, clockOffset: null }));
    expect(early).toMatchObject({ ok: false, reason: 'not-due', effects: [] });
  });

  it('measured from the later of the armed end and the fresh detail end', () => {
    const d = detail({ endTime: iso(END_MS + 60 * 60_000) });
    expect(preflight(snipe(), ctx({ detail: d })).ok).toBe(false);
    expect(preflight(snipe(), ctx({ detail: d }))).toMatchObject({ reason: 'not-due', effects: [] });
  });
});

// ── R2: price ──────────────────────────────────────────────────────────────

/** A detail with `numBids` bids: the price, the increment, and SGW's own minimumBid set apart. */
const withBids = (currentPrice: number, bidIncrement: number) =>
  detail({ numBids: 3, currentPrice, bidIncrement, minimumBid: currentPrice + 1 });
const noBids = (minimumBid: number) =>
  detail({ numBids: 0, currentPrice: minimumBid, startingMinimumBid: minimumBid, minimumBid, bidHistory: [] });

describe('R2 (corrected): price fails only when the next acceptable bid is above maxBid', () => {
  it('no-bid item, max equal to the minimum bid: passes', () => {
    expect(preflight(snipe({ maxBid: 1000 }), ctx({ detail: noBids(1000) })).ok).toBe(true);
  });

  it('no-bid item, max one cent below the minimum bid: fails as price, no fallback', () => {
    const r = failed(preflight(snipe({ maxBid: 999 }), ctx({ detail: noBids(1000) })));
    expect(r.failures[0]).toMatchObject({ reason: 'price', cause: 'next-bid-above-max' });
    expect(r.fallback).toBeNull();
    expect(bids(r.effects)).toEqual([]);
  });

  it("no-bid item: the price source is the detail's minimumBid, not startingMinimumBid", () => {
    // startingMinimumBid below minimumBid: a max between them still fails.
    const lowStart = detail({ numBids: 0, currentPrice: 500, startingMinimumBid: 500, minimumBid: 1000 });
    expect(failed(preflight(snipe({ maxBid: 999 }), ctx({ detail: lowStart }))).failures[0]).toMatchObject({
      reason: 'price',
      cause: 'next-bid-above-max',
    });
    expect(preflight(snipe({ maxBid: 1000 }), ctx({ detail: lowStart })).ok).toBe(true);
    // startingMinimumBid above minimumBid: a max equal to minimumBid passes.
    const highStart = detail({ numBids: 0, currentPrice: 1500, startingMinimumBid: 1500, minimumBid: 1000 });
    expect(preflight(snipe({ maxBid: 1000 }), ctx({ detail: highStart })).ok).toBe(true);
  });

  it('with bids, current price equal to max: next acceptable is current + one increment, above max, so it fails', () => {
    const r = failed(preflight(snipe({ maxBid: 1000 }), ctx({ detail: withBids(1000, 100) })));
    expect(r.failures[0]).toMatchObject({ reason: 'price', cause: 'next-bid-above-max' });
    expect(r.detail).toMatch(/next acceptable bid \$11\.00 is above your max \$10\.00/);
    expect(r.reason).toBe('price');
    expect(r.fallback).toBeNull();
    expect(bids(r.effects)).toEqual([]);
    expect(r.outcome).toBe('skipped');
    expect(r.state).toBe('resolved');
  });

  it('next acceptable bid exactly equal to max: passes', () => {
    expect(preflight(snipe({ maxBid: 1250 }), ctx({ detail: withBids(1000, 250) })).ok).toBe(true);
  });

  it('the increment comes from the detail (nextAcceptable), not a re-implemented table', () => {
    const r = failed(preflight(snipe({ maxBid: 1249 }), ctx({ detail: withBids(1000, 250) })));
    expect(r.failures[0]).toMatchObject({ reason: 'price', cause: 'next-bid-above-max' });
  });

  it('current price above max fails as price', () => {
    const r = failed(preflight(snipe({ maxBid: 999 }), ctx({ detail: withBids(1000, 100) })));
    expect(r.failures[0]).toMatchObject({ reason: 'price', cause: 'next-bid-above-max' });
  });

  it('price wins over fallback-applying failures: still no fallback', () => {
    const r = failed(
      preflight(snipe({ maxBid: 1000 }), ctx({ detail: withBids(1500, 100), clockOffset: null, keepAwake: 'not-held' })),
    );
    expect(r.reason).toBe('price');
    expect(r.failures.map((f) => f.reason)).toEqual(['price', 'clock', 'keep-awake']);
    expect(r.fallback).toBeNull();
    expect(bids(r.effects)).toEqual([]);
  });

  /** Next acceptable bid `next` with or without bids, and an increment. */
  const priced = (next: number, hasBids: boolean, inc: number): ItemDetail =>
    hasBids && next >= inc ? withBids(next - inc, inc) : noBids(next);

  it('property: next acceptable > max never yields a bid effect, whatever else fails', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 100_000 }),
        fc.integer({ min: 1, max: 100_000 }),
        fc.integer({ min: 1, max: 10_000 }),
        fc.boolean(),
        fc.boolean(),
        fc.constantFrom<Snipe['fallback']>('early-proxy', 'skip'),
        (max, over, inc, hasBids, clockBad, fallback) => {
          const r = failed(
            preflight(
              snipe({ maxBid: max, fallback }),
              ctx({ detail: priced(max + over, hasBids, inc), clockOffset: clockBad ? null : ctx().clockOffset }),
            ),
          );
          expect(r.reason).toBe('price');
          expect(r.fallback).toBeNull();
          expect(bids(r.effects)).toEqual([]);
        },
      ),
    );
  });

  it('property: next acceptable <= max never fails the price check', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 5000 }),
        fc.integer({ min: 0, max: 5000 }),
        fc.integer({ min: 1, max: 1000 }),
        fc.boolean(),
        (max, under, inc, hasBids) => {
          const next = Math.max(0, max - under);
          const r = preflight(snipe({ maxBid: max }), ctx({ detail: priced(next, hasBids, inc) }));
          expect(r.ok || r.reason !== 'price').toBe(true);
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
          preflight(snipe({ maxBid: max }), ctx({ clockOffset: null, detail: noBids(1) })),
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
  /** Every guard open: an early proxy is allowed. */
  const open = (over: Partial<FallbackInput> = {}): FallbackInput => ({
    reason: 'clock',
    detail: 'x.',
    caps: OK,
    sessionUsable: true,
    writesAllowed: true,
    ...over,
  });

  it('early-proxy with a usable session, writes allowed and passing caps places exactly maxBid', () => {
    const d = fallbackDecision(snipe({ maxBid: 4321 }), open());
    expect(d?.effects.map((e) => e.kind)).toEqual(['applyFallbackProxy', 'audit']);
    expect(d && proxies(d.effects)).toEqual([{ kind: 'applyFallbackProxy', snipeId: 's1', amount: 4321 }]);
    expect(d).toMatchObject({ state: 'fallback-applied', outcome: 'fallback-proxy-placed', applied: 'early-proxy' });
  });

  it('sessionUsable false never bids', () => {
    const d = fallbackDecision(snipe(), open({ sessionUsable: false }));
    expect(d).toMatchObject({ applied: 'skip', degradedBecause: 'auth', outcome: 'skipped' });
    expect(d && bids(d.effects)).toEqual([]);
  });

  it('writesAllowed false (kill switch, health, bidding gate) never bids', () => {
    const d = fallbackDecision(snipe(), open({ writesAllowed: false }));
    expect(d).toMatchObject({ applied: 'skip', degradedBecause: 'writes-blocked', outcome: 'skipped' });
    expect(d?.detail).toMatch(/bidding is blocked/);
    expect(d && bids(d.effects)).toEqual([]);
  });

  it("reason 'auth' never bids, even if the caller says the session is usable", () => {
    const d = fallbackDecision(snipe(), open({ reason: 'auth' }));
    expect(d).toMatchObject({ applied: 'skip', degradedBecause: 'auth', outcome: 'skipped' });
    expect(d && bids(d.effects)).toEqual([]);
  });

  it('failing caps never bid', () => {
    const d = fallbackDecision(snipe(), open({ reason: 'network', caps: { ok: false, violations: ['per-day: y'] } }));
    expect(d).toMatchObject({ applied: 'skip', degradedBecause: 'cap', outcome: 'skipped' });
    expect(d?.detail).toMatch(/per-day: y/);
    expect(d && bids(d.effects)).toEqual([]);
  });

  it('property: an early proxy only when every guard is open', () => {
    fc.assert(
      fc.property(
        fc.constantFrom<FallbackInput['reason']>('auth', 'clock', 'keep-awake', 'cap', 'network', 'anomaly'),
        fc.boolean(),
        fc.boolean(),
        fc.boolean(),
        (reason, sessionUsable, writesAllowed, capsOk) => {
          const caps = capsOk ? OK : { ok: false, violations: ['exposure: z'] };
          const d = fallbackDecision(snipe(), open({ reason, sessionUsable, writesAllowed, caps }));
          const allowed = reason !== 'auth' && sessionUsable && writesAllowed && capsOk;
          expect(d && proxies(d.effects).length).toBe(allowed ? 1 : 0);
        },
      ),
    );
  });

  it('reason is a closed union, not free text', () => {
    // @ts-expect-error -- 'whatever' is not a FallbackReason
    expect(fallbackDecision(snipe(), open({ reason: 'whatever' }))).not.toBeNull();
  });

  it.each(['armed', 'waking', 'verified'] as const)('applies in the pre-fire state %s', (state) => {
    expect(fallbackDecision(snipe({ state }), open())).not.toBeNull();
  });

  it.each(['draft', 'fallback-applied', 'firing', 'sent', 'resolved', 'killed'] as const)(
    'returns null in state %s (a bid may already be out, or the snipe is gone)',
    (state: SnipeState) => {
      expect(fallbackDecision(snipe({ state }), open())).toBeNull();
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

  it('bidding writes blocked (writesAllowed false): early-proxy degrades to skip', () => {
    const r = failed(preflight(snipe(), ctx({ clockOffset: null, writesAllowed: false })));
    expect(r.reason).toBe('clock');
    expect(r.fallback).toMatchObject({ applied: 'skip', degradedBecause: 'writes-blocked' });
    expect(bids(r.effects)).toEqual([]);
  });

  it('writesAllowed false alone does not fail preflight (dry runs run with bidding blocked)', () => {
    expect(preflight(snipe({ dryRun: true }), ctx({ writesAllowed: false })).ok).toBe(true);
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
          fallback: fc.constantFrom<Snipe['fallback']>('early-proxy', 'skip'),
          dryRun: fc.boolean(),
          maxBid: fc.integer({ min: 0, max: 30_000 }),
          price: fc.integer({ min: 0, max: 30_000 }),
          session: fc.constantFrom('ok', 'expiring', 'expired', 'logged-out' as const),
          token: fc.boolean(),
          clockBad: fc.boolean(),
          keepAwake: fc.constantFrom('held', 'not-held', 'not-required' as const),
          readable: fc.boolean(),
          hasBids: fc.boolean(),
          inc: fc.integer({ min: 1, max: 1000 }),
          spent: fc.integer({ min: 0, max: 20_000 }),
          writesAllowed: fc.boolean(),
          late: fc.boolean(),
        }),
        (p) => {
          const s = snipe({ fallback: p.fallback, dryRun: p.dryRun, maxBid: p.maxBid });
          const d = p.readable ? (p.hasBids ? withBids(p.price, p.inc) : noBids(p.price)) : null;
          const nextBid = p.hasBids ? p.price + p.inc : p.price;
          const r = preflight(
            s,
            ctx({
              session: { state: p.session, token: p.token ? { expiresAt: END_MS + 20 * 24 * HOUR } : null },
              clockOffset: p.clockBad ? null : ctx().clockOffset,
              keepAwake: p.keepAwake,
              writesAllowed: p.writesAllowed,
              detail: d,
              caps: { limits: DEFAULT_CAPS, others: [], spentToday: p.spent },
              ...(p.late ? { now: END_MS + 60_000 } : {}),
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
            expect(nextBid).toBeLessThanOrEqual(p.maxBid);
            expect(p.maxBid).toBeLessThanOrEqual(DEFAULT_CAPS.perItemMax);
            expect(p.writesAllowed).toBe(true);
            expect(p.late).toBe(false);
          }
        },
      ),
    );
  });
});
