// T-116: the Firefox runner-page SnipeHost (S-7 verdict: 'runner-page').
//
// S-7 (docs/spikes/S-7.md) proved Firefox defers the background's timers by
// about min(delay/8, 10 s) - 0.6 s unless an extension window is open. This
// host is the §1.3 fallback: one small unfocused popup per snipe
// (`windows.create({ type: 'popup', focused: false })`, R2) holding the
// runner page (src/entrypoints/snipe-runner), which keeps a `runtime.connect`
// port open from the T-5 min wake through the end. The timer itself stays in
// the background; the window only removes the deferral (S-7: "If the window
// works, its job is to keep an extension window open across the fire").
//
// The factory in ./snipe-host.ts picks this module by its `verdict` on
// Firefox (S7_HOST_VERDICT.firefox); Chrome always gets the background host,
// so a Chrome build never opens a window (R4). The module is self-registered
// through the factory's `./snipe-host-*.ts` glob: neither the factory nor the
// runner edits (R1, I-12).
//
// The host's deps are frozen at { clock, log } (the runner builds them), so
// what a deps-less host cannot do is wired by
// src/background/jobs/snipe-host-page.ts through `setSnipeHostPageHooks`:
// writing the audit entry for an early user close, knowing whether the
// snipe's window time is still ahead (the runner keeps the window through the
// first post-read, end + 5 s), and whether a left-over page is still needed.
// Unset hooks degrade safely: the close is logged, a held snipe is still
// re-acquired once, and no left-over page is ever closed.
//
// A worker that dies mid-window leaves its window open (the runner's frozen
// dispose() never releases). The restarted worker's `acquire` adopts that
// page instead of opening a second one (runtime.getContexts lists it), and
// `reapRunnerPages` (run at startup by the job module) closes pages whose
// snipe no longer needs a window. The page reconnects its port when the
// worker goes away, which also wakes a suspended event page. Windows held by a
// live host in this worker are claimed, so neither path ever touches them.
//
// R3: the window never takes focus or comes to the front (`focused: false`,
// a popup, nothing steals attention). Its page shows only the leave-alone text.
import { browser } from 'wxt/browser';

import type { EpochMs } from '../../domain/types';
import type { SnipeHost } from '../../ports/snipe-host';
import type { SnipeHostDeps, SnipeHostImplementation } from './snipe-host';

/** The runtime port the runner page holds open (its main.ts connects it on load). */
export const SNIPE_HOST_PORT = 'sbw:snipe-host';

/** The runner page (src/entrypoints/snipe-runner/index.html). */
const SNIPE_HOST_PAGE = '/snipe-runner.html';

/** S-7's probe popup size (scripts/timing-probe/ext/probe.js): small, still readable (R2). */
const WINDOW_WIDTH = 260;
const WINDOW_HEIGHT = 120;

type Log = (message: string, error?: unknown) => void;

// ── The browser surface (read lazily from `browser`, so tests swap it) ──────

interface BrowserEvent<L> {
  addListener(listener: L): void;
  removeListener?(listener: L): void;
}

/** The parts of `browser.windows` the host uses. */
export interface SnipeHostWindows {
  create(options: {
    url: string;
    type: 'popup';
    focused: false;
    width: number;
    height: number;
  }): Promise<{ id?: number }>;
  remove(windowId: number): Promise<void>;
  onRemoved: BrowserEvent<(windowId: number) => void>;
}

/** The slice of runtime.getContexts' ExtensionContext the host reads. */
interface ExtensionContextInfo {
  readonly documentUrl?: string;
  readonly windowId?: number;
}

/** The parts of `browser.runtime` the host uses. */
export interface SnipeHostRuntime {
  getURL(path: string): string;
  onConnect: BrowserEvent<(port: SnipeHostPagePort) => void>;
  /** Firefox 128+ (the build's minimum is 140); absent: no adoption or reaping, only fresh windows. */
  getContexts?(filter: Record<string, never>): Promise<ExtensionContextInfo[]>;
}

