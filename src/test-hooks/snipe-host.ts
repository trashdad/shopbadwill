// `sbw:test:snipe-host` (T-116): drives the runner-page SnipeHost in the real
// browser, so the Firefox E2E spec (test/e2e/firefox/snipe_host_page_test.py)
// can prove, outside the background: acquire opens one small unfocused popup
// with the runner-page text that holds its runtime port, a second acquire is
// a no-op, release closes the window, and a window the user closes early is
// audited and re-acquired once. Test builds only; see ./index.ts for how
// hooks are loaded and called.
//
// `restart` simulates a worker that died mid-window: the host is disposed
// (its windows stay open, its ports drop) and a fresh one replaces it, which
// may at once acquire again (`acquire: true`, adopting the open page before
// the page's 1 s reconnect). `reap` runs the startup reap with the job
// module's real `needsWindow` (the test snipes are unknown, so not needed).
//
// The host is created through the real factory with the runner-page verdict
// (what the runner gets on a Firefox build). The audit and window-time hooks
// were wired at startup by src/background/jobs/snipe-host-page.ts, so the
// early-close path under test is the production one.
import { BrowserClock } from '../adapters/browser/clock';
import { createSnipeHost, type SelectedSnipeHost } from '../adapters/browser/snipe-host';
import { PageSnipeHost, reapRunnerPages } from '../adapters/browser/snipe-host-page';
import type { TestHookContext } from './index';

export const SNIPE_HOST_HOOK = 'sbw:test:snipe-host';

const TEST_CLOCK = new BrowserClock();

function log(message: string, error?: unknown): void {
  console.warn(`[ShopBadwill test] ${message}`, error);
}

let host: SelectedSnipeHost | undefined;

function getHost(): SelectedSnipeHost {
  if (host === undefined) {
    host = createSnipeHost(
      {
        clock: TEST_CLOCK,
        log,
      },
      { verdict: 'runner-page' },
    );
  }
  return host;
}

function pageHost(selected: SelectedSnipeHost): PageSnipeHost | undefined {
  return selected.host instanceof PageSnipeHost ? selected.host : undefined;
}

export function install(ctx: TestHookContext): void {
  ctx.serve(SNIPE_HOST_HOOK, async (payload: unknown): Promise<unknown> => {
    const req = (payload ?? {}) as { action?: unknown; snipeId?: unknown; acquire?: unknown };
    const snipeId = typeof req.snipeId === 'string' ? req.snipeId : 'test-snipe';
    const acquire = async (selected: SelectedSnipeHost): Promise<unknown> => {
      const page = pageHost(selected);
      await selected.host.acquire(snipeId);
      return {
        held: true,
        windowId: page?.windowIdFor(snipeId) ?? null,
        createOptions: page?.createOptionsFor(snipeId) ?? null,
      };
    };
    if (req.action === 'restart') {
      if (host !== undefined) pageHost(host)?.dispose();
      host = undefined;
      const fresh = getHost();
      return req.acquire === true ? acquire(fresh) : { restarted: true };
    }
    if (req.action === 'reap') {
      return { closed: await reapRunnerPages({ now: TEST_CLOCK.now(), log }) };
    }
    const selected = getHost();
    const page = pageHost(selected);
    switch (req.action) {
      case 'acquire': {
        return acquire(selected);
      }
      case 'release': {
        await selected.host.release(snipeId);
        return { held: false };
      }
      case 'status': {
        return {
          implementation: selected.implementation,
          degraded: selected.degraded,
          verdict: selected.verdict,
          snipes: page?.diagnostics() ?? [],
        };
      }
      default:
        throw new Error(
          `sbw:test:snipe-host: unknown action ${typeof req.action === 'string' ? req.action : '<none>'}`,
        );
    }
  });
}
