// T-86 (R5): the popup kill section's reason list. Pure text formatting: the
// auto-kill entries of the audit log become plain text lines, rendered by the
// section as Preact text nodes — never markup, never HTML.
//
// The entry kinds are stable audit-log strings:
//   - 'snipe.disarm' with details.by === 'kill' | 'anomaly' (the reducer's
//     audit of an accepted disarm; 'kill' comes from jobs/kill-disarm.ts,
//     'anomaly' from the snipe runner's auto-kill);
//   - 'kill.snipe-sent' (jobs/kill-disarm.ts, R2: a sent snipe the kill switch
//     could not stop). The constant is not imported from the background (that
//     would bundle the runner into the popup).
import type { AuditEntry } from '../../../../domain/audit/types';

export interface KillReason {
  at: number;
  text: string;
}

export const KILL_REASON_LIMIT = 3;
const KILL_SNIPE_SENT_KIND = 'kill.snipe-sent';

/** The last auto-kill lines of `entries` (newest first, per the audit.list contract), at most `limit`. */
export function killReasons(entries: readonly AuditEntry[], limit: number = KILL_REASON_LIMIT): KillReason[] {
  const out: KillReason[] = [];
  for (const e of entries) {
    if (e.kind === 'snipe.disarm' && (e.details.by === 'kill' || e.details.by === 'anomaly')) {
      const who = e.details.by === 'kill' ? 'Kill switch' : 'Auto-stopped';
      const ref = typeof e.ref === 'string' && e.ref !== '' ? ` ${e.ref}` : '';
      const why = typeof e.details.why === 'string' && e.details.why !== '' ? `: ${e.details.why}` : '';
      out.push({ at: e.at, text: `${who}${ref}${why}` });
    } else if (e.kind === KILL_SNIPE_SENT_KIND) {
      const note = e.details.note;
      out.push({ at: e.at, text: typeof note === 'string' && note !== '' ? note : 'kill: a sent snipe was left running; outcome pending' });
    }
    if (out.length >= limit) break;
  }
  return out;
}
