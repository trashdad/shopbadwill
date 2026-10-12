// T-59: the daily autonomous job end to end, in a real Chromium, on the TEST
// build (.output/chrome-mv3-test: SBW_TEST=1). The full arc per PLAN §6 T-59:
//
//   create watch (watches.save) → trigger `sbw:tick` (sbw:test:fireAlarm)
//     → one SGW request per tick, ≥ 120 s apart in fake time, proven from the
//       fake server's /__log through the `x-sbw-fake-now` header the test
//       build's fetch wrapper stamps (R4)
//     → a browser-context restart mid-run resumes at the stored cursor (R2:
//       the base-URL override and the Clock offset are re-applied from the
//       harness after the restart)
//     → catch-up: a watch 3 days past its slot runs once as trigger
//       'catch-up' and moves to the next daily slot
//     → dry-run favoriting: audit entries, zero AddToFavorite/Favorite/Save
//       calls
//     → live favoriting (against the fake only): exactly one AddToFavorite per
//       sgw-mode item, none for a `favoriteMode: 'local'` watch.
//
// Every browser request is either fulfilled by the route from the local fake
// servers or aborted; a request to any host beyond the known set fails the
// spec (R5). The background's own base URLs are overridden through the real
// `sbw:test:baseUrl` hook, so nothing can leave the machine. The fake
// buyerapi clock is pinned to 2026-10-08T00:00:00 Pacific and the
// background's Clock is anchored 30 minutes later, so the open-auction set is
// fixed forever. Time moves only through `sbw:test:advance` (fake time; no
// sleeps, test-strategy §7.4).
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { chromium, expect, test, type BrowserContext, type Page, type Route, type Worker } from '@playwright/test';

import { pacificNaiveToEpoch } from '../../fakes/fake-sgw-server/clock';
import type { AuditEntry } from '../../../src/domain/audit/types';
import type { Rule } from '../../../src/domain/rules/schema';
import type { SgwSessionRecord, TrackedItem } from '../../../src/domain/types';
import type { JobRun, Watch } from '../../../src/domain/watches/schema';
import { MSG_VERSION } from '../../../src/messaging/protocol';
import { seed, testExtensionDir } from './fixtures';
import { DAY, HOUR, TICK_STEP_MS } from './helpers/time';
import { decideRequest, FAKE_BUYERAPI, FAKE_GOOGLE } from './network';

// ── The fixed clock ──────────────────────────────────────────────────────────

/** The fake buyerapi clock, pinned per test (overlay.spec pins the same instant). */
const SERVER_PIN_PACIFIC = '2026-10-08T00:00:00';
/** The background's fake clock, anchored 30 min after the server pin (still far before every open auction ends). */
const ANCHOR_MS = pacificNaiveToEpoch('2026-10-08T00:30:00');

// The fixture items the tests match (test/fakes/fake-sgw-server/seed/):
const PYREX_1 = 280000000; // "Pyrex lot #1 vintage"
const PYREX_13 = 280000012; // "Pyrex lot #13"
const PYREX_25 = 280000024; // "Pyrex lot #25"

// ── Wire types ───────────────────────────────────────────────────────────────

interface FakeLogEntry {
  seq: number;
  method: string;
  path: string;
  query: string;
  endpoint: string;
  status: number;
  receivedAtMs: number;
  fakeNowMs: number | null;
  requestTimeMs: number;
  hasBearer: boolean;
  body: string;
}

interface HookReply {
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

// ── The fake-server side (Node) ──────────────────────────────────────────────

async function pinFakeClock(): Promise<void> {
  const res = await fetch(`${FAKE_BUYERAPI}/__scenario`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ reset: true, serverNowMs: pacificNaiveToEpoch(SERVER_PIN_PACIFIC) }),
  });
  expect(res.status).toBe(200);
}

async function clearFakeLog(): Promise<void> {
  const res = await fetch(`${FAKE_BUYERAPI}/__log`, { method: 'DELETE' });
  expect(res.status).toBe(200);
}

/** The log entries the background produced: the ones carrying `x-sbw-fake-now` (every background request does). */
async function backgroundLog(): Promise<FakeLogEntry[]> {
  const res = await fetch(`${FAKE_BUYERAPI}/__log`);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { entries: FakeLogEntry[] };
  return body.entries.filter((e) => e.fakeNowMs !== null);
}

