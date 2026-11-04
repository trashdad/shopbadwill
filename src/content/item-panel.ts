// T-124: the item page action panel (ISOLATED world), driven by sgw-overlay.ts.
//
// - Where: right after SGW's bidding control (findItemBidArea, the DomAdapter's
//   ranked selectors), as a sibling so SGW's own component content is never
//   touched. With no anchor it floats bottom-right. Every update re-places it,
//   so an Angular re-render that drops it puts it back, and a stray host (an
//   older script's) is removed: one panel per page, ever.
// - State is read only, from storage.local (`sbw:tracked`, `sbw:snipes`,
//   `sbw:calendar`), like T-115's badges: no protocol message for state, and
//   no SGW request at all. The page item's detail comes from the overlay (what
//   the api-tap relayed).
// - Out: `ui.openSnipe` (Snipe…), `tracked.add` (Track) and `tracked.remove`
//   (Stop tracking, after a confirm step), on trusted clicks only.
// - Never breaks the page: every step is guarded, and destroy() removes it all.
import { h } from 'preact';

import { findItemBidArea } from '../adapters/sgw/dom-adapter';
import type { Settings } from '../domain/settings/schema';
import { STORAGE_KEYS } from '../domain/storage/schema';
import type { ItemDetail, ItemId } from '../domain/types';
import type { MessagingClient } from '../ports/messaging';
import type { Storage } from '../ports/storage';
import { ItemPanelView, type PanelModel, type PanelSnipe, type PanelUi } from './ui/item-panel';
import { createUiHost, type UiHost } from './ui/shadow';
import { PANEL_CSS } from './ui/styles';

export const PANEL_ATTR = 'data-sbw-item-panel';
const PANEL_TAG = 'sbw-item-panel';
/** Snipe states that are still going to bid, or have bid and await the result (T-115's set, plus `sent`). */
const OPEN_SNIPE_STATES = new Set(['armed', 'fallback-applied', 'waking', 'verified', 'firing', 'sent']);
const KEYS = [STORAGE_KEYS.tracked, STORAGE_KEYS.snipes, STORAGE_KEYS.calendar] as const;
/** setTimeout's ceiling; an end further out is re-checked on the next update. */
const MAX_TIMER_MS = 2 ** 31 - 1;

export const PANEL_COPY = {
  tracked: 'Tracking this item.',
  trackFailed: 'Could not track this item. Reload the page and try again.',
  stopped: 'Stopped tracking.',
  stoppedCalendar: 'Stopped tracking. Its event leaves your calendar at the next sync.',
  stoppedCalendarDryRun: 'Stopped tracking. Calendar dry run is on, so no event was removed.',
  stopFailed: 'Could not stop tracking. Reload the page and try again.',
} as const;

export interface ItemPanelInput {
  itemId: ItemId;
  /** The page's own detail read (from the tap), or null before it arrives. */
  detail: ItemDetail | null;
  settings: Settings;
}

export interface ItemPanelDeps {
  doc: Document;
  /** storage.local; read only. */
  storage: Pick<Storage, 'get' | 'onChanged'>;
  client: MessagingClient;
  now: () => number;
}

export interface ItemPanel {
  /** Shows or refreshes the panel for this item; null removes it. */
  update(input: ItemPanelInput | null): void;
  destroy(): void;
}

type Rec = Record<string, unknown>;

function records(value: unknown): Rec[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return [];
  return Object.values(value).filter((v): v is Rec => typeof v === 'object' && v !== null);
}

function ms(iso: unknown): number | null {
  if (typeof iso !== 'string') return null;
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? null : t;
}

/** The tracked entry for the item, or null. Malformed records count as absent. */
function trackedOf(tracked: unknown, itemId: ItemId): Rec | null {
  return records(tracked).find((t) => t['itemId'] === itemId) ?? null;
}

