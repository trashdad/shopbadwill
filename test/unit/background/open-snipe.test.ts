// T-85 concern 6: a "Snipe…" click must always open the dashboard. Chrome's
// sidePanel.open rejects without a user gesture (the background has none);
// the fallback is a tab on the dashboard page with ?item= so the Snipes
// section can prefill. A successful panel or sidebar open does not also
// open a tab.
import { describe, expect, it, vi } from 'vitest';

import { openDashboard, type DashboardBrowser } from '../../../src/background/handlers/open-snipe';

const ITEM = 279250057;
const getURL = (path: string): string => `chrome-extension://ext${path}`;

describe('openDashboard', () => {
  it('opens a sidepanel tab with ?item= when sidePanel.open is refused', async () => {
    const create = vi.fn(async () => ({}));
    const open = vi.fn(async () => {
      throw new Error('sidePanel.open() may only be called in response to a user gesture.');
    });
    const b: DashboardBrowser = {
      sidePanel: { open },
      windows: { getLastFocused: async () => ({ id: 3 }) },
      tabs: { create },
      runtime: { getURL },
    };
    await expect(openDashboard(b, ITEM)).resolves.toBe('tab');
    expect(open).toHaveBeenCalledWith({ windowId: 3 });
    expect(create).toHaveBeenCalledTimes(1);
    const url = new URL(String(create.mock.calls[0]?.[0]?.url));
    expect(url.pathname).toBe('/sidepanel.html');
    expect(url.searchParams.get('item')).toBe(String(ITEM));
  });

  it('opens a sidepanel tab when there is no focused window to attach the panel to', async () => {
    const create = vi.fn(async () => ({}));
    const open = vi.fn(async () => undefined);
    const b: DashboardBrowser = {
      sidePanel: { open },
      windows: { getLastFocused: async () => ({}) },
      tabs: { create },
      runtime: { getURL },
    };
    await expect(openDashboard(b, ITEM)).resolves.toBe('tab');
    expect(open).not.toHaveBeenCalled();
    expect(new URL(String(create.mock.calls[0]?.[0]?.url)).searchParams.get('item')).toBe(String(ITEM));
  });

  it('does not open a tab when the side panel accepts the call', async () => {
    const create = vi.fn(async () => ({}));
    const b: DashboardBrowser = {
      sidePanel: { open: async () => undefined },
      windows: { getLastFocused: async () => ({ id: 4 }) },
      tabs: { create },
      runtime: { getURL },
    };
    await expect(openDashboard(b, ITEM)).resolves.toBe('side-panel');
    expect(create).not.toHaveBeenCalled();
  });

  it('opens a sidebar tab with ?item= when sidebarAction.open is refused', async () => {
    const create = vi.fn(async () => ({}));
    const b: DashboardBrowser = {
      sidebarAction: {
        open: async () => {
          throw new Error('sidebar refused');
        },
      },
      tabs: { create },
      runtime: { getURL },
    };
    await expect(openDashboard(b, ITEM)).resolves.toBe('tab');
    const url = new URL(String(create.mock.calls[0]?.[0]?.url));
    expect(url.pathname).toBe('/sidebar.html');
    expect(url.searchParams.get('item')).toBe(String(ITEM));
  });

  it('does not open a tab when the sidebar accepts the call', async () => {
    const create = vi.fn(async () => ({}));
    const b: DashboardBrowser = {
      sidebarAction: { open: async () => undefined },
      tabs: { create },
      runtime: { getURL },
    };
    await expect(openDashboard(b, ITEM)).resolves.toBe('sidebar');
    expect(create).not.toHaveBeenCalled();
  });

  it('opens a tab when no panel API exists, so the click still opens something', async () => {
    const create = vi.fn(async () => ({}));
    const b: DashboardBrowser = { tabs: { create }, runtime: { getURL } };
    await expect(openDashboard(b, ITEM)).resolves.toBe('tab');
    expect(create).toHaveBeenCalledTimes(1);
    expect(new URL(String(create.mock.calls[0]?.[0]?.url)).searchParams.get('item')).toBe(String(ITEM));
  });

  it('refuses to pretend success when the tab cannot be opened either', async () => {
    const b: DashboardBrowser = {
      sidePanel: {
        open: async () => {
          throw new Error('no gesture');
        },
      },
      windows: { getLastFocused: async () => ({ id: 1 }) },
      runtime: { getURL },
    };
    await expect(openDashboard(b, ITEM)).rejects.toThrow(/dashboard/i);
  });
});
