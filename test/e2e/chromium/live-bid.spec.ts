// T-104: the LIVE money paths end to end, in a real Chromium, on the TEST
// build (.output/chrome-mv3-test: SBW_TEST=1), against the fake SGW buyerapi
// and its proxy-bidding semantics (test/fakes/fake-sgw-server/bidding: a bid
// is a hidden max; the leader pays the runner-up's max plus one increment),
// with 150 ms latency and SGW's clock 1.3 s ahead (as T-89). PLAN §6 T-104,
// I-42, R4, R6.
//
// The live gate first (I-42). Bidding ships in dry run (T-102), and nothing
// here seeds `completedDryRuns` or bypasses the `settings.set` interceptor.
// The first test asserts the gate refuses at 0 and at 4 dry runs (a crafted
// count is refused and never sticks), then completes `requiredDryRuns` (5)
// REAL dry-run snipes against the fake, fast-forwarded with sbw:test:advance,
// counted by T-90. The fifth fires 1.5 s late (the fake clock jumps past its
// timer, as a stalled machine would), so the soak is 4 of 5 on time (80 %,
// under T-102's 95 %): going live needs the typed confirmation, which the
// test types in the popup's real Live bidding section. That profile is the
// template every live test starts from (a fresh copy each, so no test sees
// another's spend, caps or kill switch). The ≥ 95 % path (no confirmation) is
// covered by T-102's unit tests.
//
// The live scenarios, each asserted on the fake's own request log, the
// snipe's outcome, the outcome notification's exact text and, where the
// calendar is on, the stamp on the (fake) Google event:
//
//   win (WON stamp) · outbid by a higher hidden max (LOST stamp, margin) ·
//   below the minimum at the fire (SGW refuses the one PlaceBid) · below the
//   minimum at the T−60 s verify (no PlaceBid) · cap-blocked at the fire (no
//   PlaceBid) · the `Bid` cookie (no Cookie on any request) · ambiguous with
//   ≥ 2 s left (exactly one resend, same amount and key) · ambiguous with
//   < 2 s left (no resend; Unconfirmed) · the kill switch between arm and fire
//
// R4 on the wire: every test counts PlaceBid on the fake's log AND on the
// browser side: at most one per snipe on the default flow, two only on
// T-101's proof-retry path. Every PlaceBid carries exactly the snipe's max.
//
// The wire is real. Requests to the fake SGW are NOT proxied by Playwright
// here (helpers/harness.ts's route.fetch keeps its own upstream request open
// after the browser aborts, and it replays the context's cookie jar on every
// request whatever the page's credentials mode). The browser is launched fail
// closed like everywhere else, except that 127.0.0.1 resolves, and requests to
// 127.0.0.1:8787 continue straight to the fake over a real socket: what the
// fake logs (including the new `cookie` field and the 499 of a request the
// browser gave up on) is exactly what the browser sent. Every other request
// goes through the shared fail-closed guard, and a request to any other host
// fails the spec.
//
// Notifications: Chrome cannot read a notification's text back, and its
// permission is optional (a headless run cannot answer the prompt), so
// sbw:test:notifications records the background's `notifications.create`
// calls (src/test-hooks/notifications.ts). The notifier and the copy are the
// production ones.
//
// Time: the background's Clock and alarms are fake (T-59); the harness only
// advances to deadlines the runner set, once it holds them (T-89). The
// PlaceBid timeout (20 s, bid.ts) runs on real time, so the two stall tests
// wait that long on real time, by polling for the outcome (no sleeps).
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { chromium, expect, test, type BrowserContext, type Page, type Request, type Route, type Worker } from '@playwright/test';

import type { AuditEntry } from '../../../src/domain/audit/types';
import type { Settings } from '../../../src/domain/settings/schema';
import { fireErrorMs, isOnTime, ON_TIME_TOLERANCE_MS } from '../../../src/domain/snipe/soak';
import { CLOCK_SAMPLE_SPACING_MS } from '../../../src/domain/snipe/timing';
import type { Snipe } from '../../../src/domain/snipe/types';
import type { CalendarState, SnipeRunnerRecord } from '../../../src/domain/storage/schema';
import { formatDual } from '../../../src/domain/time/pacific';
import type { TrackedItem } from '../../../src/domain/types';
import { GOOGLE_AUTH_HOOK } from '../../../src/test-hooks/google-auth-stub';
import { NOTIFICATIONS_HOOK, type RecordedNotification } from '../../../src/test-hooks/notifications';
import { seed, testExtensionDir } from './fixtures';
import { clearFakeLog, fakeLog, mintSession, setScenario, type FakeLogEntry } from './helpers/fake-sgw';
import {
  advance,
  anchorClock,
  applyBaseUrl,
  auditEntries,
  callHook,
  createRouteGuard,
  openOptions,
  sendMsg,
  stateHook,
  testState,
  verifyBaseUrl,
  verifyRewrite,
} from './helpers/harness';
import { MIN, SEC } from './helpers/time';
import { FAKE_BUYERAPI, FAKE_GOOGLE } from './network';

// ── The fixed setup ─────────────────────────────────────────────────────────

/** seed/items.json: has bids (a hidden competitor leads); seller 31, shipping $11.50. */
const PYREX = 279250057;
const PYREX_TITLE = 'Vintage Pyrex Butterprint Casserole Dish 1.5 Qt Turquoise';
/** seed/items.json: no bids and no bid history ($4.00 start), seller 31: T-101's no-change proof can hold. */
const HOT_WHEELS = 279250102;
const HOT_WHEELS_TITLE = 'Lot of 12 Hot Wheels Cars Assorted Loose';
const SELLER = 31;

/** PLAN §6 T-89: the fake server's injected latency and SGW's clock skew (server − local). */
const LATENCY_MS = 150;
const SKEW_MS = 1300;
/** Every auction ends this long after its test starts (server clock). */
const END_IN_MS = 20 * MIN;
/** snipe-runner.ts: VERIFY_BEFORE_END_MS, POST_READ_AFTER_END_MS (not imported: that module pulls in wxt/browser). */
const VERIFY_BEFORE_END_MS = 60 * SEC;
const POST_READ_AFTER_END_MS = 5 * SEC;
/** snipe-send.ts: PROOF_RESEND_MIN_TIME_LEFT_MS (same reason). */
const PROOF_RESEND_MIN_TIME_LEFT_MS = 2 * SEC;
/** settings defaults: requiredDryRuns (the gate never opens on fewer). */
const REQUIRED_DRY_RUNS = 5;
/** The fifth dry run's fire is this late: over the 1 s on-time tolerance, well before the end. */
const LATE_FIRE_MS = 1500;
/** Longer than bid.ts's 20 s PlaceBid timeout: the browser gives up first (the fake logs 499 and never evaluates the bid). */
const PLACE_BID_STALL_MS = 25 * SEC;

const SHOW_BID_MODAL = 'ItemBid/ShowBidModal';
const PLACE_BID = 'ItemBid/PlaceBid';
const ITEM_DETAIL = 'ItemDetail/GetItemDetailModelByItemId';

/** The dashboard copy (src/ui/dashboard/sections/snipes/arm-form.tsx). */
const DRY_RUN_LABEL = 'DRY RUN — no bid will be placed';
const DRY_RUN_OPTION = 'Dry run (no bid will be placed)';

/** The send path's audit kinds (state-machine.ts AUDIT_KIND, snipe-runner.ts). */
const SEND_AUDIT_KINDS = ['bid.sent', 'bid.result', 'bid.ambiguous', 'bid.not-sent'];

const money = (cents: number): string => `$${(cents / 100).toFixed(2)}`;

// ── The wire ────────────────────────────────────────────────────────────────

/** A request as it left the browser for the fake SGW. */
interface Departure {
  endpoint: string;
  method: string;
  path: string;
  body: string | null;
}
type LeaveHook = (d: Departure, departed: readonly Departure[]) => Promise<void>;

