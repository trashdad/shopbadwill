import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  allInToBid,
  bidAmount,
  exceedsTypo,
  formatCents,
  formatMoney,
  nextAcceptable,
  parseCents,
} from '../../../src/domain/money';
import { DEFAULT_CAPS } from '../../../src/domain/settings/defaults';

describe('parseCents / formatCents', () => {
  it.each([
    ['0.00', 0],
    ['0.05', 5],
    ['12.99', 1299],
    ['12.5', 1250],
    ['12', 1200],
    ['$1,299.50', 129950],
    ['  7.10 ', 710],
  ])('parses %j -> %d', (s, cents) => {
    expect(parseCents(s)).toBe(cents);
  });

  it.each(['', 'abc', '-1.00', '1.234', '1.', '.50', '1,2,3.00', '$', '1e3', '99999999999999999.00'])(
    'rejects %j with null',
    (s) => {
      expect(parseCents(s)).toBeNull();
    },
  );

  it('format(parse(s)) === s for /^\\d+\\.\\d{2}$/ (canonical: no leading zeros)', () => {
    const canonical = fc
      .tuple(fc.integer({ min: 0, max: 9_000_000_000_000 }), fc.integer({ min: 0, max: 99 }))
      .map(([d, c]) => `${String(d)}.${String(c).padStart(2, '0')}`);
    fc.assert(
      fc.property(canonical, (s) => {
        expect(/^\d+\.\d{2}$/.test(s)).toBe(true);
        const c = parseCents(s);
        expect(c).not.toBeNull();
        expect(formatCents(c ?? -1)).toBe(s);
      }),
      { numRuns: 10_000 },
    );
  });

  it('parse(format(c)) === c for any cents', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER }), (c) => {
        expect(parseCents(formatCents(c))).toBe(c);
      }),
    );
  });

  it('formatCents rejects non-integer or negative cents', () => {
    expect(() => formatCents(1.5)).toThrow(RangeError);
    expect(() => formatCents(-1)).toThrow(RangeError);
    expect(() => formatCents(Number.NaN)).toThrow(RangeError);
  });
});

describe('formatMoney', () => {
  it.each([
    [0, '$0.00'],
    [5, '$0.05'],
    [1299, '$12.99'],
    [129950, '$1,299.50'],
    [123456789, '$1,234,567.89'],
  ])('%d -> %s', (c, s) => {
    expect(formatMoney(c)).toBe(s);
  });
  it('round-trips through parseCents', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER }), (c) => {
        expect(parseCents(formatMoney(c))).toBe(c);
      }),
    );
  });
});

describe('no floating drift', () => {
  it('1e6 additions of 10 cents is exactly 1e7 cents and prints exactly', () => {
    let total = 0;
    for (let i = 0; i < 1_000_000; i++) total = nextAcceptable(total, 10);
    expect(total).toBe(10_000_000);
    expect(formatCents(total)).toBe('100000.00');
  });
  it('1e6 additions of random increments stays an exact integer', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 999 }), (inc) => {
        let total = 0;
        for (let i = 0; i < 1_000_000; i++) total = nextAcceptable(total, inc);
        expect(total).toBe(inc * 1_000_000);
        expect(Number.isInteger(total)).toBe(true);
      }),
      { numRuns: 5 },
    );
  });
});

describe('nextAcceptable', () => {
  it('is current plus increment', () => {
    expect(nextAcceptable(1299, 100)).toBe(1399);
    expect(nextAcceptable(0, 100)).toBe(100);
  });
  it('rejects non-cents input', () => {
    expect(() => nextAcceptable(1.5, 100)).toThrow(RangeError);
    expect(() => nextAcceptable(100, -1)).toThrow(RangeError);
  });
});

describe('allInToBid', () => {
  it('subtracts shipping and handling from the all-in max', () => {
    expect(allInToBid(5000, 899, 150)).toBe(3951);
  });
  it('treats unknown (null/undefined) shipping or handling as zero', () => {
    expect(allInToBid(5000, null, undefined)).toBe(5000);
    expect(allInToBid(5000, 899, null)).toBe(4101);
  });
  it('never goes below zero', () => {
    expect(allInToBid(500, 899, 0)).toBe(0);
  });
  it('bid + shipping + handling never exceeds the all-in max (property)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 10_000_000 }),
        fc.integer({ min: 0, max: 100_000 }),
        fc.integer({ min: 0, max: 100_000 }),
        (allIn, ship, hand) => {
          const bid = allInToBid(allIn, ship, hand);
          expect(bid).toBeGreaterThanOrEqual(0);
          expect(bid + ship + hand <= allIn || bid === 0).toBe(true);
        },
      ),
    );
  });
});

describe('exceedsTypo(max, current, multiplier, absolute)', () => {
  const abs = DEFAULT_CAPS.typoAbsolute;
  it('default absolute is 2500 cents', () => {
    expect(abs).toBe(2500);
  });
  it('trips above multiplier x current', () => {
    expect(exceedsTypo(1501, 500, 3, abs)).toBe(true);
    expect(exceedsTypo(1500, 500, 3, abs)).toBe(false); // exactly 3x is allowed
  });
  it('trips above the absolute threshold', () => {
    expect(exceedsTypo(2501, 2400, 3, abs)).toBe(true);
    expect(exceedsTypo(2500, 2400, 3, abs)).toBe(false); // exactly the threshold is allowed
  });
  it('a sane bid trips neither', () => {
    expect(exceedsTypo(1200, 1000, 3, abs)).toBe(false);
  });
  it('with no bids yet (current 0) only the absolute threshold applies', () => {
    expect(exceedsTypo(2000, 0, 3, abs)).toBe(false);
    expect(exceedsTypo(2501, 0, 3, abs)).toBe(true);
  });
  it('is monotone in max (property)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 1_000_000 }),
        fc.integer({ min: 0, max: 1_000_000 }),
        fc.integer({ min: 0, max: 1_000_000 }),
        (a, b, current) => {
          const [lo, hi] = a <= b ? [a, b] : [b, a];
          if (exceedsTypo(lo, current, 3, abs)) expect(exceedsTypo(hi, current, 3, abs)).toBe(true);
        },
      ),
    );
  });
});

describe('bidAmount', () => {
  it('is always a two-decimal string (property)', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: Number.MAX_SAFE_INTEGER }), (c) => {
        expect(bidAmount(c)).toMatch(/^\d+\.\d{2}$/);
      }),
    );
  });
  it('examples', () => {
    expect(bidAmount(1200)).toBe('12.00');
    expect(bidAmount(5)).toBe('0.05');
  });
  it('rejects invalid cents', () => {
    expect(() => bidAmount(0.5)).toThrow(RangeError);
  });
});
