// T-85 concern 6: a "Snipe…" click must always open the dashboard. Chrome's
// sidePanel.open rejects without a user gesture (the background has none);
// the fallback is a tab on the dashboard page with ?item= so the Snipes
// section can prefill. A successful panel or sidebar open does not also
// open a tab.
import { describe, expect, it, vi } from 'vitest';

import {
  openDashboard,
  PREFILL_HOLD_MS,
  registerOpenSnipe,
  type DashboardBrowser,
  type DashboardPort,
} from '../../../src/background/handlers/open-snipe';
import type { BackgroundContext } from '../../../src/background/context';
import { PORT_NAMES } from '../../../src/messaging/protocol';

const ITEM = 279250057;
const getURL = (path: string): string => `chrome-extension://ext${path}`;

function created() {
  return vi.fn((options: { url: string }) => Promise.resolve(options));
}

const tabUrl = (create: ReturnType<typeof created>): URL => {
  const url = create.mock.calls[0]?.[0]?.url;
  if (url === undefined) throw new Error('tabs.create was not called');
  return new URL(url);
};

describe('openDashboard', () => {
  it('opens a sidepanel tab with ?item= when sidePanel.open is refused', async () => {
    const create = created();
    const open = vi.fn(() => Promise.reject(new Error('sidePanel.open() may only be called in response to a user gesture.')));
    const b: DashboardBrowser = {
      sidePanel: { open },
      windows: { getLastFocused: () => Promise.resolve({ id: 3 }) },
      tabs: { create },
      runtime: { getURL },
    };
    await expect(openDashboard(b, ITEM)).resolves.toBe('tab');
    expect(open).toHaveBeenCalledWith({ windowId: 3 });
    expect(create).toHaveBeenCalledTimes(1);
    const url = tabUrl(create);
    expect(url.pathname).toBe('/sidepanel.html');
    expect(url.searchParams.get('item')).toBe(String(ITEM));
  });

  it('opens a sidepanel tab when there is no focused window to attach the panel to', async () => {
    const create = created();
    const open = vi.fn(() => Promise.resolve());
    const b: DashboardBrowser = {
      sidePanel: { open },
      windows: { getLastFocused: () => Promise.resolve({}) },
      tabs: { create },
      runtime: { getURL },
    };
    await expect(openDashboard(b, ITEM)).resolves.toBe('tab');
    expect(open).not.toHaveBeenCalled();
    expect(tabUrl(create).searchParams.get('item')).toBe(String(ITEM));
  });

  it('does not open a tab when the side panel accepts the call', async () => {
    const create = created();
    const b: DashboardBrowser = {
      sidePanel: { open: () => Promise.resolve() },
      windows: { getLastFocused: () => Promise.resolve({ id: 4 }) },
      tabs: { create },
      runtime: { getURL },
    };
    await expect(openDashboard(b, ITEM)).resolves.toBe('side-panel');
    expect(create).not.toHaveBeenCalled();
  });

  it('opens a sidebar tab with ?item= when sidebarAction.open is refused', async () => {
    const create = created();
    const b: DashboardBrowser = {
      sidebarAction: { open: () => Promise.reject(new Error('sidebar refused')) },
      tabs: { create },
      runtime: { getURL },
    };
    await expect(openDashboard(b, ITEM)).resolves.toBe('tab');
    const url = tabUrl(create);
    expect(url.pathname).toBe('/sidebar.html');
    expect(url.searchParams.get('item')).toBe(String(ITEM));
  });

  it('does not open a tab when the sidebar accepts the call', async () => {
    const create = created();
    const b: DashboardBrowser = {
      sidebarAction: { open: () => Promise.resolve() },
      tabs: { create },
      runtime: { getURL },
    };
    await expect(openDashboard(b, ITEM)).resolves.toBe('sidebar');
    expect(create).not.toHaveBeenCalled();
  });

  it('opens a tab when no panel API exists, so the click still opens something', async () => {
    const create = created();
    const b: DashboardBrowser = { tabs: { create }, runtime: { getURL } };
    await expect(openDashboard(b, ITEM)).resolves.toBe('tab');
    expect(create).toHaveBeenCalledTimes(1);
    expect(tabUrl(create).searchParams.get('item')).toBe(String(ITEM));
  });

  it('refuses to pretend success when the tab cannot be opened either', async () => {
    const b: DashboardBrowser = {
      sidePanel: { open: () => Promise.reject(new Error('no gesture')) },
      windows: { getLastFocused: () => Promise.resolve({ id: 1 }) },
      runtime: { getURL },
    };
    await expect(openDashboard(b, ITEM)).rejects.toThrow(/dashboard/i);
  });
});

