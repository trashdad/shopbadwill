// T-124: the item page action panel's view: big buttons beside SGW's bid area
// (src/content/item-panel.ts places it and owns the state). Pure: it renders
// what `model` says and calls back on TRUSTED clicks only (a page script's
// synthetic click does nothing). Text only (Preact text nodes; never markup).
//
// - Snipe… only sends `ui.openSnipe` (the dashboard arms; nothing arms here).
//   With an open snipe it reads "Snipe armed: max $X · Open" and opens it.
// - Track / Stop tracking (behind a confirm step). Stop is unavailable while a
//   snipe is open, as in the dashboard (T-122): tracked.remove leaves snipes be.
// - An ended auction shows the status only: no Snipe…, no Track, no Stop.
import type { VNode } from 'preact';

import { formatMoney } from '../../domain/money';
import type { Cents } from '../../domain/types';

export interface PanelSnipe {
  maxBid: Cents;
  dryRun: boolean;
  /** The bid already went out (state `sent`): waiting for the result. */
  sent: boolean;
}

export interface PanelModel {
  /** Storage has been read; until then no Track / Stop is offered. */
  loaded: boolean;
  ended: boolean;
  tracked: boolean;
  /** Tracked, wanted on the calendar, AND our event is synced there. */
  onCalendar: boolean;
  snipe: PanelSnipe | null;
  /** No snipe yet and `dryRun.bidding` is on: a snipe armed now would not bid. */
  biddingDryRun: boolean;
  /** Tracked for the calendar, calendar sync on, and `dryRun.calendar` on: nothing is written to Google. */
  calendarDryRun: boolean;
}

export interface PanelUi {
  busy: boolean;
  confirming: boolean;
  message: { text: string; alert: boolean } | null;
}

export interface ItemPanelProps {
  model: PanelModel;
  ui: PanelUi;
  onSnipe: () => void;
  onTrack: () => void;
  onAskStop: () => void;
  onConfirmStop: () => void;
  onCancelStop: () => void;
}

/** Wraps a callback so only a trusted (real user) click reaches it. */
const trusted =
  (fn: () => void) =>
  (e: Event): void => {
    if (e.isTrusted) fn();
  };

function snipeLine(s: PanelSnipe | null): string {
  if (s === null) return 'No snipe set';
  const what = s.sent ? 'Snipe bid sent' : 'Snipe armed';
  return `${what}: max ${formatMoney(s.maxBid)}${s.dryRun ? ' (dry run)' : ''}`;
}

function StatusLines({ model }: { model: PanelModel }): VNode {
  const lines: Array<{ text: string; dry?: boolean }> = [];
  if (model.ended) lines.push({ text: 'This auction has ended' });
  if (!model.loaded) lines.push({ text: 'Checking…' });
  else {
    lines.push({ text: model.tracked ? (model.onCalendar ? 'Tracked · On your calendar' : 'Tracked') : 'Not tracked' });
    lines.push({ text: snipeLine(model.snipe) });
    if (model.snipe === null && model.biddingDryRun && !model.ended) lines.push({ text: 'Dry run: a snipe set now will not bid', dry: true });
    if (model.calendarDryRun) lines.push({ text: 'Calendar dry run: nothing is written to your calendar', dry: true });
  }
  return (
    <ul class="lines" role="status" aria-live="polite">
      {lines.map((l) => (
        <li key={l.text} class={l.dry === true ? 'dry' : undefined}>
          {l.text}
        </li>
      ))}
    </ul>
  );
}

function Actions(p: ItemPanelProps): VNode | null {
  const { model, ui } = p;
  if (model.ended) return null;
  const snipe =
    model.snipe === null ? (
      <button type="button" class="big" data-action="panel-snipe" title="Open the dashboard to set a snipe (never arms from here)" onClick={trusted(p.onSnipe)}>
        Snipe…
      </button>
    ) : (
      <button type="button" class="big" data-action="panel-snipe" title="Open this snipe in the dashboard" onClick={trusted(p.onSnipe)}>
        {`${snipeLine(model.snipe)} · Open`}
      </button>
    );
  if (!model.loaded) return snipe;
  if (!model.tracked) {
    return (
      <>
        {snipe}
        <button type="button" class="big secondary" data-action="panel-track" disabled={ui.busy} onClick={trusted(p.onTrack)}>
          Track
        </button>
      </>
    );
  }
  if (model.snipe !== null) {
    return (
      <>
        {snipe}
        <button type="button" class="big secondary" data-action="panel-stop" disabled>
          Stop tracking
        </button>
        <p class="note">Cancel the snipe first (in the dashboard).</p>
      </>
    );
  }
  if (ui.confirming) {
    return (
      <>
        {snipe}
        <p class="confirm">
          {model.onCalendar ? 'Stop tracking this item? Its event leaves your calendar at the next sync.' : 'Stop tracking this item?'}
        </p>
        <button type="button" class="big danger" data-action="panel-stop-yes" disabled={ui.busy} onClick={trusted(p.onConfirmStop)}>
          Yes, stop tracking
        </button>
        <button type="button" class="big secondary" data-action="panel-stop-cancel" disabled={ui.busy} onClick={trusted(p.onCancelStop)}>
          Cancel
        </button>
      </>
    );
  }
  return (
    <>
      {snipe}
      <button type="button" class="big secondary" data-action="panel-stop" disabled={ui.busy} onClick={trusted(p.onAskStop)}>
        Stop tracking
      </button>
    </>
  );
}

export function ItemPanelView(p: ItemPanelProps): VNode {
  const { message } = p.ui;
  return (
    <section class="panel" aria-label="ShopBadwill">
      <p class="head">ShopBadwill</p>
      <StatusLines model={p.model} />
      <Actions {...p} />
      {message === null ? null : (
        <p class={message.alert ? 'msg alert' : 'msg'} role={message.alert ? 'alert' : 'status'}>
          {message.text}
        </p>
      )}
    </section>
  );
}