/** The fake SGW endpoint name a path belongs to (the fake logs the same names). */
function endpointOf(pathname: string): string {
  if (/\/api\/ItemBid\/PlaceBid\/?$/i.test(pathname)) return PLACE_BID;
  if (/\/api\/ItemBid\/ShowBidModal\/?$/i.test(pathname)) return SHOW_BID_MODAL;
  if (/\/api\/ItemDetail\/GetItemDetailModelByItemId\//i.test(pathname)) return ITEM_DETAIL;
  return pathname;
}

/**
 * The context's one route. Requests to the fake SGW (127.0.0.1:8787, where
 * sbw:test:baseUrl sends the background) are recorded as they leave, then
 * continue to the fake over a real socket; every other request goes through
 * the shared fail-closed guard (a fake fetch, or an abort that fails the spec).
 * A hook may change the fake's scenario at the exact moment a request leaves,
 * before it can arrive.
 */
class Wire {
  readonly departed: Departure[] = [];
  /** The fake's answers as the browser received them (raw headers, Set-Cookie included). */
  readonly answers: Array<Promise<{ endpoint: string; status: number; setCookie: string | undefined }>> = [];
  readonly hookErrors: string[] = [];
  private readonly guard = createRouteGuard();
  private readonly hooks: LeaveHook[] = [];

  get unexpected(): readonly string[] {
    return this.guard.unexpected;
  }

  onLeave(hook: LeaveHook): void {
    this.hooks.push(hook);
  }

  async route(route: Route): Promise<void> {
    const req = route.request();
    const url = new URL(req.url());
    if (url.origin !== FAKE_BUYERAPI) {
      await this.guard.fulfil(route);
      return;
    }
    const d: Departure = { endpoint: endpointOf(url.pathname), method: req.method(), path: `${url.pathname}${url.search}`, body: req.postData() };
    this.departed.push(d);
    try {
      for (const hook of this.hooks) await hook(d, this.departed);
    } catch (e) {
      this.hookErrors.push(String(e));
    }
    await route.continue();
  }

  /** `requestfinished`: keeps the answer of every request to the fake. */
  finished(req: Request): void {
    const url = new URL(req.url());
    if (url.origin !== FAKE_BUYERAPI) return;
    this.answers.push(
      (async () => {
        const res = await req.response();
        const headers = res === null ? {} : await res.allHeaders();
        return { endpoint: endpointOf(url.pathname), status: res?.status() ?? 0, setCookie: headers['set-cookie'] };
      })(),
    );
  }

  /** PlaceBid requests that left the browser. */
  placeBids(): Departure[] {
    return this.departed.filter((d) => d.endpoint === PLACE_BID);
  }
}

let extensionBuild: string | undefined;
/** The TEST build, built once per worker (fixtures.ts rebuilds on every call). */
function extensionDir(): string {
  extensionBuild ??= testExtensionDir();
  return extensionBuild;
}

/**
 * helpers/harness.ts's fail-closed browser (no name resolves, every proxied
 * request hits a dead port) with one exception: 127.0.0.1 resolves (Chromium
 * never proxies loopback), so the route can continue a request to the fake
 * SGW and the browser itself puts it on the wire.
 */
async function launchLive(profileDir: string, wire: Wire): Promise<{ context: BrowserContext; worker: Worker }> {
  const extension = extensionDir();
  const context = await chromium.launchPersistentContext(profileDir, {
    channel: 'chromium',
    headless: true,
    viewport: { width: 1280, height: 800 },
    args: [
      `--disable-extensions-except=${extension}`,
      `--load-extension=${extension}`,
      '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1',
      '--proxy-server=http://127.0.0.1:9',
    ],
  });
  await context.route('**/*', (route) => wire.route(route));
  context.on('requestfinished', (req) => {
    wire.finished(req);
  });
  const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  return { context, worker };
}

// ── The rig ─────────────────────────────────────────────────────────────────

interface Rig {
  context: BrowserContext;
  worker: Worker;
  /** The options page: messages and test hooks go through it. */
  options: Page;
  extensionId: string;
  wire: Wire;
  /** The user's time zone (settings.locale), for the notification's end time. */
  timeZone: string;
}

/** What afterEach closes and removes, set as soon as it exists (a failed setup is cleaned up too). */
let opened: { context?: BrowserContext; profile?: string } = {};

test.afterEach(async () => {
  const { context, profile } = opened;
  opened = {};
  await context?.close();
  if (profile !== undefined) rmSync(profile, { recursive: true, force: true });
  // The fake SGW is shared by every spec (CI starts one): leave it as a reset finds it.
  await setScenario({ reset: true });
});

/** The background, pointed at the fakes (T-59 R2: in memory, so after every launch). */
async function backgroundUp(context: BrowserContext, worker: Worker, wire: Wire): Promise<Rig> {
  const options = await openOptions(context, worker);
  await applyBaseUrl(options);
  await verifyBaseUrl(worker);
  const settings = (await sendMsg(options, 'settings.get')) as Settings;
  return { context, worker, options, extensionId: new URL(worker.url()).host, wire, timeZone: settings.locale.timeZone };
}

async function settingsOf(r: Rig): Promise<Settings> {
  return (await sendMsg(r.options, 'settings.get')) as Settings;
}

/**
 * The fake SGW for one auction: reset, SGW's clock pinned to the background's
 * fake now and following it (+1.3 s), 150 ms on every endpoint, the item's
 * proxy-bidding state, and its end `END_IN_MS` from now (with fractional
 * seconds, as SGW's ends have: S-1). A fresh signed-in session. Returns the end.
 */
async function auction(r: Rig, itemId: number, state: Record<string, unknown>, extra: Record<string, unknown> = {}): Promise<number> {
  const t0 = (await advance(r.options, 0)).now;
  const endMs = Math.round((t0 + SKEW_MS + END_IN_MS) / SEC) * SEC + 450;
  const { latencyMs, ...rest } = extra;
  await setScenario({
    reset: true,
    serverNowMs: t0,
    followFakeNow: true,
    skewMs: SKEW_MS,
    latencyMs: { '*': LATENCY_MS, ...(latencyMs as Record<string, number> | undefined) },
    ...rest,
    bidding: { items: { [String(itemId)]: { ...state, endsAtMs: endMs } } },
  });
  await clearFakeLog();
  await seed(r.worker, { 'sbw:sgwSession': await mintSession(t0) });
  return endMs;
}

interface ArmInput {
  itemId: number;
  maxText: string;
  leadS: number;
  /** The dashboard's "Next acceptable bid" line, from the fake's state. */
  nextBid: string;
  live: boolean;
}

/** T-85: Prepare → amount and lead → Review and arm → Arm snipe, in the side panel page. */
async function armThroughDashboard(r: Rig, a: ArmInput): Promise<Snipe> {
  const page = await r.context.newPage();
  try {
    await page.goto(`chrome-extension://${r.extensionId}/sidepanel.html`);
    const section = page.locator('#section-snipes');
    await section.getByLabel('Item id').fill(String(a.itemId));
    await section.getByRole('button', { name: 'Prepare', exact: true }).click();
    await expect(section.getByText(`Next acceptable bid: ${a.nextBid}`, { exact: true })).toBeVisible();
    await section.getByLabel('Max bid ($)').fill(a.maxText);
    await section.getByLabel('Lead (seconds)').fill(String(a.leadS));
    const dryRun = section.getByLabel(DRY_RUN_OPTION);
    if (a.live) {
      // Bidding is live (the gate opened): the per-snipe dry run is the user's choice, off by default.
      await expect(dryRun).not.toBeChecked();
      await expect(dryRun).toBeEnabled();
    } else {
      // Global bidding dry run on (T-102): the box is checked and cannot be cleared.
      await expect(dryRun).toBeChecked();
      await expect(dryRun).toBeDisabled();
    }
    await section.getByRole('button', { name: 'Review and arm' }).click();
    const confirm = section.locator('.sbw-confirm');
    await expect(confirm.getByText('Review your snipe')).toBeVisible();
    await expect(confirm.getByText(`Max bid: $${a.maxText}`)).toBeVisible();
    await expect(confirm.getByText(DRY_RUN_LABEL)).toHaveCount(a.live ? 0 : 1);
    await confirm.getByRole('button', { name: 'Arm snipe' }).click();
    await expect(section.getByRole('status').filter({ hasText: 'Snipe armed' })).toHaveText(a.live ? 'Snipe armed.' : `Snipe armed. ${DRY_RUN_LABEL}.`);
    const armed = ((await sendMsg(page, 'snipe.list')) as Snipe[]).find((s) => s.itemId === a.itemId && s.state === 'armed');
    expect(armed, 'the dashboard armed the snipe').toBeDefined();
    expect(armed).toMatchObject({ dryRun: !a.live, leadMs: a.leadS * SEC, fallback: 'early-proxy' });
    return armed as Snipe;
  } finally {
    // The side panel holds the countdown port; the scenarios run without it.
    await page.close();
  }
}

// ── Reading the background ──────────────────────────────────────────────────

async function snipeOf(r: Rig, id: string): Promise<Snipe> {
  const s = ((await sendMsg(r.options, 'snipe.list')) as Snipe[]).find((x) => x.id === id);
  expect(s, `snipe ${id} is stored`).toBeDefined();
  return s as Snipe;
}

type RunnerEntry = SnipeRunnerRecord['entries'][string];

async function runnerEntry(r: Rig, id: string): Promise<RunnerEntry | undefined> {
  const { local } = await stateHook(r.options);
  return (local['sbw:snipeRunner'] as SnipeRunnerRecord | undefined)?.entries[id];
}

async function alarmAt(r: Rig, id: string, kind: string): Promise<number | undefined> {
  const name = `sbw:snipe:${id}:${kind}`;
  return (await testState(r.options)).alarms.find((a) => a.name === name)?.scheduledTime;
}

async function auditFor(r: Rig, id: string): Promise<AuditEntry[]> {
  return (await auditEntries(r.options)).filter((e) => e.ref === id);
}

const kinds = (entries: AuditEntry[]): string[] => entries.map((e) => e.kind);

/** The outcome notifications the background asked the browser to show for this snipe. */
async function notificationsFor(r: Rig, id: string): Promise<RecordedNotification[]> {
  const reply = await callHook(r.options, NOTIFICATIONS_HOOK, { op: 'list' });
  expect(reply.ok, reply.error ?? 'sbw:test:notifications failed').toBe(true);
  return (reply.value as RecordedNotification[]).filter((n) => n.id.startsWith(`sbw:snipe:${id}:`));
}

/** Waits for the snipe's notification titled `title`, then checks it word for word. */
async function expectNotification(r: Rig, id: string, title: string, message: string): Promise<void> {
  await expect
    .poll(async () => (await notificationsFor(r, id)).map((n) => n.title), { message: `no "${title}" notification`, timeout: 10_000 })
    .toContain(title);
  const n = (await notificationsFor(r, id)).filter((x) => x.title === title);
  expect(n, `one "${title}" notification`).toHaveLength(1);
  expect(n[0]?.message).toBe(message);
}

/**
 * Every notification the snipe produced, in order: the passing preflight's
 * "Snipe soon" notice (live copy: "Bidding up to …"), then `titles`. Nothing
 * else, and nothing twice.
 */
async function expectNotificationSequence(r: LiveRig, titles: readonly string[]): Promise<void> {
  const want = [`Snipe soon: ${r.setup.title}`, ...titles];
  await expect
    .poll(async () => (await notificationsFor(r, r.snipe.id)).map((n) => n.title), { message: "the snipe's notifications", timeout: 10_000 })
    .toEqual(want);
  const soon = (await notificationsFor(r, r.snipe.id))[0];
  expect(soon?.message.startsWith(`Bidding up to ${money(r.setup.maxBid)}, ending ${formatDual(r.endMs, r.timeZone)} (`), soon?.message).toBe(true);
  expect(soon?.message.endsWith('Keep this computer awake and the browser open.')).toBe(true);
}

/** The notification's "Ended …" sentence (classifyOutcome: the armed end, in Pacific and the user's zone). */
function ended(r: Rig, endMs: number): string {
  return `Ended ${formatDual(endMs, r.timeZone)}.`;
}

/** The fake SGW's proxy-bidding state for an item (GET /__scenario). */
async function fakeAuction(itemId: number): Promise<{ price: number; numBids: number; holder: string | null } | undefined> {
  const res = await fetch(`${FAKE_BUYERAPI}/__scenario`);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { bidding: { items: Record<string, { price: number; numBids: number; holder: string | null }> } };
  return body.bidding.items[String(itemId)];
}

// ── Driving time (T-89's walk: only to deadlines the runner set, once it holds them) ──

/** Moves the fake clock forward to `at` (never back: the fake clock also ticks with real time). */
async function advanceUntil(r: Rig, at: number): Promise<number> {
  const reply = await callHook(r.options, 'sbw:test:advance', { until: at });
  expect(reply.ok, reply.error ?? 'sbw:test:advance failed').toBe(true);
  return (reply.value as { now: number }).now;
}

/** Waits until the runner holds a Clock timer due in [lo, hi] (its step returned: no read in flight). */
async function waitForTimer(r: Rig, lo: number, hi: number, what: string, timeout = 15_000): Promise<number> {
  let found: number | undefined;
  await expect
    .poll(
      async () => {
        found = (await advance(r.options, 0)).timers.find((t) => t >= lo && t <= hi);
        return found !== undefined;
      },
      { message: `the runner never set its timer for ${what}`, timeout },
    )
    .toBe(true);
  return found as number;
}

async function waitForState(r: Rig, id: string, states: readonly Snipe['state'][], what: string, timeout = 15_000): Promise<Snipe> {
  await expect.poll(async () => (await snipeOf(r, id)).state, { message: what, timeout }).toMatch(new RegExp(`^(${states.join('|')})$`));
  return snipeOf(r, id);
}

/** T−15 min: the preflight alarm fires; waits until the preflight ran. */
async function runPreflight(r: Rig, id: string): Promise<void> {
  const at = await alarmAt(r, id, 'preflight');
  expect(at, 'the preflight alarm is set').toBeDefined();
  await advanceUntil(r, at as number);
  await expect
    .poll(async () => (await runnerEntry(r, id))?.preflightAt !== undefined || (await snipeOf(r, id)).state !== 'armed', {
      message: 'the preflight never ran',
      timeout: 15_000,
    })
    .toBe(true);
}

/** The wake: the window opens and the first clock sample goes out. Returns the second sample's timer. */
async function wake(r: Rig, id: string): Promise<number> {
  const at = await alarmAt(r, id, 'wake');
  expect(at, 'the wake alarm is set').toBeDefined();
  await advanceUntil(r, at as number);
  await waitForState(r, id, ['waking'], 'the wake alarm did not wake the snipe');
  return waitForTimer(r, (at as number) + CLOCK_SAMPLE_SPACING_MS, (at as number) + CLOCK_SAMPLE_SPACING_MS + 5 * SEC, 'the second clock sample');
}

/** The remaining clock samples (20 s apart). Returns the verify timer (T−60 s on the runner's clock). */
async function sampleClock(r: Rig, endMs: number, secondSampleAt: number): Promise<number> {
  await advanceUntil(r, secondSampleAt);
  const third = await waitForTimer(r, secondSampleAt + CLOCK_SAMPLE_SPACING_MS - 5, secondSampleAt + CLOCK_SAMPLE_SPACING_MS + 50, 'the third clock sample');
  await advanceUntil(r, third);
  const verifyAt = endMs - VERIFY_BEFORE_END_MS;
  return waitForTimer(r, verifyAt - SKEW_MS - 1000, verifyAt - SKEW_MS + 1000, 'the T−60 s verify');
}

/** Preflight, wake, three clock samples, then the T−60 s verify read; returns the snipe after it. */
async function toVerify(r: Rig, id: string, endMs: number, beforeVerify?: () => Promise<void>): Promise<Snipe> {
  await runPreflight(r, id);
  const second = await wake(r, id);
  const verifyTimer = await sampleClock(r, endMs, second);
  if (beforeVerify !== undefined) await beforeVerify();
  await advanceUntil(r, verifyTimer);
  return waitForState(r, id, ['verified', 'resolved', 'killed'], 'the verify read never settled');
}

/** The runner's local fire instant: the measured server-time plan minus the measured offset. */
function fireLocalOf(s: Snipe): number {
  expect(s.fireAt, 'the verify planned the fire').toBeDefined();
  expect(s.measured?.offsetMs, 'the verify measured the offset').toBeDefined();
  return (s.fireAt as number) - (s.measured?.offsetMs as number);
}

/**
 * Moves the clock to the runner's fire timer (plus `lateMs`), which fires it.
 * Returns the fake instant it fired at.
 */
async function fire(r: Rig, verified: Snipe, lateMs = 0): Promise<number> {
  const fireLocal = fireLocalOf(verified);
  const timer = await waitForTimer(r, fireLocal - 2, fireLocal + 2, 'the fire');
  await advanceUntil(r, timer + lateMs);
  return timer + lateMs;
}

/** Waits for the send's one answer (a recorded reply, or ambiguous), or for an end without a send. */
async function sendAnswered(r: Rig, id: string, timeout = 15_000): Promise<Snipe> {
  await expect
    .poll(
      async () => {
        const s = await snipeOf(r, id);
        if (s.state === 'resolved' || s.state === 'killed') return true;
        return s.state === 'sent' && (s.attempt.reply !== undefined || s.attempt.ambiguous === true);
      },
      { message: 'the send never got its answer', timeout },
    )
    .toBe(true);
  return snipeOf(r, id);
}

/** The outcome read 5 s after the end: the window holds its timer; the harness moves the clock to it. */
async function outcomeRead(r: Rig, sent: Snipe): Promise<Snipe> {
  const due = Date.parse(sent.endTime) - (sent.measured?.offsetMs as number) + POST_READ_AFTER_END_MS;
  const timer = await waitForTimer(r, due - 1500, due + 1500, 'the outcome read');
  await advanceUntil(r, timer);
  return waitForState(r, sent.id, ['resolved'], 'the outcome read never settled the snipe');
}

/** Requests the background sent at or after `fromLocal` (its fake clock). */
function readsSince(log: FakeLogEntry[], fromLocal: number): FakeLogEntry[] {
  return log.filter((e) => e.fakeNowMs !== null && e.fakeNowMs >= fromLocal);
}

const show = (log: FakeLogEntry[]): string[] => log.map((e) => `${e.endpoint} ${String(e.status)}`);

/** A measured value, kept on the test's report (and logged): the timing evidence behind an assertion. */
function note(type: string, value: number): void {
  test.info().annotations.push({ type, description: String(value) });
  console.log(`[live-bid] ${test.info().title.slice(0, 40)}: ${type} = ${String(value)}`);
}

// ── The money assertions ────────────────────────────────────────────────────

interface WireExpect {
  itemId: number;
  maxBid: number;
  /** PlaceBid requests for the snipe: 0 (nothing sent), 1 (default flow) or 2 (T-101's proof retry). */
  placeBids: 0 | 1 | 2;
  endMs: number;
}

/**
 * What every test checks on the fake's log and on the browser side:
 *   - no request to the fake carried a Cookie header (credentials: 'omit');
 *   - exactly `placeBids` PlaceBid requests arrived, and as many left the browser (R4);
 *   - each is the snipe's max to the cent, for the right item and seller, with
 *     the bearer, before the end, and right after its ShowBidModal;
 *   - only item reads, ShowBidModal and PlaceBid reached SGW.
 */
async function expectMoneyWire(r: Rig, x: WireExpect): Promise<FakeLogEntry[]> {
  const log = await fakeLog();
  // Playwright reuses whatever already listens on 8787: an older fake (another checkout's run) has no `cookie` field.
  expect(
    log.filter((e) => (e as Partial<FakeLogEntry>).cookie === undefined).map((e) => e.endpoint),
    'the fake SGW on 8787 logs the Cookie header (is an older fake server from another checkout running?)',
  ).toEqual([]);
  expect(
    log.filter((e) => e.cookie !== null).map((e) => `${e.endpoint}: ${String(e.cookie)}`),
    'no request carries a Cookie header',
  ).toEqual([]);
  expect([...new Set(log.map((e) => e.endpoint))].filter((e) => ![ITEM_DETAIL, SHOW_BID_MODAL, PLACE_BID].includes(e)), 'only reads and the bid path').toEqual([]);
  const writes = log.filter((e) => e.endpoint === SHOW_BID_MODAL || e.endpoint === PLACE_BID);
  const placeBids = writes.filter((e) => e.endpoint === PLACE_BID);
  expect(placeBids, `R4: ${String(x.placeBids)} PlaceBid on the fake's log`).toHaveLength(x.placeBids);
  expect(r.wire.placeBids(), `R4: ${String(x.placeBids)} PlaceBid left the browser`).toHaveLength(x.placeBids);
  for (const w of writes) {
    expect(w.hasBearer, `${w.endpoint} carries the bearer`).toBe(true);
    if (w.endpoint === SHOW_BID_MODAL) expect(w.query).toBe(`?itemId=${String(x.itemId)}`);
  }
  for (const p of placeBids) {
    expect(JSON.parse(p.body), 'the bid is the snipe max, to the cent').toEqual({ itemId: x.itemId, bidAmount: money(x.maxBid).slice(1), sellerId: SELLER, quantity: 1 });
    expect((p.fakeNowMs as number) + SKEW_MS, 'sent before the end (server time)').toBeLessThan(x.endMs);
    const before = writes.filter((w) => w.seq < p.seq).at(-1);
    expect(before?.endpoint, 'ShowBidModal is read before every PlaceBid').toBe(SHOW_BID_MODAL);
  }
  return log;
}

/** The send's audit trail: one `bid.sent` whose key is the snipe's stored attempt key. Returns the key. */
async function expectOneSendKey(r: Rig, s: Snipe): Promise<string> {
  const audit = await auditFor(r, s.id);
  const sent = audit.filter((e) => e.kind === 'bid.sent');
  expect(sent, 'one attempt, persisted before the request left').toHaveLength(1);
  const key = sent[0]?.details['key'];
  expect(typeof key).toBe('string');
  expect(s.attempt.idempotencyKey).toBe(key);
  expect(key as string).toMatch(new RegExp(`^${s.id}:`));
  return key as string;
}

/** A snipe that never sent: no ShowBidModal, no PlaceBid, and no send in the audit. */
async function expectNothingSent(r: Rig, x: Omit<WireExpect, 'placeBids'>, id: string): Promise<FakeLogEntry[]> {
  const log = await expectMoneyWire(r, { ...x, placeBids: 0 });
  expect(log.filter((e) => e.endpoint === SHOW_BID_MODAL), 'not even the bid modal was read').toEqual([]);
  expect(kinds(await auditFor(r, id)).filter((k) => SEND_AUDIT_KINDS.includes(k)), 'no send attempt').toEqual([]);
  return log;
}

function expectNoUnexpectedHosts(r: Rig): void {
  expect(r.wire.unexpected, `unexpected hosts: ${r.wire.unexpected.join(', ')}`).toEqual([]);
  expect(r.wire.hookErrors, 'the wire hooks ran').toEqual([]);
}

// ── The live gate (I-42), once per worker: the template profile ─────────────

interface GatedTemplate {
  profile: string;
  /** The background's fake clock when the gate opened: later runs anchor after it (time never runs back). */
  fakeNow: number;
}

let template: GatedTemplate | undefined;

test.afterAll(() => {
  if (template !== undefined) rmSync(template.profile, { recursive: true, force: true });
  template = undefined;
});

/** The popup's Live bidding section (T-102), on its own page. */
async function openPopup(r: Rig): Promise<Page> {
  const page = await r.context.newPage();
  await page.goto(`chrome-extension://${r.extensionId}/popup.html`);
  await expect(page.getByTestId('exposure-section')).toBeVisible();
  return page;
}

/** The gate's refusal of a direct settings.set from an extension page (the background is the authority). */
async function expectGateRefuses(r: Rig, why: RegExp): Promise<void> {
  const s = await settingsOf(r);
  await expect(sendMsg(r.options, 'settings.set', { dryRun: { ...s.dryRun, bidding: false } })).rejects.toThrow(why);
  expect((await settingsOf(r)).dryRun.bidding, 'bidding stays in dry run').toBe(true);
}

/** One real dry-run snipe against the fake, start to finish (T-89's walk); `lateMs` delays its fire. */
async function dryRun(r: Rig, n: number, lateMs: number): Promise<void> {
  // The seed's state for the Pyrex dish: a hidden competitor leads; next acceptable bid $17.00.
  const endMs = await auction(r, PYREX, {});
  const snipe = await armThroughDashboard(r, { itemId: PYREX, maxText: '20.00', leadS: 8, nextBid: '$17.00', live: false });
  expect(snipe.dryRun).toBe(true);
  const verified = await toVerify(r, snipe.id, endMs);
  expect(verified.state, `dry run ${String(n)} verified`).toBe('verified');
  await fire(r, verified, lateMs);
  const done = await waitForState(r, snipe.id, ['resolved', 'killed'], `dry run ${String(n)} never resolved`);
  expect(done).toMatchObject({ state: 'resolved', outcome: 'dry-run', dryRun: true });
  const error = fireErrorMs(done) as number;
  note(`dry-run-${String(n)}-fire-error-ms`, error);
  if (lateMs === 0) expect(isOnTime(error), `dry run ${String(n)} fired on time (${String(error)} ms)`).toBe(true);
  else expect(error, `dry run ${String(n)} fired late`).toBeGreaterThan(ON_TIME_TOLERANCE_MS);
  await expectNothingSent(r, { itemId: PYREX, maxBid: 2000, endMs }, snipe.id);
  expect(kinds(await auditFor(r, snipe.id))).toContain('bid.dry-run');
  // T-90 counted it, once.
  await expect.poll(async () => (await settingsOf(r)).snipe.completedDryRuns, { message: 'T-90 counts the dry run' }).toBe(n);
}

/**
 * Opens T-102's live gate the honest way (I-42) on a fresh profile, asserting
 * every refusal on the way, and returns the closed profile as the template.
 */
async function openTheGate(): Promise<GatedTemplate> {
  const profile = mkdtempSync(path.join(os.tmpdir(), 'sbw-e2e-live-gate-'));
  const wire = new Wire();
  let context: BrowserContext | undefined;
  try {
    const launched = await launchLive(profile, wire);
    context = launched.context;
    const r = await backgroundUp(launched.context, launched.worker, wire);

    await test.step('setup: sniping on; the daily job off (its background-lane traffic is not under test here)', async () => {
      const s = await settingsOf(r);
      expect(s.dryRun.bidding, 'T-102: bidding ships in dry run').toBe(true);
      expect(s.snipe).toMatchObject({ completedDryRuns: 0, requiredDryRuns: REQUIRED_DRY_RUNS });
      await sendMsg(r.options, 'settings.set', { snipe: { ...s.snipe, enabled: true }, dailyRun: { ...s.dailyRun, enabled: false } });
    });

    await test.step('the gate refuses at 0 dry runs; a crafted count is refused and never sticks', async () => {
      await expectGateRefuses(r, /Complete 5 dry-run snipes before bidding live\./);
      const s = await settingsOf(r);
      // A patch that claims the dry runs: the gate judges the KEPT count (T-90), so it is refused...
      await expect(
        sendMsg(r.options, 'settings.set', { snipe: { ...s.snipe, completedDryRuns: REQUIRED_DRY_RUNS }, dryRun: { ...s.dryRun, bidding: false } }),
      ).rejects.toThrow(/Complete 5 dry-run snipes before bidding live\./);
      // ...and on its own it never changes the count.
      await sendMsg(r.options, 'settings.set', { snipe: { ...s.snipe, completedDryRuns: REQUIRED_DRY_RUNS } });
      expect((await settingsOf(r)).snipe.completedDryRuns).toBe(0);
      const popup = await openPopup(r);
      try {
        const section = popup.getByTestId('exposure-section');
        await expect(section.getByTestId('bidding-state')).toHaveAttribute('data-state', 'dry');
        await expect(section).toContainText('0 of 5 dry-run snipes completed');
        await expect(section).toContainText('Complete 5 more dry-run snipes before going live.');
        await expect(section.getByRole('button', { name: 'Go live…' })).toHaveCount(0);
      } finally {
        await popup.close();
      }
    });

    for (let n = 1; n <= REQUIRED_DRY_RUNS; n++) {
      const late = n === REQUIRED_DRY_RUNS;
      await test.step(`dry run ${String(n)} of ${String(REQUIRED_DRY_RUNS)} against the fake${late ? `, fired ${String(LATE_FIRE_MS)} ms late` : ''}`, async () => {
        await dryRun(r, n, late ? LATE_FIRE_MS : 0);
        if (n === REQUIRED_DRY_RUNS - 1) await expectGateRefuses(r, /Complete 1 dry-run snipe before bidding live\./);
      });
    }

    await test.step('5 of 5, but 4 of 5 on time (80 %): a direct settings.set without the typed confirmation is refused', async () => {
      await expectGateRefuses(r, /fired on time 80% of the time \(below 95%\), so going live needs a typed confirmation/);
    });

    await test.step('go live in the popup: the wrong phrase is refused; typing GO LIVE opens the gate (audited)', async () => {
      const popup = await openPopup(r);
      try {
        const section = popup.getByTestId('exposure-section');
        await expect(section).toContainText('5 of 5 dry-run snipes completed · 80% on time (4 of 5 fires)');
        await section.getByRole('button', { name: 'Go live…' }).click();
        const confirm = section.getByRole('group', { name: 'Confirm going live' });
        await expect(confirm).toContainText('Live bids are real money: at most $50.00 for one item and $100.00 per day.');
        // The on-time rate is under 95 %, so the typed confirmation is required.
        const typed = confirm.getByLabel('Type GO LIVE to confirm');
        await typed.fill('go live');
        await confirm.getByRole('button', { name: 'Go live', exact: true }).click();
        await expect(section.getByRole('alert')).toHaveText('That is not the confirmation text. Type GO LIVE exactly.');
        await expect(section.getByTestId('bidding-state')).toHaveAttribute('data-state', 'dry');
        await typed.fill('GO LIVE');
        await confirm.getByRole('button', { name: 'Go live', exact: true }).click();
        await expect(section.getByTestId('bidding-state')).toHaveAttribute('data-state', 'live');
        await expect(section.getByTestId('bidding-state')).toHaveText('Bidding: LIVE');
      } finally {
        await popup.close();
      }
      const s = await settingsOf(r);
      expect(s.dryRun.bidding, 'bidding is live').toBe(false);
      expect(s.snipe.completedDryRuns).toBe(REQUIRED_DRY_RUNS);
      const off = (await auditEntries(r.options)).filter((e) => e.kind === 'dryrun.bidding.off');
      expect(off).toHaveLength(1);
      expect(off[0]?.details).toEqual({
        confirmed: true,
        completedDryRuns: 5,
        requiredDryRuns: 5,
        firesAttempted: 5,
        onTimeRate: 0.8,
        maxBid: 5000,
        perDayMax: 10000,
      });
      expectNoUnexpectedHosts(r);
    });

    const fakeNow = (await advance(r.options, 0)).now;
    await launched.context.close();
    context = undefined;
    return { profile, fakeNow };
  } catch (e) {
    await context?.close();
    rmSync(profile, { recursive: true, force: true });
    throw e;
  }
}

/** The gated template, opened once per worker (again after a worker restart). */
async function gatedTemplate(): Promise<GatedTemplate> {
  template ??= await openTheGate();
  return template;
}

// ── The live rig ────────────────────────────────────────────────────────────

interface LiveSetup {
  itemId: number;
  title: string;
  /** The fake's proxy-bidding state for the item (bidding/index.ts ItemPatchSchema). */
  state: Record<string, unknown>;
  maxText: string;
  maxBid: number;
  leadS: number;
  nextBid: string;
  /** More fake scenario fields (latencyMs entries, bidSetsCookie). */
  scenario?: Record<string, unknown>;
  /** Connect Google Calendar and put the auction on it before arming. */
  calendar?: boolean;
  /** Before arming: e.g. cookies already in the browser. */
  beforeArm?: (r: Rig) => Promise<void>;
}

interface LiveRig extends Rig {
  setup: LiveSetup;
  endMs: number;
  snipe: Snipe;
  calendar?: CalendarEvent;
  /** The fake Google server's request log length when the test started. */
  googleMark: number;
}

/**
 * A copy of the gated template (bidding live, 5 dry runs counted), the
 * background pointed at the fakes, its clock anchored after the template's,
 * the notification record installed, the auction set up on the fake, and one
 * LIVE snipe armed through the dashboard.
 */
async function liveRig(setup: LiveSetup): Promise<LiveRig> {
  const tpl = await gatedTemplate();
  const profile = mkdtempSync(path.join(os.tmpdir(), 'sbw-e2e-live-'));
  opened = { profile };
  cpSync(tpl.profile, profile, { recursive: true });
  const wire = new Wire();
  const { context, worker } = await launchLive(profile, wire);
  opened.context = context;
  const r = await backgroundUp(context, worker, wire);
  await anchorClock(r.options, Math.max(Date.now(), tpl.fakeNow) + MIN);
  const notes = await callHook(r.options, NOTIFICATIONS_HOOK, { op: 'install' });
  expect(notes, JSON.stringify(notes)).toEqual({ ok: true, value: { mode: 'stand-in' } });
  const googleMark = (await googleState()).requests.length;

  const s = await settingsOf(r);
  expect(s.dryRun.bidding, 'the template went live through the gate').toBe(false);
  expect(s.snipe).toMatchObject({ enabled: true, completedDryRuns: REQUIRED_DRY_RUNS });

  const endMs = await auction(r, setup.itemId, setup.state, setup.scenario);
  const calendar = setup.calendar === true ? await connectCalendar(r, setup.itemId, setup.title, endMs) : undefined;
  await setup.beforeArm?.(r);
  const snipe = await armThroughDashboard(r, { itemId: setup.itemId, maxText: setup.maxText, leadS: setup.leadS, nextBid: setup.nextBid, live: true });
  expect(snipe).toMatchObject({ itemId: setup.itemId, title: setup.title, maxBid: setup.maxBid, dryRun: false, sellerId: SELLER });
  expect(Date.parse(snipe.endTime)).toBe(endMs);
  return { ...r, setup, endMs, snipe, googleMark, ...(calendar === undefined ? {} : { calendar }) };
}

// ── Google Calendar (T-72's fake; only where a test turns the calendar on) ──

const CLIENT_ID = '1234567890-sbwe2efake.apps.googleusercontent.com';
const CLIENT_SECRET = 'fake-e2e-client-secret';
/** T-72: `forbidCalendarList` makes a fresh profile create its own calendar (the fake keeps calendars across tests). */
const GOOGLE_SCENARIO = {
  revive: true,
  invalidGrant: false,
  testingMode: false,
  denyConsent: false,
  rateLimitNext: 0,
  forbidCalendarList: true,
  clientId: CLIENT_ID,
  clientSecret: CLIENT_SECRET,
};

interface FakeEvent {
  id: string;
  status: string;
  summary: string;
  description?: string;
  start: { dateTime: string };
  reminders: { useDefault: boolean; overrides?: Array<{ method: string; minutes: number }> };
  extendedProperties?: { private?: Record<string, string> };
}
interface FakeGoogleState {
  requests: Array<{ method: string; path: string; status?: number }>;
  calendars: Array<{ id: string; events: FakeEvent[] }>;
}

async function googleState(): Promise<FakeGoogleState> {
  const res = await fetch(`${FAKE_GOOGLE}/__admin/state`);
  expect(res.status).toBe(200);
  return (await res.json()) as FakeGoogleState;
}

interface CalendarEvent {
  calendarId: string;
  eventId: string;
  /** The event title before any stamp. */
  summary: string;
}

async function fakeEvent(e: CalendarEvent): Promise<FakeEvent | undefined> {
  return (await googleState()).calendars.find((c) => c.id === e.calendarId)?.events.find((x) => x.id === e.eventId);
}

/**
 * Connects Google Calendar from the options page (T-72: the harness plays the
 * user in the consent stand-in), turns calendar writes on, and puts the
 * tracked auction on the calendar. Returns its event.
 */
async function connectCalendar(r: Rig, itemId: number, title: string, endMs: number): Promise<CalendarEvent> {
  const res = await fetch(`${FAKE_GOOGLE}/__admin/scenario`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(GOOGLE_SCENARIO),
  });
  expect(res.status).toBe(200);
  for (const host of ['https://www.googleapis.com', 'https://oauth2.googleapis.com', 'https://accounts.google.com']) {
    await verifyRewrite(r.worker, `${host}/__admin/state`);
  }
  const stub = await callHook(r.options, GOOGLE_AUTH_HOOK, { op: 'install' });
  expect(stub.ok, JSON.stringify(stub)).toBe(true);
  const s = await settingsOf(r);
  await sendMsg(r.options, 'settings.set', { dryRun: { ...s.dryRun, calendar: false } });
  const now = (await advance(r.options, 0)).now;
  const tracked: TrackedItem = {
    itemId,
    title,
    endTime: new Date(endMs).toISOString(),
    sellerId: SELLER,
    reasons: [{ kind: 'manual' }],
    favoriteState: 'none',
    calendar: true,
    addedAt: now,
    updatedAt: now,
  };
  await seed(r.worker, { 'sbw:tracked': { [String(itemId)]: tracked } });

  const section = r.options.locator('#section-google');
  await section.locator('#g-client-id').fill(CLIENT_ID);
  await section.locator('#g-client-secret').fill(CLIENT_SECRET);
  await section.getByRole('button', { name: 'Connect to Google Calendar' }).click();
  await approveConsent(r);
  await expect(section.getByText('Connected to Google Calendar.')).toBeVisible();
  await section.getByRole('button', { name: 'Turn on calendar events now?' }).click();
  const calendarState = async (): Promise<CalendarState> =>
    ((await stateHook(r.options)).local['sbw:calendar'] as CalendarState | undefined) ?? { links: {} };
  await expect.poll(async () => (await calendarState()).links[itemId]?.status, { message: 'the auction never reached the calendar' }).toBe('synced');
  await sendMsg(r.options, 'calendar.syncNow');
  const state = await calendarState();
  const event: CalendarEvent = { calendarId: state.calendarId ?? '', eventId: `sbv${String(itemId)}g0`, summary: '' };
  const ev = await fakeEvent(event);
  expect(ev, 'the auction is on our calendar').toMatchObject({
    status: 'confirmed',
    // Calendar times are whole seconds: the auction end, its fraction dropped.
    start: { dateTime: new Date(Math.floor(endMs / SEC) * SEC).toISOString() },
    extendedProperties: { private: { sbwItemId: String(itemId), sbwState: 'open' } },
  });
  return { ...event, summary: ev?.summary ?? '' };
}

