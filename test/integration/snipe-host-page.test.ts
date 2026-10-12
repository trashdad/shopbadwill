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
  PageSnipeHost,
  reapRunnerPages,
  snipeHost as pageSnipeHost,
  setSnipeHostPageHooks,
  SNIPE_HOST_PORT,
  type SnipeHostPageHooks,
} from '../../src/adapters/browser/snipe-host-page';
import type { BackgroundContext } from '../../src/background/context';
import { register as registerHostPageJob } from '../../src/background/jobs/snipe-host-page';
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
  /** Every windows API call in order ('create' / 'remove:<id>'), for ordering checks. */
  calls: string[];
  onRemoved: FakeEvent<(id: number) => void>;
  /** The user closes the window: it disappears and the browser fires onRemoved. */
  close(id: number): void;
  /** A window that is already open (e.g. left by a worker that died): no create call. */
  open(url: string): number;
  /** Holds the next create calls until `releaseCreates()` (an in-flight windows.create). */
  holdCreates(): void;
  releaseCreates(): void;
}

/** The background side of a page's runtime port, plus the page side's `disconnected` flag. */
interface FakePort {
  name: string;
  sender: { id: string; url: string; tab?: { windowId: number } };
  onMessage: FakeEvent<(m: unknown) => void>;
  onDisconnect: FakeEvent<() => void>;
  disconnected: boolean;
  postMessage(m: unknown): void;
  disconnect(): void;
}

interface FakeRuntime {
  onConnect: FakeEvent<(p: FakePort) => void>;
  /** Delivers a page connection for `pageUrl`, as the page's own runtime.connect does (from `windowId`'s tab, if given). */
  pageConnects(pageUrl: string, windowId?: number): FakePort;
}

const EXT_ID = 'test-extension-id';
const ORIGIN = `moz-extension://${EXT_ID}/`;
const T0 = Date.UTC(2026, 9, 10, 15, 0, 0);

/** The runner page's URL for `snipeId`, as the host builds it. */
function pageUrlOf(snipeId: string): string {
  return `${ORIGIN}snipe-runner.html?s=${encodeURIComponent(snipeId)}`;
}

function installFakeWindows(): FakeWindows {
  const windows: FakeWindow[] = [];
  const createCalls: Array<Record<string, unknown>> = [];
  const removeCalls: number[] = [];
  const calls: string[] = [];
  const onRemoved = fakeEvent<(id: number) => void>();
  let nextId = 1;
  let held: Array<() => void> | undefined;
  const drop = (id: number): void => {
    const at = windows.findIndex((w) => w.id === id);
    if (at >= 0) {
      windows.splice(at, 1);
      for (const l of [...onRemoved.listeners]) l(id);
    }
  };
  (fakeBrowser as unknown as { windows: unknown }).windows = {
    create: (options: Record<string, unknown>): Promise<{ id: number }> => {
      createCalls.push(options);
      calls.push('create');
      const id = nextId++;
      windows.push({ id, options });
      if (held === undefined) return Promise.resolve({ id });
      const queue = held;
      return new Promise((resolve) => {
        queue.push(() => {
          resolve({ id });
        });
      });
    },
    remove: (id: number): Promise<void> => {
      removeCalls.push(id);
      calls.push(`remove:${String(id)}`);
      const known = windows.some((w) => w.id === id);
      drop(id);
      return known ? Promise.resolve() : Promise.reject(new Error(`No window with id: ${String(id)}`));
    },
    onRemoved,
  };
  return {
    windows,
    createCalls,
    removeCalls,
    calls,
    onRemoved,
    close: drop,
    open: (url: string): number => {
      const id = nextId++;
      windows.push({ id, options: { url } });
      return id;
    },
    holdCreates: () => {
      held = [];
    },
    releaseCreates: () => {
      const queue = held ?? [];
      held = undefined;
      for (const resolve of queue) resolve();
    },
  };
}

/**
 * Installs a fake runtime. With `contexts`, it also has runtime.getContexts,
 * listing one TAB context per open fake window (its document URL is the URL
 * the window was opened with), as Firefox does for the runner pages.
 */
