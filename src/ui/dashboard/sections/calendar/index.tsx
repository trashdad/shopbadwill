// T-67: the dashboard's Calendar section (I-06 registry, I-10). Shows whether Google
// Calendar is connected, lets the user connect, disconnect and sync now, and
// downloads a .ics file (T-68's buildIcs, through `calendar.ics`) that needs no
// Google at all. Every control is a native button; results use role="status" or
// role="alert".
import type { VNode } from 'preact';
import { useState } from 'preact/hooks';

import type { AuthStatus } from '../../../../domain/calendar/types';
import { describeError } from '../../../components/describeError';
import { ErrorAlert, LoadNotice, useLoad } from '../../parts';
import type { SectionDef, SectionProps } from '../../registry';

export function describeStatus(s: AuthStatus): string {
  if (!s.configured && !s.connected) return 'Google Calendar is not set up. Add your OAuth client in the options page first.';
  if (!s.connected) return 'Not connected. Events are queued as pending and are added after you connect.';
  if (s.needsInteraction) return 'Google needs you to reconnect. Events are queued as pending until you do.';
  return `Connected${s.account === undefined ? '' : ` as ${s.account}`}.`;
}

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
  const connected = status.kind === 'ok' && status.value.connected;

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
      <p class="sbw-muted">The .ics file works without Google. Google may ignore its reminders when you import it; Apple and Outlook keep them.</p>
      {note === '' ? null : <p role="status">{note}</p>}
      <ErrorAlert message={error} />
    </div>
  );
}

export const section: SectionDef = { id: 'calendar', title: 'Calendar', order: 50, Component: CalendarSection };