/** The item's open snipe (the most recently armed, when several), or null. */
function openSnipeOf(snipes: unknown, itemId: ItemId): Rec | null {
  let best: Rec | null = null;
  for (const s of records(snipes)) {
    if (s['itemId'] !== itemId || typeof s['state'] !== 'string' || !OPEN_SNIPE_STATES.has(s['state'])) continue;
    if (typeof s['maxBid'] !== 'number' || !Number.isSafeInteger(s['maxBid']) || s['maxBid'] < 0) continue;
    const at = typeof s['armedAt'] === 'number' ? s['armedAt'] : 0;
    const bestAt = best !== null && typeof best['armedAt'] === 'number' ? best['armedAt'] : -1;
    if (at > bestAt) best = s;
  }
  return best;
}

/** Our event for the item is really on the calendar: a synced link. */
function synced(calendar: unknown, itemId: ItemId): boolean {
  if (typeof calendar !== 'object' || calendar === null) return false;
  const link = records((calendar as Rec)['links']).find((l) => l['itemId'] === itemId);
  return link?.['status'] === 'synced';
}

export function createItemPanel(deps: ItemPanelDeps): ItemPanel {
  const { doc, storage, client, now } = deps;
  let host: UiHost | null = null;
  let input: ItemPanelInput | null = null;
  /** Raw storage values; undefined until read for the current item. */
  let stored: Partial<Record<(typeof KEYS)[number], unknown>> = {};
  let loaded = false;
  let readGen = 0;
  let ui: PanelUi = { busy: false, confirming: false, message: null };
  let endTimer: ReturnType<typeof setTimeout> | undefined;
  let destroyed = false;

  const guard = (fn: () => void): void => {
    try {
      fn();
    } catch {
      /* never break the page */
    }
  };

  const offStorage = storage.onChanged((changes) => {
    let hit = false;
    for (const key of KEYS) {
      const c = changes[key];
      if (c === undefined) continue;
      stored[key] = c.newValue;
      hit = true;
    }
    if (hit && input !== null) render();
  });

  function read(): void {
    const gen = ++readGen;
    loaded = false;
    stored = {};
    void Promise.all(KEYS.map((k) => storage.get<unknown>(k).catch(() => undefined))).then((values) => {
      if (gen !== readGen || destroyed) return;
      KEYS.forEach((k, i) => {
        // A change that arrived meanwhile is newer than this read.
        if (!(k in stored)) stored[k] = values[i];
      });
      loaded = true;
      render();
    });
  }

  function model(cur: ItemPanelInput): PanelModel {
    const { itemId, detail, settings } = cur;
    const t = trackedOf(stored[STORAGE_KEYS.tracked], itemId);
    const s = openSnipeOf(stored[STORAGE_KEYS.snipes], itemId);
    const own = detail !== null && detail.itemId === itemId ? detail : null;
    const endMs = ms(own?.endTime) ?? ms(t?.['endTime']) ?? ms(s?.['endTime']);
    const ended = own?.isClosed === true || (endMs !== null && endMs <= now());
    const snipe: PanelSnipe | null =
      s === null ? null : { maxBid: s['maxBid'] as number, dryRun: s['dryRun'] !== false, sent: s['state'] === 'sent' };
    const wantsCalendar = t !== null && t['calendar'] === true;
    return {
      loaded,
      ended,
      tracked: t !== null,
      onCalendar: wantsCalendar && synced(stored[STORAGE_KEYS.calendar], itemId),
      snipe,
      biddingDryRun: settings.dryRun.bidding,
      calendarDryRun: wantsCalendar && settings.calendar.enabled && settings.dryRun.calendar,
    };
  }

  /** At SGW's bid area (as its next sibling), else floating; strays from elsewhere removed. */
  function place(panel: UiHost): void {
    for (const stray of Array.from(doc.querySelectorAll(`[${PANEL_ATTR}]`))) {
      if (stray !== panel.host) stray.remove();
    }
    const anchor = findItemBidArea(doc);
    if (anchor !== null) {
      if (anchor.nextElementSibling !== panel.host) anchor.after(panel.host);
      panel.host.setAttribute('data-sbw-placement', 'inline');
      return;
    }
    const parent = doc.querySelector('body') ?? doc.documentElement;
    if (panel.host.parentNode !== parent) parent.append(panel.host);
    panel.host.setAttribute('data-sbw-placement', 'fixed');
  }

  function scheduleEnd(m: PanelModel, cur: ItemPanelInput): void {
    if (endTimer !== undefined) clearTimeout(endTimer);
    endTimer = undefined;
    if (m.ended) return;
    const t = trackedOf(stored[STORAGE_KEYS.tracked], cur.itemId);
    const endMs = ms(cur.detail?.itemId === cur.itemId ? cur.detail.endTime : undefined) ?? ms(t?.['endTime']);
    if (endMs === null) return;
    const wait = endMs - now();
    if (wait > MAX_TIMER_MS) return;
    endTimer = setTimeout(() => {
      endTimer = undefined;
      if (input !== null) render();
    }, Math.max(0, wait) + 50);
  }

  function setUi(next: Partial<PanelUi>): void {
    ui = { ...ui, ...next };
    render();
  }

  function snipe(): void {
    if (input === null) return;
    void client.send('ui.openSnipe', { itemId: input.itemId }).catch(() => undefined);
  }

  async function track(): Promise<void> {
    const cur = input;
    if (cur === null || ui.busy) return;
    setUi({ busy: true, message: null });
    try {
      await client.send('tracked.add', { itemId: cur.itemId });
      if (input === cur) setUi({ busy: false, message: { text: PANEL_COPY.tracked, alert: false } });
    } catch {
      if (input === cur) setUi({ busy: false, message: { text: PANEL_COPY.trackFailed, alert: true } });
    }
  }

  async function stop(): Promise<void> {
    const cur = input;
    if (cur === null || ui.busy) return;
    const wasOnCalendar = model(cur).onCalendar;
    setUi({ busy: true, confirming: false, message: null });
    try {
      await client.send('tracked.remove', { itemId: cur.itemId });
      const text = !wasOnCalendar ? PANEL_COPY.stopped : cur.settings.dryRun.calendar ? PANEL_COPY.stoppedCalendarDryRun : PANEL_COPY.stoppedCalendar;
      if (input === cur) setUi({ busy: false, message: { text, alert: false } });
    } catch {
      if (input === cur) setUi({ busy: false, message: { text: PANEL_COPY.stopFailed, alert: true } });
    }
  }

  function render(): void {
    const cur = input;
    if (cur === null || destroyed) return;
    guard(() => {
      host ??= createUiHost(doc, PANEL_TAG, PANEL_CSS, { [PANEL_ATTR]: String(cur.itemId) });
      const panel = host;
      if (panel.host.getAttribute(PANEL_ATTR) !== String(cur.itemId)) panel.host.setAttribute(PANEL_ATTR, String(cur.itemId));
      place(panel);
      const m = model(cur);
      panel.render(
        h(ItemPanelView, {
          model: m,
          ui,
          onSnipe: snipe,
          onTrack: () => void track(),
          onAskStop: () => {
            setUi({ confirming: true, message: null });
          },
          onConfirmStop: () => void stop(),
          onCancelStop: () => {
            setUi({ confirming: false });
          },
        }),
      );
      scheduleEnd(m, cur);
    });
  }

  function remove(): void {
    if (endTimer !== undefined) clearTimeout(endTimer);
    endTimer = undefined;
    readGen += 1;
    const old = host;
    host = null;
    guard(() => old?.destroy());
  }

  return {
    update(next) {
      if (destroyed) return;
      if (next === null) {
        input = null;
        remove();
        return;
      }
      const sameItem = input?.itemId === next.itemId;
      input = next;
      if (!sameItem) {
        ui = { busy: false, confirming: false, message: null };
        read();
      }
      render();
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      input = null;
      remove();
      guard(offStorage);
    },
  };
}
