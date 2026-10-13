// T-120: each listed item has the same audited "Stop tracking" as T-117's
// Calendar section (a confirm step, then `tracked.remove`). The copy names the
// calendar only for an item that is on it. The list and the flow live in
// ../../tracked-list (T-122 shares them).
import type { VNode } from 'preact';
import { useState } from 'preact/hooks';

import { describeError } from '../../../components/describeError';
import { Status } from '../../../components/Status';
import { ErrorAlert, LoadNotice, useLoad } from '../../parts';
import type { SectionDef, SectionProps } from '../../registry';
import { endMs, inFavorites, inMatches, ItemList, useStopTracking } from '../../tracked-list';

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

  const stop = useStopTracking({ client, reload, busy, setBusy, setStatus, setError });

  const items = tracked.kind === 'ok' ? tracked.value : [];
  const matches = items.filter(inMatches).sort((a, b) => b.addedAt - a.addedAt);
  const favorites = items.filter(inFavorites).sort((a, b) => endMs(a) - endMs(b));

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
