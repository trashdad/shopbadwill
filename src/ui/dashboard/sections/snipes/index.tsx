// T-85: the dashboard Snipes section (I-06 registry, section "Snipes"):
//   - the exposure meter (R4), the one component from src/ui/exposure/**,
//     showing open exposure plus spent/unconfirmed today against the daily cap;
//   - the prepare/arm form (R3) with its money guards and typed confirmation;
//   - the per-snipe countdown from the sbw:snipe-countdown port (R5), with the
//     reconnect T-54's dashboard uses (connectResilient);
//   - disarm through snipe.disarm;
//   - the outcome list (R6) with each outcome's own classifier copy (a
//     non-final win shows "Leading").
//
// The "Snipe…" deep link arrives as a re-send of ui.openSnipe from the
// background (src/background/handlers/open-snipe.ts): the section listens with
// the client's broadcast mechanism and only pre-fills its form — arming goes
// through snipe.arm alone (R1, R2).
import type { VNode } from 'preact';
import { useEffect, useState } from 'preact/hooks';

import { formatMoney } from '../../../../domain/money';
import type { Snipe, SnipeState } from '../../../../domain/snipe/types';
import type { ItemId } from '../../../../domain/types';
import { PORT_NAMES, type SnipeCountdownTick } from '../../../../messaging/protocol';
import { describeError } from '../../../components/describeError';
import { ExposureMeter, measureExposure } from '../../../exposure';
import { Money } from '../../../money';
import { PacificTime, RelativeTime } from '../../../time';
import { ErrorAlert, LoadNotice, useLoad } from '../../parts';
import { connectResilient } from '../../reconnect';
import type { SectionDef, SectionProps } from '../../registry';
import { ArmForm, DRY_RUN_LABEL } from './arm-form';
import { outcomeDisplay } from './outcome-copy';

/** States in which the fire moment still matters. */
const OPEN_STATES: ReadonlySet<SnipeState> = new Set(['armed', 'fallback-applied', 'waking', 'verified', 'firing', 'sent']);
const TERMINAL: ReadonlySet<SnipeState> = new Set(['resolved', 'killed']);

const STATE_TEXT: Readonly<Record<SnipeState, string>> = {
  draft: 'Draft',
  armed: 'Armed',
  'fallback-applied': 'Early proxy bid placed',
  waking: 'Waking (measuring the clock)',
  verified: 'Verified',
  firing: 'Firing',
  sent: 'Bid sent — waiting for the outcome',
  resolved: 'Finished',
  killed: 'Stopped',
};

const itemUrl = (id: ItemId): string => `https://shopgoodwill.com/item/${String(id)}`;

/**
 * Item id from a dashboard URL `?item=` (the tab opened when the side panel
 * refuses). Junk, zero and non-integers are ignored so a bad query never prepares.
 */
export function itemIdFromSearch(search: string): ItemId | null {
  const raw = new URLSearchParams(search).get('item');
  if (raw === null || !/^[1-9]\d*$/.test(raw)) return null;
  const id = Number(raw);
  // Reject values that do not survive the number conversion unchanged (too big to be a safe integer).
  return Number.isSafeInteger(id) && String(id) === raw ? id : null;
}

function SnipeRow(props: {
  snipe: Snipe;
  tick: SnipeCountdownTick | undefined;
  tz: string;
  busy: boolean;
  onDisarm: () => void;
}): VNode {
  const { snipe, tick } = props;
  const state = tick?.state ?? snipe.state;
  const target = tick?.fireAt ?? snipe.fireAt;
  const now = tick?.serverNow ?? Date.now();
  const endMs = new Date(snipe.endTime).getTime();
  const counting = target !== undefined && OPEN_STATES.has(state) && state !== 'sent';
  return (
    <li class="sbw-watch" data-snipe-id={snipe.id} data-state={state}>
      <div class="sbw-row">
        <h3>
          <a href={itemUrl(snipe.itemId)} target="_blank" rel="noopener noreferrer">
            {snipe.title === '' ? `Item ${String(snipe.itemId)}` : snipe.title}
          </a>
        </h3>
        {snipe.dryRun ? <span class="sbw-tag">{DRY_RUN_LABEL}</span> : null}
      </div>
      <p class="sbw-meta">
        {STATE_TEXT[state]}
        {counting ? (
          <>
            {' · fires '}
            <RelativeTime ms={target} now={now} />
          </>
        ) : null}
        <br />
        Ends <PacificTime ms={endMs} userTz={props.tz} /> · max <Money cents={snipe.maxBid} />
      </p>
      {state === 'sent' ? (
        // The reducer refuses every disarm after `sent` (the kill switch's too):
        // offering the button would suggest the bid can still be stopped.
        <p class="sbw-warn">A bid may already be out: it cannot be stopped now.</p>
      ) : (
        <button type="button" class="sbw-secondary" disabled={props.busy} aria-label={`Disarm ${snipe.title}`} onClick={props.onDisarm}>
          Disarm
        </button>
      )}
    </li>
  );
}

function OutcomeRow(props: { snipe: Snipe; tz: string }): VNode {
  const { snipe } = props;
  const o = outcomeDisplay(snipe, props.tz);
  if (o === null) {
    return (
      <li class="sbw-watch">
        <p class="sbw-muted">Finished.</p>
      </li>
    );
  }
  return (
    <li class="sbw-watch" data-outcome={o.outcome}>
      <p>
        <strong>{o.title}</strong>
        {snipe.dryRun ? <span class="sbw-tag">{DRY_RUN_LABEL}</span> : null}
      </p>
      <p>{o.message}</p>
    </li>
  );
}

