// T-126: the one wording for a calendar.syncNow reply, shared by the dashboard's
// Calendar section and the popup's Sync now.
import { describe, expect, it } from 'vitest';

import { calendarSyncMessage } from '../../src/ui/calendar-sync-message';

const reply = (over: Partial<Parameters<typeof calendarSyncMessage>[0]> = {}) => ({
  status: 'synced' as const,
  changed: 0,
  pending: 0,
  errors: 0,
  ...over,
});

describe('calendarSyncMessage', () => {
  it('synced with nothing to change', () => {
    expect(calendarSyncMessage(reply())).toEqual({ ok: true, text: 'Sync finished: the calendar was already up to date.' });
  });

  it('synced with changes', () => {
    expect(calendarSyncMessage(reply({ changed: 3 }))).toEqual({ ok: true, text: 'Sync finished: 3 event(s) updated.' });
  });

  it('calendar events off', () => {
    expect(calendarSyncMessage(reply({ status: 'disabled' }))).toEqual({ ok: true, text: 'Calendar events are off, so nothing was synced.' });
  });

  it('a failure says why, how many still wait, and what Google said', () => {
    expect(calendarSyncMessage(reply({ status: 'needs-reconnect', pending: 2, detail: 'Forbidden' }))).toEqual({
      ok: false,
      text: 'Google refused the calendar write. 2 item(s) still waiting. Google said: Forbidden',
    });
    expect(calendarSyncMessage(reply({ status: 'pending' }))).toEqual({
      ok: false,
      text: 'Google is not connected, so nothing went on the calendar.',
    });
    expect(calendarSyncMessage(reply({ status: 'blocked' })).text).toMatch(/kill switch or a safety check/);
    expect(calendarSyncMessage(reply({ status: 'cooling-down' })).text).toMatch(/slow down/);
    expect(calendarSyncMessage(reply({ status: 'offline' })).text).toMatch(/Could not reach Google/);
    expect(calendarSyncMessage(reply({ status: 'error', errors: 1 })).text).toBe('Some calendar writes failed.');
  });
});
