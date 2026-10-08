import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { DEFAULT_CAPS } from '../../../../src/domain/settings/defaults';
import { checkCaps, exposure, localDayKey, spentToday, typoCheck } from '../../../../src/domain/snipe/caps';
import type { CheckCaps, Snipe } from '../../../../src/domain/snipe/types';
import type { ItemDetail } from '../../../../src/domain/types';

const CAPS = { ...DEFAULT_CAPS };
const TZ = 'America/New_York';

function snipe(over: Partial<Snipe> = {}): Snipe {
  return {
    id: 's1',
    itemId: 1,
    title: 't',
    endTime: '2026-10-08T20:00:00.000Z',
    endTimeAtArm: '2026-10-08T20:00:00.000Z',
    maxBid: 1000,
    leadMs: 8000,
    fallback: 'skip',
    dryRun: false,
    state: 'armed',
    armedAt: 0,
    attempt: {},
    history: [],
    ...over,
  };
}

function detail(over: Partial<ItemDetail> = {}): ItemDetail {
  return {
    itemId: 1,
    title: 't',
    currentPrice: 1000,
    startingMinimumBid: 100,
    numBids: 3,
    endTime: '2026-10-08T20:00:00.000Z',
    endTimeRaw: '2026-10-08T13:00:00',
    sellerId: 1,
    pickupOnly: false,
    source: 'api',
    observedAt: 0,
    minimumBid: 1100,
    bidIncrement: 100,
    serverTime: '2026-10-08T19:00:00.000Z',
    serverTimeRaw: '2026-10-08T12:00:00',
    isClosed: false,
    isHighBidder: null,
    inWatchlist: null,
    bidHistory: [],
    ...over,
  };
}

// Compile-time check: checkCaps is assignable to the frozen CheckCaps type.
const asContract: CheckCaps = checkCaps;

const has = (r: { violations: string[] }, kind: string): boolean => r.violations.some((v) => v.startsWith(kind));

describe('checkCaps', () => {
  it('passes a small bid with nothing else going on', () => {
    expect(asContract(snipe(), [], 0, CAPS)).toEqual({
      ok: true,
      violations: [],
    });
  });

  it('per-item cap: exactly at the cap passes, one cent over fails', () => {
    const caps = { ...CAPS, typoAbsolute: 100000 };
    expect(checkCaps(snipe({ maxBid: 5000 }), [], 0, caps).ok).toBe(true);
    const r = checkCaps(snipe({ maxBid: 5001 }), [], 0, caps);
    expect(r.ok).toBe(false);
    expect(has(r, 'per-item')).toBe(true);
  });

  it('per-item cap uses detail.minimumBid (next acceptable bid), not the search starting minimum', () => {
    const caps = { ...CAPS, typoAbsolute: 100000 };
    const s = snipe({ maxBid: 4000 });
    const d = detail({
      startingMinimumBid: 100,
      minimumBid: 6000,
      currentPrice: 5900,
    });
    expect(has(checkCaps(s, [], 0, caps, d), 'per-item')).toBe(true);
    const low = detail({ startingMinimumBid: 9000, minimumBid: 1100, currentPrice: 2000 });
    expect(checkCaps(s, [], 0, caps, low).ok).toBe(true);
  });

  it('per-day cap counts spent-today plus this bid', () => {
    const caps = { ...CAPS, typoAbsolute: 100000 };
    expect(checkCaps(snipe({ maxBid: 4000 }), [], 6000, caps).ok).toBe(true);
    expect(has(checkCaps(snipe({ maxBid: 4000 }), [], 6001, caps), 'per-day')).toBe(true);
  });

  it('exposure counts every armed snipe as a potential win, plus shipping and handling', () => {
    const caps = { ...CAPS, typoAbsolute: 100000, openExposureMax: 20000 };
    const others = [
      snipe({ id: 'a', maxBid: 5000, estShipping: 500 }),
      snipe({
        id: 'b',
        maxBid: 5000,
        estHandling: 300,
        estShipping: 200,
        state: 'verified',
      }),
      snipe({ id: 'c', maxBid: 4000, estShipping: 0 }),
    ];
    // others = 5500 + 5500 + 4000 = 15000; this = 5000 -> 20000 exactly.
    expect(checkCaps(snipe({ maxBid: 5000, estShipping: 0 }), others, 0, caps).ok).toBe(true);
    expect(has(checkCaps(snipe({ maxBid: 5000, estShipping: 1 }), others, 0, caps), 'exposure')).toBe(true);
  });

  it('ignores drafts, finished and dry-run snipes, and the snipe itself, in others', () => {
    const caps = { ...CAPS, typoAbsolute: 100000, openExposureMax: 6000 };
    const others = [
      snipe({ id: 's1', maxBid: 5000 }),
      snipe({ id: 'd', maxBid: 5000, state: 'draft' }),
      snipe({ id: 'k', maxBid: 5000, state: 'killed' }),
      snipe({ id: 'r', maxBid: 5000, state: 'resolved', outcome: 'outbid' }),
      snipe({ id: 'x', maxBid: 5000, dryRun: true }),
    ];
    expect(checkCaps(snipe({ maxBid: 5000 }), others, 0, caps).ok).toBe(true);
  });

  it('never reports typo, however large the max versus the price', () => {
    const caps = { ...CAPS, perItemMax: 10_000_000, perDayMax: 10_000_000, openExposureMax: 10_000_000 };
    const d = detail({ currentPrice: 100, minimumBid: 200 });
    const r = checkCaps(snipe({ maxBid: 5000 }), [], 0, caps, d);
    expect(r).toEqual({ ok: true, violations: [] });
    expect(checkCaps(snipe({ maxBid: 9_000_000 }), [], 0, caps).violations.some((v) => v.startsWith('typo'))).toBe(
      false,
    );
  });

  it('reports several violations at once', () => {
    const r = checkCaps(snipe({ maxBid: 30000 }), [], 10000, CAPS);
    expect(r.ok).toBe(false);
    expect(r.violations.length).toBeGreaterThanOrEqual(3);
  });

  it('property: monotone in maxBid (raising the max never removes a violation)', () => {
    const arb = fc.record({
      a: fc.integer({ min: 0, max: 100000 }),
      b: fc.integer({ min: 0, max: 100000 }),
      spent: fc.integer({ min: 0, max: 30000 }),
      others: fc.array(fc.integer({ min: 0, max: 20000 }), { maxLength: 5 }),
      current: fc.integer({ min: 0, max: 20000 }),
      withDetail: fc.boolean(),
      ship: fc.option(fc.integer({ min: 0, max: 2000 }), { nil: undefined }),
    });
    fc.assert(
      fc.property(arb, ({ a, b, spent, others, current, withDetail, ship }) => {
        const lo = Math.min(a, b);
        const hi = Math.max(a, b);
        const o = others.map((m, i) => snipe({ id: `o${String(i)}`, maxBid: m }));
        const d = withDetail ? detail({ currentPrice: current, minimumBid: current + 100 }) : undefined;
        const rLo = checkCaps(snipe({ maxBid: lo, estShipping: ship }), o, spent, CAPS, d);
        const rHi = checkCaps(snipe({ maxBid: hi, estShipping: ship }), o, spent, CAPS, d);
        const kinds = (v: string[]): Set<string> => new Set(v.map((x) => x.split(':')[0] ?? x));
        for (const k of kinds(rLo.violations)) expect(kinds(rHi.violations).has(k)).toBe(true);
        if (rHi.ok) expect(rLo.ok).toBe(true);
      }),
      { numRuns: 500 },
    );
  });
});

