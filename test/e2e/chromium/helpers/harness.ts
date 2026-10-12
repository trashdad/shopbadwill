// The background-facing E2E harness (T-59, shared since T-72). T-59 wrote
// these in daily-job.spec.ts; calendar.spec.ts needs the same pieces, so they
// live here once instead of being copied:
//
//   - `createRouteGuard()`: the fail-closed route (network.ts decides each
//     request; an unexpected host is recorded, and the spec fails on it, R5);
//   - `launchInto()`: the fail-closed browser over a real profile directory
//     (a relaunch over the same directory is a browser restart);
//   - `openOptions()`, `callHook()`, `sendMsg()`: talk to the background from
//     the options page, through the real router or the test-hook ports;
//   - `applyBaseUrl()` / `verifyRewrite()`: point the background at the fake
//     servers and prove it (T-59 R2: in memory, so re-applied after every
//     restart);
//   - `anchorClock()` / `advance()` / `fireTick()`: fake time (no sleeps);
//   - `stateHook()` / `auditEntries()`: what the background persisted.
import { chromium, expect, type BrowserContext, type Page, type Route, type Worker } from '@playwright/test';

import type { AuditEntry } from '../../../../src/domain/audit/types';
import { MSG_VERSION } from '../../../../src/messaging/protocol';
import { decideRequest, FAKE_BUYERAPI, FAKE_GOOGLE } from '../network';

// ── Wire types ───────────────────────────────────────────────────────────────

export interface HookReply {
  ok: boolean;
  value?: unknown;
  error?: string;
}

interface MessageResponse {
  ok: boolean;
  reply?: unknown;
  error?: { code: string; message: string };
}

interface ChromePort {
  onMessage: { addListener(cb: (m: unknown) => void): void };
  postMessage(m: unknown): void;
  disconnect(): void;
}
interface ChromeRuntime {
  chrome: {
    runtime: {
      sendMessage(m: unknown): Promise<unknown>;
      connect(info: { name: string }): ChromePort;
    };
  };
}

// ── The network ──────────────────────────────────────────────────────────────

export interface RouteGuard {
  /** Requests to hosts beyond the known set: the spec fails unless this stays empty. */
  readonly unexpected: string[];
  /** The `context.route('**\/*', ...)` handler: fetch from a local fake, continue, or abort. */
  fulfil(route: Route): Promise<void>;
}

export function createRouteGuard(): RouteGuard {
  const unexpected: string[] = [];
  return {
    unexpected,
    async fulfil(route) {
      const req = route.request();
      const decision = decideRequest(req.url(), { serviceWorker: req.serviceWorker() !== null });
      if (decision.action === 'continue') {
        await route.continue();
        return;
      }
      if (decision.action === 'abort') {
        if (decision.unexpected) unexpected.push(req.url());
        await route.abort();
        return;
      }
      const res = await route.fetch({
        url: decision.url,
        method: req.method(),
        headers: req.headers(),
        postData: req.postData() ?? undefined,
        // Upstream is always a local fake; a redirect it answers goes back to the browser (and its route).
        maxRedirects: 0,
      });
      await route.fulfill({ response: res });
    },
  };
}

/**
 * The fail-closed browser over a real profile directory (the same args the
 * shared harness uses: no name resolves, every proxied request hits a dead
 * port). The directory is the point: a context restart over the same profile
 * keeps storage.local, which is what "resume after a restart" means.
 */
export async function launchInto(
  extension: string,
  profileDir: string,
  route: (route: Route) => Promise<void>,
): Promise<{ context: BrowserContext; worker: Worker }> {
  const context = await chromium.launchPersistentContext(profileDir, {
    channel: 'chromium',
    headless: true,
    viewport: { width: 1280, height: 800 },
    args: [
      `--disable-extensions-except=${extension}`,
      `--load-extension=${extension}`,
      '--host-resolver-rules=MAP * ~NOTFOUND',
      '--proxy-server=http://127.0.0.1:9',
    ],
  });
  await context.route('**/*', route);
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  return { context, worker };
}

// ── Talking to the background ────────────────────────────────────────────────

/** The options page: where messages are sent from and the test hooks are called. */
export async function openOptions(context: BrowserContext, worker: Worker): Promise<Page> {
  const id = new URL(worker.url()).host;
  const page = await context.newPage();
  await page.goto(`chrome-extension://${id}/options.html`);
  await expect(page.locator('h1')).toHaveText('ShopBadwill options');
  return page;
}

/** Calls a test hook from an extension page (the only place the hook port accepts). */
export async function callHook(page: Page, name: string, payload: unknown): Promise<HookReply> {
  return page.evaluate(
    async ({ hook, data }) => {
      const chrome = (globalThis as unknown as ChromeRuntime).chrome;
      const reply = await new Promise<HookReply>((resolve) => {
        const port = chrome.runtime.connect({ name: hook });
        const timer = setTimeout(() => {
          port.disconnect();
          resolve({ ok: false, error: `no reply on ${hook} within 10 s` });
        }, 10_000);
        port.onMessage.addListener((m) => {
          clearTimeout(timer);
          port.disconnect();
          resolve(m as HookReply);
        });
        port.postMessage({ payload: data });
      });
      return reply;
    },
    { hook: name, data: payload },
  );
}

