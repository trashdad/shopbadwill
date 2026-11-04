import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { DEFAULT_CAPS } from '../../../../src/domain/settings/defaults';
import {
  checkCaps as realCheckCaps,
  confirmsAmount,
  exposure,
  localDayKey,
  spentToday,
  typoCheck,
} from '../../../../src/domain/snipe/caps';
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

// Default detail so tests that are not about detail pass one (checkCaps fails closed without it).
const checkCaps = (
  s: Snipe,
  o: readonly Snipe[],
  spent: number,
  caps: typeof CAPS,
  d: ItemDetail | undefined = detail({ currentPrice: 500, minimumBid: 600 }),
) => realCheckCaps(s, o, spent, caps, d);

// Compile-time check: checkCaps is assignable to the frozen CheckCaps type.
const asContract: CheckCaps = realCheckCaps;

const has = (r: { violations: string[] }, kind: string): boolean => r.violations.some((v) => v.startsWith(kind));

describe('checkCaps', () => {
  it('passes a small bid with nothing else going on', () => {
    expect(checkCaps(snipe(), [], 0, CAPS)).toEqual({
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
    const caps = { ...CAPS, perDayMax: 1000000, openExposureMax: 20000 };
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

  it('fails closed without detail', () => {
    const r = realCheckCaps(snipe(), [], 0, CAPS);
    expect(r.ok).toBe(false);
    expect(has(r, 'per-item')).toBe(true);
    expect(r.violations[0]).toContain('detail required');
    expect(asContract(snipe(), [], 0, CAPS).ok).toBe(false);
    expect(realCheckCaps(snipe(), [], 0, CAPS, detail()).ok).toBe(true);
  });

  it('rejects bad inputs with a violation instead of throwing', () => {
    for (const bad of [{ maxBid: -1 }, { maxBid: 1.5 }, { estShipping: -5 }, { estHandling: 0.5 }, { maxBid: NaN }]) {
      const r = checkCaps(snipe(bad), [], 0, CAPS);
      expect(r.ok).toBe(false);
      expect(has(r, 'invalid')).toBe(true);
    }
    expect(has(checkCaps(snipe(), [], -1, CAPS), 'invalid')).toBe(true);
  });

  it('a negative shipping estimate on another snipe never reduces the totals', () => {
    const caps = { ...CAPS, openExposureMax: 1500 };
    const others = [snipe({ id: 'a', maxBid: 1000, estShipping: -900 })];
    expect(has(checkCaps(snipe({ maxBid: 600 }), others, 0, caps), 'exposure')).toBe(true);
  });

  describe('per-day cap with concurrent in-flight snipes', () => {
    const caps = { ...CAPS, perDayMax: 10000, perItemMax: 5000 };
    const fly = (id: string, state: Snipe['state'], over: Partial<Snipe> = {}): Snipe =>
      snipe({ id, state, maxBid: 5000, estShipping: 0, ...over });

    it('blocks the third of three concurrent $50 snipes on one local day', () => {
      const a = fly('a', 'verified');
      const b = fly('b', 'firing');
      const c = fly('c', 'verified');
      expect(checkCaps(a, [b], 0, caps).ok).toBe(true); // 100
      expect(has(checkCaps(c, [a, b], 0, caps), 'per-day')).toBe(true); // 150
    });

    it('counts sent snipes but not armed, draft, dry-run or finished ones', () => {
      const s = fly('s', 'verified');
      expect(has(checkCaps(s, [fly('a', 'sent'), fly('b', 'sent')], 0, caps), 'per-day')).toBe(true);
      const quiet = [fly('a', 'armed'), fly('b', 'draft'), fly('c', 'firing', { dryRun: true }), fly('d', 'resolved')];
      expect(has(checkCaps(s, quiet, 0, { ...caps, openExposureMax: 100000 }), 'per-day')).toBe(false);
    });

    it('an in-flight snipe on a different local day does not count', () => {
      const s = fly('s', 'verified', { endTime: '2026-10-08T20:00:00.000Z' });
      // 2026-10-09T03:30Z is still 10-08 local (EDT); 04:30Z is 10-09 local.
      const sameDay = fly('a', 'firing', { endTime: '2026-10-09T03:30:00.000Z' });
      const nextDay = fly('b', 'firing', { endTime: '2026-10-09T04:30:00.000Z' });
      expect(has(checkCaps(s, [sameDay, nextDay], 0, caps), 'per-day')).toBe(false);
      expect(has(checkCaps(s, [sameDay, nextDay, fly('c', 'sent')], 0, caps), 'per-day')).toBe(true);
    });

    it('does not count the snipe itself twice', () => {
      const s = fly('s', 'firing');
      expect(has(checkCaps(s, [s, fly('a', 'sent')], 0, caps), 'per-day')).toBe(false);
    });
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

describe('confirmsAmount / typoCheck prompt', () => {
  it('typoCheck exposes expectedCents and a prompt', () => {
    const r = typoCheck(2000, detail({ currentPrice: 100 }), CAPS);
    expect(r.needsConfirmation).toBe(true);
    expect(r.expectedCents).toBe(2000);
    expect(r.prompt).toBe('Type the amount to confirm: $20.00');
    expect(typoCheck(100, undefined, CAPS).prompt).toBeUndefined();
  });

  it.each(['$20', '20', '20.00', '$20.00', ' 20.0 '])('accepts %j for $20.00', (typed) => {
    expect(confirmsAmount(typed, 2000)).toBe(true);
  });

  it.each(['$2000', '20.01', '2', '', 'twenty', '-20', '20.001'])('rejects %j for $20.00', (typed) => {
    expect(confirmsAmount(typed, 2000)).toBe(false);
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

  // T-80b R4: Unconfirmed counts conservatively; proven not-sent does not.
  it('R4: an Unconfirmed outcome counts at the ceiling (the bid may have been placed)', () => {
    const now = t('2026-10-08T15:00:00Z');
    const unconfirmed = won('a', '2026-10-08T14:00:00Z', {
      outcome: 'network',
      attempt: { sentAt: t('2026-10-07T23:42:05Z') },
    });
    expect(spentToday([unconfirmed], now, TZ)).toBe(1200);
  });

  it('R4: an Unconfirmed ambiguous send (no reply, no post-read) counts too', () => {
    const now = t('2026-10-08T15:00:00Z');
    const unconfirmed = won('a', '2026-10-08T14:00:00Z', {
      outcome: 'network',
      attempt: { ambiguous: true },
    });
    expect(spentToday([unconfirmed], now, TZ)).toBe(1200);
  });

  it('R4: a proven not-sent does not count, however the outcome reads "network"', () => {
    const now = t('2026-10-08T15:00:00Z');
    const notSent = won('a', '2026-10-08T14:00:00Z', {
      outcome: 'network',
      attempt: { sentAt: t('2026-10-07T23:42:05Z'), notSent: true },
    });
    expect(spentToday([notSent], now, TZ)).toBe(0);
  });

  it('R4: a network outcome with no send recorded at all does not count', () => {
    const now = t('2026-10-08T15:00:00Z');
    const never = won('a', '2026-10-08T14:00:00Z', {
      outcome: 'network',
      attempt: {},
    });
    expect(spentToday([never], now, TZ)).toBe(0);
  });

  it('R4: a win that also has send evidence is counted once, not again as Unconfirmed', () => {
    const now = t('2026-10-08T15:00:00Z');
    const wonWithSend = won('a', '2026-10-08T14:00:00Z', {
      attempt: { sentAt: t('2026-10-07T23:42:05Z'), ambiguous: true },
    });
    const unconfirmed = won('b', '2026-10-08T14:00:00Z', {
      outcome: 'network',
      attempt: { sentAt: t('2026-10-07T23:42:05Z') },
    });
    // 1000 max + 200 shipping. A second add for the send evidence would be 2400.
    expect(spentToday([wonWithSend], now, TZ)).toBe(1200);
    expect(spentToday([unconfirmed], now, TZ)).toBe(1200);
    expect(spentToday([wonWithSend, unconfirmed], now, TZ)).toBe(2400);
  });
});
