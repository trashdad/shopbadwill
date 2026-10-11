// T-85 ruling 3: the arm confirmation's end time carries the DATE, in the
// user's zone and in SGW Pacific, DST-correct from the IANA zones. When the
// two dates differ across midnight, each side shows its own.
import { describe, expect, it } from 'vitest';

import { formatEndDual } from '../../../src/ui/dashboard/sections/snipes/end-time';

const at = (iso: string): number => new Date(iso).getTime();

describe('formatEndDual', () => {
  it('shows the user-zone date and time, then Pacific; one date when both sides agree', () => {
    expect(formatEndDual(at('2026-10-08T02:18:30Z'), 'America/New_York')).toBe('Wed Oct 7, 10:18:30 PM EDT (7:18:30 PM PT)');
  });

  it('gives each side its own date across midnight, in either direction', () => {
    // East of Pacific: the user is already on the next day.
    expect(formatEndDual(at('2026-10-08T04:30:00Z'), 'America/New_York')).toBe('Thu Oct 8, 12:30:00 AM EDT (Wed Oct 7, 9:30:00 PM PT)');
    // West of Pacific: Pacific is already on the next day.
    expect(formatEndDual(at('2026-10-08T07:30:00Z'), 'Pacific/Honolulu')).toBe('Wed Oct 7, 9:30:00 PM HST (Thu Oct 8, 12:30:00 AM PT)');
  });

  it('follows each zone through the fall-back night (New York 06:00Z, Pacific 09:00Z)', () => {
    expect(formatEndDual(at('2026-11-01T05:30:00Z'), 'America/New_York')).toBe('Sun Nov 1, 1:30:00 AM EDT (Sat Oct 31, 10:30:00 PM PT)');
    expect(formatEndDual(at('2026-11-01T06:30:00Z'), 'America/New_York')).toBe('Sun Nov 1, 1:30:00 AM EST (Sat Oct 31, 11:30:00 PM PT)');
    expect(formatEndDual(at('2026-11-01T08:30:00Z'), 'America/New_York')).toBe('Sun Nov 1, 3:30:00 AM EST (1:30:00 AM PT)');
    expect(formatEndDual(at('2026-11-01T09:30:00Z'), 'America/New_York')).toBe('Sun Nov 1, 4:30:00 AM EST (1:30:00 AM PT)');
  });

  it('follows each zone through the spring-forward night', () => {
    expect(formatEndDual(at('2026-03-08T06:30:00Z'), 'America/New_York')).toBe('Sun Mar 8, 1:30:00 AM EST (Sat Mar 7, 10:30:00 PM PT)');
    expect(formatEndDual(at('2026-03-08T07:30:00Z'), 'America/New_York')).toBe('Sun Mar 8, 3:30:00 AM EDT (Sat Mar 7, 11:30:00 PM PT)');
  });

  it('a Pacific user sees one time, with the zone that is in force (PDT or PST)', () => {
    // The fall-back hour happens twice in Pacific: the zone name tells them apart.
    expect(formatEndDual(at('2026-11-01T08:30:00Z'), 'America/Los_Angeles')).toBe('Sun Nov 1, 1:30:00 AM PDT');
    expect(formatEndDual(at('2026-11-01T09:30:00Z'), 'America/Los_Angeles')).toBe('Sun Nov 1, 1:30:00 AM PST');
  });

  it('uses plain spaces only (Intl may emit narrow no-break spaces before AM/PM)', () => {
    expect(formatEndDual(at('2026-10-08T02:18:30Z'), 'America/New_York')).not.toMatch(new RegExp(`[${String.fromCharCode(0xa0)}${String.fromCharCode(0x202f)}]`));
  });
});