/** The slice of runtime.Port the host holds (the page's side stays with the page). */
export interface SnipeHostPagePort {
  readonly name: string;
  readonly sender?: { readonly id?: string; readonly url?: string; readonly tab?: { readonly windowId?: number } };
  disconnect(): void;
}

function windowsApi(): SnipeHostWindows | undefined {
  const w = (browser as unknown as { windows?: Partial<SnipeHostWindows> }).windows;
  if (
    w === undefined ||
    typeof w.create !== 'function' ||
    typeof w.remove !== 'function' ||
    w.onRemoved === undefined ||
    typeof w.onRemoved.addListener !== 'function'
  ) {
    return undefined;
  }
  return w as SnipeHostWindows;
}

function runtimeApi(): SnipeHostRuntime | undefined {
  const r = (browser as unknown as { runtime?: Partial<SnipeHostRuntime> }).runtime;
  if (
    r === undefined ||
    typeof r.getURL !== 'function' ||
    r.onConnect === undefined ||
    typeof r.onConnect.addListener !== 'function'
  ) {
    return undefined;
  }
  return r as SnipeHostRuntime;
}

// ── The background wiring the frozen deps cannot carry ──────────────────────

/**
 * The pieces the host needs beyond its frozen { clock, log } deps, set by
 * src/background/jobs/snipe-host-page.ts at startup. Unset hooks degrade
 * safely (log, re-acquire while still held, never reap).
 */
export interface SnipeHostPageHooks {
  /** Called when the user closes a held window before the runner released it; writes the audit entry. */
  auditClosed?(snipeId: string, closedAt: EpochMs, reacquired: boolean): void | Promise<void>;
  /** Whether the snipe's window time is still ahead of `now`. Default (or failing): true (keep the window while held). */
  stillAhead?(snipeId: string, now: EpochMs): boolean | Promise<boolean>;
  /** Whether a runner page no live host holds may still be adopted (open snipe, window time ahead). Default: never reap. */
  needsWindow?(snipeId: string, now: EpochMs): boolean | Promise<boolean>;
}

let hooks: SnipeHostPageHooks | undefined;

/** Installed by the job module at startup (I-12: a module, never an edit). */
export function setSnipeHostPageHooks(next: SnipeHostPageHooks | undefined): void {
  hooks = next;
}

// ── Runner pages in this browser (claims, listing, reaping) ─────────────────

/** Windows held by a live host in this worker: never adopted by another host, never reaped. */
const claimedWindows = new Set<number>();
/** Windows being closed as left-overs or duplicates: never adopted meanwhile. */
const closingWindows = new Set<number>();

/** The snipe id of a runner-page URL of this extension (its `s` parameter), else undefined. */
function runnerPageSnipeId(runtime: SnipeHostRuntime, url: string | undefined): string | undefined {
  if (url === undefined) return undefined;
  try {
    const page = new URL(runtime.getURL(SNIPE_HOST_PAGE));
    const u = new URL(url);
    // Not `origin`: it is "null" for every moz-extension: URL.
    if (u.protocol !== page.protocol || u.host !== page.host || u.pathname !== page.pathname) return undefined;
    const snipeId = u.searchParams.get('s');
    return snipeId === null || snipeId === '' ? undefined : snipeId;
  } catch {
    return undefined;
  }
}

interface RunnerPage {
  readonly snipeId: string;
  readonly windowId: number;
}

/** Every open runner page of this extension, by window (none if runtime.getContexts is missing or fails). */
async function listRunnerPages(runtime: SnipeHostRuntime, log: Log): Promise<RunnerPage[]> {
  if (typeof runtime.getContexts !== 'function') return [];
  let contexts: ExtensionContextInfo[];
  try {
    contexts = await runtime.getContexts({});
  } catch (e) {
    log('the runner pages could not be listed', e);
    return [];
  }
  const pages: RunnerPage[] = [];
  for (const c of contexts) {
    const snipeId = runnerPageSnipeId(runtime, c.documentUrl);
    if (snipeId !== undefined && typeof c.windowId === 'number' && c.windowId >= 0) {
      pages.push({ snipeId, windowId: c.windowId });
    }
  }
  return pages;
}

