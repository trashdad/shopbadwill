// T-120's tracked-item list with the audited "Stop tracking" (a confirm step,
// then `tracked.remove`), shared by Matches/Favorites and T-122's "Other
// tracked items". The copy names the calendar only for an item that is on it.
import type { VNode } from 'preact';
import { useState } from 'preact/hooks';

import type { TrackedItem } from '../../domain/types';
import type { MessagingClient } from '../../ports/messaging';
import { describeError } from '../components/describeError';
import { PacificTime } from '../time';

const SHOWN = 20;

/** `endTime` is canonical ISO UTC (IsoUtcSchema). */
export const endMs = (t: TrackedItem): number => new Date(t.endTime).getTime();
/** Site-derived title, shown as a text node only. */
export const titleOf = (t: TrackedItem): string => (t.title === '' ? `Item ${String(t.itemId)}` : t.title);

export interface StopTracking {
  busy: boolean;
  /** `${list label}:${itemId}` of the row whose confirm step is open. */
  confirming: string | null;
  setConfirming: (key: string | null) => void;
  stop: (t: TrackedItem) => void;
}

/** The T-117/T-120 stop-tracking flow. `busy` is shared with the caller's other actions. */
export function useStopTracking(opts: {
  client: MessagingClient;
  reload: () => void;
  busy: boolean;
  setBusy: (b: boolean) => void;
  setStatus: (s: string) => void;
  setError: (s: string) => void;
}): StopTracking {
  const { client, reload, setBusy, setStatus, setError } = opts;
  const [confirming, setConfirming] = useState<string | null>(null);

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
  return { busy: opts.busy, confirming, setConfirming, stop: (t) => void stopTracking(t) };
}

export function ItemList(props: {
  items: readonly TrackedItem[];
  tz: string;
  empty: string;
  label: string;
  stop: StopTracking;
  /** T-122: why this row's Stop tracking is unavailable (shown beside the disabled button), or null. */
  blocked?: (t: TrackedItem) => string | null;
}): VNode {
  const { stop } = props;
  if (props.items.length === 0) return <p class="sbw-muted">{props.empty}</p>;
  return (
    <ul class="sbw-list" aria-label={props.label}>
      {props.items.slice(0, SHOWN).map((t) => {
        const blocked = props.blocked?.(t) ?? null;
        return (
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
                disabled={stop.busy || blocked !== null}
                aria-label={`Stop tracking ${titleOf(t)}`}
                onClick={() => {
                  stop.setConfirming(`${props.label}:${String(t.itemId)}`);
                }}
              >
                Stop tracking
              </button>
              {blocked === null ? null : <span class="sbw-muted"> {blocked}</span>}
            </div>
            {blocked === null && stop.confirming === `${props.label}:${String(t.itemId)}` ? (
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
        );
      })}
      {props.items.length > SHOWN ? <li class="sbw-muted">and {props.items.length - SHOWN} more</li> : null}
    </ul>
  );
}

/** The predicates of the lists that already offer Stop tracking (T-117 Calendar, T-120 Matches/Favorites). */
export const inMatches = (t: TrackedItem): boolean => t.reasons.some((r) => r.kind === 'watch');
export const inFavorites = (t: TrackedItem): boolean => t.favoriteState === 'favorited';
export const onCalendar = (t: TrackedItem): boolean => t.calendar;