export function SnipesSection(props: SectionProps): VNode {
  const { client } = props;
  const [settings, reloadSettings] = useLoad(() => client.send('settings.get', undefined), [client]);
  const [snipes, reloadSnipes] = useLoad(() => client.send('snipe.list', undefined), [client]);
  const [ticks, setTicks] = useState<ReadonlyMap<string, SnipeCountdownTick>>(new Map());
  const [openItem, setOpenItem] = useState<ItemId | null>(() => itemIdFromSearch(globalThis.location.search));
  const [disarming, setDisarming] = useState<string | null>(null);
  const [disarmError, setDisarmError] = useState('');

  // R5: the countdown stream, reconnecting on port drop (an MV3 worker restart),
  // then re-fetching what was missed — the same resilience T-54's dashboard uses.
  useEffect(
    () =>
      connectResilient(
        client,
        PORT_NAMES.snipeCountdown,
        (t) => {
          setTicks((prev) => {
            const next = new Map(prev);
            next.set(t.snipeId, t);
            return next;
          });
        },
        () => {
          setTicks(new Map());
          reloadSettings();
          reloadSnipes();
        },
      ),
    [client],
  );

  // The "Snipe…" deep link: the background re-sends ui.openSnipe to extension
  // pages after opening the dashboard (handlers/open-snipe.ts). A fallback tab
  // also arrives with `?item=` (read above), because this message can land
  // before the new page is listening.
  // TODO(protocol): ui.openSnipe is not in the frozen broadcast union, so the
  // subscription is cast. The client delivers any background-sent message of
  // that type (it validates the same envelope). Replace the cast with a real
  // protocol channel; do not change the protocol in this card. It only
  // pre-fills the form — nothing here arms (R1, R2).
  useEffect(() => {
    const onBroadcast = client.onBroadcast.bind(client) as unknown as (type: string, cb: (payload: unknown) => void) => () => void;
    return onBroadcast('ui.openSnipe', (payload) => {
      const p = payload as { itemId?: unknown };
      if (typeof p.itemId === 'number' && Number.isSafeInteger(p.itemId) && p.itemId > 0) setOpenItem(p.itemId);
    });
  }, [client]);

  const s = settings.kind === 'ok' ? settings.value : null;
  const list = snipes.kind === 'ok' ? snipes.value : [];
  const open = list.filter((x) => !TERMINAL.has(x.state));
  const closed = list.filter((x) => TERMINAL.has(x.state));

  const disarm = (x: Snipe): void => {
    if (disarming !== null) return;
    setDisarming(x.id);
    setDisarmError('');
    client.send('snipe.disarm', { id: x.id }).then(
      () => {
        setDisarming(null);
        reloadSnipes();
      },
      (e: unknown) => {
        setDisarming(null);
        setDisarmError(`Could not disarm ${x.title}. ${describeError(e)}`);
      },
    );
  };

  const meter =
    s === null || snipes.kind !== 'ok'
      ? null
      : (() => {
          const m = measureExposure(list, Date.now(), s.locale.timeZone);
          const detail = [
            `${String(m.open.count)} armed${m.open.count === 1 ? ' snipe' : ' snipes'}`,
            m.open.shippingUnknown ? 'some shipping is unknown and counts as zero' : '',
            m.spentToday > 0 ? `${formatMoney(m.spentToday)} spent or unconfirmed today` : '',
          ]
            .filter((t) => t !== '')
            .join(' · ');
          return { m, detail };
        })();

  return (
    <div>
      <LoadNotice state={settings} what="snipe settings" />
      <LoadNotice state={snipes} what="snipes" />
      {s !== null && meter !== null ? (
        <ExposureMeter used={meter.m.used} cap={s.snipe.caps.perDayMax} detail={meter.detail === '' ? undefined : meter.detail} />
      ) : null}

      <ArmForm
        client={client}
        userTz={props.userTz}
        settings={s}
        snipes={list}
        openItem={openItem}
        onArmed={reloadSnipes}
      />

      <h3>Armed snipes</h3>
      {snipes.kind === 'ok' && open.length === 0 ? <p class="sbw-muted">No armed snipes.</p> : null}
      {open.length > 0 ? (
        <ul class="sbw-list" aria-label="Armed snipes">
          {open.map((x) => (
            <SnipeRow
              key={x.id}
              snipe={x}
              tick={ticks.get(x.id)}
              tz={props.userTz}
              busy={disarming === x.id}
              onDisarm={() => {
                disarm(x);
              }}
            />
          ))}
        </ul>
      ) : null}

      <h3>Outcomes</h3>
      {snipes.kind === 'ok' && closed.length === 0 ? <p class="sbw-muted">No finished snipes.</p> : null}
      {closed.length > 0 ? (
        <ul class="sbw-list" aria-label="Snipe outcomes">
          {closed.map((x) => (
            <OutcomeRow key={x.id} snipe={x} tz={props.userTz} />
          ))}
        </ul>
      ) : null}
      <ErrorAlert message={disarmError} />
    </div>
  );
}

export const section: SectionDef = { id: 'snipes', title: 'Snipes', order: 35, Component: SnipesSection };