/** A background message, through the real router. Throws on a failed reply. */
export async function sendMsg(page: Page, type: string, payload?: unknown): Promise<unknown> {
  return page.evaluate(
    async ({ v, type: t, payload: p }) => {
      const chrome = (globalThis as unknown as ChromeRuntime).chrome;
      const reply = (await chrome.runtime.sendMessage({
        v,
        reqId: crypto.randomUUID(),
        type: t,
        ...(p === undefined ? {} : { payload: p }),
      })) as MessageResponse;
      if (!reply.ok) throw new Error(`${t} failed: ${String(reply.error?.code)}: ${String(reply.error?.message)}`);
      return reply.reply;
    },
    { v: MSG_VERSION, type, payload },
  );
}

/** R2: the base-URL override is in-memory; every (re)started background gets it again from the harness. */
export async function applyBaseUrl(page: Page): Promise<void> {
  const reply = await callHook(page, 'sbw:test:baseUrl', { sgw: FAKE_BUYERAPI, google: FAKE_GOOGLE });
  expect(reply, JSON.stringify(reply)).toEqual({ ok: true, value: { sgw: FAKE_BUYERAPI, google: FAKE_GOOGLE } });
}

/**
 * The overlay spec's rewrite check, with a bounded retry: the route aborts a
 * service-worker request that still names a prod origin, so a 200 proves the
 * hook really rewrote the URL. A freshly relaunched browser can refuse its
 * very first proxied fetch once ("Failed to fetch") and then settle; the
 * retries ride that out without any sleep.
 */
export async function verifyRewrite(worker: Worker, prodUrl: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    const status = await worker.evaluate(async (url) => {
      try {
        const response = await fetch(url);
        return response.status;
      } catch {
        return 0;
      }
    }, prodUrl);
    if (status === 200) return;
    expect(attempt, `the rewritten background fetch of ${prodUrl} never reached its fake`).toBeLessThan(4);
  }
}

/** The buyerapi rewrite (T-39/T-59): the fake SGW's request log answers through the prod origin. */
export async function verifyBaseUrl(worker: Worker): Promise<void> {
  await verifyRewrite(worker, 'https://buyerapi.shopgoodwill.com/__log');
}

/**
 * Anchors the background's Clock to `at` (absolute set: a restart's lost
 * offset is re-anchored, not re-added).
 *
 * It first waits for the startup reconcile to have created `sbw:tick`. The
 * hook ports answer from the worker's first turn, before startup finishes, so
 * an anchor could land first; the tick alarm was then created at `at + 2 min`
 * in fake time, and the first `advance` fired it on top of the spec's own
 * `fireTick` (T-72 found this as a ~1-in-30 failure of T-59's restart test:
 * the run went one step too far). Created before the anchor, the alarm stays
 * days ahead of the fake clock and only `fireTick` drives the scheduler.
 */
export async function anchorClock(page: Page, at: number): Promise<void> {
  await expect
    .poll(async () => (await testState(page)).alarms.some((a) => a.name === 'sbw:tick'), {
      message: 'the background never created sbw:tick (its startup did not finish)',
      timeout: 15_000,
    })
    .toBe(true);
  const reply = await callHook(page, 'sbw:test:advance', { to: at });
  expect(reply.ok, reply.error ?? 'sbw:test:advance failed').toBe(true);
  const value = reply.value as { now: number; fired: string[] };
  expect(value.now).toBe(at);
}

/** Moves the fake clock by `ms` (firing due alarms and Clock timers); returns the new now and the pending Clock timer deadlines. */
export async function advance(page: Page, ms: number): Promise<{ now: number; fired: string[]; timers: number[] }> {
  const adv = await callHook(page, 'sbw:test:advance', { ms });
  expect(adv.ok, adv.error ?? 'sbw:test:advance failed').toBe(true);
  return adv.value as { now: number; fired: string[]; timers: number[] };
}

export async function fireTick(page: Page): Promise<void> {
  const fire = await callHook(page, 'sbw:test:fireAlarm', { name: 'sbw:tick' });
  expect(fire.ok, fire.error ?? 'sbw:test:fireAlarm failed').toBe(true);
}

export interface TestStateDump {
  installedAt: number;
  storage: { local: Record<string, unknown>; session: Record<string, unknown> };
  alarms: Array<{ name: string; scheduledTime: number }>;
}

/** What `sbw:test:state` dumps (only extension pages may call it). */
export async function testState(page: Page): Promise<TestStateDump> {
  const reply = await callHook(page, 'sbw:test:state', undefined);
  expect(reply.ok, reply.error ?? 'sbw:test:state failed').toBe(true);
  return reply.value as TestStateDump;
}

/** Storage dumps through `sbw:test:state`. */
export async function stateHook(page: Page): Promise<{ local: Record<string, unknown>; session: Record<string, unknown> }> {
  return (await testState(page)).storage;
}

/** The audit entries across the stored chunks, oldest first. */
export async function auditEntries(page: Page): Promise<AuditEntry[]> {
  const { local } = await stateHook(page);
  return Object.entries(local)
    .filter(([k]) => k.startsWith('sbw:audit:'))
    .flatMap(([, v]) => v as AuditEntry[])
    .sort((a, b) => a.seq - b.seq);
}
