// T-67: the dashboard's Calendar section (I-06 registry, I-10). Shows whether Google
// Calendar is connected, lets the user connect, disconnect and sync now, and
// downloads a .ics file (T-68's buildIcs, through `calendar.ics`) that needs no
// Google at all. Every control is a native button; results use role="status" or
// role="alert".
//
// T-117: the auctions on the calendar, each with "Stop tracking". A confirm
// step says the event leaves our dedicated calendar; Yes sends the existing
// `tracked.remove` (the background audits it; the sync then deletes our event
// and audits that). There is no undo: re-tracking has no audit undo kind.
import type { VNode } from 'preact';
import { useState } from 'preact/hooks';

import type { AuthStatus } from '../../../../domain/calendar/types';
import type { TrackedItem } from '../../../../domain/types';
import { describeError } from '../../../components/describeError';
import { PacificTime } from '../../../time';
import { ErrorAlert, LoadNotice, useLoad } from '../../parts';
import type { SectionDef, SectionProps } from '../../registry';

export function describeStatus(s: AuthStatus): string {
  if (!s.configured && !s.connected) return 'Google Calendar is not set up. Add your OAuth client in the options page first.';
  if (!s.connected) return 'Not connected. Events are queued as pending and are added after you connect.';
  if (s.needsInteraction) return 'Google needs you to reconnect. Events are queued as pending until you do.';
  return `Connected${s.account === undefined ? '' : ` as ${s.account}`}.`;
}

/** Site-derived title, shown as a text node only. */
const titleOf = (t: TrackedItem): string => (t.title === '' ? `Item ${String(t.itemId)}` : t.title);

/** Saves `ics` as a file through a temporary link. */
function download(ics: string): void {
  const url = URL.createObjectURL(new Blob([ics], { type: 'text/calendar' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = 'shopbadwill-auctions.ics';
  document.body.append(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export function CalendarSection(props: SectionProps): VNode {
  const { client } = props;
  // A missing handler reads as "unavailable", like every other section (T-54's useLoad).
  const [status, refresh] = useLoad(() => client.send('calendar.status', undefined), [client]);
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [tracked, reloadTracked] = useLoad(() => client.send('tracked.list', undefined), [client]);
  /** The item whose "Stop tracking" awaits confirmation. */
  const [confirming, setConfirming] = useState<TrackedItem | null>(null);
  const connected = status.kind === 'ok' && status.value.connected;
  const onCalendar = tracked.kind === 'ok' ? tracked.value.filter((t) => t.calendar) : [];

  const act = async (label: string, fn: () => Promise<void>): Promise<void> => {
    setBusy(true);
    setError('');
    setNote('');
    try {
      await fn();
      setNote(label);
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
      refresh();
    }
  };

  const stopTracking = async (t: TrackedItem): Promise<void> => {
    setConfirming(null);
    setBusy(true);
    setError('');
    setNote('');
    try {
      await client.send('tracked.remove', { itemId: t.itemId });
      setNote(`Stopped tracking ${titleOf(t)}. Its event leaves your calendar at the next sync.`);
    } catch (e) {
      setError(`Could not stop tracking ${titleOf(t)}. ${describeError(e)}`);
    } finally {
      setBusy(false);
      reloadTracked();
    }
  };

  return (
    <div>
      {status.kind === 'ok' ? <p>{describeStatus(status.value)}</p> : <LoadNotice state={status} what="Calendar status" />}
      <p class="sbw-muted">Reminders go off 60, 15 and 5 minutes before an auction ends, on your own "ShopGoodwill Auctions" calendar.</p>
      <div>
        <button
          type="button"
          disabled={busy}
          onClick={() =>
            void act('Connected.', async () => {
              await client.send('calendar.connect', undefined);
            })
          }
        >
          Connect Google Calendar
        </button>{' '}
        <button
          type="button"
          disabled={busy || !connected}
          onClick={() => void act('Disconnected.', () => client.send('calendar.disconnect', undefined).then(() => undefined))}
        >
          Disconnect
        </button>{' '}
        <button
          type="button"
          disabled={busy}
          onClick={() => void act('Sync finished.', () => client.send('calendar.syncNow', undefined).then(() => undefined))}
        >
          Sync now
        </button>{' '}
        <button
          type="button"
          disabled={busy}
          onClick={() =>
            void act('Downloaded.', async () => {
              const tracked = await client.send('tracked.list', undefined);
              const itemIds = tracked.filter((t) => t.calendar).map((t) => t.itemId);
              download((await client.send('calendar.ics', { itemIds })).ics);
            })
          }
        >
          Download .ics file
        </button>
      </div>
      <h3>Auctions on your calendar</h3>
      <LoadNotice state={tracked} what="Tracked auctions" />
      {tracked.kind === 'ok' && onCalendar.length === 0 ? <p class="sbw-muted">No tracked auctions are on your calendar.</p> : null}
      {onCalendar.length > 0 ? (
        <ul class="sbw-list" aria-label="Auctions on your calendar">
          {onCalendar.map((t) => (
            <li key={t.itemId}>
              <span>{titleOf(t)}</span>
              <div class="sbw-meta">
                Ends <PacificTime ms={new Date(t.endTime).getTime()} userTz={props.userTz} />{' '}
                <button
                  type="button"
                  disabled={busy}
                  aria-label={`Stop tracking ${titleOf(t)}`}
                  onClick={() => {
                    setConfirming(t);
                  }}
                >
                  Stop tracking
                </button>
              </div>
              {confirming?.itemId === t.itemId ? (
                <div>
                  <p>
                    Stop tracking {titleOf(t)}? Its event will be removed from your "ShopGoodwill Auctions" calendar, the dedicated
                    calendar this extension made. Nothing else in your Google Calendar is touched, and nothing changes in your
                    ShopGoodwill favorites.
                  </p>
                  <button type="button" disabled={busy} onClick={() => void stopTracking(t)}>
                    Yes, stop tracking
                  </button>{' '}
                  <button type="button" onClick={() => {
                    setConfirming(null);
                  }}>
                    Cancel
                  </button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      <p class="sbw-muted">The .ics file works without Google. Google may ignore its reminders when you import it; Apple and Outlook keep them.</p>
      {note === '' ? null : <p role="status">{note}</p>}
      <ErrorAlert message={error} />
    </div>
  );
}

export const section: SectionDef = { id: 'calendar', title: 'Calendar', order: 50, Component: CalendarSection };
