// T-89: the snipe scenarios end to end, in a real Chromium, on the TEST build
// (.output/chrome-mv3-test: SBW_TEST=1), all in DRY RUN against the fake SGW
// buyerapi with 150 ms latency and SGW's clock 1.3 s ahead (PLAN §6 T-89):
//
//   on-time dry-run fire (the measured error is logged) · restart mid-wake ·
//   stalled fetch → unresolved → post-read · extended end → `extended` ·
//   ended early → `ended` · kill mid-window · preflight failure → fallback audit
//
// (The Firefox host per S-7, T-116's runner page, is test/e2e/firefox/snipe_test.py.)
//
// Every snipe is armed through the dashboard's Snipes section (T-85): the
// side panel page, Prepare → Review and arm → Arm snipe. Live gating (T-102)
// is left as it ships: `dryRun.bidding` stays on, so every snipe is a dry run
// and every test asserts ZERO PlaceBid (and ShowBidModal) requests in the fake
// server's log. The dry run's one harmless ItemDetail read at fire time is the
// only read after the fire.
//
// Time. The background's Clock and alarms are fake in the test build (T-59):
// `sbw:test:advance` fast-forwards them and fires what became due. The fake
// server runs with `followFakeNow`: each background request carries
// `x-sbw-fake-now` and re-pins SGW's clock to it, `skewMs` (1.3 s) ahead, so
// SGW moves with the time travel. Item 279250057 ends 20 min after the test
// starts (an `endsAtMs` override on the server clock). The harness walks the
// snipe through its real alarms and timers: preflight (T−15 min), wake
// (T−5 min before the fire), the three clock samples 20 s apart, the T−60 s
// verify. It only ever advances to a deadline the runner itself set, and only
// once the runner holds that timer (its read has returned), so no fast-forward
// lands inside a read's round trip. The last APPROACH_MS before the fire run
// on real time: the harness fires the window's `recover` alarm (the production
// revival alarm), whose drive re-arms the runner's tight timer on real time,
// so the fire error measured is the real timer's.
//
// Network: every browser request is fulfilled from the local fakes or aborted
// (helpers/harness.ts); a request to any other host fails the spec.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { expect, test, type BrowserContext, type Page, type Worker } from '@playwright/test';

import type { AuditEntry } from '../../../src/domain/audit/types';
import type { Settings } from '../../../src/domain/settings/schema';
import { fireErrorMs, isOnTime, ON_TIME_TOLERANCE_MS } from '../../../src/domain/snipe/soak';
import { CLOCK_SAMPLE_SPACING_MS } from '../../../src/domain/snipe/timing';
import type { Snipe } from '../../../src/domain/snipe/types';
import type { SnipeRunnerRecord } from '../../../src/domain/storage/schema';
import { seed, testExtensionDir } from './fixtures';
import { clearFakeLog, fakeLog, mintSession, setScenario, type FakeLogEntry } from './helpers/fake-sgw';
import {
  advance,
  anchorClock,
  applyBaseUrl,
  auditEntries,
  callHook,
  createRouteGuard,
  launchInto,
  openOptions,
  sendMsg,
  stateHook,
  testState,
  verifyBaseUrl,
} from './helpers/harness';
import { MIN, SEC } from './helpers/time';

// ── The fixed setup ─────────────────────────────────────────────────────────

/** "Vintage Pyrex Butterprint Casserole Dish" (seed/items.json): next acceptable bid $17.00, shipping $11.50. */
const ITEM = 279250057;
const MAX_BID_TEXT = '20.00';
const MAX_BID = 2000;
const LEAD_S = 8;
/** PLAN §6 T-89: the fake server's injected latency and SGW's clock skew (server − local). */
const LATENCY_MS = 150;
const SKEW_MS = 1300;
/** The auction ends this long after the test starts (server clock). */
const END_IN_MS = 20 * MIN;
/** The last stretch before the fire runs on real time (the measured timer). */
const APPROACH_MS = 3 * SEC;
/** snipe-runner.ts: VERIFY_BEFORE_END_MS. */
const VERIFY_BEFORE_END_MS = 60 * SEC;
/** test-strategy §7: the generous CI bound for the fire error (the tight 250 ms one is the local soak's). */
const CI_FIRE_ERROR_BOUND_MS = ON_TIME_TOLERANCE_MS;

/** The dashboard copy (src/ui/dashboard/sections/snipes/arm-form.tsx). */
const DRY_RUN_LABEL = 'DRY RUN — no bid will be placed';
const DRY_RUN_OPTION = 'Dry run (no bid will be placed)';

const BID_WRITE = /ItemBid\/(PlaceBid|ShowBidModal)/i;
const ITEM_DETAIL = 'ItemDetail/GetItemDetailModelByItemId';

// ── The rig ─────────────────────────────────────────────────────────────────

const guard = createRouteGuard();
const unexpected = guard.unexpected;

