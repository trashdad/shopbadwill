// T-116: the Firefox runner-page SnipeHost
// (src/adapters/browser/snipe-host-page.ts), over fake windows/runtime (R5).
//
// The brief's tests: `acquire` opens one unfocused popup window and holds the
// page's `runtime.connect` port; `release` closes it; a second `acquire` for
// the same snipe is a no-op; the factory selects this host on Firefox only
// under the runner-page verdict (R4: Chrome never opens a window).
//
// R2's early-close behaviour: a window the user closes early is noticed,
// audited through the module's hooks (wired to the background's AuditLog by
// src/background/jobs/snipe-host-page.ts), and re-acquired once while the
// snipe's window time is still ahead.
//
// The module reads its browser surface lazily from `wxt/browser`, which
// WxtVitest swaps for the in-memory fakeBrowser; the tests below install
// hand-written windows/runtime fakes onto it. fakeBrowser.reset() (shared
// setup) resets only built-in state, not replaced APIs, so the pristine
// throwing surfaces are kept aside and each test installs its own fakes.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';

import {
  BackgroundSnipeHost,
  createSnipeHost,
  hostVerdict,
  S7_HOST_VERDICT,
  type SelectedSnipeHost,
  type SnipeHostDeps,
} from '../../src/adapters/browser/snipe-host';
import {
  snipeHost as pageSnipeHost,
  setSnipeHostPageHooks,
  SNIPE_HOST_PORT,
  type SnipeHostPageHooks,
} from '../../src/adapters/browser/snipe-host-page';
import type { SnipeHost } from '../../src/ports/snipe-host';
import { FakeClock } from '../fakes/ports/fake-clock';

// ── Fakes (R5: fake windows / runtime) ──────────────────────────────────────

/** The pristine throwing surfaces (captured before any test replaces them). */
const THROWING_WINDOWS = fakeBrowser.windows;
const THROWING_RUNTIME = fakeBrowser.runtime;

interface FakeEvent<L extends (...args: never[]) => unknown> {
  listeners: L[];
  addListener(l: L): void;
  removeListener(l: L): void;
}

function fakeEvent<L extends (...args: never[]) => unknown>(): FakeEvent<L> {
  const listeners: L[] = [];
  return {
    listeners,
    addListener: (l) => {
      listeners.push(l);
    },
    removeListener: (l) => {
      const i = listeners.indexOf(l);
      if (i >= 0) listeners.splice(i, 1);
    },
  };
}

interface FakeWindow {
  id: number;
  options: Record<string, unknown>;
}

interface FakeWindows {
  windows: FakeWindow[];
  createCalls: Array<Record<string, unknown>>;
  removeCalls: number[];
  onRemoved: FakeEvent<(id: number) => void>;
  /** The user closes the window: it disappears and the browser fires onRemoved. */
  close(id: number): void;
}

/** The background side of a page's runtime port, plus the page side's `disconnected` flag. */
interface FakePort {
  name: string;
  sender: { id: string; url: string };
  onMessage: FakeEvent<(m: unknown) => void>;
  onDisconnect: FakeEvent<() => void>;
  disconnected: boolean;
  postMessage(m: unknown): void;
  disconnect(): void;
}

interface FakeRuntime {
  onConnect: FakeEvent<(p: FakePort) => void>;
  /** Delivers a page connection for `pageUrl`, as the page's own runtime.connect does. */
  pageConnects(pageUrl: string): FakePort;
}

const EXT_ID = 'test-extension-id';
const ORIGIN = `moz-extension://${EXT_ID}/`;
const T0 = Date.UTC(2026, 9, 10, 15, 0, 0);

function installFakeWindows(): FakeWindows {
  const windows: FakeWindow[] = [];
  const createCalls: Array<Record<string, unknown>> = [];
  const removeCalls: number[] = [];
  const onRemoved = fakeEvent<(id: number) => void>();
  let nextId = 1;
  (fakeBrowser as unknown as { windows: unknown }).windows = {
    create: (options: Record<string, unknown>): Promise<{ id: number }> => {
      createCalls.push(options);
      const id = nextId++;
      windows.push({ id, options });
      return Promise.resolve({ id });
    },
    remove: (id: number): Promise<void> => {
      removeCalls.push(id);
      const at = windows.findIndex((w) => w.id === id);
      if (at >= 0) {
        windows.splice(at, 1);
        for (const l of [...onRemoved.listeners]) l(id);
      }
      return Promise.resolve();
    },
    onRemoved,
  };
  return {
    windows,
    createCalls,
    removeCalls,
    onRemoved,
    close: (id: number): void => {
      const at = windows.findIndex((w) => w.id === id);
      if (at >= 0) {
        windows.splice(at, 1);
        for (const l of [...onRemoved.listeners]) l(id);
      }
    },
  };
}

