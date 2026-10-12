// T-120: each listed item has the same audited "Stop tracking" as T-117's
// Calendar section (a confirm step, then `tracked.remove`). The copy names the
// calendar only for an item that is on it.
import type { VNode } from 'preact';
import { useState } from 'preact/hooks';

import type { TrackedItem } from '../../../../domain/types';
import { describeError } from '../../../components/describeError';
import { Status } from '../../../components/Status';
import { PacificTime } from '../../../time';
import { ErrorAlert, LoadNotice, useLoad } from '../../parts';
import type { SectionDef, SectionProps } from '../../registry';

const SHOWN = 20;

/** `endTime` is canonical ISO UTC (IsoUtcSchema). */
const endMs = (t: TrackedItem): number => new Date(t.endTime).getTime();
/** Site-derived title, shown as a text node only. */
const titleOf = (t: TrackedItem): string => (t.title === '' ? `Item ${String(t.itemId)}` : t.title);

interface StopTracking {
  busy: boolean;
  /** `${list label}:${itemId}` of the row whose confirm step is open. */
  confirming: string | null;
  setConfirming: (key: string | null) => void;
  stop: (t: TrackedItem) => void;
}

function ItemList(props: { items: readonly TrackedItem[]; tz: string; empty: string; label: string; stop: StopTracking }): VNode {
  const { stop } = props;
  if (props.items.length === 0) return <p class="sbw-muted">{props.empty}</p>;
  return (
    <ul class="sbw-list" aria-label={props.label}>
      {props.items.slice(0, SHOWN).map((t) => (
        <li key={t.itemId}>
          {/* Site-derived title: rendered as a text node only. */}
          <a href={`https://shopgoodwill.com/item/${String(t.itemId)}`} target="_blank" rel="noopener noreferrer">
            {titleOf(t)}
          </a>
          <div class="sbw-meta">
            Ends <PacificTime ms={endMs(t)} userTz={props.tz} />
            {t.favoriteState === 'failed' ? <span class="sbw-tag"> favorite failed</span> : null}
            {t.favoriteState === 'queued' ? <span class="sbw-tag"> favorite queued</span> : null}{' '}
            <button
              type="button"
              disabled={stop.busy}
              aria-label={`Stop tracking ${titleOf(t)}`}
              onClick={() => {
                stop.setConfirming(`${props.label}:${String(t.itemId)}`);
              }}
            >
              Stop tracking
            </button>
          </div>
          {stop.confirming === `${props.label}:${String(t.itemId)}` ? (
            <div>
              <p>
                {t.calendar
                  ? `Stop tracking ${titleOf(t)}? Its event will be removed from your "ShopGoodwill Auctions" calendar, the dedicated calendar this extension made. Nothing else in your Google Calendar is touched, and nothing changes in your ShopGoodwill favorites.`
                  : `Stop tracking ${titleOf(t)}? It leaves this list. Nothing changes in your ShopGoodwill favorites.`}
              </p>
              <button type="button" disabled={stop.busy} onClick={() => {
                stop.stop(t);
              }}>
                Yes, stop tracking
              </button>{' '}
              <button type="button" onClick={() => {
                stop.setConfirming(null);
              }}>
                Cancel
              </button>
            </div>
          ) : null}
        </li>
      ))}
      {props.items.length > SHOWN ? <li class="sbw-muted">and {props.items.length - SHOWN} more</li> : null}
    </ul>
  );
}

export function MatchesSection(props: SectionProps): VNode {
  const { client } = props;
  const [tracked, reload] = useLoad(() => client.send('tracked.list', undefined), [client]);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);

  const sync = (): void => {
    if (busy) return;
    setBusy(true);
    setError('');
    setStatus('');
    client.send('favorites.sync', undefined).then(
      () => {
        setBusy(false);
        setStatus('Favorites synced.');
        reload();
      },
      (e: unknown) => {
        setBusy(false);
        setError(`Could not sync favorites. ${describeError(e)}`);
      },
    );
  };

  const stopTracking = async (t: TrackedItem): Promise<void> => {
    setConfirming(null);
    setBusy(true);
    setError('');
    setStatus('');
    try {
      await client.send('tracked.remove', { itemId: t.itemId });
      // Same honest copy as the Calendar section (T-117); calendar words only for an item on the calendar.
      const dryRun = t.calendar
        ? await client.send('settings.get', undefined).then(
            (s) => s.dryRun.calendar,
            () => undefined,
          )
        : undefined;
      setStatus(
        dryRun === true
          ? 'Stopped tracking. Calendar dry run is on, so the event was not removed.'
          : dryRun === false
            ? `Stopped tracking ${titleOf(t)}. Its event leaves your calendar at the next sync.`
            : `Stopped tracking ${titleOf(t)}.`,
      );
    } catch (e) {
      setError(`Could not stop tracking ${titleOf(t)}. ${describeError(e)}`);
    } finally {
      setBusy(false);
      reload();
    }
  };
  const stop: StopTracking = {
    busy,
    confirming,
    setConfirming,
    stop: (t) => void stopTracking(t),
  };

  const items = tracked.kind === 'ok' ? tracked.value : [];
  const matches = items.filter((t) => t.reasons.some((r) => r.kind === 'watch')).sort((a, b) => b.addedAt - a.addedAt);
  const favorites = items
    .filter((t) => t.favoriteState === 'favorited')
    .sort((a, b) => endMs(a) - endMs(b));

  return (
    <div>
      <LoadNotice state={tracked} what="matches" />
      {tracked.kind === 'ok' ? (
        <>
          <h3>Matches</h3>
          <ItemList items={matches} tz={props.userTz} empty="No matches yet." label="Matches" stop={stop} />
          <h3>Favorites</h3>
          <ItemList items={favorites} tz={props.userTz} empty="No favorites yet." label="Favorites" stop={stop} />
        </>
      ) : null}
      <p>
        <button type="button" disabled={busy} onClick={sync}>
          Sync favorites
        </button>
      </p>
      <Status message={status} />
      <ErrorAlert message={error} />
    </div>
  );
}

export const section: SectionDef = { id: 'matches', title: 'Matches and favorites', order: 20, Component: MatchesSection };