interface Rig {
  context: BrowserContext;
  worker: Worker;
  /** The options page: messages and test hooks go through it. */
  options: Page;
  extensionId: string;
  profile: string;
  /** The auction end on SGW's clock (server frame). */
  endMs: number;
  snipeId: string;
}

/** What afterEach closes and removes, set as soon as it exists (a failed setup is cleaned up too). */
let opened: { context?: BrowserContext; profile?: string } = {};

test.beforeEach(() => {
  unexpected.length = 0;
});

test.afterEach(async () => {
  const { context, profile } = opened;
  opened = {};
  await context?.close();
  if (profile !== undefined) rmSync(profile, { recursive: true, force: true });
  // The fake SGW is shared by every spec (CI starts one): leave it as a reset finds it.
  await setScenario({ reset: true });
});

/**
 * A fresh profile, the base-URL override, the fake SGW scenario (150 ms, +1.3 s,
 * following the fake clock, the item ending END_IN_MS from now), a signed-in
 * session, sniping turned on, and one dry-run snipe armed through the dashboard.
 */
async function armedRig(): Promise<Rig> {
  const profile = mkdtempSync(path.join(os.tmpdir(), 'sbw-e2e-snipe-'));
  opened = { profile };
  const { context, worker } = await launchInto(testExtensionDir(), profile, (route) => guard.fulfil(route));
  opened.context = context;
  const extensionId = new URL(worker.url()).host;
  const options = await openOptions(context, worker);
  await applyBaseUrl(options);
  await verifyBaseUrl(worker);

  const t0 = (await advance(options, 0)).now;
  // SGW's ends carry fractional seconds (S-1); keep one so ms precision is exercised.
  const endMs = Math.round((t0 + SKEW_MS + END_IN_MS) / SEC) * SEC + 450;
  await setScenario({
    reset: true,
    followFakeNow: true,
    skewMs: SKEW_MS,
    latencyMs: { '*': LATENCY_MS },
    bidding: { items: { [String(ITEM)]: { endsAtMs: endMs } } },
  });
  await clearFakeLog();

  await seed(worker, { 'sbw:sgwSession': await mintSession(t0) });
  const settings = (await sendMsg(options, 'settings.get')) as Settings;
  expect(settings.dryRun.bidding, 'T-102 ships with bidding in dry run').toBe(true);
  await sendMsg(options, 'settings.set', { snipe: { ...settings.snipe, enabled: true } });

  const snipe = await armThroughDashboard(context, extensionId);
  const r: Rig = { context, worker, options, extensionId, profile, endMs, snipeId: snipe.id };
  expect(snipe).toMatchObject({ itemId: ITEM, maxBid: MAX_BID, leadMs: LEAD_S * SEC, dryRun: true, state: 'armed', fallback: 'early-proxy' });
  expect(Date.parse(snipe.endTime)).toBe(endMs);
  return r;
}

/** T-85: Prepare → amount and lead → Review and arm → Arm snipe, in the side panel page. */
async function armThroughDashboard(context: BrowserContext, extensionId: string): Promise<Snipe> {
  const page = await context.newPage();
  try {
    await page.goto(`chrome-extension://${extensionId}/sidepanel.html`);
    const section = page.locator('#section-snipes');
    await section.getByLabel('Item id').fill(String(ITEM));
    await section.getByRole('button', { name: 'Prepare', exact: true }).click();
    await expect(section.getByText('Next acceptable bid: $17.00', { exact: true })).toBeVisible();
    await section.getByLabel('Max bid ($)').fill(MAX_BID_TEXT);
    await section.getByLabel('Lead (seconds)').fill(String(LEAD_S));
    // Global bidding dry run on (T-102): the box is checked and cannot be cleared.
    const dryRun = section.getByLabel(DRY_RUN_OPTION);
    await expect(dryRun).toBeChecked();
    await expect(dryRun).toBeDisabled();
    await section.getByRole('button', { name: 'Review and arm' }).click();
    const confirm = section.locator('.sbw-confirm');
    await expect(confirm.getByText('Review your snipe')).toBeVisible();
    await expect(confirm.getByText(`Max bid: $${MAX_BID_TEXT}`)).toBeVisible();
    await expect(confirm.getByText(DRY_RUN_LABEL)).toBeVisible();
    await confirm.getByRole('button', { name: 'Arm snipe' }).click();
    await expect(section.getByRole('status').filter({ hasText: 'Snipe armed' })).toHaveText(`Snipe armed. ${DRY_RUN_LABEL}.`);
    const armed = (await snipeList(page)).find((s) => s.itemId === ITEM && s.state === 'armed');
    expect(armed, 'the dashboard armed the snipe').toBeDefined();
    return armed as Snipe;
  } finally {
    // The side panel holds the countdown port; the scenarios run without it.
    await page.close();
  }
}

// ── Reading the background ──────────────────────────────────────────────────

async function snipeList(page: Page): Promise<Snipe[]> {
  return (await sendMsg(page, 'snipe.list')) as Snipe[];
}