/** T-72: the user's part of the consent window, on the fake Google server. */
async function approveConsent(r: Rig): Promise<void> {
  let pending: { url: string; fakeUrl: string } | null = null;
  await expect
    .poll(
      async () => {
        const reply = await callHook(r.options, GOOGLE_AUTH_HOOK, { op: 'pending' });
        expect(reply.ok, reply.error).toBe(true);
        pending = reply.value as { url: string; fakeUrl: string } | null;
        return pending !== null;
      },
      { message: 'the Google consent window never opened', timeout: 15_000 },
    )
    .toBe(true);
  const { fakeUrl } = pending as unknown as { url: string; fakeUrl: string };
  expect(fakeUrl.startsWith(`${FAKE_GOOGLE}/`)).toBe(true);
  const consent = await fetch(fakeUrl, { redirect: 'manual' });
  expect(consent.status).toBe(302);
  const done = await callHook(r.options, GOOGLE_AUTH_HOOK, { op: 'complete', responseUrl: consent.headers.get('location') ?? '' });
  expect(done, JSON.stringify(done)).toEqual({ ok: true, value: { completed: true } });
}

/** Calendar off in this test: nothing reached Google (the stamp effect is refused before any call). */
async function expectNoGoogleTraffic(r: LiveRig): Promise<void> {
  expect((await googleState()).requests.slice(r.googleMark).filter((q) => !q.path.startsWith('/__admin/'))).toEqual([]);
}

