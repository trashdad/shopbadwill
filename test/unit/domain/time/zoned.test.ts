import { describe, expect, it } from 'vitest';

import { offsetAt, wallParts, zonedWallToInstant } from '../../../../src/domain/time/zoned';

const NY = 'America/New_York';
const H = 3_600_000;
const wall = (y: number, mo: number, d: number, h: number, mi = 0): number => Date.UTC(y, mo - 1, d, h, mi);

describe('zoned', () => {
  it('wallParts reads the zone wall clock', () => {
    expect(wallParts(Date.UTC(2026, 6, 15, 3, 4, 5), NY)).toEqual({ year: 2026, month: 7, day: 14, hour: 23, minute: 4, second: 5 });
  });

  it('offsetAt is east-positive and DST aware', () => {
    expect(offsetAt(Date.UTC(2026, 0, 15), NY)).toBe(-5 * H);
    expect(offsetAt(Date.UTC(2026, 6, 15), NY)).toBe(-4 * H);
    expect(offsetAt(Date.UTC(2026, 6, 15), 'Europe/Berlin')).toBe(2 * H);
  });

  it('zonedWallToInstant: ordinary time', () => {
    expect(zonedWallToInstant(wall(2026, 1, 15, 7), NY)).toEqual({ ms: Date.UTC(2026, 0, 15, 12), ambiguous: false, nonexistent: false });
  });

  it('zonedWallToInstant: spring-forward gap uses the pre-transition offset', () => {
    expect(zonedWallToInstant(wall(2026, 3, 8, 2, 30), NY)).toEqual({ ms: Date.UTC(2026, 2, 8, 7, 30), ambiguous: false, nonexistent: true });
  });

  it('zonedWallToInstant: fall-back overlap takes the earlier instant', () => {
    expect(zonedWallToInstant(wall(2026, 11, 1, 1, 30), NY)).toEqual({ ms: Date.UTC(2026, 10, 1, 5, 30), ambiguous: true, nonexistent: false });
  });
});