async function snipeOf(r: Rig): Promise<Snipe> {
  const s = (await snipeList(r.options)).find((x) => x.id === r.snipeId);
  expect(s, `snipe ${r.snipeId} is stored`).toBeDefined();
  return s as Snipe;
}

type RunnerEntry = SnipeRunnerRecord['entries'][string];

async function runnerEntry(r: Rig): Promise<RunnerEntry | undefined> {
  const { local } = await stateHook(r.options);
  return (local['sbw:snipeRunner'] as SnipeRunnerRecord | undefined)?.entries[r.snipeId];
}

const alarmName = (r: Rig, kind: string): string => `sbw:snipe:${r.snipeId}:${kind}`;

async function alarmAt(r: Rig, kind: string): Promise<number | undefined> {
  const name = alarmName(r, kind);
  return (await testState(r.options)).alarms.find((a) => a.name === name)?.scheduledTime;
}

async function auditFor(r: Rig): Promise<AuditEntry[]> {
  return (await auditEntries(r.options)).filter((e) => e.ref === r.snipeId);
}

const kinds = (entries: AuditEntry[]): string[] => entries.map((e) => e.kind);

// ── Driving time ────────────────────────────────────────────────────────────

/** Moves the fake clock forward to `at` (never back: the fake clock also ticks with real time). */
async function advanceUntil(r: Rig, at: number): Promise<number> {
  const reply = await callHook(r.options, 'sbw:test:advance', { until: at });
  expect(reply.ok, reply.error ?? 'sbw:test:advance failed').toBe(true);
  return (reply.value as { now: number }).now;
}

/** Waits until the runner holds a Clock timer due in [lo, hi] (its step returned: no read in flight). */
async function waitForTimer(r: Rig, lo: number, hi: number, what: string): Promise<number> {
  let found: number | undefined;
  await expect
    .poll(
      async () => {
        found = (await advance(r.options, 0)).timers.find((t) => t >= lo && t <= hi);
        return found !== undefined;
      },
      { message: `the runner never set its timer for ${what}`, timeout: 15_000 },
    )
    .toBe(true);
  return found as number;
}

async function waitForState(r: Rig, states: readonly Snipe['state'][], what: string, timeout = 15_000): Promise<Snipe> {
  await expect
    .poll(async () => (await snipeOf(r)).state, { message: what, timeout })
    .toMatch(new RegExp(`^(${states.join('|')})$`));
  return snipeOf(r);
}

/** T−15 min: the preflight alarm fires; waits until the preflight ran (or resolved the snipe). */
async function runPreflight(r: Rig): Promise<void> {
  const at = await alarmAt(r, 'preflight');
  expect(at, 'the preflight alarm is set').toBeDefined();
  await advanceUntil(r, at as number);
  await expect
    .poll(async () => (await runnerEntry(r))?.preflightAt !== undefined || (await snipeOf(r)).state !== 'armed', {
      message: 'the preflight never ran',
      timeout: 15_000,
    })
    .toBe(true);
}

/** The wake: the window opens and the first clock sample goes out. Returns the second sample's timer. */
async function wake(r: Rig): Promise<number> {
  const at = await alarmAt(r, 'wake');
  expect(at, 'the wake alarm is set').toBeDefined();
  await advanceUntil(r, at as number);
  await waitForState(r, ['waking'], 'the wake alarm did not wake the snipe');
  return waitForTimer(r, (at as number) + CLOCK_SAMPLE_SPACING_MS, (at as number) + CLOCK_SAMPLE_SPACING_MS + 5 * SEC, 'the second clock sample');
}

/** The remaining clock samples (20 s apart). Returns the verify timer (T−60 s on the runner's clock). */
async function sampleClock(r: Rig, secondSampleAt: number): Promise<number> {
  await advanceUntil(r, secondSampleAt);
  // Both sample instants come from one plan (T-81): 20 s apart, give or take the timer stamp's millisecond.
  const third = await waitForTimer(r, secondSampleAt + CLOCK_SAMPLE_SPACING_MS - 5, secondSampleAt + CLOCK_SAMPLE_SPACING_MS + 50, 'the third clock sample');
  await advanceUntil(r, third);
  // endLocal = end − offset; the offset is SGW's 1.3 s skew give or take the estimator's rtt/2.
  const verifyAt = r.endMs - VERIFY_BEFORE_END_MS;
  return waitForTimer(r, verifyAt - SKEW_MS - 1000, verifyAt - SKEW_MS + 1000, 'the T−60 s verify');
}

/** The T−60 s verify read; returns the snipe after it (verified, or resolved by the read). */
async function verify(r: Rig, verifyTimer: number): Promise<Snipe> {
  await advanceUntil(r, verifyTimer);
  return waitForState(r, ['verified', 'resolved', 'killed'], 'the verify read never settled');
}

/** The runner's local fire instant: the measured server-time plan minus the measured offset. */
function fireLocalOf(s: Snipe): number {
  expect(s.fireAt, 'the verify planned the fire').toBeDefined();
  expect(s.measured?.offsetMs, 'the verify measured the offset').toBeDefined();
  return (s.fireAt as number) - (s.measured?.offsetMs as number);
}