describe('typoCheck', () => {
  it('3x current: at 3x passes, one cent over needs confirmation', () => {
    const d = detail({ currentPrice: 500, minimumBid: 600 });
    expect(typoCheck(1500, d, CAPS)).toEqual({ needsConfirmation: false });
    const r = typoCheck(1501, d, CAPS);
    expect(r.needsConfirmation).toBe(true);
    expect(r.reason).toBeTruthy();
  });

  it('absolute threshold: at it passes, one cent over needs confirmation, with or without detail', () => {
    expect(typoCheck(2500, undefined, CAPS).needsConfirmation).toBe(false);
    expect(typoCheck(2501, undefined, CAPS).needsConfirmation).toBe(true);
    const d = detail({ currentPrice: 2400, minimumBid: 2500 });
    expect(typoCheck(2501, d, CAPS).needsConfirmation).toBe(true);
  });

  it('with no bids yet only the absolute threshold applies', () => {
    const d = detail({ currentPrice: 0, numBids: 0, minimumBid: 100 });
    expect(typoCheck(2000, d, CAPS).needsConfirmation).toBe(false);
  });

  it('propagates RangeError on a bad absolute or multiplier', () => {
    expect(() => typoCheck(100, undefined, { ...CAPS, typoAbsolute: -1 })).toThrow(RangeError);
    expect(() => typoCheck(100, undefined, { ...CAPS, typoMultiplier: 0 as unknown as 3 })).toThrow(RangeError);
  });

  it('property: monotone in maxBid', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 100000 }),
        fc.integer({ min: 0, max: 100000 }),
        fc.integer({ min: 0, max: 20000 }),
        (a, b, cur) => {
          const d = detail({ currentPrice: cur });
          const lo = Math.min(a, b);
          const hi = Math.max(a, b);
          if (typoCheck(lo, d, CAPS).needsConfirmation) expect(typoCheck(hi, d, CAPS).needsConfirmation).toBe(true);
        },
      ),
    );
  });
});