/** The outcome's stamp on the auction's calendar event: label, final price, reminders cleared. */
async function expectStamp(r: LiveRig, label: 'WON' | 'LOST', finalPrice: number): Promise<void> {
  const event = r.calendar as CalendarEvent;
  await expect
    .poll(async () => (await fakeEvent(event))?.summary, { message: `the event was never stamped ${label}` })
    .toBe(`${label}: ${event.summary}`);
  const ev = await fakeEvent(event);
  expect(ev?.description).toContain(`Final price: ${money(finalPrice)}`);
  expect(ev?.reminders).toEqual({ useDefault: false, overrides: [] });
  expect(ev?.extendedProperties?.private?.['sbwState']).toBe(label === 'WON' ? 'won' : 'lost');
  const stamps = (await auditEntries(r.options)).filter((e) => e.kind === 'calendar.stamp' && e.itemId === r.setup.itemId);
  expect(stamps.map((e) => e.details['outcome'])).toEqual([label === 'WON' ? 'won' : 'lost']);
}

// ── Scenario presets ────────────────────────────────────────────────────────

/** A hidden competitor's max of $16.50 shows a $15.00 price; next acceptable bid $16.00. */
const PYREX_UNDER_OUR_MAX = { currentPrice: 15, numBids: 3, competitorMax: 16.5 };
/** The same price, but the hidden competitor's max is $25.00: above ours. */
const PYREX_OVER_OUR_MAX = { currentPrice: 15, numBids: 3, competitorMax: 25 };
/** A competitor's late bid: price $24.00, next acceptable bid $25.00, over our $20.00 max. */
const PYREX_PRICE_PASSED = { currentPrice: 24, numBids: 5, competitorMax: 30 };