/**
 * Fast-forwards to APPROACH_MS before the fire, then fires the window's
 * `recover` alarm: its drive re-arms the runner's tight timer, which then
 * fires on real time.
 */
async function approachFire(r: Rig, verified: Snipe): Promise<number> {
  const fireLocal = fireLocalOf(verified);
  await waitForTimer(r, fireLocal - 2, fireLocal + 2, 'the fire');
  await advanceUntil(r, fireLocal - APPROACH_MS);
  const fire = await callHook(r.options, 'sbw:test:fireAlarm', { name: alarmName(r, 'recover') });
  expect(fire.ok, fire.error ?? 'sbw:test:fireAlarm failed').toBe(true);
  return fireLocal;
}

// ── Assertions ──────────────────────────────────────────────────────────────

/**
 * The send path's audit kinds (state-machine.ts AUDIT_KIND). A dry run writes none of them:
 * `bid.not-sent` would mean a money effect was emitted for it and dropped by the runner.
 */
const SEND_AUDIT_KINDS = ['bid.sent', 'bid.result', 'bid.ambiguous', 'bid.not-sent'];

/**
 * The money assertion: no PlaceBid (and no ShowBidModal) ever reached the fake
 * SGW, and the runner's audit holds no send attempt either (a request the
 * server never saw would still have been audited).
 */
async function expectZeroBidWrites(r: Rig): Promise<FakeLogEntry[]> {
  const log = await fakeLog();
  const writes = log.filter((e) => BID_WRITE.test(e.endpoint) || BID_WRITE.test(e.path));
  expect(writes, 'a dry run must never reach PlaceBid or ShowBidModal').toEqual([]);
  const sends = (await auditEntries(r.options)).filter((e) => SEND_AUDIT_KINDS.includes(e.kind));
  expect(sends, 'a dry run must never attempt a send').toEqual([]);
  return log;
}

function expectNoUnexpectedHosts(): void {
  expect(unexpected, `unexpected hosts: ${unexpected.join(', ')}`).toEqual([]);
}

/** Reads sent at or after `fromLocal` (the background's fake clock). */
function readsSince(log: FakeLogEntry[], fromLocal: number): FakeLogEntry[] {
  return log.filter((e) => e.fakeNowMs !== null && e.fakeNowMs >= fromLocal);
}

/** The timing record of a fired dry run, logged and attached (test-strategy §7: the distribution is an artifact). */
async function logTiming(label: string, s: Snipe, measureRead: FakeLogEntry | undefined, endMs: number): Promise<Record<string, number | string | null>> {
  const offset = s.measured?.offsetMs ?? 0;
  const firedAt = s.measured?.firedAt ?? null;
  const firedLocal = firedAt === null ? null : firedAt - offset;
  const timing = {
    scenario: label,
    fireErrorMs: fireErrorMs(s),
    // Against the fake SGW's own clock (local + 1.3 s by construction): includes the offset estimate's error.
    fireErrorVsSgwClockMs: firedLocal === null || s.fireAt === undefined ? null : firedLocal + SKEW_MS - s.fireAt,
    measureReadSentVsSgwClockMs:
      measureRead?.fakeNowMs === null || measureRead === undefined || s.fireAt === undefined ? null : measureRead.fakeNowMs + SKEW_MS - s.fireAt,
    firedBeforeEndMs: firedAt === null ? null : endMs - firedAt,
    offsetMs: offset,
    rttMs: s.measured?.rttMs ?? null,
    measureResponseMs: firedAt === null || s.measured?.responseAt === undefined ? null : s.measured.responseAt - firedAt,
  };
  console.log(`[snipe timing] ${JSON.stringify(timing)}`);
  const info = test.info();
  info.annotations.push({ type: 'fire-error-ms', description: String(timing.fireErrorMs) });
  const file = info.outputPath(`snipe-timing-${label}.json`);
  writeFileSync(file, `${JSON.stringify(timing, null, 2)}
`);
  await info.attach(`snipe-timing-${label}.json`, { path: file, contentType: 'application/json' });
  return timing;
}

// ── The scenarios ───────────────────────────────────────────────────────────

