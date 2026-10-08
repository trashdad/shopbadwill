import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  formatDual,
  formatPacificNaive,
  parsePacific,
  parsePacificDetailed,
  relative,
} from '../../../../src/domain/time/pacific';

const iso = (ms: number): string => new Date(ms).toISOString();

describe('parsePacificDetailed (table)', () => {
  const rows: { raw: string; utc: string; ambiguous: boolean; nonexistent: boolean }[] = [
    { raw: '2026-10-07T19:18:30', utc: '2026-10-08T02:18:30.000Z', ambiguous: false, nonexistent: false }, // PDT
    { raw: '2026-10-07T19:18:17.45', utc: '2026-10-08T02:18:17.450Z', ambiguous: false, nonexistent: false },
    { raw: '2026-01-15T12:00:00', utc: '2026-01-15T20:00:00.000Z', ambiguous: false, nonexistent: false }, // PST
    // spring forward 2026-03-08 02:00 -> 03:00; 02:30 does not exist, resolves to 03:30 PDT
    { raw: '2026-03-08T02:30:00', utc: '2026-03-08T10:30:00.000Z', ambiguous: false, nonexistent: true },
    // fall back 2026-11-01 02:00 PDT -> 01:00 PST; 01:30 happens twice, earlier = PDT
    { raw: '2026-11-01T01:30:00', utc: '2026-11-01T08:30:00.000Z', ambiguous: true, nonexistent: false },
    { raw: '2026-11-01T00:59:59', utc: '2026-11-01T07:59:59.000Z', ambiguous: false, nonexistent: false },
    { raw: '2026-11-01T02:00:00', utc: '2026-11-01T10:00:00.000Z', ambiguous: false, nonexistent: false },
    { raw: '2026-03-08T01:59:59', utc: '2026-03-08T09:59:59.000Z', ambiguous: false, nonexistent: false },
    { raw: '2026-03-08T03:00:00', utc: '2026-03-08T10:00:00.000Z', ambiguous: false, nonexistent: false },
  ];
  it.each(rows)('$raw', ({ raw, utc, ambiguous, nonexistent }) => {
    const r = parsePacificDetailed(raw);
    expect(iso(r.ms)).toBe(utc);
    expect(r.ambiguous).toBe(ambiguous);
    expect(r.nonexistent).toBe(nonexistent);
    expect(parsePacific(raw)).toBe(r.ms);
  });

  it('nonexistent 02:30 resolves to 03:30 PDT wall time', () => {
    const r = parsePacificDetailed('2026-03-08T02:30:00');
    expect(formatPacificNaive(r.ms)).toBe('2026-03-08T03:30:00');
  });

  it('ambiguous resolves to the earlier instant', () => {
    const r = parsePacificDetailed('2026-11-01T01:30:00');
    expect(formatPacificNaive(r.ms)).toBe('2026-11-01T01:30:00');
    // one hour later prints the same wall time again (the PST repeat)
    expect(formatPacificNaive(r.ms + 3_600_000)).toBe('2026-11-01T01:30:00');
    expect(formatPacificNaive(r.ms + 2 * 3_600_000)).toBe('2026-11-01T02:30:00');
  });

  it.each([
    '',
    '2026-10-07',
    '2026-10-07T19:18',
    '2026-10-07T19:18:30Z',
    '2026-10-07T19:18:30-07:00',
    '2026-13-07T19:18:30',
    '2026-02-30T10:00:00',
    '2026-10-07T24:00:00',
    '2026-10-07T19:60:00',
    ' 2026-10-07T19:18:30',
  ])('rejects %j', (bad) => {
    expect(() => parsePacificDetailed(bad)).toThrow(RangeError);
  });
});

describe('formatPacificNaive', () => {
  it('prints fractional seconds only when non-zero', () => {
    expect(formatPacificNaive(parsePacific('2026-10-07T19:18:17.45'))).toBe('2026-10-07T19:18:17.450');
    expect(formatPacificNaive(parsePacific('2026-10-07T19:18:30'))).toBe('2026-10-07T19:18:30');
  });
});

describe('format(parse(x)) === x (property)', () => {
  const pad = (n: number, w = 2): string => String(n).padStart(w, '0');
  const naive = fc
    .record({
      y: fc.integer({ min: 2000, max: 2100 }),
      m: fc.integer({ min: 1, max: 12 }),
      d: fc.integer({ min: 1, max: 28 }),
      h: fc.integer({ min: 0, max: 23 }),
      mi: fc.integer({ min: 0, max: 59 }),
      s: fc.integer({ min: 0, max: 59 }),
    })
    .map((p) => `${pad(p.y, 4)}-${pad(p.m)}-${pad(p.d)}T${pad(p.h)}:${pad(p.mi)}:${pad(p.s)}`);

  it('round-trips 10k generated strings outside DST transitions', () => {
    fc.assert(
      fc.property(naive, (x) => {
        const r = parsePacificDetailed(x);
        // Skip the (rare) generated strings that fall inside a transition hour.
        fc.pre(!r.ambiguous && !r.nonexistent);
        expect(formatPacificNaive(r.ms)).toBe(x);
      }),
      { numRuns: 10_000 },
    );
  });
});

describe('formatDual', () => {
  it('reads "7:18 PM PT · 10:18 PM ET" (PDT/EDT)', () => {
    expect(formatDual(parsePacific('2026-10-07T19:18:30'), 'America/New_York')).toBe('7:18 PM PT · 10:18 PM ET');
  });
  it('uses PT/ET labels in winter too (PST/EST)', () => {
    expect(formatDual(parsePacific('2026-01-15T12:00:00'), 'America/New_York')).toBe('12:00 PM PT · 3:00 PM ET');
  });
  it('is correct on the night the zones change DST on the same day', () => {
    // 2026-11-01 07:30Z: LA is 00:30 PDT; NY already fell back at 06:00Z, so 02:30 EST.
    expect(formatDual(Date.UTC(2026, 10, 1, 7, 30), 'America/New_York')).toBe('12:30 AM PT · 2:30 AM ET');
  });
  it('collapses to a single time when the user is on Pacific time', () => {
    expect(formatDual(parsePacific('2026-10-07T19:18:30'), 'America/Los_Angeles')).toBe('7:18 PM PT');
  });
  it('labels other zones with their generic initials', () => {
    expect(formatDual(parsePacific('2026-10-07T19:18:30'), 'America/Chicago')).toBe('7:18 PM PT · 9:18 PM CT');
  });
  it('midnight and noon use 12', () => {
    expect(formatDual(parsePacific('2026-10-07T00:05:00'), 'America/New_York')).toBe('12:05 AM PT · 3:05 AM ET');
  });
});

describe('relative', () => {
  const now = 1_000_000_000_000;
  it.each([
    [0, 'now'],
    [400, 'now'],
    [45_000, 'in 45s'],
    [-45_000, '45s ago'],
    [5 * 60_000, 'in 5m'],
    [2 * 3_600_000 + 5 * 60_000, 'in 2h 5m'],
    [-(2 * 3_600_000 + 5 * 60_000), '2h 5m ago'],
    [3 * 86_400_000 + 4 * 3_600_000, 'in 3d 4h'],
    [59 * 60_000 + 59_000, 'in 59m 59s'],
  ])('%d ms -> %s', (delta, expected) => {
    expect(relative(now + delta, now)).toBe(expected);
  });
});