const pyrex = (state: Record<string, unknown>, more: Partial<LiveSetup> = {}): LiveSetup => ({
  itemId: PYREX,
  title: PYREX_TITLE,
  state,
  maxText: '20.00',
  maxBid: 2000,
  leadS: 8,
  nextBid: '$16.00',
  ...more,
});

const hotWheels = (leadS: number, scenario: Record<string, unknown>): LiveSetup => ({
  itemId: HOT_WHEELS,
  title: HOT_WHEELS_TITLE,
  state: {},
  maxText: '10.00',
  maxBid: 1000,
  leadS,
  nextBid: '$4.00',
  scenario,
});

// ── The gate ────────────────────────────────────────────────────────────────

test('the live gate (I-42): refused until 5 real dry runs; at 80 % on time the typed GO LIVE opens it', async () => {
  test.setTimeout(300_000);
  if (template !== undefined) rmSync(template.profile, { recursive: true, force: true });
  template = undefined;
  template = await openTheGate();
});

// ── Live: the default flow (one PlaceBid at most) ───────────────────────────

test('win: one PlaceBid at exactly the max; the proxy price is the runner-up plus one increment; Won, stamped WON', async () => {
  test.setTimeout(300_000);
  const r = await liveRig(pyrex(PYREX_UNDER_OUR_MAX, { calendar: true }));
  const verified = await toVerify(r, r.snipe.id, r.endMs);
  expect(verified.state).toBe('verified');
  const firedAt = await fire(r, verified);

  const sent = await test.step('the fire: ShowBidModal, then PlaceBid $20.00; SGW accepts and we lead', async () => {
    const s = await sendAnswered(r, r.snipe.id);
    expect(s.state).toBe('sent');
    // Stage 1 (no P5 catalogue): every reply is 'rejected-unknown'; the outcome read decides (T-100).
    expect(s.attempt.reply).toMatchObject({ kind: 'rejected-unknown', rawStatus: null, rawResult: 0 });
    expect(await fakeAuction(PYREX)).toMatchObject({ holder: 'me', price: 17.5, numBids: 4 });
    return s;
  });

  await test.step('the outcome read after the close: Won at $17.50, the notification says so', async () => {
    const done = await outcomeRead(r, sent);
    expect(done).toMatchObject({ state: 'resolved', outcome: 'won' });
    expect(done.outcomeDetail).toContain('Won; reported by SGW.');
    expect(done.outcomeDetail).toContain('Unrecognised reply (status null, result 0)');
    await expectNotification(
      r,
      done.id,
      `Won: ${PYREX_TITLE}`,
      `Won at $17.50 (your max $20.00). ShopGoodwill's reply was not recognised; this comes from re-reading the item. ${ended(r, r.endMs)}`,
    );
    await expectNotificationSequence(r, [`Won: ${PYREX_TITLE}`]);
  });

  await test.step('the wire: exactly one PlaceBid, the max, no cookie; then the outcome read', async () => {
    const log = await expectMoneyWire(r, { itemId: PYREX, maxBid: 2000, placeBids: 1, endMs: r.endMs });
    expect(show(readsSince(log, firedAt))).toEqual([`${SHOW_BID_MODAL} 200`, `${PLACE_BID} 200`, `${ITEM_DETAIL} 200`]);
    await expectOneSendKey(r, await snipeOf(r, r.snipe.id));
    const audit = kinds(await auditFor(r, r.snipe.id));
    expect(audit.filter((k) => k === 'bid.result')).toHaveLength(1);
    expect(audit).not.toContain('bid.ambiguous');
    expect(audit).not.toContain('bid.not-sent');
  });

  await test.step('the calendar: the auction event is stamped WON with the final price', async () => {
    await expectStamp(r, 'WON', 1750);
    expectNoUnexpectedHosts(r);
  });
});