describe('exposure', () => {
  it('sums armed maxes plus known shipping and handling', () => {
    const r = exposure([
      snipe({ id: 'a', maxBid: 1000, estShipping: 300, estHandling: 100 }),
      snipe({ id: 'b', maxBid: 2000, estShipping: 0 }),
    ]);
    expect(r).toEqual({ total: 3400, shippingUnknown: false, count: 2 });
  });

  it('counts the max only and flags shippingUnknown when the estimate is unknown', () => {
    const r = exposure([snipe({ id: 'a', maxBid: 1000 }), snipe({ id: 'b', maxBid: 500, estShipping: 50 })]);
    expect(r).toEqual({ total: 1550, shippingUnknown: true, count: 2 });
  });

  it('counts in-flight states, skips draft, killed, resolved and dry-run', () => {
    const states = ['armed', 'fallback-applied', 'waking', 'verified', 'firing', 'sent'] as const;
    const live = states.map((state, i) => snipe({ id: `l${String(i)}`, maxBid: 100, estShipping: 0, state }));
    const dead = [
      snipe({ id: 'd1', maxBid: 100, state: 'draft' }),
      snipe({ id: 'd2', maxBid: 100, state: 'killed' }),
      snipe({ id: 'd3', maxBid: 100, state: 'resolved' }),
      snipe({ id: 'd4', maxBid: 100, dryRun: true }),
    ];
    expect(exposure([...live, ...dead])).toEqual({
      total: 600,
      shippingUnknown: false,
      count: 6,
    });
  });

  it('is zero for nothing', () => {
    expect(exposure([])).toEqual({
      total: 0,
      shippingUnknown: false,
      count: 0,
    });
  });
});

describe('spentToday (local day, America/New_York)', () => {
  // 2026-10-08 is EDT (UTC-4). Local midnight = 04:00Z.
  const t = (iso: string): number => new Date(iso).getTime();
  const won = (id: string, resolvedAtIso: string, over: Partial<Snipe> = {}): Snipe =>
    snipe({
      id,
      state: 'resolved',
      outcome: 'won',
      maxBid: 1000,
      estShipping: 200,
      history: [{ at: t(resolvedAtIso), from: 'sent', to: 'resolved', why: 'won' }],
      ...over,
    });

  it('localDayKey uses the local calendar day', () => {
    expect(localDayKey(t('2026-10-08T03:59:59Z'), TZ)).toBe('2026-10-07');
    expect(localDayKey(t('2026-10-08T04:00:00Z'), TZ)).toBe('2026-10-08');
    expect(localDayKey(t('2026-10-09T03:59:59Z'), TZ)).toBe('2026-10-08');
  });

  it('counts wins resolved on the local day, bounded by local midnight (not UTC)', () => {
    const now = t('2026-10-08T15:00:00Z');
    const snipes = [
      won('a', '2026-10-08T04:00:00Z'),
      won('b', '2026-10-08T03:59:59Z'),
      won('c', '2026-10-09T03:59:59Z', { maxBid: 500, estShipping: 0 }),
      won('d', '2026-10-09T04:00:00Z'),
    ];
    expect(spentToday(snipes, now, TZ)).toBe(1200 + 500);
  });

  it('handles the DST fall-back day in local terms', () => {
    // 2026-11-01: EDT -> EST at 06:00Z. Local day 11-01 is 04:00Z .. 04:59:59Z on 11-02 (25 hours).
    const now = t('2026-11-02T04:30:00Z');
    const snipes = [
      won('a', '2026-11-01T04:00:00Z'),
      won('b', '2026-11-02T04:59:59Z'),
      won('c', '2026-11-02T05:00:00Z'),
    ];
    expect(spentToday(snipes, now, TZ)).toBe(2400);
  });

  it('counts only real money outcomes: not dry-run snipes, not other outcomes', () => {
    const now = t('2026-10-08T15:00:00Z');
    const at = '2026-10-08T14:00:00Z';
    const snipes = [
      won('a', at, { dryRun: true }),
      won('b', at, { outcome: 'outbid' }),
      won('c', at, { outcome: 'dry-run' }),
      won('d', at, { outcome: 'cap-blocked' }),
      won('e', at),
    ];
    expect(spentToday(snipes, now, TZ)).toBe(1200);
  });

  it('counts a fallback proxy placement as spend (it can still win)', () => {
    const now = t('2026-10-08T15:00:00Z');
    expect(
      spentToday(
        [
          won('a', '2026-10-08T14:00:00Z', {
            outcome: 'fallback-proxy-placed',
          }),
        ],
        now,
        TZ,
      ),
    ).toBe(1200);
  });

  it('falls back to the last history entry, then armedAt, when there is no resolved entry', () => {
    const now = t('2026-10-08T15:00:00Z');
    const a = won('a', '2026-10-08T14:00:00Z', {
      history: [{ at: t('2026-10-08T14:00:00Z'), from: 'sent', to: 'firing', why: 'x' }],
    });
    const b = won('b', '2026-10-08T14:00:00Z', {
      history: [],
      armedAt: t('2026-10-08T13:00:00Z'),
    });
    const c = won('c', '2026-10-08T14:00:00Z', {
      history: [],
      armedAt: t('2026-10-01T13:00:00Z'),
    });
    expect(spentToday([a, b, c], now, TZ)).toBe(2400);
  });

  it('is zero for nothing', () => {
    expect(spentToday([], Date.now(), TZ)).toBe(0);
  });
});