/** Closes a left-over or duplicate window no live host holds (best effort). */
async function closeUnclaimed(windows: SnipeHostWindows, windowId: number, log: Log): Promise<boolean> {
  if (claimedWindows.has(windowId) || closingWindows.has(windowId)) return false;
  closingWindows.add(windowId);
  try {
    await windows.remove(windowId);
    return true;
  } catch (e) {
    log(`the left-over runner-page window ${String(windowId)} could not be closed`, e);
    return false;
  } finally {
    closingWindows.delete(windowId);
  }
}

/**
 * Closes the runner pages no live host holds whose snipe no longer needs a
 * window (hooks.needsWindow): left by a worker that died mid-window. Without
 * the hook, or when it fails, nothing is closed. Returns the closed windows.
 */
export async function reapRunnerPages(opts: { now: EpochMs; log: Log }): Promise<number[]> {
  const current = hooks;
  const windows = windowsApi();
  const runtime = runtimeApi();
  if (current?.needsWindow === undefined || windows === undefined || runtime === undefined) return [];
  const closed: number[] = [];
  for (const page of await listRunnerPages(runtime, opts.log)) {
    if (claimedWindows.has(page.windowId) || closingWindows.has(page.windowId)) continue;
    let needed: boolean;
    try {
      needed = await current.needsWindow(page.snipeId, opts.now);
    } catch (e) {
      opts.log(`snipe ${page.snipeId}: could not tell whether its left-over runner page is needed`, e);
      continue;
    }
    if (needed) continue;
    if (await closeUnclaimed(windows, page.windowId, opts.log)) closed.push(page.windowId);
  }
  return closed;
}

// ── The host ────────────────────────────────────────────────────────────────

interface HeldWindow {
  readonly snipeId: string;
  windowId: number;
  port: SnipeHostPagePort | undefined;
  reacquired: boolean;
  /** Adopted from a worker that died mid-window (not opened by this host). */
  readonly adopted: boolean;
  /** An early-close re-acquire is opening the next window (its id is not known yet). */
  reopening: boolean;
  createOptions: Record<string, unknown> | undefined;
}

export class PageSnipeHost implements SnipeHost {
  private readonly held = new Map<string, HeldWindow>();
  private readonly windowOf = new Map<number, string>();
  /** Acquires in flight: a second acquire joins it, a release waits for it. */
  private readonly opening = new Map<string, Promise<void>>();
  private readonly windows: SnipeHostWindows;
  private readonly runtime: SnipeHostRuntime;
  private readonly onRemoved = (windowId: number): void => {
    this.onWindowRemoved(windowId);
  };
  private readonly onConnect = (port: SnipeHostPagePort): void => {
    this.onPortConnected(port);
  };
  private disposed = false;

  constructor(private readonly deps: SnipeHostDeps) {
    const windows = windowsApi();
    const runtime = runtimeApi();
    if (windows === undefined || runtime === undefined) {
      // The factory catches this and lets the background host stand in (degraded).
      throw new Error('the runner-page snipe host needs browser.windows and browser.runtime');
    }
    this.windows = windows;
    this.runtime = runtime;
    // Subscribing first is also the usability proof: an environment whose
    // window API throws here refuses this host, and the runner audits it as
    // degraded instead of running a host that cannot notice an early close.
    windows.onRemoved.addListener(this.onRemoved);
    runtime.onConnect.addListener(this.onConnect);
  }

  /** One window per snipe; a second acquire for the same snipe (even one in flight) is a no-op (R2). */
  acquire(snipeId: string): Promise<void> {
    if (this.held.has(snipeId)) return Promise.resolve();
    const inFlight = this.opening.get(snipeId);
    if (inFlight !== undefined) return inFlight;
    const opening = this.open(snipeId).finally(() => {
      this.opening.delete(snipeId);
    });
    this.opening.set(snipeId, opening);
    return opening;
  }