function installFakeRuntime(contexts?: FakeWindows): FakeRuntime {
  const onConnect = fakeEvent<(p: FakePort) => void>();
  (fakeBrowser as unknown as { runtime: unknown }).runtime = {
    getURL: (path: string): string => ORIGIN + path.replace(/^\//, ''),
    onConnect,
    ...(contexts === undefined
      ? {}
      : {
          getContexts: (): Promise<unknown[]> =>
            Promise.resolve(
              contexts.windows.map((w) => ({
                contextType: 'TAB',
                windowId: w.id,
                tabId: w.id * 10,
                documentUrl: String(w.options.url),
              })),
            ),
        }),
  };
  return {
    onConnect,
    pageConnects(pageUrl: string, windowId?: number): FakePort {
      const port: FakePort = {
        name: SNIPE_HOST_PORT,
        sender: { id: EXT_ID, url: pageUrl, ...(windowId === undefined ? {} : { tab: { windowId } }) },
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

/** Every page host a test made: afterEach tears them down, as a worker's end does. */
const madeHosts: SnipeHost[] = [];

function pageHost(verdict: 'runner-page' | 'background' = 'runner-page'): SelectedSnipeHost {
  const selected = createSnipeHost(deps(), { verdict, modules: PAGE_MODULE });
  madeHosts.push(selected.host);
  return selected;
}

/** The page host itself (its diagnostics and the worker-teardown `dispose`). */
function runnerPageHost(): PageSnipeHost {
  const host = pageHost().host;
  if (!(host instanceof PageSnipeHost)) throw new Error('expected the runner-page host');
  return host;
}

/** Waits until `check` holds (the host's early-close handling is async). */
async function until(check: () => void): Promise<void> {
  await vi.waitFor(check);
}

/** Lets pending promise continuations run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

/** A promise the test resolves itself. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

afterEach(() => {
  for (const host of madeHosts.splice(0)) if (host instanceof PageSnipeHost) host.dispose();
  setSnipeHostPageHooks(undefined);
  vi.unstubAllEnvs();
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

// ── R4 through the build's own verdict (what the runner gets) ──────────────

describe('platform selection through the default verdict (what the runner gets)', () => {
  it('a Chrome build gets the background host and never opens a window', async () => {
    vi.stubEnv('FIREFOX', 'false');
    const windows = installFakeWindows();
    installFakeRuntime(windows);

    const chrome = createSnipeHost(deps()); // the production glob and the build's own verdict
    expect(chrome).toMatchObject({ verdict: 'background', implementation: 'background', degraded: false });
    expect(chrome.host).toBeInstanceOf(BackgroundSnipeHost);
    await chrome.host.acquire('sn1');
    await chrome.host.release('sn1');

    expect(windows.calls).toEqual([]);
  });

  it('a Firefox build gets the runner-page host', async () => {
    vi.stubEnv('FIREFOX', 'true');
    const windows = installFakeWindows();
    installFakeRuntime(windows);

    const firefox = createSnipeHost(deps());
    madeHosts.push(firefox.host);
    expect(firefox).toMatchObject({ verdict: 'runner-page', implementation: './snipe-host-page.ts', degraded: false });
    await firefox.host.acquire('sn1');
    expect(windows.createCalls).toHaveLength(1);
    await firefox.host.release('sn1');
    expect(windows.windows).toHaveLength(0);
  });
});

// ── Races between acquire, release and an early close ──────────────────────

describe('acquire, release and an early close racing each other', () => {
  it('two acquires for the same snipe at once open one window', async () => {
    const windows = installFakeWindows();
    installFakeRuntime(windows);
    const host = runnerPageHost();

    await Promise.all([host.acquire('sn1'), host.acquire('sn1')]);

    expect(windows.createCalls).toHaveLength(1);
    expect(windows.windows).toHaveLength(1);
  });

  it('a release while the window is still opening closes it', async () => {
    const windows = installFakeWindows();
    installFakeRuntime();
    const host = runnerPageHost();
    windows.holdCreates();

    const acquiring = host.acquire('sn1');
    await settle();
    const releasing = host.release('sn1');
    windows.releaseCreates();
    await Promise.all([acquiring, releasing]);

    expect(windows.createCalls).toHaveLength(1);
    expect(windows.windows).toHaveLength(0);
    expect(host.windowIdFor('sn1')).toBeUndefined();
  });

  it('a release while an early close is being handled never re-opens the window', async () => {
    const windows = installFakeWindows();
    installFakeRuntime();
    const ahead = deferred<boolean>();
    const audits: boolean[] = [];
    setSnipeHostPageHooks({
      stillAhead: () => ahead.promise,
      auditClosed: (_snipeId, _closedAt, reacquired) => {
        audits.push(reacquired);
      },
    });
    const host = runnerPageHost();
    await host.acquire('sn1');

    windows.close(1); // the user closes the window...
    await host.release('sn1'); // ...as the runner releases it (the snipe ended)
    ahead.resolve(true);
    await until(() => {
      expect(audits).toHaveLength(1);
    });
    await settle();

    expect(audits).toEqual([false]);
    expect(windows.createCalls).toHaveLength(1);
    expect(windows.windows).toHaveLength(0);
  });

  it('a release while the early-close audit is being written never re-opens the window', async () => {
    const windows = installFakeWindows();
    installFakeRuntime();
    const written = deferred<undefined>();
    setSnipeHostPageHooks({ stillAhead: () => true, auditClosed: () => written.promise });
    const host = runnerPageHost();
    await host.acquire('sn1');

    windows.close(1);
    await settle(); // the audit is being written...
    await host.release('sn1'); // ...as the runner releases the snipe
    written.resolve(undefined);
    await settle();

    expect(windows.createCalls).toHaveLength(1);
    expect(windows.windows).toHaveLength(0);
  });

  it('a release while the re-acquired window is opening closes that window', async () => {
    const windows = installFakeWindows();
    installFakeRuntime();
    setSnipeHostPageHooks({ stillAhead: () => true });
    const host = runnerPageHost();
    await host.acquire('sn1');

    windows.holdCreates();
    windows.close(1);
    await until(() => {
      expect(windows.createCalls).toHaveLength(2);
    });
    await host.release('sn1');
    windows.releaseCreates();
    await settle();

    expect(windows.windows).toHaveLength(0);
    expect(host.windowIdFor('sn1')).toBeUndefined();
  });

  it('an early close is still audited and re-acquired when the window-time check fails', async () => {
    const windows = installFakeWindows();
    installFakeRuntime();
    const audits: boolean[] = [];
    setSnipeHostPageHooks({
      stillAhead: () => {
        throw new Error('storage unreadable');
      },
      auditClosed: (_snipeId, _closedAt, reacquired) => {
        audits.push(reacquired);
      },
    });
    const host = runnerPageHost();
    await host.acquire('sn1');

    windows.close(1);
    await until(() => {
      expect(windows.createCalls).toHaveLength(2);
    });

    expect(audits).toEqual([true]);
    expect(windows.createCalls[1]).toMatchObject({ type: 'popup', focused: false });
  });
});

// ── The page port: only the held window's runner page ──────────────────────

describe('the page port', () => {
  it('is held only from the runner page of the held window', async () => {
    installFakeWindows();
    const runtime = installFakeRuntime();
    const host = runnerPageHost();
    await host.acquire('sn1'); // window 1

    runtime.pageConnects(`${ORIGIN}sidebar.html?s=sn1`, 1); // not the runner page
    runtime.pageConnects('moz-extension://another-extension/snipe-runner.html?s=sn1', 1); // not ours
    expect(host.diagnostics()[0]?.portConnected).toBe(false);

    runtime.pageConnects(pageUrlOf('sn1'), 1);
    expect(host.diagnostics()[0]?.portConnected).toBe(true);
  });

  it('release closes the window before it hangs up the port (the page never reconnects to a released snipe)', async () => {
    const windows = installFakeWindows();
    const runtime = installFakeRuntime();
    const host = runnerPageHost();
    await host.acquire('sn1');
    const port = runtime.pageConnects(pageUrlOf('sn1'), 1);
    const windowOpenAtHangUp: boolean[] = [];
    port.onDisconnect.addListener(() => {
      windowOpenAtHangUp.push(windows.windows.some((w) => w.id === 1));
    });

    await host.release('sn1');

    expect(port.disconnected).toBe(true);
    expect(windowOpenAtHangUp[0]).toBe(false);
  });
});

// ── A worker that died with its window open (DeepSeek concern 2) ──────────

describe('a worker that died with its window still open', () => {
  it('the restarted worker adopts the open runner page instead of opening a second window', async () => {
    const windows = installFakeWindows();
    const runtime = installFakeRuntime(windows);
    const before = runnerPageHost();
    await before.acquire('sn1');
    before.dispose(); // the worker dies: its window stays open

    const after = runnerPageHost();
    await after.acquire('sn1');

    expect(windows.createCalls).toHaveLength(1); // no second window
    expect(windows.windows.map((w) => w.id)).toEqual([1]);
    expect(after.diagnostics()).toEqual([
      { snipeId: 'sn1', windowId: 1, reacquired: false, adopted: true, portConnected: false },
    ]);

    // The page reconnects its port to the new worker, which holds it again.
    const port = runtime.pageConnects(pageUrlOf('sn1'), 1);
    expect(after.diagnostics()[0]?.portConnected).toBe(true);

    // release closes the adopted window.
    await after.release('sn1');
    expect(windows.removeCalls).toEqual([1]);
    expect(windows.windows).toHaveLength(0);
    expect(port.disconnected).toBe(true);
  });

  it('an early close of an adopted window is audited and re-acquired once', async () => {
    const windows = installFakeWindows();
    installFakeRuntime(windows);
    const audits: boolean[] = [];
    setSnipeHostPageHooks({
      stillAhead: () => true,
      auditClosed: (_snipeId, _closedAt, reacquired) => {
        audits.push(reacquired);
      },
    });
    const orphan = windows.open(pageUrlOf('sn1'));
    const host = runnerPageHost();
    await host.acquire('sn1');
    expect(host.windowIdFor('sn1')).toBe(orphan);

    windows.close(orphan);
    await until(() => {
      expect(windows.createCalls).toHaveLength(1);
    });

    expect(audits).toEqual([true]);
    expect(windows.createCalls[0]).toMatchObject({ type: 'popup', focused: false });
    expect(host.windowIdFor('sn1')).not.toBe(orphan);
  });

  it('duplicate runner pages for the snipe: one is adopted, the others are closed', async () => {
    const windows = installFakeWindows();
    installFakeRuntime(windows);
    const a = windows.open(pageUrlOf('sn1'));
    const b = windows.open(pageUrlOf('sn1'));
    const host = runnerPageHost();

    await host.acquire('sn1');
    await settle();

    expect(windows.createCalls).toHaveLength(0);
    expect(host.windowIdFor('sn1')).toBe(a);
    expect(windows.removeCalls).toEqual([b]);
    expect(windows.windows.map((w) => w.id)).toEqual([a]);
  });

  it("never adopts a page a live host holds, another snipe's page, or a page that is not the runner page", async () => {
    const windows = installFakeWindows();
    installFakeRuntime(windows);
    const first = runnerPageHost();
    await first.acquire('sn1'); // window 1, held
    windows.open(pageUrlOf('sn2')); // 2
    windows.open(`${ORIGIN}sidebar.html?s=sn1`); // 3
    windows.open('moz-extension://another-extension/snipe-runner.html?s=sn1'); // 4

    const second = runnerPageHost();
    await second.acquire('sn1');

    expect(windows.createCalls).toHaveLength(2);
    expect(first.windowIdFor('sn1')).toBe(1);
    expect(second.windowIdFor('sn1')).toBe(5);
    expect(windows.removeCalls).toEqual([]);
  });

  it('without runtime.getContexts, an old page that reconnects to a worker holding the snipe in another window is closed', async () => {
    const windows = installFakeWindows();
    const runtime = installFakeRuntime(); // no getContexts: adoption cannot find the old page
    const orphan = windows.open(pageUrlOf('sn1'));
    const host = runnerPageHost();
    await host.acquire('sn1'); // a second window, 2

    const port = runtime.pageConnects(pageUrlOf('sn1'), orphan);
    await settle();

    expect(windows.removeCalls).toEqual([orphan]);
    expect(windows.windows.map((w) => w.id)).toEqual([2]);
    expect(host.diagnostics()[0]).toMatchObject({ windowId: 2, portConnected: false });
    expect(port.disconnected).toBe(false);
  });

  it('the page of a window being re-acquired is never closed as a duplicate', async () => {
    const windows = installFakeWindows();
    const runtime = installFakeRuntime();
    setSnipeHostPageHooks({ stillAhead: () => true });
    const host = runnerPageHost();
    await host.acquire('sn1'); // 1

    windows.holdCreates();
    windows.close(1); // the user closes it: the host re-acquires window 2...
    await until(() => {
      expect(windows.createCalls).toHaveLength(2);
    });
    runtime.pageConnects(pageUrlOf('sn1'), 2); // ...whose page connects before windows.create resolves
    await settle();
    windows.releaseCreates();
    await settle();

    expect(windows.removeCalls).toEqual([]);
    expect(windows.windows.map((w) => w.id)).toEqual([2]);
    expect(host.windowIdFor('sn1')).toBe(2);
  });
});

describe('reaping runner pages no live host holds', () => {
  it('closes the pages whose snipe no longer needs a window, and only those', async () => {
    const windows = installFakeWindows();
    installFakeRuntime(windows);
    const held = runnerPageHost();
    await held.acquire('held'); // 1, held by a live host
    const done = windows.open(pageUrlOf('done')); // 2
    const live = windows.open(pageUrlOf('live')); // 3
    const other = windows.open(`${ORIGIN}sidebar.html?s=done`); // 4, not a runner page
    setSnipeHostPageHooks({ needsWindow: (snipeId) => snipeId === 'live' });

    const closed = await reapRunnerPages({ now: T0, log: () => undefined });

    expect(closed).toEqual([done]);
    expect(windows.windows.map((w) => w.id)).toEqual([1, live, other]);
  });

  it('closes nothing without the needsWindow hook, or when it fails', async () => {
    const windows = installFakeWindows();
    installFakeRuntime(windows);
    windows.open(pageUrlOf('sn1'));

    expect(await reapRunnerPages({ now: T0, log: () => undefined })).toEqual([]);
    setSnipeHostPageHooks({
      needsWindow: () => {
        throw new Error('storage unreadable');
      },
    });
    expect(await reapRunnerPages({ now: T0, log: () => undefined })).toEqual([]);
    expect(windows.windows).toHaveLength(1);
  });

  it('closes nothing without runtime.getContexts', async () => {
    const windows = installFakeWindows();
    installFakeRuntime();
    windows.open(pageUrlOf('sn1'));
    setSnipeHostPageHooks({ needsWindow: () => false });

    expect(await reapRunnerPages({ now: T0, log: () => undefined })).toEqual([]);
    expect(windows.windows).toHaveLength(1);
  });
});

// ── The background wiring (src/background/jobs/snipe-host-page.ts) ─────────

describe('the background wiring of the runner-page host', () => {
  const END = new Date(T0 + 60_000).toISOString();

  function snipe(id: string, state: string, endTime: string = END): Record<string, unknown> {
    return { id, itemId: 42, state, endTime, dryRun: false };
  }

  function jobContext(snipes: Record<string, unknown>): { ctx: BackgroundContext; audits: unknown[] } {
    const audits: unknown[] = [];
    const ctx = {
      clock: new FakeClock(T0),
      repo: { get: () => Promise.resolve(snipes) },
      audit: {
        append: (entry: unknown) => {
          audits.push(entry);
          return Promise.resolve();
        },
      },
    } as unknown as BackgroundContext;
    return { ctx, audits };
  }

  it('on a Firefox build, the startup closes the pages of finished, unknown and past snipes and keeps the open ones', async () => {
    vi.stubEnv('FIREFOX', 'true');
    const windows = installFakeWindows();
    installFakeRuntime(windows);
    const open = windows.open(pageUrlOf('open'));
    const resolved = windows.open(pageUrlOf('resolved'));
    const killed = windows.open(pageUrlOf('killed'));
    const past = windows.open(pageUrlOf('past'));
    const unknown = windows.open(pageUrlOf('unknown'));
    const { ctx } = jobContext({
      open: snipe('open', 'waking'),
      resolved: snipe('resolved', 'resolved'),
      killed: snipe('killed', 'killed'),
      past: snipe('past', 'sent', new Date(T0 - 6_000).toISOString()),
    });

    registerHostPageJob(ctx);

    await until(() => {
      expect([...windows.removeCalls].sort()).toEqual([resolved, killed, past, unknown].sort());
    });
    expect(windows.windows.map((w) => w.id)).toEqual([open]);
  });

  it('on a Chrome build, the startup never looks for runner pages', async () => {
    vi.stubEnv('FIREFOX', 'false');
    const windows = installFakeWindows();
    installFakeRuntime(windows);
    const getContexts = vi.fn(() => Promise.resolve([]));
    (fakeBrowser.runtime as unknown as { getContexts: unknown }).getContexts = getContexts;
    windows.open(pageUrlOf('unknown'));
    const { ctx } = jobContext({});

    registerHostPageJob(ctx);
    await settle();

    expect(getContexts).not.toHaveBeenCalled();
    expect(windows.calls).toEqual([]);
  });

  it("an early close is audited with the snipe's item and re-acquired while the window time is ahead", async () => {
    const windows = installFakeWindows();
    installFakeRuntime();
    const { ctx, audits } = jobContext({ sn1: snipe('sn1', 'waking') });
    registerHostPageJob(ctx);
    const host = runnerPageHost();
    await host.acquire('sn1');

    windows.close(1);
    await until(() => {
      expect(windows.createCalls).toHaveLength(2);
    });

    expect(audits).toEqual([
      {
        actor: 'snipe',
        kind: 'snipe.host-window-closed',
        itemId: 42,
        ref: 'sn1',
        details: { closedAt: T0, reacquired: true },
        dryRun: false,
      },
    ]);
  });
});

// ── The runner page (src/entrypoints/snipe-runner/main.ts) ─────────────────

describe('the runner page', () => {
  it('holds its port open, and reconnects it a bounded number of times when the background goes away', async () => {
    vi.useFakeTimers();
    try {
      const ports: Array<{ name: string; drop(): void }> = [];
      (fakeBrowser as unknown as { runtime: unknown }).runtime = {
        connect: (info: { name: string }) => {
          const onDisconnect = fakeEvent<() => void>();
          ports.push({
            name: info.name,
            drop: () => {
              for (const l of [...onDisconnect.listeners]) l();
            },
          });
          return { name: info.name, onDisconnect, disconnect: () => undefined };
        },
      };

      await import('../../src/entrypoints/snipe-runner/main');
      expect(ports.map((p) => p.name)).toEqual([SNIPE_HOST_PORT]);

      // The background goes away (a worker death, or the event page suspended): reconnect after a short delay.
      for (let i = 1; i <= 5; i++) {
        ports[i - 1]?.drop();
        expect(ports).toHaveLength(i);
        await vi.advanceTimersByTimeAsync(1_000);
        expect(ports).toHaveLength(i + 1);
      }
      // Bounded: no endless reconnect loop.
      ports[5]?.drop();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(ports).toHaveLength(6);
    } finally {
      vi.useRealTimers();
    }
  });
});
