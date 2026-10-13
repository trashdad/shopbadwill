import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { eventIdFor } from '../../../../src/domain/calendar/event-id';
import { CalendarLinkSchema } from '../../../../src/domain/calendar/types';

describe('eventIdFor', () => {
  it('matches the base32hex regex over 10k ids', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: Number.MAX_SAFE_INTEGER }), fc.nat({ max: 1_000_000 }), (id, gen) => {
        expect(eventIdFor(id, gen)).toMatch(/^[a-v0-9]{5,1024}$/);
      }),
      { numRuns: 10_000 },
    );
  });
  it('uses the sbv prefix and g<generation>', () => {
    expect(eventIdFor(279250057, 2)).toBe('sbv279250057g2');
  });
  it('is distinct per generation and accepted by CalendarLinkSchema', () => {
    expect(eventIdFor(5, 0)).not.toBe(eventIdFor(5, 1));
    const link = {
      itemId: 5,
      eventId: eventIdFor(5, 0),
      generation: 0,
      calendarId: 'c',
      lastSyncedHash: '',
      status: 'pending',
    };
    expect(CalendarLinkSchema.safeParse(link).success).toBe(true);
  });
  it('rejects bad inputs', () => {
    expect(() => eventIdFor(0, 0)).toThrow(RangeError);
    expect(() => eventIdFor(1, -1)).toThrow(RangeError);
    expect(() => eventIdFor(1, 1.5)).toThrow(RangeError);
  });
});