  /** Closes the window (best effort: the user may already have closed it), then hangs up the held port. */
  async release(snipeId: string): Promise<void> {
    const inFlight = this.opening.get(snipeId);
    if (inFlight !== undefined) await inFlight.catch(() => undefined);
    const entry = this.held.get(snipeId);
    if (entry === undefined) return;
    this.held.delete(snipeId);
    this.windowOf.delete(entry.windowId);
    // The window first: a page whose port hangs up first would reconnect.
    try {
      await this.windows.remove(entry.windowId);
    } catch (e) {
      this.deps.log(`snipe ${snipeId}: the runner-page window could not be closed`, e);
    } finally {
      claimedWindows.delete(entry.windowId);
    }
    try {
      entry.port?.disconnect();
    } catch (e) {
      this.deps.log(`snipe ${snipeId}: the runner-page port could not be disconnected`, e);
    }
  }

  /**
   * The worker's end: stop listening, hang up the ports and forget the held
   * snipes, leaving their windows open (as a dying worker does) for the next
   * worker to adopt, or to reap once their snipe no longer needs them.
   */
  dispose(): void {
    this.disposed = true;
    this.windows.onRemoved.removeListener?.(this.onRemoved);
    this.runtime.onConnect.removeListener?.(this.onConnect);
    for (const entry of this.held.values()) {
      claimedWindows.delete(entry.windowId);
      try {
        entry.port?.disconnect();
      } catch {
        // already gone with its page
      }
    }
    this.held.clear();
    this.windowOf.clear();
  }

  private async open(snipeId: string): Promise<void> {
    const adopted = await this.adopt(snipeId);
    let windowId: number;
    let createOptions: Record<string, unknown> | undefined;
    if (adopted !== undefined) {
      windowId = adopted;
    } else {
      const options = this.createOptions(snipeId);
      const win = await this.windows.create(options);
      if (typeof win.id !== 'number') {
        throw new Error('windows.create returned no window id');
      }
      windowId = win.id;
      createOptions = options;
      claimedWindows.add(windowId);
    }
    if (this.disposed) {
      claimedWindows.delete(windowId); // the worker ended meanwhile: the window is a left-over
      return;
    }
    this.held.set(snipeId, {
      snipeId,
      windowId,
      port: undefined,
      reacquired: false,
      adopted: adopted !== undefined,
      reopening: false,
      createOptions,
    });
    this.windowOf.set(windowId, snipeId);
  }

  /**
   * A runner page for `snipeId` no live host holds (left by a worker that died
   * mid-window): claims the first and closes the others. Undefined if none.
   */
  private async adopt(snipeId: string): Promise<number | undefined> {
    const pages = await listRunnerPages(this.runtime, this.deps.log);
    const ids = [
      ...new Set(
        pages
          .filter((p) => p.snipeId === snipeId && !claimedWindows.has(p.windowId) && !closingWindows.has(p.windowId))
          .map((p) => p.windowId),
      ),
    ];
    const [keep, ...duplicates] = ids;
    if (keep === undefined) return undefined;
    claimedWindows.add(keep);
    for (const id of duplicates) void closeUnclaimed(this.windows, id, this.deps.log);
    return keep;
  }

  private createOptions(snipeId: string): { url: string; type: 'popup'; focused: false; width: number; height: number } {
    return { url: this.pageUrl(snipeId), type: 'popup', focused: false, width: WINDOW_WIDTH, height: WINDOW_HEIGHT };
  }

  private pageUrl(snipeId: string): string {
    const url = new URL(this.runtime.getURL(SNIPE_HOST_PAGE));
    url.searchParams.set('s', snipeId);
    return url.href;
  }

