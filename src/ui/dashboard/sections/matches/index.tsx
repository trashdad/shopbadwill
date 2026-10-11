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

function ItemList(props: { items: readonly TrackedItem[]; tz: string; empty: string; label: string }): VNode {
  if (props.items.length === 0) return <p class="sbw-muted">{props.empty}</p>;
  return (
    <ul class="sbw-list" aria-label={props.label}>
      {props.items.slice(0, SHOWN).map((t) => (
        <li key={t.itemId}>
          {/* Site-derived title: rendered as a text node only. */}
          <a href={`https://shopgoodwill.com/item/${String(t.itemId)}`} target="_blank" rel="noopener noreferrer">
            {t.title === '' ? `Item ${String(t.itemId)}` : t.title}
          </a>
          <div class="sbw-meta">
            Ends <PacificTime ms={endMs(t)} userTz={props.tz} />
            {t.favoriteState === 'failed' ? <span class="sbw-tag"> favorite failed</span> : null}
            {t.favoriteState === 'queued' ? <span class="sbw-tag"> favorite queued</span> : null}
          </div>
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
          <ItemList items={matches} tz={props.userTz} empty="No matches yet." label="Matches" />
          <h3>Favorites</h3>
          <ItemList items={favorites} tz={props.userTz} empty="No favorites yet." label="Favorites" />
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