// Ruling 4: a side panel or sidebar that has just opened is not listening yet
// when the prefill is sent. The background holds the item (memory only, at
// most PREFILL_HOLD_MS) and re-sends it once, when a dashboard page connects
// the countdown port (the Snipes section does on mount). It only prefills.
describe('the held prefill for a dashboard that is still opening', () => {
  const ORIGIN = 'chrome-extension://ext';

  function harness(b: DashboardBrowser) {
    let now = 1_000_000;
    const sent: unknown[] = [];
    const ports: Array<(port: DashboardPort) => void> = [];
    const handlers = new Map<string, (payload: { itemId: number }) => Promise<unknown>>();
    const ctx = {
      router: {
        register: (type: string, h: (payload: { itemId: number }) => Promise<unknown>) => {
          handlers.set(type, h);
        },
      },
    } as unknown as Pick<BackgroundContext, 'router'>;
    registerOpenSnipe(ctx, {
      browser: b,
      sendMessage: (message) => {
        sent.push(message);
        return Promise.resolve();
      },
      onConnect: (listener) => {
        ports.push(listener);
      },
      extensionOrigin: ORIGIN,
      now: () => now,
    });
    return {
      handlers,
      sent,
      click: async (itemId: number): Promise<void> => {
        const h = handlers.get('ui.openSnipe');
        if (h === undefined) throw new Error('ui.openSnipe is not registered');
        await h({ itemId });
      },
      connect: async (name: string, url: string | undefined): Promise<void> => {
        for (const l of ports) l({ name, sender: url === undefined ? {} : { url } });
        await Promise.resolve();
      },
      advance: (ms: number): void => {
        now += ms;
      },
    };
  }

  const panel = (): DashboardBrowser => ({
    sidePanel: { open: () => Promise.resolve() },
    windows: { getLastFocused: () => Promise.resolve({ id: 1 }) },
    tabs: { create: () => Promise.resolve() },
    runtime: { getURL },
  });
  const prefills = (sent: unknown[]): number[] =>
    sent.map((m) => {
      const env = m as { type: string; payload: { itemId: number } };
      // Nothing but the prefill message is ever sent: never an arm.
      expect(env.type).toBe('ui.openSnipe');
      return env.payload.itemId;
    });

  it('re-sends the item once to a dashboard page that connects after the panel opened', async () => {
    const t = harness(panel());
    await t.click(ITEM);
    expect(prefills(t.sent)).toEqual([ITEM]); // the first send, to pages already listening
    await t.connect(PORT_NAMES.snipeCountdown, `${ORIGIN}/sidepanel.html`);
    expect(prefills(t.sent)).toEqual([ITEM, ITEM]);
    // Once: a later connect (another page, a reconnect) gets nothing.
    await t.connect(PORT_NAMES.snipeCountdown, `${ORIGIN}/sidepanel.html`);
    expect(prefills(t.sent)).toEqual([ITEM, ITEM]);
    expect([...t.handlers.keys()]).toEqual(['ui.openSnipe']);
  });

  it('holds for at most a minute', async () => {
    const t = harness(panel());
    await t.click(ITEM);
    t.advance(PREFILL_HOLD_MS);
    await t.connect(PORT_NAMES.snipeCountdown, `${ORIGIN}/sidepanel.html`);
    expect(prefills(t.sent)).toEqual([ITEM, ITEM]);

    const late = harness(panel());
    await late.click(ITEM);
    late.advance(PREFILL_HOLD_MS + 1);
    await late.connect(PORT_NAMES.snipeCountdown, `${ORIGIN}/sidepanel.html`);
    expect(prefills(late.sent)).toEqual([ITEM]);
    expect(PREFILL_HOLD_MS).toBeLessThanOrEqual(60_000);
  });

  it('ignores other ports and connections that are not extension pages (a content script)', async () => {
    const t = harness(panel());
    await t.click(ITEM);
    await t.connect(PORT_NAMES.jobProgress, `${ORIGIN}/sidepanel.html`);
    await t.connect(PORT_NAMES.snipeCountdown, 'https://shopgoodwill.com/item/279250057');
    await t.connect(PORT_NAMES.snipeCountdown, undefined);
    expect(prefills(t.sent)).toEqual([ITEM]);
    // Still held for the real dashboard.
    await t.connect(PORT_NAMES.snipeCountdown, `${ORIGIN}/sidepanel.html`);
    expect(prefills(t.sent)).toEqual([ITEM, ITEM]);
  });

  it('a newer click replaces the held item', async () => {
    const t = harness(panel());
    await t.click(ITEM);
    await t.click(7);
    await t.connect(PORT_NAMES.snipeCountdown, `${ORIGIN}/sidepanel.html`);
    expect(prefills(t.sent)).toEqual([ITEM, 7, 7]);
  });

  it('holds nothing when the fallback tab opened (it reads ?item= itself) or nothing opened', async () => {
    const refused: DashboardBrowser = { ...panel(), sidePanel: { open: () => Promise.reject(new Error('no gesture')) } };
    const t = harness(refused);
    await t.click(ITEM);
    await t.connect(PORT_NAMES.snipeCountdown, `${ORIGIN}/sidepanel.html?item=${String(ITEM)}`);
    expect(prefills(t.sent)).toEqual([ITEM]);

    const none = harness({ runtime: { getURL } });
    await none.click(ITEM);
    await none.connect(PORT_NAMES.snipeCountdown, `${ORIGIN}/sidepanel.html`);
    expect(prefills(none.sent)).toEqual([ITEM]);
  });
});