  /**
   * Holds the runner page's port (matched to its snipe by the `s` URL
   * parameter and to the held window by its tab). An old page of the same
   * snipe in another window (a dead worker's) is a duplicate: it is closed.
   */
  private onPortConnected(port: SnipeHostPagePort): void {
    if (port.name !== SNIPE_HOST_PORT) return;
    const snipeId = runnerPageSnipeId(this.runtime, port.sender?.url);
    const entry = snipeId === undefined ? undefined : this.held.get(snipeId);
    if (entry === undefined) return; // a left-over page: the reaper or a later acquire handles it
    const pageWindow = port.sender?.tab?.windowId;
    if (typeof pageWindow === 'number' && pageWindow !== entry.windowId) {
      // While a re-acquire is opening, the other window may be the new one.
      if (!entry.reopening) void closeUnclaimed(this.windows, pageWindow, this.deps.log);
      return;
    }
    if (entry.port !== undefined) return; // already held
    entry.port = port;
  }

  /** An early user close: audit it, and re-acquire once if the window time is still ahead (R2). */
  private onWindowRemoved(windowId: number): void {
    const snipeId = this.windowOf.get(windowId);
    const entry = snipeId === undefined ? undefined : this.held.get(snipeId);
    if (entry === undefined || entry.windowId !== windowId) return; // not one of ours, or already released
    this.windowOf.delete(windowId);
    claimedWindows.delete(windowId);
    entry.port = undefined; // the page unloaded with its window
    const closedAt = this.deps.clock.now();
    void this.handleEarlyClose(entry, closedAt).catch((e: unknown) => {
      this.deps.log(`snipe ${entry.snipeId}: the early-close handling failed`, e);
    });
  }

  private async handleEarlyClose(entry: HeldWindow, closedAt: EpochMs): Promise<void> {
    const stillHeld = (): boolean => this.held.get(entry.snipeId) === entry;
    let stillAhead = true;
    try {
      stillAhead = (await hooks?.stillAhead?.(entry.snipeId, closedAt)) ?? true;
    } catch (e) {
      this.deps.log(`snipe ${entry.snipeId}: the window-time check failed; keeping the window`, e);
    }
    const reacquire = stillAhead && !entry.reacquired && stillHeld();
    try {
      await hooks?.auditClosed?.(entry.snipeId, closedAt, reacquire);
    } catch (e) {
      this.deps.log(`snipe ${entry.snipeId}: the early-close audit failed`, e);
    }
    if (!reacquire || !stillHeld()) return;
    entry.reopening = true;
    try {
      const options = this.createOptions(entry.snipeId);
      const win = await this.windows.create(options);
      if (typeof win.id !== 'number') {
        throw new Error('windows.create returned no window id');
      }
      if (!stillHeld()) {
        // Released while the window was opening: it must not outlive the snipe.
        await this.windows.remove(win.id);
        return;
      }
      entry.windowId = win.id;
      entry.createOptions = options;
      entry.reacquired = true;
      claimedWindows.add(win.id);
      this.windowOf.set(win.id, entry.snipeId);
    } catch (e) {
      this.deps.log(`snipe ${entry.snipeId}: the runner-page window could not be re-acquired`, e);
    } finally {
      entry.reopening = false;
    }
  }

  // ── Diagnostics and tests (like BackgroundSnipeHost.holds) ────────────────

  /** The window currently held for `snipeId`, if any. */
  windowIdFor(snipeId: string): number | undefined {
    return this.held.get(snipeId)?.windowId;
  }

  /** The create options of the window held for `snipeId` (what the host asked windows.create for; none if adopted). */
  createOptionsFor(snipeId: string): Record<string, unknown> | undefined {
    return this.held.get(snipeId)?.createOptions;
  }

  /** One row per held snipe (the E2E spec's status). */
  diagnostics(): Array<{ snipeId: string; windowId: number; reacquired: boolean; adopted: boolean; portConnected: boolean }> {
    return [...this.held.entries()].map(([snipeId, e]) => ({
      snipeId,
      windowId: e.windowId,
      reacquired: e.reacquired,
      adopted: e.adopted,
      portConnected: e.port !== undefined,
    }));
  }
}

/** The factory (./snipe-host.ts) picks this on Firefox, and only there (R4). */
export const snipeHost: SnipeHostImplementation = {
  verdict: 'runner-page',
  create: (deps) => new PageSnipeHost(deps),
};