test('outbid by a higher hidden max: one PlaceBid at the max; Lost, short by $1.00; stamped LOST', async () => {
  test.setTimeout(300_000);
  const r = await liveRig(pyrex(PYREX_OVER_OUR_MAX, { calendar: true }));
  const verified = await toVerify(r, r.snipe.id, r.endMs);
  expect(verified.state).toBe('verified');
  const firedAt = await fire(r, verified);

  const sent = await test.step('PlaceBid $20.00 meets a hidden $25.00 max: SGW reports us outbid at once', async () => {
    const s = await sendAnswered(r, r.snipe.id);
    expect(s.state).toBe('sent');
    expect(s.attempt.reply).toMatchObject({ kind: 'rejected-unknown', rawStatus: null, rawResult: 1 });
    // Proxy semantics: the competitor's hidden max answers ours plus one increment.
    expect(await fakeAuction(PYREX)).toMatchObject({ holder: 'other', price: 21, numBids: 4 });
    return s;
  });

  await test.step('the outcome read: Lost, with the margin', async () => {
    const done = await outcomeRead(r, sent);
    expect(done).toMatchObject({ state: 'resolved', outcome: 'outbid' });
    expect(done.outcomeDetail).toContain('Outbid; reported by SGW.');
    await expectNotification(
      r,
      done.id,
      `Lost: ${PYREX_TITLE}`,
      `Lost: outbid at $21.00 (your max $20.00), short by $1.00. ShopGoodwill's reply was not recognised; this comes from re-reading the item. ${ended(r, r.endMs)}`,
    );
    await expectNotificationSequence(r, [`Lost: ${PYREX_TITLE}`]);
  });

  await test.step('the wire: exactly one PlaceBid at the max, never a second one after the outbid', async () => {
    const log = await expectMoneyWire(r, { itemId: PYREX, maxBid: 2000, placeBids: 1, endMs: r.endMs });
    expect(show(readsSince(log, firedAt))).toEqual([`${SHOW_BID_MODAL} 200`, `${PLACE_BID} 200`, `${ITEM_DETAIL} 200`]);
    await expectOneSendKey(r, await snipeOf(r, r.snipe.id));
  });

  await test.step('the calendar: stamped LOST with the final price', async () => {
    await expectStamp(r, 'LOST', 2100);
    expectNoUnexpectedHosts(r);
  });
});

test('below the minimum at the fire: the price passed the max after the verify; SGW refuses the one PlaceBid; Lost, short by $4.00', async () => {
  test.setTimeout(300_000);
  const r = await liveRig(pyrex(PYREX_UNDER_OUR_MAX));
  const verified = await toVerify(r, r.snipe.id, r.endMs);
  expect(verified.state, 'at T−60 s the next bid ($16.00) is under the max').toBe('verified');

  await test.step('a competitor bids in the last minute: next acceptable bid $25.00', async () => {
    await setScenario({ bidding: { items: { [String(PYREX)]: PYREX_PRICE_PASSED } } });
  });
  const firedAt = await fire(r, verified);

  const sent = await test.step('the one PlaceBid at the max; SGW answers "too low" (-4); nothing registers', async () => {
    const s = await sendAnswered(r, r.snipe.id);
    expect(s.state).toBe('sent');
    expect(s.attempt.reply).toMatchObject({ kind: 'rejected-unknown', rawStatus: null, rawResult: -4, messageText: 'Your bid must be at least $25.00.' });
    expect(await fakeAuction(PYREX)).toMatchObject({ holder: 'other', price: 24, numBids: 5 });
    return s;
  });

  await test.step('the outcome read: Lost with the margin (stage 1 has no catalogue entry for -4, so not yet "below-minimum")', async () => {
    const done = await outcomeRead(r, sent);
    expect(done).toMatchObject({ state: 'resolved', outcome: 'outbid' });
    expect(done.outcomeDetail).toContain('Unrecognised reply (status null, result -4): Your bid must be at least $25.00.');
    await expectNotification(
      r,
      done.id,
      `Lost: ${PYREX_TITLE}`,
      `Lost: outbid at $24.00 (your max $20.00), short by $4.00. ShopGoodwill's reply was not recognised; this comes from re-reading the item. ${ended(r, r.endMs)}`,
    );
    await expectNotificationSequence(r, [`Lost: ${PYREX_TITLE}`]);
  });

  await test.step('the wire: exactly one PlaceBid at the max; no retry after the refusal; the calendar is off', async () => {
    const log = await expectMoneyWire(r, { itemId: PYREX, maxBid: 2000, placeBids: 1, endMs: r.endMs });
    expect(show(readsSince(log, firedAt))).toEqual([`${SHOW_BID_MODAL} 200`, `${PLACE_BID} 200`, `${ITEM_DETAIL} 200`]);
    await expectOneSendKey(r, await snipeOf(r, r.snipe.id));
    await expectNoGoogleTraffic(r);
    expectNoUnexpectedHosts(r);
  });
});

test('below the minimum at the verify: the next bid passed the max before T−60 s; no ShowBidModal, no PlaceBid', async () => {
  test.setTimeout(300_000);
  const r = await liveRig(pyrex(PYREX_UNDER_OUR_MAX));
  const done = await toVerify(r, r.snipe.id, r.endMs, async () => {
    await setScenario({ bidding: { items: { [String(PYREX)]: PYREX_PRICE_PASSED } } });
  });

  await test.step('the T−60 s verify sees the next bid ($25.00) above the max: not bid', async () => {
    expect(done).toMatchObject({ state: 'resolved', outcome: 'skipped' });
    expect((await auditFor(r, done.id)).find((e) => e.kind === 'snipe.verify-failed')).toMatchObject({ details: { reason: 'price-over-max' } });
    await expectNotification(
      r,
      done.id,
      `Not bid: price passed your max: ${PYREX_TITLE}`,
      `The next acceptable bid was above your max $20.00. No bid was placed. ${ended(r, r.endMs)}`,
    );
    await expectNotificationSequence(r, [`Not bid: price passed your max: ${PYREX_TITLE}`]);
  });

  await test.step('the fire moment and the end pass: nothing is sent', async () => {
    const at = (await advance(r.options, 0)).now;
    await advanceUntil(r, r.endMs + 10 * SEC);
    const log = await expectNothingSent(r, { itemId: PYREX, maxBid: 2000, endMs: r.endMs }, done.id);
    expect(readsSince(log, at + 1), 'no read after the snipe ended').toEqual([]);
    expect(await fakeAuction(PYREX)).toMatchObject({ holder: 'other', price: 24, numBids: 5 });
    await expectNoGoogleTraffic(r);
    expectNoUnexpectedHosts(r);
  });
});

