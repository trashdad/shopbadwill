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
// the two things a deps-less host cannot do are wired by
// src/background/jobs/snipe-host-page.ts through `setSnipeHostPageHooks`:
// writing the audit entry for an early user close, and knowing whether the
// snipe's window time is still ahead (the runner keeps the window through the
// first post-read, end + 5 s). Unset hooks degrade safely: the close is
// logged, and a held snipe is still re-acquired once.
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

// ── The browser surface (read lazily from `browser`, so tests swap it) ──────

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
  onRemoved: { addListener(listener: (windowId: number) => void): void };
}

/** The parts of `browser.runtime` the host uses. */
export interface SnipeHostRuntime {
  getURL(path: string): string;
  onConnect: { addListener(listener: (port: SnipeHostPagePort) => void): void };
}

/** The slice of runtime.Port the host holds (the page's side stays with the page). */
export interface SnipeHostPagePort {
  readonly name: string;
  readonly sender?: { readonly id?: string; readonly url?: string };
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
 * The two pieces the host needs beyond its frozen { clock, log } deps, set by
 * src/background/jobs/snipe-host-page.ts at startup. Unset hooks degrade
 * safely (log, and re-acquire while still held).
 */
export interface SnipeHostPageHooks {
  /** Called when the user closes a held window before the runner released it; writes the audit entry. */
  auditClosed?(snipeId: string, closedAt: EpochMs, reacquired: boolean): void | Promise<void>;
  /** Whether the snipe's window time is still ahead of `now`. Default: true (keep the window while held). */
  stillAhead?(snipeId: string, now: EpochMs): boolean | Promise<boolean>;
}

let hooks: SnipeHostPageHooks | undefined;

/** Installed by the job module at startup (I-12: a module, never an edit). */
export function setSnipeHostPageHooks(next: SnipeHostPageHooks | undefined): void {
  hooks = next;
}

// ── The host ────────────────────────────────────────────────────────────────

interface HeldWindow {
  readonly snipeId: string;
  windowId: number;
  port: SnipeHostPagePort | undefined;
  reacquired: boolean;
  createOptions: Record<string, unknown>;
}

export class PageSnipeHost implements SnipeHost {
  private readonly held = new Map<string, HeldWindow>();
  private readonly windowOf = new Map<number, string>();
  private readonly windows: SnipeHostWindows;
  private readonly runtime: SnipeHostRuntime;

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
    windows.onRemoved.addListener((windowId) => {
      this.onWindowRemoved(windowId);
    });
    runtime.onConnect.addListener((port) => {
      this.onPortConnected(port);
    });
  }

  /** One window per snipe; a second acquire for the same snipe is a no-op (R2). */
  async acquire(snipeId: string): Promise<void> {
    if (this.held.has(snipeId)) return;
    const options = this.createOptions(snipeId);
    const win = await this.windows.create(options);
    if (typeof win.id !== 'number') {
      throw new Error('windows.create returned no window id');
    }
    this.held.set(snipeId, { snipeId, windowId: win.id, port: undefined, reacquired: false, createOptions: options });
    this.windowOf.set(win.id, snipeId);
  }

  /** Closes the window (best effort: the user may already have closed it) and hangs up the held port. */
  async release(snipeId: string): Promise<void> {
    const entry = this.held.get(snipeId);
    if (entry === undefined) return;
    this.held.delete(snipeId);
    this.windowOf.delete(entry.windowId);
    try {
      entry.port?.disconnect();
    } catch (e) {
      this.deps.log(`snipe ${snipeId}: the runner-page port could not be disconnected`, e);
    }
    try {
      await this.windows.remove(entry.windowId);
    } catch (e) {
      this.deps.log(`snipe ${snipeId}: the runner-page window could not be closed`, e);
    }
  }