/** R4: consecutive background requests are at least the background lane's 120 s apart in fake time. */
function expectFakeSpacing(entries: FakeLogEntry[]): void {
  for (let i = 1; i < entries.length; i++) {
    const prev = entries[i - 1];
    const cur = entries[i];
    const gap = (cur?.fakeNowMs ?? 0) - (prev?.fakeNowMs ?? 0);
    expect(
      gap,
      `request ${String(cur?.seq)} (${String(cur?.endpoint)}) came ${String(gap)} ms after ${String(prev?.seq)} (${String(prev?.endpoint)}); the background lane requires >= 120 s`,
    ).toBeGreaterThanOrEqual(120_000);
  }
}

async function mintSession(): Promise<SgwSessionRecord> {
  const res = await fetch(`${FAKE_BUYERAPI}/__token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
  expect(res.status).toBe(200);
  const token = (await res.json()) as { accessToken: string; expiresAtMs: number };
  return { bearer: token.accessToken, capturedAt: ANCHOR_MS, expiresAt: token.expiresAtMs, buyerId: '1234567', source: 'tap' };
}

// ── The browser side ─────────────────────────────────────────────────────────

/** Requests to hosts beyond the known set: the spec fails unless this stays empty. */
const unexpected: string[] = [];

async function fulfil(route: Route): Promise<void> {
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
  });
  await route.fulfill({ response: res });
}

/**
 * The fail-closed browser over a real profile directory (the same args the
 * shared harness uses: no name resolves, every proxied request hits a dead
 * port). The directory is the point: a context restart over the same profile
 * keeps storage.local, which is what "resume after a restart" means.
 */
async function launchInto(extension: string, profileDir: string): Promise<{ context: BrowserContext; worker: Worker }> {
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
  await context.route('**/*', fulfil);
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  return { context, worker };
}

/** The options page: where messages are sent from and the test hooks are called. */
async function openOptions(context: BrowserContext, worker: Worker): Promise<Page> {
  const id = new URL(worker.url()).host;
  const page = await context.newPage();
  await page.goto(`chrome-extension://${id}/options.html`);
  await expect(page.locator('h1')).toHaveText('ShopBadwill options');
  return page;
}

/** Calls a test hook from the options page (the only place the hook port accepts). */
async function callHook(page: Page, name: string, payload: unknown): Promise<HookReply> {
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
async function sendMsg(page: Page, type: string, payload?: unknown): Promise<unknown> {
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
async function applyBaseUrl(page: Page): Promise<void> {
  const reply = await callHook(page, 'sbw:test:baseUrl', { sgw: FAKE_BUYERAPI, google: FAKE_GOOGLE });
  expect(reply, JSON.stringify(reply)).toEqual({ ok: true, value: { sgw: FAKE_BUYERAPI, google: FAKE_GOOGLE } });
}

/**
 * The overlay spec's rewrite check, with a bounded retry: the route aborts a
 * service-worker request that still names the prod origin, so a 200 proves
 * the hook really rewrote the URL. A freshly relaunched browser can refuse
 * its very first proxied fetch once ("Failed to fetch") and then settle; the
 * retries ride that out without any sleep.
 */
async function verifyBaseUrl(worker: Worker): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    const status = await worker.evaluate(async () => {
      try {
        const response = await fetch('https://buyerapi.shopgoodwill.com/__log');
        return response.status;
      } catch {
        return 0;
      }
    });
    if (status === 200) return;
    expect(attempt, 'the rewritten background fetch never reached the fake buyerapi').toBeLessThan(4);
  }
}

/** Anchors the background's Clock to the fixed instant (absolute set: a restart's lost offset is re-anchored, not re-added). */
async function anchorClock(page: Page, at = ANCHOR_MS): Promise<void> {
  const reply = await callHook(page, 'sbw:test:advance', { to: at });
  expect(reply.ok, reply.error ?? 'sbw:test:advance failed').toBe(true);
  const value = reply.value as { now: number; fired: string[] };
  expect(value.now).toBe(at);
}

/** Moves the fake clock by `ms` (firing due alarms and Clock timers); returns the new now and the pending Clock timer deadlines. */
async function advance(page: Page, ms: number): Promise<{ now: number; timers: number[] }> {
  const adv = await callHook(page, 'sbw:test:advance', { ms });
  expect(adv.ok, adv.error ?? 'sbw:test:advance failed').toBe(true);
  return adv.value as { now: number; timers: number[] };
}

async function fireTick(page: Page): Promise<void> {
  const fire = await callHook(page, 'sbw:test:fireAlarm', { name: 'sbw:tick' });
  expect(fire.ok, fire.error ?? 'sbw:test:fireAlarm failed').toBe(true);
}

/** One fake-time step plus one tick alarm, waiting until the run moved and the tick settled. */
async function stepTick(page: Page, before: JobRun | null): Promise<JobRun> {
  await advance(page, TICK_STEP_MS);
  await fireTick(page);
  return awaitTick(page, before);
}

/** Waits until the tick moved the run on and settled. */
async function awaitTick(page: Page, before: JobRun | null): Promise<JobRun> {
  // The tick plans the run (first tick) and/or executes exactly one step.
  await expect
    .poll(
      async () => {
        const run = await jobStatus(page);
        if (run === null) return false;
        if (before === null) return run.cursor >= 1 || run.status !== 'running';
        if (run.id !== before.id) return run.cursor >= 1 || run.status !== 'running';
        return run.cursor > before.cursor || run.status !== 'running';
      },
      { message: `the tick did not advance the run (before: ${before === null ? 'none' : String(before.cursor)})`, timeout: 15_000 },
    )
    .toBe(true);
  return settleRun(page);
}

/** The run's persisted shape unchanged across two reads: the tick's step and subscribers have settled. */
async function settleRun(page: Page): Promise<JobRun> {
  let prev = '';
  await expect
    .poll(
      async () => {
        const run = await jobStatus(page);
        const snap =
          run === null
            ? ''
            : JSON.stringify([run.id, run.cursor, run.status, run.results.errors.length, run.results.newMatches.length, run.steps.length]);
        if (snap === '' || snap !== prev) {
          prev = snap;
          return false;
        }
        return true;
      },
      { message: 'the run never settled', timeout: 10_000 },
    )
    .toBe(true);
  return (await jobStatus(page)) as JobRun;
}

async function jobStatus(page: Page): Promise<JobRun | null> {
  return (await sendMsg(page, 'job.status', undefined)) as JobRun | null;
}

/** Storage dumps through `sbw:test:state` (only extension pages may call it). */
async function stateHook(page: Page): Promise<{ local: Record<string, unknown>; session: Record<string, unknown> }> {
  const reply = await callHook(page, 'sbw:test:state', undefined);
  expect(reply.ok, reply.error ?? 'sbw:test:state failed').toBe(true);
  return (reply.value as { storage: { local: Record<string, unknown>; session: Record<string, unknown> } }).storage;
}

/** The audit entries across the stored chunks, oldest first. */
async function auditEntries(page: Page): Promise<AuditEntry[]> {
  const { local } = await stateHook(page);
  return Object.entries(local)
    .filter(([k]) => k.startsWith('sbw:audit:'))
    .flatMap(([, v]) => v as AuditEntry[])
    .sort((a, b) => a.seq - b.seq);
}

async function tracked(page: Page): Promise<Record<string, TrackedItem>> {
  const { local } = await stateHook(page);
  return (local['sbw:tracked'] as Record<string, TrackedItem> | undefined) ?? {};
}

async function watches(page: Page): Promise<Watch[]> {
  return (await sendMsg(page, 'watches.list', undefined)) as Watch[];
}

// ── Domain fixtures (same shapes the options UI saves) ───────────────────────

function watchRule(id: string, terms: string[]): Rule {
  return {
    id,
    name: id,
    enabled: true,
    action: 'watch',
    all: [{ kind: 'keyword', mode: 'any', terms, wholeWord: true, regex: false, fields: ['title'] }],
    createdAt: ANCHOR_MS,
    updatedAt: ANCHOR_MS,
  };
}

function makeWatch(
  id: string,
  name: string,
  searchText: string,
  ruleIds: string[],
  favoriteMode: 'sgw' | 'local',
  maxPages: 1 | 2 = 1,
): Watch {
  return {
    id,
    name,
    enabled: true,
    query: { searchText, categoryIds: [], sellerIds: [], page: 1 },
    ruleIds,
    maxPages,
    favoriteMode,
    calendar: false,
    notify: false,
    nextRunAt: 0,
    seenItemIds: [],
  };
}

/** The watch is saved, then its slot is moved (e.g. to now, or 3 days back): the job's due/catch-up detection runs on it. */
async function saveAndMakeDue(page: Page, worker: Worker, saved: Watch, at: number): Promise<void> {
  await sendMsg(page, 'watches.save', saved);
  const list = await watches(page);
  await seed(worker, {
    'sbw:watches': list.map((w) => (w.id === saved.id ? { ...w, nextRunAt: at } : w)),
  });
}

const stepsOf = (run: JobRun): string[] => run.steps.map((s) => s.kind);

// ── The tests ────────────────────────────────────────────────────────────────

test('pacing: one SGW request per tick, at least 120 s of fake time apart', async () => {
  unexpected.length = 0;
  const profile = mkdtempSync(path.join(os.tmpdir(), 'sbw-e2e-daily-'));
  const ext = testExtensionDir();
  let context: BrowserContext | undefined;
  try {
    await pinFakeClock();
    await clearFakeLog();

    const launched = await launchInto(ext, profile);
    context = launched.context;
    const worker = launched.worker;
    const options = await openOptions(context, worker);
    await applyBaseUrl(options);
    await verifyBaseUrl(worker);
    await anchorClock(options);

    await test.step('a two-page watch is due now', async () => {
      await sendMsg(options, 'rules.save', watchRule('r-pacing', ['lot #1 vintage']));
      await saveAndMakeDue(options, worker, makeWatch('w-pacing', 'Pacing watch', 'lot', ['r-pacing'], 'local', 2), ANCHOR_MS);
    });

    let run: JobRun | null = null;
    let seen = 0;
    const atMostOneRequest = async (tick: string): Promise<void> => {
      const entries = await backgroundLog();
      expect(entries.length - seen, `tick ${tick} sent more than one request`).toBeLessThanOrEqual(1);
      seen = entries.length;
    };

    await test.step('the first tick searches page 1', async () => {
      run = await stepTick(options, run);
      await atMostOneRequest('1');
      expect(seen).toBe(1);
    });

    await test.step('a tick only 30 s later waits out the 120 s gap before page 2', async () => {
      // The spacing below must come from the RequestScheduler, not from the
      // harness's step size: fire this tick early, wait until the scheduler
      // holds page 2 on its gap timer (or, if pacing broke, already sent it),
      // then fast-forward past the gap.
      const [first] = await backgroundLog();
      const sentAt = first?.fakeNowMs ?? 0;
      const firedAt = (await advance(options, 30_000)).now;
      expect(firedAt - sentAt).toBeLessThan(120_000);
      await fireTick(options);
      await expect
        .poll(
          async () => {
            if ((await backgroundLog()).length > 1) return 'sent';
            const { timers } = await advance(options, 0);
            return timers.some((t) => t >= sentAt + 120_000 && t <= sentAt + TICK_STEP_MS + 60_000) ? 'held' : 'pending';
          },
          { message: 'page 2 was neither held on a gap timer nor sent', timeout: 15_000 },
        )
        .not.toBe('pending');
      await advance(options, TICK_STEP_MS);
      run = await awaitTick(options, run);
      await atMostOneRequest('2');
      const entries = await backgroundLog();
      expect(entries).toHaveLength(2);
      expect(entries[1]?.fakeNowMs ?? 0, 'page 2 went out when the early tick fired').toBeGreaterThan(firedAt);
      expectFakeSpacing(entries);
    });

    await test.step('the last tick reads the favorites list (no session: no request)', async () => {
      run = await stepTick(options, run);
      await atMostOneRequest('3');
    });

    await test.step('the run searched both pages and then read the favorites list', () => {
      const done = run as JobRun;
      expect(done.trigger).toBe('scheduled');
      expect(done.status).toBe('done');
      expect(stepsOf(done)).toEqual(['search', 'search', 'favoritesList']);
      expect(done.results.newMatches).toEqual([PYREX_1]);
    });

    await test.step('the fake log shows one request per step with 120 s fake spacing', async () => {
      const entries = await backgroundLog();
      expect(entries.map((e) => e.endpoint)).toEqual(['Search/ItemListing', 'Search/ItemListing']);
      expect(entries.map((e) => (JSON.parse(e.body) as { page: string }).page)).toEqual(['1', '2']);
      expectFakeSpacing(entries);
    });

    await test.step('no request ever left the machine', () => {
      expect(unexpected, `unexpected hosts: ${unexpected.join(', ')}`).toEqual([]);
    });
  } finally {
    await context?.close();
    rmSync(profile, { recursive: true, force: true });
  }
});

test('restart resume: a context restart mid-run resumes at the stored cursor', async () => {
  unexpected.length = 0;
  const profile = mkdtempSync(path.join(os.tmpdir(), 'sbw-e2e-daily-'));
  const ext = testExtensionDir();
  let context: BrowserContext | undefined;
  let worker: Worker | null = null;
  /** A box, so TypeScript never narrows the run to the initial null across the step callbacks. */
  const hold: { run: JobRun | null } = { run: null };
  try {
    await pinFakeClock();
    await clearFakeLog();

    await test.step('the run starts: search, then the favorites list', async () => {
      const launched = await launchInto(ext, profile);
      context = launched.context;
      worker = launched.worker;
      const options = await openOptions(context, worker);
      await applyBaseUrl(options);
      await verifyBaseUrl(worker);
      await anchorClock(options);
      await sendMsg(options, 'rules.save', watchRule('r-restart', ['lot #1 vintage']));
      await saveAndMakeDue(options, worker, makeWatch('w-restart', 'Restart watch', 'pyrex', ['r-restart'], 'sgw'), ANCHOR_MS);

      hold.run = await stepTick(options, null); // search
      hold.run = await stepTick(options, hold.run); // favoritesList (no session: an auth error, no request)
      expect(hold.run.cursor).toBe(2);
      expect(hold.run.status).toBe('running');
    });
    const runId = hold.run?.id;
    expect(runId).toBeDefined();
    const beforeRestart = await backgroundLog();
    expect(beforeRestart.map((e) => e.endpoint)).toEqual(['Search/ItemListing']);

    await test.step('the context restarts over the same profile and the run resumes', async () => {
      await context?.close();
      context = undefined;
      const relaunched = await launchInto(ext, profile);
      context = relaunched.context;
      worker = relaunched.worker;
      const options = await openOptions(context, worker);
      // R2: the override and the clock offset died with the worker; re-apply
      // both, then continue from where the fake clock was (two steps further,
      // for the re-anchored lane gap).
      await applyBaseUrl(options);
      await verifyBaseUrl(worker);
      await anchorClock(options, ANCHOR_MS + 4 * TICK_STEP_MS);

      const resumed = (await jobStatus(options)) as JobRun;
      expect(resumed.id).toBe(runId);
      expect(resumed.cursor).toBe(2);

      // The runner retries a first request that fails right after a restart
      // (a fresh browser can refuse one proxied fetch), so the finish may
      // take one tick more than the two steps left: run until done, bounded.
      hold.run = await stepTick(options, resumed); // detail
      hold.run = await stepTick(options, hold.run); // favorite (dry-run: audit, no call)
      if (hold.run.status !== 'done') hold.run = await stepTick(options, hold.run);
    });

    await test.step('the same run finished without re-running any step', async () => {
      const done = hold.run as JobRun;
      expect(done.id).toBe(runId);
      expect(done.status).toBe('done');
      expect(stepsOf(done)).toEqual(['search', 'favoritesList', 'detail', 'favorite']);
      expect(done.results.newMatches).toEqual([PYREX_1]);
      expect(done.results.favorited).toEqual([]);
      const entries = await backgroundLog();
      expect(entries.map((e) => e.endpoint)).toEqual(['Search/ItemListing', 'ItemDetail/GetItemDetailModelByItemId']);
      expectFakeSpacing(entries);
    });

    await test.step('the dry-run favorite was audited, never called', async () => {
      const options = await openOptions(context as BrowserContext, worker as Worker);
      const audit = await auditEntries(options);
      const favorites = audit.filter((e) => e.kind === 'favorite.add');
      expect(favorites).toHaveLength(1);
      expect(favorites[0]).toMatchObject({ itemId: PYREX_1, dryRun: true });
      const items = await tracked(options);
      expect(items[PYREX_1]?.favoriteState).toBe('none');
    });

    await test.step('no request ever left the machine', () => {
      expect(unexpected, `unexpected hosts: ${unexpected.join(', ')}`).toEqual([]);
    });
  } finally {
    await context?.close();
    rmSync(profile, { recursive: true, force: true });
  }
});

test('catch-up: a watch three days past its slot runs once, as catch-up', async () => {
  unexpected.length = 0;
  const profile = mkdtempSync(path.join(os.tmpdir(), 'sbw-e2e-daily-'));
  const ext = testExtensionDir();
  let context: BrowserContext | undefined;
  try {
    await pinFakeClock();
    await clearFakeLog();

    const launched = await launchInto(ext, profile);
    context = launched.context;
    const worker = launched.worker;
    const options = await openOptions(context, worker);
    await applyBaseUrl(options);
    await verifyBaseUrl(worker);
    await anchorClock(options);

    await test.step('the watch is three days overdue (the browser was closed)', async () => {
      await sendMsg(options, 'rules.save', watchRule('r-catch', ['lot #1 vintage']));
      await saveAndMakeDue(
        options,
        worker,
        makeWatch('w-catch', 'Catch-up watch', 'pyrex', ['r-catch'], 'local'),
        ANCHOR_MS - 3 * DAY - 1 * HOUR,
      );
    });

    let run: JobRun | null = null;
    await test.step('the catch-up run completes over two ticks', async () => {
      run = await stepTick(options, run); // search
      run = await stepTick(options, run); // favoritesList
      expect(run.status).toBe('done');
    });

    await test.step('it was a catch-up run, run once, moved to the next slot', async () => {
      const done = run as JobRun;
      expect(done.trigger).toBe('catch-up');
      expect(stepsOf(done)).toEqual(['search', 'favoritesList']);
      const list = await watches(options);
      const w = list.find((x) => x.id === 'w-catch');
      expect(w?.nextRunAt).toBeGreaterThan(ANCHOR_MS);
      expect(w?.nextRunAt).toBeLessThan(ANCHOR_MS + 2 * DAY);
      expect(w?.seenItemIds).toContain(PYREX_1);
      const audit = await auditEntries(options);
      expect(audit.some((e) => e.kind === 'job.skipped')).toBe(false); // catch-up is on
      const jobDone = audit.find((e) => e.kind === 'job.run.done');
      expect(jobDone?.details.trigger).toBe('catch-up');
    });

    await test.step('one request, and none beyond the machine', async () => {
      const entries = await backgroundLog();
      expect(entries.map((e) => e.endpoint)).toEqual(['Search/ItemListing']);
      expect(unexpected, `unexpected hosts: ${unexpected.join(', ')}`).toEqual([]);
    });
  } finally {
    await context?.close();
    rmSync(profile, { recursive: true, force: true });
  }
});

test('dry-run favoriting: audit entries and zero AddToFavorite calls', async () => {
  unexpected.length = 0;
  const profile = mkdtempSync(path.join(os.tmpdir(), 'sbw-e2e-daily-'));
  const ext = testExtensionDir();
  let context: BrowserContext | undefined;
  try {
    await pinFakeClock();
    await clearFakeLog();

    const launched = await launchInto(ext, profile);
    context = launched.context;
    const worker = launched.worker;
    const options = await openOptions(context, worker);
    await applyBaseUrl(options);
    await verifyBaseUrl(worker);
    await anchorClock(options);

    // The defaults are the point: dryRun.favorites is on, nobody signs in.
    await sendMsg(options, 'rules.save', watchRule('r-dry', ['lot #1 vintage']));
    await saveAndMakeDue(options, worker, makeWatch('w-dry', 'Dry-run watch', 'pyrex', ['r-dry'], 'sgw'), ANCHOR_MS);

    let run: JobRun | null = null;
    for (let i = 0; i < 4; i++) run = await stepTick(options, run);

    await test.step('the run matched, and the dry-run favorite wrote only the audit', async () => {
      const done = run as JobRun;
      expect(done.status).toBe('done');
      expect(stepsOf(done)).toEqual(['search', 'favoritesList', 'detail', 'favorite']);
      expect(done.results.newMatches).toEqual([PYREX_1]);
      expect(done.results.favorited).toEqual([]);
      const audit = await auditEntries(options);
      const favorites = audit.filter((e) => e.kind === 'favorite.add');
      expect(favorites).toHaveLength(1);
      expect(favorites[0]).toMatchObject({ itemId: PYREX_1, dryRun: true });
      const items = await tracked(options);
      expect(items[PYREX_1]?.favoriteState).toBe('none');
    });

    await test.step('zero favorite writes reached the fake SGW', async () => {
      const entries = await backgroundLog();
      expect(entries.map((e) => e.endpoint)).toEqual(['Search/ItemListing', 'ItemDetail/GetItemDetailModelByItemId']);
      for (const e of entries) {
        expect(e.path, 'no AddToFavorite and no Favorite/Save in dry-run').not.toMatch(/AddToFavorite|Favorite\/Save/);
      }
      expectFakeSpacing(entries);
      expect(unexpected, `unexpected hosts: ${unexpected.join(', ')}`).toEqual([]);
    });
  } finally {
    await context?.close();
    rmSync(profile, { recursive: true, force: true });
  }
});

test('live favoriting: exactly one call per sgw item, none for local watches', async () => {
  unexpected.length = 0;
  const profile = mkdtempSync(path.join(os.tmpdir(), 'sbw-e2e-daily-'));
  const ext = testExtensionDir();
  let context: BrowserContext | undefined;
  try {
    await pinFakeClock();
    await clearFakeLog();

    const launched = await launchInto(ext, profile);
    context = launched.context;
    const worker = launched.worker;
    const options = await openOptions(context, worker);
    await applyBaseUrl(options);
    await verifyBaseUrl(worker);
    await anchorClock(options);

    await test.step('a signed-in session, live favoriting, two sgw matches and one local', async () => {
      await seed(worker, { 'sbw:sgwSession': await mintSession() });
      await sendMsg(options, 'settings.set', { dryRun: { favorites: false, calendar: true, bidding: true } });
      await sendMsg(options, 'rules.save', watchRule('r-live', ['lot #1 vintage', 'lot #13']));
      await sendMsg(options, 'rules.save', watchRule('r-local', ['lot #25']));
      await saveAndMakeDue(options, worker, makeWatch('w-live', 'Live watch', 'pyrex', ['r-live'], 'sgw'), ANCHOR_MS);
      await saveAndMakeDue(options, worker, makeWatch('w-local', 'Local watch', 'pyrex', ['r-local'], 'local'), ANCHOR_MS);
    });

    let run: JobRun | null = null;
    await test.step('the run completes: searches, favorites list, details, favorites', async () => {
      for (let i = 0; i < 7; i++) run = await stepTick(options, run);
      const done = run as JobRun;
      expect(done.status).toBe('done');
      expect(stepsOf(done)).toEqual(['search', 'search', 'favoritesList', 'detail', 'detail', 'favorite', 'favorite']);
      expect([...done.results.newMatches].sort()).toEqual([PYREX_1, PYREX_13, PYREX_25].sort());
      expect(done.results.favorited).toEqual([PYREX_1, PYREX_13]);
    });

    await test.step('exactly one AddToFavorite per sgw item, none for the local one', async () => {
      const entries = await backgroundLog();
      const adds = entries.filter((e) => e.path.includes('AddToFavorite'));
      expect(adds.map((e) => Number(new URL(`http://fake${e.query}`).searchParams.get('itemId')))).toEqual([PYREX_1, PYREX_13]);
      expect(entries.map((e) => e.path)).not.toContain('/api/Favorite/Save');
      expect(entries.filter((e) => e.path.includes('AddToFavorite'))).toHaveLength(2);
      expectFakeSpacing(entries);
    });

    await test.step('the audit recorded the live favorites with undos; the local item stays untouched', async () => {
      const audit = await auditEntries(options);
      const favorites = audit.filter((e) => e.kind === 'favorite.add');
      expect(favorites).toHaveLength(2);
      expect(favorites.map((e) => e.itemId).sort()).toEqual([PYREX_1, PYREX_13].sort());
      for (const f of favorites) {
        expect(f.dryRun).toBeUndefined();
        expect(f.undo).toEqual({ kind: 'unfavorite', ref: `removeFavorite:${String(f.itemId)}` });
      }
      const items = await tracked(options);
      expect(items[PYREX_1]?.favoriteState).toBe('favorited');
      expect(items[PYREX_13]?.favoriteState).toBe('favorited');
      expect(items[PYREX_25]?.favoriteState).toBe('none');
      expect(items[PYREX_25]?.reasons).toEqual([{ kind: 'watch', id: 'w-local' }]);
    });

    await test.step('no request ever left the machine', () => {
      expect(unexpected, `unexpected hosts: ${unexpected.join(', ')}`).toEqual([]);
    });
  } finally {
    await context?.close();
    rmSync(profile, { recursive: true, force: true });
  }
});