test('on-time dry-run fire: the tight timer fires on time, the measured error is logged, no bid is sent', async () => {
  const r = await armedRig();

  await test.step('the T−15 min preflight reads the item and passes; the snipe stays armed', async () => {
    const at = (await alarmAt(r, 'preflight')) as number;
    await runPreflight(r);
    expect((await snipeOf(r)).state).toBe('armed');
    const preflight = (await auditFor(r)).filter((e) => e.kind === 'snipe.preflight');
    expect(preflight).toHaveLength(1);
    // No warning: the preflight's own read answered (an unreadable item would warn).
    expect(preflight[0]).toMatchObject({ dryRun: true, details: { ok: true, warning: null } });
    // The preflight read (lane background), then SGW's clock: the runner holds no clock sample yet
    // (ItemDetail reads off the snipe lane feed none), so it takes one (serverTimeSample: the item's
    // detail, ms precision, lane interactive).
    expect(readsSince(await fakeLog(), at).map((e) => e.endpoint)).toEqual([ITEM_DETAIL, ITEM_DETAIL]);
  });

  let verified: Snipe | undefined;
  let wakeAt = 0;
  await test.step('wake, three clock samples 20 s apart, the T−60 s verify measures SGW +1.3 s', async () => {
    wakeAt = (await alarmAt(r, 'wake')) as number;
    const second = await wake(r);
    const verifyTimer = await sampleClock(r, second);
    verified = await verify(r, verifyTimer);
    expect(verified.state).toBe('verified');
    const offset = verified.measured?.offsetMs as number;
    const rtt = verified.measured?.rttMs as number;
    expect(rtt, 'the round trip carries the injected 150 ms').toBeGreaterThanOrEqual(LATENCY_MS);
    // The midpoint estimate is within rtt/2 of the true offset (plus the stamp-to-send gap).
    expect(Math.abs(offset - SKEW_MS)).toBeLessThanOrEqual(rtt / 2 + 50);
    expect(verified.fireAt).toBe(r.endMs - LEAD_S * SEC - rtt / 2);
  });

  await test.step('the last 3 s run on real time; the dry run fires and resolves', async () => {
    const fireLocal = await approachFire(r, verified as Snipe);
    const done = await waitForState(r, ['resolved', 'killed'], 'the dry run never resolved');
    expect(done).toMatchObject({ state: 'resolved', outcome: 'dry-run', dryRun: true });
    const log = await expectZeroBidWrites(r);
    // The one harmless read at fire time: the only request after the fire.
    const after = readsSince(log, fireLocal);
    expect(after.map((e) => [e.endpoint, e.status])).toEqual([[ITEM_DETAIL, 200]]);
    const timing = await logTiming('on-time', done, after[0], r.endMs);
    const error = fireErrorMs(done) as number;
    expect(error, 'the fire error (runner clock)').toBeGreaterThanOrEqual(0);
    expect(Math.abs(error), `fire error ${String(error)} ms`).toBeLessThanOrEqual(CI_FIRE_ERROR_BOUND_MS);
    expect(isOnTime(error)).toBe(true);
    expect(Math.abs(timing.fireErrorVsSgwClockMs as number)).toBeLessThanOrEqual(CI_FIRE_ERROR_BOUND_MS);
    expect(timing.firedBeforeEndMs as number).toBeGreaterThan(0);
  });

  await test.step('the window: five snipe-lane reads, signed in, within the 6-read budget (PLAN §9)', async () => {
    const log = await fakeLog();
    const window = readsSince(log, wakeAt);
    // Three clock samples 20 s apart, the T−60 s verify, the read at fire time.
    expect(window.map((e) => e.endpoint)).toEqual([ITEM_DETAIL, ITEM_DETAIL, ITEM_DETAIL, ITEM_DETAIL, ITEM_DETAIL]);
    const at = window.map((e) => e.fakeNowMs as number);
    expect((at[1] as number) - (at[0] as number)).toBeGreaterThanOrEqual(CLOCK_SAMPLE_SPACING_MS - 5);
    expect((at[2] as number) - (at[1] as number)).toBeGreaterThanOrEqual(CLOCK_SAMPLE_SPACING_MS - 5);
    // The snipe lane carries the session (isHighBidder is known at the verify); the reads before it do not.
    expect(window.every((e) => e.hasBearer)).toBe(true);
    expect(log.filter((e) => (e.fakeNowMs as number) < wakeAt).every((e) => !e.hasBearer)).toBe(true);
  });

  await test.step('the audit trail: preflight, wake, verified, bid.dry-run, post-read; nothing sent', async () => {
    const audit = await auditFor(r);
    expect(kinds(audit)).toEqual(expect.arrayContaining(['snipe.arm', 'snipe.preflight', 'snipe.wake', 'snipe.verified', 'bid.dry-run', 'snipe.post-read']));
    const fired = audit.find((e) => e.kind === 'bid.dry-run');
    expect(fired).toMatchObject({ dryRun: true, details: { amount: MAX_BID } });
  });

  await test.step('T-90 counted the dry run; live gating keeps bidding in dry run', async () => {
    const settings = (await sendMsg(r.options, 'settings.get')) as Settings;
    expect(settings.snipe.completedDryRuns).toBe(1);
    expect(settings.dryRun.bidding).toBe(true);
    expect(await alarmAt(r, 'recover'), 'the window closed').toBeUndefined();
    expectNoUnexpectedHosts();
  });
});

// ── Restart ─────────────────────────────────────────────────────────────────

/**
 * Stops the extension's service worker, as Chrome does to an idle or crashed
 * MV3 worker (CDP ServiceWorker.stopAllWorkers), and waits until it reports
 * `stopped`. Playwright emits no event for the stop or the restart, so the
 * restart is proven by `sbw:test:state`'s `installedAt`.
 */