test('cap-blocked: the per-item cap drops under the max after the verify; the fire-time re-check sends nothing', async () => {
  test.setTimeout(300_000);
  const r = await liveRig(pyrex(PYREX_UNDER_OUR_MAX));
  const verified = await toVerify(r, r.snipe.id, r.endMs);
  expect(verified.state).toBe('verified');

  await test.step('the user lowers the per-item cap to $15.00 while the snipe waits to fire', async () => {
    const s = await settingsOf(r);
    await sendMsg(r.options, 'settings.set', { snipe: { ...s.snipe, caps: { ...s.snipe.caps, perItemMax: 1500 } } });
    expect((await settingsOf(r)).snipe.caps.perItemMax).toBe(1500);
  });
  const firedAt = await fire(r, verified);

  await test.step('the fire is blocked by the cap: resolved cap-blocked, the notification says so', async () => {
    const done = await waitForState(r, r.snipe.id, ['resolved', 'killed'], 'the cap did not stop the fire');
    expect(done).toMatchObject({ state: 'resolved', outcome: 'cap-blocked', outcomeDetail: 'A spending cap blocked the bid; no bid sent.' });
    expect((await auditFor(r, done.id)).find((e) => e.kind === 'bid.fire')).toMatchObject({
      details: { violations: 'per-item: $20.00 exceeds the $15.00 per-item cap' },
    });
    await expectNotification(r, done.id, `Blocked: ${PYREX_TITLE}`, `Not bid: a spending cap blocked it (your max $20.00). ${ended(r, r.endMs)}`);
    await expectNotificationSequence(r, [`Blocked: ${PYREX_TITLE}`]);
  });

  await test.step('the wire: no ShowBidModal, no PlaceBid, nothing after the verify', async () => {
    await advanceUntil(r, r.endMs + 10 * SEC);
    const log = await expectNothingSent(r, { itemId: PYREX, maxBid: 2000, endMs: r.endMs }, r.snipe.id);
    expect(readsSince(log, firedAt), 'nothing after the blocked fire').toEqual([]);
    expect(await fakeAuction(PYREX)).toMatchObject({ holder: 'other', price: 15, numBids: 3 });
    await expectNoGoogleTraffic(r);
    expectNoUnexpectedHosts(r);
  });
});

test('cookie: with a Bid cookie in the browser and SGW setting one, no request carries a Cookie (credentials: omit); Won', async () => {
  test.setTimeout(300_000);
  /** The user's own ShopGoodwill session left a Bid cookie for the host the background talks to (the fake, here) and for SGW. */
  const USERS_BID_COOKIE = 'set-by-my-own-bid';
  const r = await liveRig(
    pyrex(PYREX_UNDER_OUR_MAX, {
      // PlaceBid answers Set-Cookie: Bid=1, and a request carrying any Bid cookie gets 403 (the `bid-cookie` scenario).
      scenario: { bidSetsCookie: true },
      beforeArm: async (rig) => {
        await rig.context.addCookies([
          { name: 'Bid', value: USERS_BID_COOKIE, domain: '127.0.0.1', path: '/' },
          { name: 'Bid', value: USERS_BID_COOKIE, domain: '.shopgoodwill.com', path: '/' },
        ]);
      },
    }),
  );
  const verified = await toVerify(r, r.snipe.id, r.endMs);
  expect(verified.state).toBe('verified');
  const firedAt = await fire(r, verified);
  const sent = await sendAnswered(r, r.snipe.id);
  await test.step('the bid path: ShowBidModal and PlaceBid left with no Cookie header and were answered 200', async () => {
    const writes = (await fakeLog()).filter((e) => e.endpoint === SHOW_BID_MODAL || e.endpoint === PLACE_BID);
    expect(writes.map((e) => `${e.endpoint} ${String(e.status)} cookie=${String(e.cookie)}`)).toEqual([
      `${SHOW_BID_MODAL} 200 cookie=null`,
      `${PLACE_BID} 200 cookie=null`,
    ]);
  });
  expect(sent.attempt.reply).toMatchObject({ kind: 'rejected-unknown', rawStatus: null, rawResult: 0 });
  const done = await outcomeRead(r, sent);

  await test.step('the bid went through (a cookie would have been 403): Won', async () => {
    expect(done).toMatchObject({ state: 'resolved', outcome: 'won' });
    await expectNotification(
      r,
      done.id,
      `Won: ${PYREX_TITLE}`,
      `Won at $17.50 (your max $20.00). ShopGoodwill's reply was not recognised; this comes from re-reading the item. ${ended(r, r.endMs)}`,
    );
    await expectNotificationSequence(r, [`Won: ${PYREX_TITLE}`]);
  });

  await test.step('the wire: no Cookie header on ShowBidModal, PlaceBid or any read; SGW\'s Set-Cookie was dropped', async () => {
    const log = await expectMoneyWire(r, { itemId: PYREX, maxBid: 2000, placeBids: 1, endMs: r.endMs });
    const after = readsSince(log, firedAt);
    expect(show(after)).toEqual([`${SHOW_BID_MODAL} 200`, `${PLACE_BID} 200`, `${ITEM_DETAIL} 200`]);
    expect(after.map((e) => e.cookie)).toEqual([null, null, null]);
    // SGW answered PlaceBid with Set-Cookie: Bid=1 (the browser saw it); the browser stored nothing from it.
    const answers = await Promise.all(r.wire.answers);
    expect(answers.filter((a) => a.endpoint === PLACE_BID).map((a) => [a.status, a.setCookie])).toEqual([[200, 'Bid=1; Path=/']]);
    const jar = (await r.context.cookies()).filter((c) => c.name === 'Bid');
    expect(jar.map((c) => `${c.domain}=${c.value}`).sort()).toEqual([`.shopgoodwill.com=${USERS_BID_COOKIE}`, `127.0.0.1=${USERS_BID_COOKIE}`]);
    await expectNoGoogleTraffic(r);
    expectNoUnexpectedHosts(r);
  });
});

// ── Live: ambiguous sends (T-101's proof path) ──────────────────────────────

test('ambiguous, ≥ 2 s left: PlaceBid stalls past its timeout; the proof read shows no change; exactly one resend, same amount and key; Won', async () => {
  test.setTimeout(300_000);
  // Lead 30 s: the stalled PlaceBid leaves ~29 s before the end, the browser gives up at 20 s, the proof read follows the lane's 1 s gap.
  const r = await liveRig(hotWheels(30, { latencyMs: { [PLACE_BID]: PLACE_BID_STALL_MS } }));
  // SGW recovers for the resend: when the resend's ShowBidModal leaves, PlaceBid's stall is lifted (the first one's is already running).
  r.wire.onLeave(async (d, departed) => {
    if (d.endpoint === SHOW_BID_MODAL && departed.some((x) => x.endpoint === PLACE_BID)) {
      await setScenario({ latencyMs: { [PLACE_BID]: null } });
    }
  });
  const verified = await toVerify(r, r.snipe.id, r.endMs);
  expect(verified.state).toBe('verified');
  const firedAt = await fire(r, verified);

  const sent = await test.step('the first PlaceBid times out (20 s, real time); the proof read shows nothing changed; one resend lands', async () => {
    const s = await sendAnswered(r, r.snipe.id, 60_000);
    expect(s.state).toBe('sent');
    expect(s.attempt.ambiguous, 'the resend answered: not ambiguous').toBeUndefined();
    expect(s.attempt.reply).toMatchObject({ kind: 'rejected-unknown', rawStatus: null, rawResult: 0 });
    expect(await fakeAuction(HOT_WHEELS)).toMatchObject({ holder: 'me', price: 4, numBids: 1 });
    return s;
  });

  await test.step('the wire: PlaceBid 499 (never evaluated), the proof read, ShowBidModal, PlaceBid 200: two sends, byte-identical', async () => {
    const log = await expectMoneyWire(r, { itemId: HOT_WHEELS, maxBid: 1000, placeBids: 2, endMs: r.endMs });
    const after = readsSince(log, firedAt);
    expect(show(after)).toEqual([`${SHOW_BID_MODAL} 200`, `${PLACE_BID} 499`, `${ITEM_DETAIL} 200`, `${SHOW_BID_MODAL} 200`, `${PLACE_BID} 200`]);
    const [first, second] = after.filter((e) => e.endpoint === PLACE_BID);
    expect(second?.body, 'the resend is the same request: same amount').toBe(first?.body);
    const proof = after[2] as FakeLogEntry;
    expect(proof.hasBearer, 'the proof read is the authenticated snipe-lane read').toBe(true);
    // The proof: sent with well over 2 s left (server time), so the strategy's ≥ 2 s rule allowed the one resend.
    const left = r.endMs - ((proof.fakeNowMs as number) + SKEW_MS);
    note('proof-read-ms-before-end', left);
    expect(left).toBeGreaterThan(PROOF_RESEND_MIN_TIME_LEFT_MS);
    const [d1, d2] = r.wire.placeBids();
    expect(d2?.body, 'both left the browser identical').toBe(d1?.body);
    // Same key: the attempt holds the one key persisted before the first send; the resend reused it (one bid.sent).
    await expectOneSendKey(r, sent);
    const audit = kinds(await auditFor(r, r.snipe.id));
    expect(audit.filter((k) => k === 'bid.result')).toHaveLength(1);
    expect(audit).not.toContain('bid.ambiguous');
  });

  await test.step('the outcome read: Won at the starting price', async () => {
    const done = await outcomeRead(r, sent);
    expect(done).toMatchObject({ state: 'resolved', outcome: 'won' });
    await expectNotification(
      r,
      done.id,
      `Won: ${HOT_WHEELS_TITLE}`,
      `Won at $4.00 (your max $10.00). ShopGoodwill's reply was not recognised; this comes from re-reading the item. ${ended(r, r.endMs)}`,
    );
    await expectNotificationSequence(r, [`Won: ${HOT_WHEELS_TITLE}`]);
    await expectMoneyWire(r, { itemId: HOT_WHEELS, maxBid: 1000, placeBids: 2, endMs: r.endMs });
    await expectNoGoogleTraffic(r);
    expectNoUnexpectedHosts(r);
  });
});