function installFakeRuntime(): FakeRuntime {
  const onConnect = fakeEvent<(p: FakePort) => void>();
  (fakeBrowser as unknown as { runtime: unknown }).runtime = {
    getURL: (path: string): string => ORIGIN + path.replace(/^\//, ''),
    onConnect,
  };
  return {
    onConnect,
    pageConnects(pageUrl: string): FakePort {
      const port: FakePort = {
        name: SNIPE_HOST_PORT,
        sender: { id: EXT_ID, url: pageUrl },
        onMessage: fakeEvent<(m: unknown) => void>(),
        onDisconnect: fakeEvent<() => void>(),
        disconnected: false,
        postMessage: () => undefined,
        disconnect: () => {
          port.disconnected = true;
          for (const l of [...port.onDisconnect.listeners]) l();
        },
      };
      for (const l of [...onConnect.listeners]) l(port);
      return port;
    },
  };
}

// ── Helpers ────────────────────────────────────────────────────────────────

const PAGE_MODULE = { './snipe-host-page.ts': { snipeHost: pageSnipeHost } };

function deps(): SnipeHostDeps {
  return { clock: new FakeClock(T0), log: () => undefined };
}

function pageHost(verdict: 'runner-page' | 'background' = 'runner-page'): SelectedSnipeHost {
  return createSnipeHost(deps(), { verdict, modules: PAGE_MODULE });
}

/** Waits until `check` holds (the host's early-close handling is async). */
async function until(check: () => void): Promise<void> {
  await vi.waitFor(check);
}

afterEach(() => {
  setSnipeHostPageHooks(undefined);
});

// ── The brief's tests ───────────────────────────────────────────────────────

describe('the Firefox runner-page SnipeHost', () => {
  it('acquire opens one small unfocused popup window and holds the page port', async () => {
    const windows = installFakeWindows();
    const runtime = installFakeRuntime();
    const host: SnipeHost = pageHost().host;

    await host.acquire('sn1');

    expect(windows.createCalls).toHaveLength(1);
    expect(windows.createCalls[0]).toMatchObject({
      type: 'popup',
      focused: false,
      width: 260,
      height: 120,
    });
    expect(String(windows.createCalls[0]?.url)).toContain('/snipe-runner.html');
    expect(windows.windows).toHaveLength(1);

    // The runner page loads and connects its port: the host holds it open.
    const url = String(windows.createCalls[0]?.url);
    const port = runtime.pageConnects(url);
    expect(port.disconnected).toBe(false);

    // release closes the window and hangs up the held port.
    await host.release('sn1');
    expect(windows.removeCalls).toEqual([1]);
    expect(windows.windows).toHaveLength(0);
    expect(port.disconnected).toBe(true);
  });

  it('a second acquire for the same snipe is a no-op (one window per snipe)', async () => {
    const windows = installFakeWindows();
    installFakeRuntime();
    const host: SnipeHost = pageHost().host;

    await host.acquire('sn1');
    await host.acquire('sn1');

    expect(windows.createCalls).toHaveLength(1);
    expect(windows.windows).toHaveLength(1);

    await host.release('sn1');
    expect(windows.removeCalls).toEqual([1]);
  });

  it('the factory selects this host on Firefox only under the runner-page verdict', () => {
    installFakeWindows();
    installFakeRuntime();
    // S-7's verdict, per browser.
    expect(S7_HOST_VERDICT).toEqual({ chrome: 'background', firefox: 'runner-page' });
    expect(hostVerdict(false)).toBe('background'); // Chrome
    expect(hostVerdict(true)).toBe('runner-page'); // Firefox

    const picked = createSnipeHost(deps(), { verdict: 'runner-page', modules: PAGE_MODULE });
    expect(picked).toMatchObject({ implementation: './snipe-host-page.ts', degraded: false });
    const chrome = createSnipeHost(deps(), { verdict: 'background', modules: PAGE_MODULE });
    expect(chrome).toMatchObject({ implementation: 'background', degraded: false });
    expect(chrome.host).toBeInstanceOf(BackgroundSnipeHost);
  });

  it('Chrome never opens a window (the background host acquires without windows)', async () => {
    const windows = installFakeWindows();
    installFakeRuntime();
    const chrome = pageHost('background');

    await chrome.host.acquire('sn1');
    await chrome.host.release('sn1');

    expect(windows.createCalls).toHaveLength(0);
    expect(windows.removeCalls).toHaveLength(0);
  });

  it('the production glob registers the page module, so the runner finds it with no factory edit', () => {
    installFakeWindows();
    installFakeRuntime();
    const picked = createSnipeHost(deps(), { verdict: 'runner-page' });
    expect(picked).toMatchObject({ implementation: './snipe-host-page.ts', degraded: false });
  });

  it('when the window APIs cannot be subscribed, the factory falls back to the background host', () => {
    // The pristine throwing surfaces stand in for an unusable windows/runtime API.
    (fakeBrowser as unknown as { windows: unknown; runtime: unknown }).windows = THROWING_WINDOWS;
    (fakeBrowser as unknown as { windows: unknown; runtime: unknown }).runtime = THROWING_RUNTIME;
    const picked = createSnipeHost(deps(), { verdict: 'runner-page' });
    expect(picked).toMatchObject({ implementation: 'background', degraded: true });
  });
});

// ── R2: an early user close is noticed, audited, re-acquired once ──────────

describe('an early user close of the snipe-host window', () => {
  it('is audited and re-acquired once while the window time is still ahead', async () => {
    const windows = installFakeWindows();
    installFakeRuntime();
    const audits: Array<{ snipeId: string; closedAt: number; reacquired: boolean }> = [];
    const hooks: SnipeHostPageHooks = {
      auditClosed: (snipeId, closedAt, reacquired) => {
        audits.push({ snipeId, closedAt, reacquired });
      },
      stillAhead: () => true,
    };
    setSnipeHostPageHooks(hooks);
    const host: SnipeHost = pageHost().host;

    await host.acquire('sn1');
    const firstWindowId = 1;
    windows.close(firstWindowId); // the user closes the window early
    await until(() => {
      expect(audits).toHaveLength(1);
    });

    expect(audits).toEqual([{ snipeId: 'sn1', closedAt: T0, reacquired: true }]);
    expect(windows.createCalls).toHaveLength(2); // the original + one re-acquire
    expect(windows.createCalls[1]).toMatchObject({ type: 'popup', focused: false });
    expect(windows.windows).toHaveLength(1);

    // The user closes the re-acquired window too: audited again, never re-acquired again.
    const secondWindowId = 2;
    windows.close(secondWindowId);
    await until(() => {
      expect(audits).toHaveLength(2);
    });

    expect(audits[1]).toMatchObject({ snipeId: 'sn1', closedAt: T0, reacquired: false });
    expect(windows.createCalls).toHaveLength(2);

    // release still closes the current (re-acquired) window.
    await host.release('sn1');
    expect(windows.removeCalls).toEqual([secondWindowId]);
    expect(windows.windows).toHaveLength(0);
  });

  it('is audited but NOT re-acquired when the window time is no longer ahead', async () => {
    const windows = installFakeWindows();
    installFakeRuntime();
    const audits: Array<{ snipeId: string; reacquired: boolean }> = [];
    setSnipeHostPageHooks({
      auditClosed: (snipeId, _closedAt, reacquired) => {
        audits.push({ snipeId, reacquired });
      },
      stillAhead: () => false,
    });
    const host: SnipeHost = pageHost().host;

    await host.acquire('sn1');
    windows.close(1);
    await until(() => {
      expect(audits).toHaveLength(1);
    });

    expect(audits).toEqual([{ snipeId: 'sn1', reacquired: false }]);
    expect(windows.createCalls).toHaveLength(1);
    expect(windows.windows).toHaveLength(0);
  });

  it('is ignored for a window the host does not hold', async () => {
    const windows = installFakeWindows();
    installFakeRuntime();
    const audits: unknown[] = [];
    setSnipeHostPageHooks({
      auditClosed: (...args: unknown[]) => {
        audits.push(args);
      },
    });
    const host: SnipeHost = pageHost().host;

    await host.acquire('sn1');
    for (const l of [...windows.onRemoved.listeners]) l(999); // some other window
    await Promise.resolve();

    expect(audits).toHaveLength(0);
    expect(windows.createCalls).toHaveLength(1);
  });

  it('a port from a window the host does not hold is left alone', async () => {
    installFakeWindows();
    const runtime = installFakeRuntime();
    const host: SnipeHost = pageHost().host;

    await host.acquire('sn1');
    const stranger = runtime.pageConnects(`${ORIGIN}snipe-runner.html?s=other`);

    await host.release('sn1');
    expect(stranger.disconnected).toBe(false); // never adopted, never hung up
  });
});
