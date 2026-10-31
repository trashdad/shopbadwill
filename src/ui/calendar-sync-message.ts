// T-126: the one wording for a `calendar.syncNow` reply, shared by the
// dashboard's Calendar section and the popup's Sync now. `ok: false` is shown
// as an alert; the text says why, how many items still wait, and Google's answer.
import type { MsgReply } from '../messaging/protocol';

export type CalendarSyncReply = MsgReply<'calendar.syncNow'>;

const SYNC_FAILED: Record<Exclude<CalendarSyncReply['status'], 'synced' | 'disabled'>, string> = {
  pending: 'Google is not connected, so nothing went on the calendar.',
  blocked: 'Calendar writes are blocked right now (the kill switch or a safety check).',
  'cooling-down': 'Google asked ShopBadwill to slow down. It will try again later.',
  'needs-reconnect': 'Google refused the calendar write.',
  offline: 'Could not reach Google. Check the connection and try again.',
  error: 'Some calendar writes failed.',
};

export function calendarSyncMessage(r: CalendarSyncReply): { ok: boolean; text: string } {
  if (r.status === 'synced') {
    return { ok: true, text: r.changed === 0 ? 'Sync finished: the calendar was already up to date.' : `Sync finished: ${String(r.changed)} event(s) updated.` };
  }
  if (r.status === 'disabled') return { ok: true, text: 'Calendar events are off, so nothing was synced.' };
  const why = r.detail === undefined ? '' : ` Google said: ${r.detail}`;
  return { ok: false, text: `${SYNC_FAILED[r.status]}${r.pending > 0 ? ` ${String(r.pending)} item(s) still waiting.` : ''}${why}` };
}