async function stopWorker(r: Rig): Promise<void> {
  const script = r.worker.url();
  const cdp = await r.context.newCDPSession(r.options);
  try {
    const stopped = new Promise<void>((resolve) => {
      cdp.on('ServiceWorker.workerVersionUpdated', (e: { versions: Array<{ scriptURL: string; runningStatus: string }> }) => {
        if (e.versions.some((v) => v.scriptURL === script && v.runningStatus === 'stopped')) resolve();
      });
    });
    await cdp.send('ServiceWorker.enable');
    await cdp.send('ServiceWorker.stopAllWorkers');
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(new Error('the service worker never reported stopped'));
      }, 10_000);
    });
    try {
      await Promise.race([stopped, late]);
    } finally {
      clearTimeout(timer);
    }
  } finally {
    await cdp.detach();
  }
}

/**
 * After a restart: steps the fake clock through whatever clock samples the
 * restarted runner planned until it holds the T−60 s verify timer. Only ever
 * advances to a timer the runner set (so never into a read in flight).
 */
async function samplesUntilVerifyTimer(r: Rig): Promise<number> {
  const verifyAt = r.endMs - VERIFY_BEFORE_END_MS;
  const lo = verifyAt - SKEW_MS - 1000;
  const hi = verifyAt - SKEW_MS + 1000;
  let verifyTimer: number | undefined;
  await expect
    .poll(
      async () => {
        const { now, timers } = await advance(r.options, 0);
        verifyTimer = timers.find((t) => t >= lo && t <= hi);
        if (verifyTimer !== undefined) return 'verify';
        const next = timers.filter((t) => t > now && t < lo).sort((a, b) => a - b)[0];
        if (next !== undefined) await advanceUntil(r, next);
        return 'sampling';
      },
      { message: 'the restarted runner never reached the T−60 s verify', timeout: 30_000 },
    )
    .toBe('verify');
  return verifyTimer as number;
}

test('restart mid-wake: the worker dies in the window; the restarted runner resumes from storage and fires on time', async () => {
  const r = await armedRig();
  await runPreflight(r);
  await wake(r);
  const before = await testState(r.options);
  const preRestartReads = (await fakeLog()).length;

  await test.step('the service worker stops mid-wake; its first events are the base-URL and clock hooks', async () => {
    const offset = (await advance(r.options, 0)).now - Date.now();
    await stopWorker(r);
    // T-59 R2: the override and the clock offset died with the worker. The
    // base-URL hook's port is the event that starts the stopped worker, so the
    // override is in place before its startup reaches the runner: every read
    // the restarted runner sends must reach the fake (no route exception).
    await applyBaseUrl(r.options);
    // The clock is re-anchored only once startup finished (T-72's anchorClock):
    // re-anchored earlier, the fast-forward fires startup's own timeouts (the
    // migrate() timeout) and storage reports itself broken. Until then the
    // runner runs on real time; SGW follows whichever clock stamps the request.
    await anchorClock(r.options, Date.now() + offset);
    const after = await testState(r.options);
    expect(after.installedAt, 'a new worker').not.toBe(before.installedAt);
    expect((await snipeOf(r)).state, 'the snipe resumes in the wake, from storage').toBe('waking');
  });

  let verified: Snipe | undefined;
  await test.step('the restarted runner re-samples the clock and verifies', async () => {
    const verifyTimer = await samplesUntilVerifyTimer(r);
    const resampled = (await fakeLog()).slice(preRestartReads).filter((e) => e.endpoint === ITEM_DETAIL);
    expect(resampled.length, 'a fresh clock sample after the restart').toBeGreaterThanOrEqual(1);
    verified = await verify(r, verifyTimer);
    expect(verified.state).toBe('verified');
    expect(Math.abs((verified.measured?.offsetMs as number) - SKEW_MS)).toBeLessThanOrEqual((verified.measured?.rttMs as number) / 2 + 50);
  });

  await test.step('it fires on time, once, and sends nothing', async () => {
    const fireLocal = await approachFire(r, verified as Snipe);
    const done = await waitForState(r, ['resolved', 'killed'], 'the dry run never resolved');
    expect(done).toMatchObject({ state: 'resolved', outcome: 'dry-run' });
    expect(done.history.map((h) => h.to)).toEqual(['armed', 'waking', 'verified', 'firing', 'resolved']);
    const log = await expectZeroBidWrites(r);
    const after = readsSince(log, fireLocal);
    expect(after.map((e) => e.endpoint)).toEqual([ITEM_DETAIL]);
    await logTiming('restart-mid-wake', done, after[0], r.endMs);
    expect(Math.abs(fireErrorMs(done) as number)).toBeLessThanOrEqual(CI_FIRE_ERROR_BOUND_MS);
    expect(((await sendMsg(r.options, 'settings.get')) as Settings).snipe.completedDryRuns).toBe(1);
    expectNoUnexpectedHosts();
  });
});

// ── Stalled read ────────────────────────────────────────────────────────────

