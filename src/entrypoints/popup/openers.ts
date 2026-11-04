// "Open dashboard" / "Open options". Each browser API is feature-checked: the
// dashboard pages (T-54) and the options page do not exist yet, and Chrome and
// Firefox expose different surfaces.

/** The slice of the browser object used here (structurally satisfied by wxt/browser's `browser`). */
export interface BrowserLike {
  /** Chrome: side panel. open() needs a user gesture and a window id. */
  sidePanel?: { open(options: { windowId: number }): Promise<void> };
  /** Firefox: sidebar. open() needs a user gesture. */
  sidebarAction?: { open(): Promise<void> };
  runtime?: { openOptionsPage?(): Promise<void> };
}

export async function openDashboard(b: BrowserLike, windowId: number | undefined): Promise<void> {
  if (b.sidePanel !== undefined && windowId !== undefined) {
    await b.sidePanel.open({ windowId });
    return;
  }
  if (b.sidebarAction !== undefined) {
    await b.sidebarAction.open();
    return;
  }
  throw new Error('The dashboard is not available in this browser yet.');
}

export async function openOptions(b: BrowserLike): Promise<void> {
  if (b.runtime?.openOptionsPage === undefined) throw new Error('The options page is not available yet.');
  await b.runtime.openOptionsPage();
}