  private createOptions(snipeId: string): { url: string; type: 'popup'; focused: false; width: number; height: number } {
    return { url: this.pageUrl(snipeId), type: 'popup', focused: false, width: WINDOW_WIDTH, height: WINDOW_HEIGHT };
  }

  private pageUrl(snipeId: string): string {
    const url = new URL(this.runtime.getURL(SNIPE_HOST_PAGE));
    url.searchParams.set('s', snipeId);
    return url.href;
  }

  /** Adopts the runner page's port (matched to its window by the `s` URL parameter). */
  private onPortConnected(port: SnipeHostPagePort): void {
    if (port.name !== SNIPE_HOST_PORT) return;
    const snipeId = snipeIdOf(port.sender?.url);
    const entry = snipeId === undefined ? undefined : this.held.get(snipeId);
    if (entry === undefined || entry.port !== undefined) return; // a leftover window, or already held
    entry.port = port;
  }

  /** An early user close: audit it, and re-acquire once if the window time is still ahead (R2). */
  private onWindowRemoved(windowId: number): void {
    const snipeId = this.windowOf.get(windowId);
    const entry = snipeId === undefined ? undefined : this.held.get(snipeId);
    if (entry === undefined || entry.windowId !== windowId) return; // not one of ours, or already released
    this.windowOf.delete(windowId);
    const closedAt = this.deps.clock.now();
    void this.handleEarlyClose(entry, closedAt).catch((e: unknown) => {
      this.deps.log(`snipe ${entry.snipeId}: the early-close handling failed`, e);
    });
  }

  private async handleEarlyClose(entry: HeldWindow, closedAt: EpochMs): Promise<void> {
    const stillAhead = (await hooks?.stillAhead?.(entry.snipeId, closedAt)) ?? true;
    const reacquire = stillAhead && !entry.reacquired;
    entry.port = undefined; // the page unloaded with its window
    try {
      await hooks?.auditClosed?.(entry.snipeId, closedAt, reacquire);
    } catch (e) {
      this.deps.log(`snipe ${entry.snipeId}: the early-close audit failed`, e);
    }
    if (!reacquire) return;
    try {
      const options = this.createOptions(entry.snipeId);
      const win = await this.windows.create(options);
      if (typeof win.id !== 'number') {
        throw new Error('windows.create returned no window id');
      }
      entry.windowId = win.id;
      entry.createOptions = options;
      entry.reacquired = true;
      this.windowOf.set(win.id, entry.snipeId);
    } catch (e) {
      this.deps.log(`snipe ${entry.snipeId}: the runner-page window could not be re-acquired`, e);
    }
  }

  // ── Diagnostics and tests (like BackgroundSnipeHost.holds) ────────────────

  /** The window currently held for `snipeId`, if any. */
  windowIdFor(snipeId: string): number | undefined {
    return this.held.get(snipeId)?.windowId;
  }

  /** The create options of the window held for `snipeId` (what the host asked windows.create for). */
  createOptionsFor(snipeId: string): Record<string, unknown> | undefined {
    return this.held.get(snipeId)?.createOptions;
  }

  /** One row per held snipe (the E2E spec's status). */
  diagnostics(): Array<{ snipeId: string; windowId: number; reacquired: boolean; portConnected: boolean }> {
    return [...this.held.entries()].map(([snipeId, e]) => ({
      snipeId,
      windowId: e.windowId,
      reacquired: e.reacquired,
      portConnected: e.port !== undefined,
    }));
  }
}

/** The snipe id carried in the page URL's `s` parameter. */
function snipeIdOf(url: string | undefined): string | undefined {
  if (url === undefined) return undefined;
  try {
    return new URL(url).searchParams.get('s') ?? undefined;
  } catch {
    return undefined;
  }
}

/** The factory (./snipe-host.ts) picks this on Firefox, and only there (R4). */
export const snipeHost: SnipeHostImplementation = {
  verdict: 'runner-page',
  create: (deps) => new PageSnipeHost(deps),
};
