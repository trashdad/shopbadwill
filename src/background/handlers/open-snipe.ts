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
import { MSG_VERSION, MsgEnvelopeSchema } from '../../messaging/protocol';
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

export function register(ctx: BackgroundContext): void {
  ctx.router.register('ui.openSnipe', async ({ itemId }) => {
    await openDashboard(browser as unknown as DashboardBrowser, itemId).catch(() => undefined);
    const message = { v: MSG_VERSION, type: 'ui.openSnipe', payload: { itemId }, reqId: crypto.randomUUID() };
    if (MsgEnvelopeSchema.safeParse(message).success) {
      try {
        await browser.runtime.sendMessage(message);
      } catch {
        // No dashboard page is open to receive it. A fallback tab reads ?item= itself.
      }
    }
    return undefined;
  });
}
