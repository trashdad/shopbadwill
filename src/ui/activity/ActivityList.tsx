// T-58: the one activity list, mounted by the dashboard and by the options
// "Activity" section. Text only: audit fields can hold site-derived strings,
// so nothing here uses innerHTML.
import type { VNode } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';

import type { AuditEntry } from '../../domain/audit/types';
import type { MessagingClient } from '../../ports/messaging';
import { describeError } from '../components/describeError';
import { Status } from '../components/Status';
import { PacificTime } from '../time';
import { UNDOABLE_KINDS } from './undoable';

export interface ActivityListProps {
  client: MessagingClient;
  /** Entries per page. */
  pageSize?: number;
  /** IANA zone for the local half of the time display. Defaults to the browser's. */
  userTz?: string;
}

const UNDO_LABEL: Record<NonNullable<AuditEntry['undo']>['kind'], string> = {
  unfavorite: 'Unfavorite',
  deleteEvent: 'Remove calendar event',
  disableRule: 'Re-enable rule',
  disarm: 'Disarm snipe',
};

function summary(e: AuditEntry): string {
  const bits: string[] = [];
  if (e.itemId !== undefined) bits.push(`item ${String(e.itemId)}`);
  for (const [k, v] of Object.entries(e.details)) bits.push(`${k}: ${v === null ? 'none' : String(v)}`);
  return bits.join(' · ');
}

const what = (e: AuditEntry): string => (e.undo ? UNDO_LABEL[e.undo.kind] : e.kind);

export function ActivityList(props: ActivityListProps): VNode {
  const { client } = props;
  const pageSize = props.pageSize ?? 50;
  const userTz = props.userTz ?? Intl.DateTimeFormat().resolvedOptions().timeZone;

  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [more, setMore] = useState(false);
  const [status, setStatus] = useState<{ message: string; tone: 'ok' | 'error' }>({ message: '', tone: 'ok' });
  const [busy, setBusy] = useState<ReadonlySet<number>>(new Set());
  const inFlight = useRef(new Set<number>());

  const load = (before?: number, limit = pageSize): void => {
    client.send('audit.list', { limit, ...(before === undefined ? {} : { before }) }).then(
      (page) => {
        setEntries((cur) => (before === undefined ? page : [...cur, ...page]));
        setMore(page.length >= limit);
        setLoaded(true);
      },
      (e: unknown) => {
        setLoaded(true);
        setStatus({ message: `Could not load activity. ${describeError(e)}`, tone: 'error' });
      },
    );
  };

  useEffect(() => {
    load();
  }, [client]);

  const undo = (e: AuditEntry): void => {
    if (inFlight.current.has(e.seq)) return;
    inFlight.current.add(e.seq);
    setBusy(new Set(inFlight.current));
    client.send('audit.undo', { seq: e.seq }).then(
      () => {
        setEntries((cur) => cur.map((x) => (x.seq === e.seq && x.undo ? { ...x, undo: { ...x.undo, done: true } } : x)));
        setStatus({ message: `Undone: ${what(e)}.`, tone: 'ok' });
        load(undefined, Math.max(pageSize, entries.length + 1)); // shows the new `undo` row
      },
      (err: unknown) => {
        setStatus({ message: `Could not undo. ${describeError(err)}`, tone: 'error' });
      },
    ).finally(() => {
      inFlight.current.delete(e.seq);
      setBusy(new Set(inFlight.current));
    });
  };

  return (
    <div class="sbw-activity">
      <Status message={status.tone === 'ok' ? status.message : ''} tone="ok" />
      {status.tone === 'error' ? (
        <p class="sbw-status" role="alert" data-tone="error">
          <strong>Problem: </strong>
          {status.message}
        </p>
      ) : null}
      {loaded && entries.length === 0 ? <p>Nothing has happened yet.</p> : null}
      <ul class="sbw-activity-list" aria-label="Activity">
        {entries.map((e) => (
          <li key={e.seq} class="sbw-activity-row">
            <span class="sbw-activity-time">
              <PacificTime ms={e.at} userTz={userTz} />
            </span>{' '}
            <span class="sbw-activity-kind">{e.kind}</span>
            {e.dryRun === true ? <span class="sbw-activity-dry"> (dry run)</span> : null}{' '}
            <span class="sbw-activity-actor">by {e.actor}</span>
            <div class="sbw-activity-summary">{summary(e)}</div>
            {e.undo && !UNDOABLE_KINDS.has(e.undo.kind) ? (
              <button type="button" disabled aria-label={`Undo not available yet: ${what(e)}, ${e.kind} #${String(e.seq)}`}>
                Undo not available yet
              </button>
            ) : e.undo ? (
              <button
                type="button"
                disabled={e.undo.done === true || busy.has(e.seq)}
                aria-label={`${e.undo.done === true ? 'Undone' : 'Undo'}: ${what(e)}${e.itemId === undefined ? '' : ` for item ${String(e.itemId)}`}, ${e.kind} #${String(e.seq)}`}
                onClick={() => {
                  undo(e);
                }}
              >
                {e.undo.done === true ? 'Undone' : 'Undo'}
              </button>
            ) : null}
          </li>
        ))}
      </ul>
      {more ? (
        <button
          type="button"
          onClick={() => {
            const last = entries[entries.length - 1];
            if (last) load(last.seq);
          }}
        >
          Load more
        </button>
      ) : null}
    </div>
  );
}