test('ambiguous, < 2 s left: the stalled PlaceBid\'s proof read shows no change too late to resend; no resend; Unconfirmed', async () => {
  test.setTimeout(300_000);
  // Lead 23 s: the browser gives up on PlaceBid ~1.8 s before the end; the proof read goes out under 1 s before it.
  const r = await liveRig(hotWheels(23, { latencyMs: { [PLACE_BID]: PLACE_BID_STALL_MS } }));
  // After the close SGW's item page is down: from the outcome read on (the second read after PlaceBid), every read gets 503.
  r.wire.onLeave(async (d, departed) => {
    const firstBid = departed.findIndex((x) => x.endpoint === PLACE_BID);
    if (d.endpoint !== ITEM_DETAIL || firstBid < 0) return;
    if (departed.slice(firstBid).filter((x) => x.endpoint === ITEM_DETAIL).length === 2) {
      await setScenario({ errors: { [ITEM_DETAIL]: { status: 503 } } });
    }
  });
  const verified = await toVerify(r, r.snipe.id, r.endMs);
  expect(verified.state).toBe('verified');
  const firedAt = await fire(r, verified);

  const sent = await test.step('the PlaceBid times out; the proof read finds nothing changed but under 2 s left: ambiguous, no resend', async () => {
    const s = await sendAnswered(r, r.snipe.id, 60_000);
    expect(s).toMatchObject({ state: 'sent', attempt: { ambiguous: true } });
    expect(s.attempt.reply).toBeUndefined();
    expect(kinds(await auditFor(r, s.id))).toContain('bid.ambiguous');
    const log = await expectMoneyWire(r, { itemId: HOT_WHEELS, maxBid: 1000, placeBids: 1, endMs: r.endMs });
    const after = readsSince(log, firedAt);
    expect(show(after)).toEqual([`${SHOW_BID_MODAL} 200`, `${PLACE_BID} 499`, `${ITEM_DETAIL} 200`]);
    const proof = after[2] as FakeLogEntry;
    const left = r.endMs - ((proof.fakeNowMs as number) + SKEW_MS);
    note('proof-read-ms-before-end', left);
    // SGW answered it open (sent before the end), yet under the 2 s the resend needs.
    expect(left, 'the proof read reached SGW before the end').toBeGreaterThan(0);
    expect(left, 'under 2 s left at the proof read').toBeLessThan(PROOF_RESEND_MIN_TIME_LEFT_MS);
    expect(await fakeAuction(HOT_WHEELS), 'nothing registered').toMatchObject({ holder: null, price: 4, numBids: 0 });
    await expectOneSendKey(r, s);
    return s;
  });

  await test.step('the outcome cannot be read (SGW down): after 3 tries the user is told Unconfirmed; the bid stays open', async () => {
    let failures = 0;
    // The first read is due 5 s after the end (the window holds it); the retries come on the postread alarm.
    const due = Date.parse(sent.endTime) - (sent.measured?.offsetMs as number) + POST_READ_AFTER_END_MS;
    await advanceUntil(r, await waitForTimer(r, due - 1500, due + 1500, 'the outcome read'));
    for (;;) {
      await expect
        .poll(async () => (await runnerEntry(r, sent.id))?.readFailures ?? 0, { message: `outcome read ${String(failures + 1)} never failed` })
        .toBe(failures + 1);
      failures += 1;
      if (failures === 3) break;
      await advanceUntil(r, (await alarmAt(r, sent.id, 'postread')) as number);
    }
    const s = await snipeOf(r, sent.id);
    expect(s.state, 'still open: never "Not bid", the exposure is held').toBe('sent');
    expect((await auditFor(r, s.id)).find((e) => e.kind === 'snipe.unconfirmed')).toMatchObject({ details: { attempts: 3, outcome: 'network' } });
    await expectNotification(
      r,
      s.id,
      `Unconfirmed: ${HOT_WHEELS_TITLE}`,
      `Unconfirmed: the bid may have been placed but the result could not be read. Check ShopGoodwill. The bid response was lost and the item could not be read. ${ended(r, r.endMs)} The result could not be read after 3 tries: check the item on ShopGoodwill.`,
    );
  });

  await test.step('the slow retries (every 6 h, about 7 days) all fail: the outcome is Unconfirmed', async () => {
    for (let i = 0; i < 40; i++) {
      const s = await snipeOf(r, sent.id);
      if (s.state === 'resolved') break;
      const before = (await runnerEntry(r, sent.id))?.readFailures ?? 0;
      const at = await alarmAt(r, sent.id, 'postread');
      expect(at, 'the next outcome read is scheduled').toBeDefined();
      await advanceUntil(r, at as number);
      await expect
        .poll(async () => ((await snipeOf(r, sent.id)).state === 'resolved' ? 'resolved' : ((await runnerEntry(r, sent.id))?.readFailures ?? 0) > before), {
          message: 'the slow outcome read did not run',
        })
        .toBeTruthy();
    }
    const done = await snipeOf(r, sent.id);
    expect(done).toMatchObject({ state: 'resolved', outcome: 'network', outcomeDetail: 'could not tell whether you lead.' });
    // The 3-try heads-up, then the outcome: nothing else, nothing twice.
    await expectNotificationSequence(r, [`Unconfirmed: ${HOT_WHEELS_TITLE}`, `Unconfirmed: ${HOT_WHEELS_TITLE}`]);
    const final = (await notificationsFor(r, done.id)).at(-1);
    expect(final?.message).toBe(
      `Unconfirmed: the bid may have been placed but the result could not be read. Check ShopGoodwill. The bid response was lost and the item could not be read. ${ended(r, r.endMs)}`,
    );
  });

  await test.step('the wire, start to finish: one ShowBidModal and one PlaceBid; never a resend', async () => {
    const log = await expectMoneyWire(r, { itemId: HOT_WHEELS, maxBid: 1000, placeBids: 1, endMs: r.endMs });
    expect(log.filter((e) => e.endpoint === SHOW_BID_MODAL)).toHaveLength(1);
    expect(await fakeAuction(HOT_WHEELS), 'nothing ever registered').toMatchObject({ holder: null, price: 4, numBids: 0 });
    expect(kinds(await auditFor(r, r.snipe.id)).filter((k) => k === 'bid.sent')).toHaveLength(1);
    await expectNoGoogleTraffic(r);
    expectNoUnexpectedHosts(r);
  });
});

// ── Live: the kill switch ───────────────────────────────────────────────────

test('kill between arm and fire: the popup\'s kill switch stops the verified live snipe; no ShowBidModal, no PlaceBid', async () => {
  test.setTimeout(300_000);
  const r = await liveRig(pyrex(PYREX_UNDER_OUR_MAX));
  const verified = await toVerify(r, r.snipe.id, r.endMs);
  expect(verified.state).toBe('verified');
  const fireLocal = fireLocalOf(verified);
  await waitForTimer(r, fireLocal - 2, fireLocal + 2, 'the fire');

  await test.step('the user presses the kill switch in the popup while the fire timer is pending', async () => {
    const popup = await r.context.newPage();
    try {
      await popup.goto(`chrome-extension://${r.extensionId}/popup.html`);
      const kill = popup.getByRole('button', { name: /Kill switch/ });
      await expect(kill).toHaveAttribute('aria-pressed', 'false');
      await kill.click();
      await expect(kill).toHaveAttribute('aria-pressed', 'true');
    } finally {
      await popup.close();
    }
    expect((await settingsOf(r)).killSwitch).toBe(true);
    const killed = await waitForState(r, r.snipe.id, ['killed', 'resolved'], 'the kill switch did not stop the snipe');
    expect(killed).toMatchObject({ state: 'killed', outcome: 'killed' });
    expect((await auditFor(r, killed.id)).find((e) => e.kind === 'snipe.disarm')).toMatchObject({ details: { by: 'kill' } });
    await expectNotification(r, killed.id, `Stopped: ${PYREX_TITLE}`, 'Stopped before the bid. No bid was placed (your max $20.00).');
    await expectNotificationSequence(r, [`Stopped: ${PYREX_TITLE}`]);
  });

  await test.step('the fire moment and the end pass: nothing fires, nothing is sent', async () => {
    const stoppedAt = (await advance(r.options, 0)).now;
    await advanceUntil(r, fireLocal + 5 * SEC);
    await advanceUntil(r, r.endMs + 10 * SEC);
    expect((await snipeOf(r, r.snipe.id)).state).toBe('killed');
    const audit = kinds(await auditFor(r, r.snipe.id));
    expect(audit).not.toContain('bid.fire');
    expect(audit, 'a kill asks for no fallback').not.toContain('snipe.fallback');
    const log = await expectNothingSent(r, { itemId: PYREX, maxBid: 2000, endMs: r.endMs }, r.snipe.id);
    expect(readsSince(log, stoppedAt), 'nothing is read after the kill').toEqual([]);
    expect(await fakeAuction(PYREX)).toMatchObject({ holder: 'other', price: 15, numBids: 3 });
    await expectNoGoogleTraffic(r);
    expectNoUnexpectedHosts(r);
  });
});

