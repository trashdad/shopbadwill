import { describe, expect, it } from 'vitest';
import { parsePacific } from '../../../../src/domain/time/pacific';
import { PacificTime, RelativeTime } from '../../../../src/ui/time';

// Components are pure functions of their props, so the returned vnode is inspected directly.
describe('time display components', () => {
  it('PacificTime renders the dual string inside a <time> carrying the UTC instant', () => {
    const ms = parsePacific('2026-10-07T19:18:30');
    const v = PacificTime({ ms, userTz: 'America/New_York' });
    expect(v.type).toBe('time');
    expect(v.props.dateTime).toBe('2026-10-08T02:18:30.000Z');
    expect(v.props.children).toBe('7:18 PM PT · 10:18 PM ET');
  });

  it('RelativeTime renders relative text', () => {
    const v = RelativeTime({ ms: 10_000 + 5 * 60_000, now: 10_000 });
    expect(v.type).toBe('time');
    expect(v.props.children).toBe('in 5m');
  });
});