test('stalled fetch: the fire-time read stalls past the 20 s timeout, stays unresolved, and the post-read settles it', async () => {
  // A dry run never reaches PlaceBid, so its stand-in, the measure read at fire
  // time, is what stalls (PLAN: stalled fetch → ambiguous → post-read). The
  // reducer refuses `ambiguous` for a dry run (state-machine.ts onAmbiguous);
  // the dry run's counterpart is a fire whose read never answered: no outcome
  // yet, a retry scheduled, and the post-read settles it.
  test.setTimeout(150_000);
  const r = await armedRig();
  await runPreflight(r);
  const second = await wake(r);
  const verified = await verify(r, await sampleClock(r, second));
  expect(verified.state).toBe('verified');

  let fireLocal = 0;
  await test.step('SGW stalls (25 s) on the read at fire time; the client gives up at 20 s', async () => {
    await setScenario({ latencyMs: { [ITEM_DETAIL]: 25_000 } });
    fireLocal = await approachFire(r, verified);
    await expect
      .poll(async () => (await runnerEntry(r))?.readFailures ?? 0, { message: 'the stalled read never timed out', timeout: 40_000 })
      .toBe(1);
    const s = await snipeOf(r);
    expect(s.state, 'fired, unresolved: no outcome yet').toBe('firing');
    expect(s.outcome).toBeUndefined();
    expect(s.measured?.firedAt).toBeDefined();
    const entry = await runnerEntry(r);
    expect(await alarmAt(r, 'postread'), 'the retry is scheduled 5 min after the failed read').toBe((entry?.lastReadAt as number) + 5 * MIN);
    const audit = kinds(await auditFor(r));
    expect(audit).toContain('bid.dry-run');
    expect(audit).not.toContain('snipe.post-read');
    expect(audit, 'a dry run is never ambiguous').not.toContain('bid.ambiguous');
  });

  await test.step('SGW recovers; the post-read settles the dry run', async () => {
    await setScenario({ latencyMs: { [ITEM_DETAIL]: null } });
    await advanceUntil(r, (await alarmAt(r, 'postread')) as number);
    const done = await waitForState(r, ['resolved', 'killed'], 'the post-read never settled the dry run');
    expect(done).toMatchObject({ state: 'resolved', outcome: 'dry-run' });
    expect(kinds(await auditFor(r))).toContain('snipe.post-read');
    // The fire-time read (stalled, given up) and the post-read retry; nothing else.
    await expect
      .poll(async () => readsSince(await fakeLog(), fireLocal).length, { message: 'the stalled read is in the log once SGW answers it', timeout: 15_000 })
      .toBe(2);
    const after = readsSince(await expectZeroBidWrites(r), fireLocal).sort((a, b) => (a.fakeNowMs as number) - (b.fakeNowMs as number));
    expect(after.map((e) => e.endpoint)).toEqual([ITEM_DETAIL, ITEM_DETAIL]);
    expect((after[0]?.fakeNowMs as number) - fireLocal, 'the stalled read went out at the fire').toBeLessThan(1000);
    expect((after[1]?.fakeNowMs as number) - (after[0]?.fakeNowMs as number), 'the post-read came after the retry delay').toBeGreaterThanOrEqual(5 * MIN);
    await logTiming('stalled-fetch', done, after[0], r.endMs);
    expect(Math.abs(fireErrorMs(done) as number)).toBeLessThanOrEqual(CI_FIRE_ERROR_BOUND_MS);
    expect(((await sendMsg(r.options, 'settings.get')) as Settings).snipe.completedDryRuns).toBe(1);
    expectNoUnexpectedHosts();
  });
});

// ── Pre-fire ends ───────────────────────────────────────────────────────────

/** The snipe never fired: no dry-run fire audit, no read after `afterLocal`, not counted as a dry run. */
async function expectNeverFired(r: Rig, afterLocal: number): Promise<void> {
  expect(kinds(await auditFor(r))).not.toContain('bid.dry-run');
  const log = await expectZeroBidWrites(r);
  expect(readsSince(log, afterLocal + 1), 'no read after the snipe ended').toEqual([]);
  expect(((await sendMsg(r.options, 'settings.get')) as Settings).snipe.completedDryRuns, 'not a completed dry run').toBe(0);
}

/** The newest background read in the log (by its fake send time). */
async function lastReadAt(): Promise<number> {
  const stamped = (await fakeLog()).map((e) => e.fakeNowMs).filter((t): t is number => t !== null);
  return Math.max(...stamped);
}

