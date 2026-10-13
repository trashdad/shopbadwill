// T-122: "Other tracked items": every tracked item no other list shows (not a
// watch match, not a favorite, not on the calendar), e.g. one tracked only by
// hand or only because a snipe was set on it. Each row has the same audited
// "Stop tracking" as T-117/T-120 (`tracked.remove`, unchanged).
//
// `tracked.remove` does not touch snipes, so an item with an open snipe (any
// state before resolved/killed) cannot be stopped here: the button is disabled
// with "Cancel the snipe first", and it stays disabled until `snipe.list` has
// been read, so a snipe is never left behind silently. Reads only storage
// (`tracked.list`, `snipe.list`): no SGW or Google request.
import type { VNode } from 'preact';
import { useState } from 'preact/hooks';

import type { SnipeState } from '../../../../domain/snipe/types';
import type { TrackedItem } from '../../../../domain/types';
import { Status } from '../../../components/Status';
import { ErrorAlert, LoadNotice, useLoad } from '../../parts';
import type { SectionDef, SectionProps } from '../../registry';
import { endMs, inFavorites, inMatches, ItemList, onCalendar, useStopTracking } from '../../tracked-list';

const DONE: ReadonlySet<SnipeState> = new Set(['resolved', 'killed']);

export function TrackedSection(props: SectionProps): VNode {
  const { client } = props;
  const [tracked, reload] = useLoad(() => client.send('tracked.list', undefined), [client]);
  const [snipes, reloadSnipes] = useLoad(() => client.send('snipe.list', undefined), [client]);
  const [status, setStatus] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const stop = useStopTracking({
    client,
    reload: () => {
      reload();
      reloadSnipes();
    },
    busy,
    setBusy,
    setStatus,
    setError,
  });

  const others = (tracked.kind === 'ok' ? tracked.value : [])
    .filter((t) => !inMatches(t) && !inFavorites(t) && !onCalendar(t))
    .sort((a, b) => endMs(a) - endMs(b));
  const sniped = new Set(snipes.kind === 'ok' ? snipes.value.filter((s) => !DONE.has(s.state)).map((s) => s.itemId) : []);
  const blocked = (t: TrackedItem): string | null => {
    if (snipes.kind === 'loading') return 'Checking for snipes…';
    if (snipes.kind !== 'ok') return 'Snipes could not be read, so this is unavailable.';
    return sniped.has(t.itemId) ? 'Cancel the snipe first (in Snipes).' : null;
  };

  return (
    <div>
      <LoadNotice state={tracked} what="tracked items" />
      {tracked.kind === 'ok' ? (
        <>
          <p class="sbw-muted">Tracked items that are not in Matches, Favorites or Calendar, such as ones you tracked by hand or set a snipe on.</p>
          <ItemList items={others} tz={props.userTz} empty="No other tracked items." label="Other tracked items" stop={stop} blocked={blocked} />
        </>
      ) : null}
      <Status message={status} />
      <ErrorAlert message={error} />
    </div>
  );
}

export const section: SectionDef = { id: 'tracked', title: 'Other tracked items', order: 25, Component: TrackedSection };
