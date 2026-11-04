// T-85 (R1): the "Snipe…" deep link. A content-script badge sends
// `ui.openSnipe { itemId }`; this handler opens the dashboard surface and
// re-sends the message to extension pages, where the dashboard's Snipes
// section listens and pre-fills its form. It never arms: the only way a snipe
// is armed is `snipe.arm` (T-84), and this handler touches no snipe state.
// Self-registered (I-01): main.ts stays frozen.
//
// Chrome's sidePanel.open (and sometimes the sidebar) rejects when the
// background has no user gesture. The click must still open something, so a
// refusal falls back to the dashboard page in a new tab with `?item=<id>`.
// The section reads that query on load, because the tab is not listening yet
// when the prefill message is sent.
import { browser } from 'wxt/browser';

import type { ItemId } from '../../domain/types';
import { MSG_VERSION, MsgEnvelopeSchema, PORT_NAMES } from '../../messaging/protocol';
import type { BackgroundContext } from '../context';

/** The dashboard surfaces this handler can open; feature-checked per browser. */
export interface DashboardBrowser {
  sidePanel?: { open(options: { windowId: number }): Promise<void> };
  sidebarAction?: { open(): Promise<void> };
  windows?: { getLastFocused(): Promise<{ id?: number } | undefined> };
  tabs?: { create(options: { url: string }): Promise<unknown> };
  runtime?: { getURL(path: string): string };
}

export type DashboardSurface = 'side-panel' | 'sidebar' | 'tab';

/** Chrome's side panel page. Firefox's sidebar page is the other build. */
function dashboardPage(b: DashboardBrowser): '/sidepanel.html' | '/sidebar.html' {
  return b.sidePanel !== undefined ? '/sidepanel.html' : '/sidebar.html';
}

function dashboardTabUrl(getURL: (path: string) => string, itemId: ItemId, page: string): string {
  const url = new URL(getURL(page));
  url.searchParams.set('item', String(itemId));
  return url.href;
}

/** The panel or sidebar, or null when it is missing or refused (no gesture, no window). */
async function tryOpenPanel(b: DashboardBrowser): Promise<'side-panel' | 'sidebar' | null> {
  try {
    if (b.sidePanel !== undefined && b.windows !== undefined) {
      const win = await b.windows.getLastFocused();
      if (win?.id === undefined) return null;
      await b.sidePanel.open({ windowId: win.id });
      return 'side-panel';
    }
    if (b.sidebarAction !== undefined) {
      await b.sidebarAction.open();
      return 'sidebar';
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Opens the dashboard for a "Snipe…" click. A refused or missing panel falls
 * back to a tab whose URL carries `?item=`, which the Snipes section reads.
 */
export async function openDashboard(b: DashboardBrowser, itemId: ItemId): Promise<DashboardSurface> {
  const panel = await tryOpenPanel(b);
  if (panel !== null) return panel;
  const runtime = b.runtime;
  if (b.tabs === undefined || runtime === undefined) {
    throw new Error('The dashboard could not be opened.');
  }
  // Call getURL on runtime so `this` stays bound.
  await b.tabs.create({ url: dashboardTabUrl((path) => runtime.getURL(path), itemId, dashboardPage(b)) });
  return 'tab';
}

/**
 * Ruling 4: how long a "Snipe…" item waits for a side panel or sidebar that
 * was just opened and is not listening yet (at most 60 s, memory only).
 */
export const PREFILL_HOLD_MS = 60_000;

/** The parts of a connecting port the relay reads. */
export interface DashboardPort {
  name: string;
  sender?: { url?: string };
}

export interface OpenSnipeDeps {
  browser: DashboardBrowser;
  /** runtime.sendMessage: reaches extension pages (never content scripts). */
  sendMessage(message: unknown): Promise<unknown>;
  /** runtime.onConnect.addListener. Observes only: the port stays served by its owner. */
  onConnect(listener: (port: DashboardPort) => void): void;
  /** This extension's page origin, e.g. "chrome-extension://<id>". */
  extensionOrigin: string;
  now(): number;
}

/**
 * The `ui.openSnipe` handler with its browser seams. After opening the
 * dashboard it sends the prefill to the pages already listening. A panel or
 * sidebar it just opened may not be listening yet, so the item is also held
 * in memory (never storage) for at most PREFILL_HOLD_MS, and re-sent ONCE when
 * an extension page connects the snipe-countdown port, which the Snipes
 * section does on mount. The message is the same prefill: nothing here arms.
 */
export function registerOpenSnipe(ctx: Pick<BackgroundContext, 'router'>, deps: OpenSnipeDeps): void {
  let held: { itemId: ItemId; at: number } | null = null;

  const sendPrefill = async (itemId: ItemId): Promise<void> => {
    const message = { v: MSG_VERSION, type: 'ui.openSnipe', payload: { itemId }, reqId: crypto.randomUUID() };
    if (!MsgEnvelopeSchema.safeParse(message).success) return;
    try {
      await deps.sendMessage(message);
    } catch {
      // No dashboard page is listening yet: the held item or the tab's ?item= covers it.
    }
  };

  ctx.router.register('ui.openSnipe', async ({ itemId }) => {
    const surface = await openDashboard(deps.browser, itemId).catch(() => null);
    // A fallback tab reads ?item= itself; nothing opened means nothing to wait for.
    held = surface === 'side-panel' || surface === 'sidebar' ? { itemId, at: deps.now() } : null;
    await sendPrefill(itemId);
    return undefined;
  });

  deps.onConnect((port) => {
    if (port.name !== PORT_NAMES.snipeCountdown || held === null) return;
    // Only a dashboard page (not a content script on a web page) counts as listening.
    if (port.sender?.url?.startsWith(`${deps.extensionOrigin}/`) !== true) return;
    const take = held;
    held = null;
    if (deps.now() - take.at <= PREFILL_HOLD_MS) void sendPrefill(take.itemId);
  });
}

export function register(ctx: BackgroundContext): void {
  const b = browser as unknown as DashboardBrowser;
  registerOpenSnipe(ctx, {
    browser: b,
    sendMessage: (message) => browser.runtime.sendMessage(message),
    onConnect: (listener) => {
      try {
        browser.runtime.onConnect.addListener(listener);
      } catch (e) {
        // The relay only helps a panel that opens slowly; the deep link still works without it.
        console.warn('open-snipe: the prefill relay could not listen for dashboards', e);
      }
    },
    extensionOrigin: new URL(browser.runtime.getURL('/sidepanel.html')).origin,
    now: () => ctx.clock.now(),
  });
}