test('extended end: a soft close moves the end later in the window; the verify ends the snipe as extended', async () => {
  const r = await armedRig();
  await runPreflight(r);
  const second = await wake(r);

  await test.step('a competitor bid in the last 10 min extends the auction (soft close)', async () => {
    await setScenario({ bidding: { softClose: { windowMs: 10 * MIN, extensionMs: 10 * MIN }, competitorBids: [{ itemId: ITEM, maxBid: 18 }] } });
  });

  await test.step('the T−60 s verify sees the later end: resolved as extended, a re-arm proposed, no fire', async () => {
    const done = await verify(r, await sampleClock(r, second));
    expect(done).toMatchObject({ state: 'resolved', outcome: 'extended' });
    expect(Date.parse(done.endTime), 'the snipe keeps the end it was armed for').toBe(r.endMs);
    const audit = await auditFor(r);
    expect(kinds(audit)).toContain('snipe.rearm-proposed');
    expect(audit.find((e) => e.kind === 'snipe.verified')).toMatchObject({ details: { outcome: 'extended' } });
    const endedAt = await lastReadAt();
    await advanceUntil(r, r.endMs + 11 * MIN);
    await expectNeverFired(r, endedAt);
    expectNoUnexpectedHosts();
  });
});

test('ended early: SGW closes the auction in the window; the verify ends the snipe as ended, with no fallback', async () => {
  const r = await armedRig();
  await runPreflight(r);
  const second = await wake(r);

  await test.step('the auction closes early (withdrawn)', async () => {
    await setScenario({ bidding: { items: { [String(ITEM)]: { closed: true } } } });
  });

  await test.step('the T−60 s verify sees it closed: resolved as ended, nothing to win, no fire', async () => {
    const done = await verify(r, await sampleClock(r, second));
    expect(done).toMatchObject({ state: 'resolved', outcome: 'ended' });
    expect(kinds(await auditFor(r)), 'nothing to win: no fallback').not.toContain('snipe.fallback');
    const endedAt = await lastReadAt();
    await advanceUntil(r, r.endMs + 10 * SEC);
    await expectNeverFired(r, endedAt);
    expectNoUnexpectedHosts();
  });
});

// ── Kill ────────────────────────────────────────────────────────────────────

test('kill mid-window: the kill switch stops a verified snipe before its fire, with no fallback', async () => {
  const r = await armedRig();
  await runPreflight(r);
  const second = await wake(r);
  const verified = await verify(r, await sampleClock(r, second));
  expect(verified.state).toBe('verified');
  const fireLocal = fireLocalOf(verified);

  await test.step('the kill switch goes on while the fire timer is pending', async () => {
    await sendMsg(r.options, 'kill.set', { on: true });
    const killed = await waitForState(r, ['killed', 'resolved'], 'the kill switch did not stop the snipe');
    expect(killed).toMatchObject({ state: 'killed', outcome: 'killed' });
    expect((await auditFor(r)).find((e) => e.kind === 'snipe.disarm')).toMatchObject({ details: { by: 'kill' } });
  });

  await test.step('the fire moment and the end pass: nothing fires, nothing is read, nothing is sent', async () => {
    const stoppedAt = await lastReadAt();
    await advanceUntil(r, fireLocal + 5 * SEC);
    await advanceUntil(r, r.endMs + 10 * SEC);
    expect((await snipeOf(r)).state).toBe('killed');
    expect(kinds(await auditFor(r)), 'a kill asks for no fallback').not.toContain('snipe.fallback');
    expect(await alarmAt(r, 'recover'), 'the window closed').toBeUndefined();
    await expectNeverFired(r, stoppedAt);
    expectNoUnexpectedHosts();
  });
});

// ── Preflight ───────────────────────────────────────────────────────────────

test('preflight failure: SGW too slow to time the snipe at T−15 min; the fallback is audited, a dry run places nothing', async () => {
  // The preflight holds no clock sample, so it measures SGW's clock (serverTimeSample);
  // at 2.5 s that round trip is over T-81's 2 s bound: preflight fails with reason 'clock'.
  const r = await armedRig();

  await test.step('SGW answers in 2.5 s at the preflight', async () => {
    await setScenario({ latencyMs: { '*': 2500 } });
    await runPreflight(r);
  });

  await test.step('preflight fails on the clock; the early-proxy fallback is decided and only audited', async () => {
    const done = await waitForState(r, ['resolved', 'killed'], 'the preflight failure did not resolve the snipe');
    expect(done).toMatchObject({ state: 'resolved', outcome: 'dry-run' });
    expect(done.outcomeDetail).toContain('Dry run: would have placed your max $20.00 now as an early proxy bid. No bid was placed.');
    const audit = await auditFor(r);
    expect(audit.find((e) => e.kind === 'snipe.preflight-failed')).toMatchObject({ dryRun: true, details: { reason: 'clock' } });
    const fallback = audit.filter((e) => e.kind === 'snipe.fallback');
    expect(fallback).toHaveLength(1);
    expect(fallback[0]).toMatchObject({
      dryRun: true,
      details: { reason: 'clock', requested: 'early-proxy', applied: 'early-proxy', degradedBecause: null, amount: MAX_BID, sessionUsable: true, writesAllowed: true },
    });
    expect(await alarmAt(r, 'wake'), 'no wake after a resolved preflight').toBeUndefined();
    const failedAt = await lastReadAt();
    await setScenario({ latencyMs: { '*': LATENCY_MS } });
    await advanceUntil(r, r.endMs + 10 * SEC);
    await expectNeverFired(r, failedAt);
    expectNoUnexpectedHosts();
  });
});
