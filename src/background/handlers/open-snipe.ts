// T-85 (R1): the "Snipe…" deep link. A content-script badge sends
// `ui.openSnipe { itemId }`; this handler opens the dashboard surface and
// re-sends the message to extension pages, where the dashboard's Snipes
// section listens and pre-fills its form. It never arms: the only way a snipe
// is armed is `snipe.arm` (T-84), and this handler touches no snipe state.
// Self-registered (I-01): main.ts stays frozen.
import { browser } from 'wxt/browser';

import { MSG_VERSION, MsgEnvelopeSchema } from '../../messaging/protocol';
import type { BackgroundContext } from '../context';

/** The dashboard surfaces this handler can open; feature-checked per browser. */
export interface DashboardBrowser {
  sidePanel?: { open(options: { windowId: number }): Promise<void> };
  sidebarAction?: { open(): Promise<void> };
  windows?: { getLastFocused(): Promise<{ id?: number } | undefined> };
}

/** Chrome: sidePanel.open needs a window (and a gesture, which may be absent in the background); Firefox: the sidebar. */
export async function openDashboard(b: DashboardBrowser): Promise<void> {
  if (b.sidePanel !== undefined && b.windows !== undefined) {
    const win = await b.windows.getLastFocused();
    if (win?.id !== undefined) await b.sidePanel.open({ windowId: win.id });
    return;
  }
  if (b.sidebarAction !== undefined) await b.sidebarAction.open();
}

export function register(ctx: BackgroundContext): void {
  ctx.router.register('ui.openSnipe', async ({ itemId }) => {
    await openDashboard(browser as unknown as DashboardBrowser).catch(() => undefined);
    const message = { v: MSG_VERSION, type: 'ui.openSnipe', payload: { itemId }, reqId: crypto.randomUUID() };
    if (MsgEnvelopeSchema.safeParse(message).success) {
      try {
        await browser.runtime.sendMessage(message);
      } catch {
        // No dashboard page is open to receive it (the open above failed or was gesture-limited on Chrome).
      }
    }
    return undefined;
  });
}
