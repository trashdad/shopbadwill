// T-112: bid groups ("win at most N") end to end, in a real Chromium, on the
// TEST build (.output/chrome-mv3-test: SBW_TEST=1), in DRY RUN against the
// fake SGW buyerapi (150 ms latency, SGW's clock 1.3 s ahead), as T-89's
// snipe.spec.ts does. Bidding stays in dry run (T-102): ZERO PlaceBid or
// ShowBidModal ever reaches the fake.
//
//   a confirmed win cancels the rest · an unconfirmed win does not
//
// The group is made and filled through the dashboard's Bid groups section
// (side panel page): "New group" (N = 1), then "Add an item" for each item,
// which arms through `snipe.arm` with the group's id. An item ending under
// 2 minutes from another is refused there, with the background's reason.
//
// A dry run resolves at its fire, before the end. The group then reads the
// item 5 s after the end and runs T-87's classifier on it: "would have won"
// at a CLOSED auction (max above the closing price) is the dry run's confirmed
// win, and the group disarms its other snipes through the runner. If the
// auction is still open when read (here: a late soft close moved the end),
// nothing is confirmed, the group keeps going and the next member fires.
//
// Time: the background's Clock and alarms are fake (T-59); the harness only
// advances to deadlines the runner (or the group) set, once it holds them.
// Network: every browser request is fulfilled from the local fakes or aborted
// (helpers/harness.ts); a request to any other host fails the spec.
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { expect, test, type BrowserContext, type Locator, type Page, type Worker } from '@playwright/test';

import type { AuditEntry } from '../../../src/domain/audit/types';
import type { Settings } from '../../../src/domain/settings/schema';
import { CLOCK_SAMPLE_SPACING_MS } from '../../../src/domain/snipe/timing';
import type { Snipe } from '../../../src/domain/snipe/types';
import type { SnipeGroupsRecord } from '../../../src/domain/storage/schema';
import { NOTIFICATIONS_HOOK, type RecordedNotification } from '../../../src/test-hooks/notifications';
import { seed, testExtensionDir } from './fixtures';
import { clearFakeLog, fakeLog, mintSession, setScenario } from './helpers/fake-sgw';
import {
  advance,
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

/** "Vintage Pyrex Butterprint Casserole Dish" (seed/items.json): a competitor leads at $12.99; next acceptable bid $17.00. */
const ITEM_A = 279250057;
/** "Lot of 12 Hot Wheels Cars Assorted Loose": $4.00, no bids. */
const ITEM_B = 279250102;
/** "Sony Walkman": used only to show the spacing refusal. */
const ITEM_C = 279250415;
const LEAD_S = 8;
const LATENCY_MS = 150;
const SKEW_MS = 1300;
/** A ends this long after the test starts (server clock); B 20 min after A (its window opens after A's check). */
const A_END_IN_MS = 20 * MIN;
const B_AFTER_A_MS = 20 * MIN;
const VERIFY_BEFORE_END_MS = 60 * SEC;
/** domain/snipe/groups.ts: GROUP_CONFIRM_AFTER_END_MS. */
const CHECK_AFTER_END_MS = 5 * SEC;
const GROUP = 'Lamps';
const DRY_RUN_LABEL = 'DRY RUN — no bid will be placed';

const BID_WRITE = /ItemBid\/(PlaceBid|ShowBidModal)/i;
const SEND_AUDIT_KINDS = ['bid.sent', 'bid.result', 'bid.ambiguous', 'bid.not-sent'];

// ── The rig ─────────────────────────────────────────────────────────────────

const guard = createRouteGuard();
const unexpected = guard.unexpected;

interface Rig {
  context: BrowserContext;
  worker: Worker;
  options: Page;
  extensionId: string;
  aEnd: number;
  bEnd: number;
}

let opened: { context?: BrowserContext; profile?: string } = {};

test.beforeEach(() => {
  unexpected.length = 0;
});

test.afterEach(async () => {
  const { context, profile } = opened;
  opened = {};
  await context?.close();
  if (profile !== undefined) rmSync(profile, { recursive: true, force: true });
  await setScenario({ reset: true });
});

/** A fresh profile on the fakes, signed in, sniping on, bidding in dry run (as T-102 ships). */
async function rig(): Promise<Rig> {
  const profile = mkdtempSync(path.join(os.tmpdir(), 'sbw-e2e-groups-'));
  opened = { profile };
  const { context, worker } = await launchInto(testExtensionDir(), profile, (route) => guard.fulfil(route));
  opened.context = context;
  const extensionId = new URL(worker.url()).host;
  const options = await openOptions(context, worker);
  await applyBaseUrl(options);
  await verifyBaseUrl(worker);
  const install = await callHook(options, NOTIFICATIONS_HOOK, { op: 'install' });
  expect(install.ok, install.error ?? 'sbw:test:notifications install failed').toBe(true);

  const t0 = (await advance(options, 0)).now;
  const aEnd = Math.round((t0 + SKEW_MS + A_END_IN_MS) / SEC) * SEC + 450;
  const bEnd = aEnd + B_AFTER_A_MS;
  await setScenario({
    reset: true,
    followFakeNow: true,
    skewMs: SKEW_MS,
    latencyMs: { '*': LATENCY_MS },
    bidding: {
      items: {
        [String(ITEM_A)]: { endsAtMs: aEnd },
        [String(ITEM_B)]: { endsAtMs: bEnd },
        // One minute after A: a group must refuse it.
        [String(ITEM_C)]: { endsAtMs: aEnd + MIN },
      },
    },
  });
  await clearFakeLog();
  await seed(worker, { 'sbw:sgwSession': await mintSession(t0) });
  const settings = (await sendMsg(options, 'settings.get')) as Settings;
  expect(settings.dryRun.bidding, 'T-102 ships with bidding in dry run').toBe(true);
  await sendMsg(options, 'settings.set', { snipe: { ...settings.snipe, enabled: true } });
  return { context, worker, options, extensionId, aEnd, bEnd };
}

// ── The dashboard: make the group and fill it ───────────────────────────────

async function openGroups(r: Rig): Promise<{ page: Page; section: Locator }> {
  const page = await r.context.newPage();
  await page.goto(`chrome-extension://${r.extensionId}/sidepanel.html`);
  const section = page.locator('#section-groups');
  await expect(section.getByRole('heading', { name: 'Bid groups' })).toBeVisible();
  return { page, section };
}

function groupCard(section: Locator, name: string): Locator {
  return section.locator('li[data-group-id]').filter({ has: section.page().getByRole('heading', { name, exact: true }) });
}

/** "New group" (N = 1), then each item through the group's own "Add an item" form; C is refused (1 min from A). */
async function makeGroup(r: Rig): Promise<{ a: Snipe; b: Snipe }> {
  const { page, section } = await openGroups(r);
  try {
    const create = section.locator('form').filter({ has: page.getByRole('heading', { name: 'New group' }) });
    await create.getByLabel('Group name').fill(GROUP);
    await create.getByLabel('Win at most').fill('1');
    await create.getByRole('button', { name: 'Create group' }).click();
    await expect(create.getByRole('status')).toHaveText(`Group "${GROUP}" created: it wins at most 1.`);
    const card = groupCard(section, GROUP);
    await expect(card.getByText('Win at most 1. Wins so far: 0 of at most 1.')).toBeVisible();
    await card.getByRole('button', { name: 'Add an item' }).click();

    const add = async (itemId: number, maxText: string): Promise<void> => {
      await card.getByLabel('Item id').fill(String(itemId));
      await card.getByRole('button', { name: 'Prepare', exact: true }).click();
      await card.getByLabel('Max bid ($)').fill(maxText);
      await card.getByLabel('Lead (seconds)').fill(String(LEAD_S));
      // Global bidding dry run on (T-102): the box is checked and cannot be cleared.
      const dry = card.getByLabel('Dry run (no bid will be placed)');
      await expect(dry).toBeChecked();
      await expect(dry).toBeDisabled();
      await card.getByRole('button', { name: 'Review and arm' }).click();
      await expect(card.locator('.sbw-confirm').getByText(DRY_RUN_LABEL)).toBeVisible();
      await card.getByRole('button', { name: 'Arm in group' }).click();
    };

    await add(ITEM_A, '20.00');
    await expect(card.getByRole('status').filter({ hasText: 'Snipe armed in' })).toHaveText(`Snipe armed in "${GROUP}". ${DRY_RUN_LABEL}.`);
    await add(ITEM_B, '10.00');
    await expect(card.getByRole('list', { name: `Items in ${GROUP}` }).getByRole('listitem')).toHaveCount(2);

    // Arm-time spacing: C ends 1 min after A. Refused by the background, with its reason; nothing armed.
    await add(ITEM_C, '25.00');
    await expect(card.getByRole('alert')).toContainText('Items in a group must end at least 2 minutes apart');
    await expect(card.getByRole('alert')).toContainText('only 1 min from "Vintage Pyrex');

    const all = (await sendMsg(page, 'snipe.list')) as Snipe[];
    expect(all.map((s) => s.itemId).sort()).toEqual([ITEM_A, ITEM_B].sort());
    const a = all.find((s) => s.itemId === ITEM_A) as Snipe;
    const b = all.find((s) => s.itemId === ITEM_B) as Snipe;
    const groupId = a.groupId;
    expect(groupId).toMatch(/^grp-/);
    for (const s of [a, b]) expect(s).toMatchObject({ state: 'armed', dryRun: true, groupId, leadMs: LEAD_S * SEC });
    return { a, b };
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

async function groupRecord(r: Rig): Promise<SnipeGroupsRecord['groups'][string]> {
  const rec = (await sendMsg(r.options, 'groups.list')) as SnipeGroupsRecord;
  const g = Object.values(rec.groups).find((x) => x.name === GROUP);
  expect(g, 'the group is stored').toBeDefined();
  return g as SnipeGroupsRecord['groups'][string];
}

async function alarmAt(r: Rig, id: string, kind: string): Promise<number | undefined> {
  const name = `sbw:snipe:${id}:${kind}`;
  return (await testState(r.options)).alarms.find((a) => a.name === name)?.scheduledTime;
}

async function auditFor(r: Rig, ref: string): Promise<AuditEntry[]> {
  return (await auditEntries(r.options)).filter((e) => e.ref === ref);
}

const kinds = (entries: AuditEntry[]): string[] => entries.map((e) => e.kind);

async function notifications(r: Rig): Promise<RecordedNotification[]> {
  const reply = await callHook(r.options, NOTIFICATIONS_HOOK, { op: 'list' });
  expect(reply.ok, reply.error ?? 'sbw:test:notifications failed').toBe(true);
  return reply.value as RecordedNotification[];
}

// ── Driving time (T-89's walk: only to deadlines set, once they are held) ───

async function advanceUntil(r: Rig, at: number): Promise<number> {
  const reply = await callHook(r.options, 'sbw:test:advance', { until: at });
  expect(reply.ok, reply.error ?? 'sbw:test:advance failed').toBe(true);
  return (reply.value as { now: number }).now;
}

async function waitForTimer(r: Rig, lo: number, hi: number, what: string): Promise<number> {
  let found: number | undefined;
  await expect
    .poll(
      async () => {
        found = (await advance(r.options, 0)).timers.find((t) => t >= lo && t <= hi);
        return found !== undefined;
      },
      { message: `no timer for ${what}`, timeout: 15_000 },
    )
    .toBe(true);
  return found as number;
}

async function waitForState(r: Rig, id: string, states: readonly Snipe['state'][], what: string): Promise<Snipe> {
  await expect.poll(async () => (await snipeOf(r, id)).state, { message: what, timeout: 15_000 }).toMatch(new RegExp(`^(${states.join('|')})$`));
  return snipeOf(r, id);
}

/** Preflight (T−15 min), wake, three clock samples, the T−60 s verify; then the fire on its timer. Returns the resolved dry run. */
async function runDryRun(r: Rig, s: Snipe, endMs: number): Promise<Snipe> {
  const pre = await alarmAt(r, s.id, 'preflight');
  expect(pre, 'the preflight alarm is set').toBeDefined();
  await advanceUntil(r, pre as number);
  const wakeAt = await alarmAt(r, s.id, 'wake');
  expect(wakeAt, 'the wake alarm is set').toBeDefined();
  await advanceUntil(r, wakeAt as number);
  await waitForState(r, s.id, ['waking'], 'the wake alarm did not wake the snipe');
  const second = await waitForTimer(r, (wakeAt as number) + CLOCK_SAMPLE_SPACING_MS, (wakeAt as number) + CLOCK_SAMPLE_SPACING_MS + 5 * SEC, 'the second clock sample');
  await advanceUntil(r, second);
  const third = await waitForTimer(r, second + CLOCK_SAMPLE_SPACING_MS - 5, second + CLOCK_SAMPLE_SPACING_MS + 50, 'the third clock sample');
  await advanceUntil(r, third);
  const verifyAt = endMs - VERIFY_BEFORE_END_MS;
  const verifyTimer = await waitForTimer(r, verifyAt - SKEW_MS - 1000, verifyAt - SKEW_MS + 1000, 'the T−60 s verify');
  await advanceUntil(r, verifyTimer);
  const verified = await waitForState(r, s.id, ['verified', 'resolved', 'killed'], 'the verify read never settled');
  expect(verified.state).toBe('verified');
  const fireLocal = (verified.fireAt as number) - (verified.measured?.offsetMs as number);
  const fireTimer = await waitForTimer(r, fireLocal - 2, fireLocal + 2, 'the fire');
  await advanceUntil(r, fireTimer);
  const done = await waitForState(r, s.id, ['resolved', 'killed'], 'the dry run never resolved');
  expect(done).toMatchObject({ state: 'resolved', outcome: 'dry-run', dryRun: true });
  return done;
}

/** The group's check 5 s after the end (local clock): it holds a timer for it; the harness moves the clock there. */
async function groupCheck(r: Rig, resolved: Snipe): Promise<void> {
  const due = Date.parse(resolved.endTime) - (resolved.measured?.offsetMs as number) + CHECK_AFTER_END_MS;
  const timer = await waitForTimer(r, due - 1500, due + 1500, "the group's check after the end");
  await advanceUntil(r, timer);
  await expect
    .poll(async () => (await groupRecord(r)).results[resolved.id]?.attempts ?? 0, { message: "the group's check never ran", timeout: 15_000 })
    .toBeGreaterThanOrEqual(1);
}

// ── Assertions ──────────────────────────────────────────────────────────────

/** Dry run: no PlaceBid or ShowBidModal on the fake, and no send attempt audited. */
async function expectZeroBidWrites(r: Rig): Promise<void> {
  const writes = (await fakeLog()).filter((e) => BID_WRITE.test(e.endpoint) || BID_WRITE.test(e.path));
  expect(writes, 'a dry run must never reach PlaceBid or ShowBidModal').toEqual([]);
  const sends = (await auditEntries(r.options)).filter((e) => SEND_AUDIT_KINDS.includes(e.kind));
  expect(sends, 'a dry run must never attempt a send').toEqual([]);
}

function expectNoUnexpectedHosts(): void {
  expect(unexpected, `unexpected hosts: ${unexpected.join(', ')}`).toEqual([]);
}

// ── The scenarios ───────────────────────────────────────────────────────────

test('a confirmed win cancels the rest: A would have won at the close, so the group disarms B before its window', async () => {
  const r = await rig();
  const { a, b } = await makeGroup(r);

  let doneA: Snipe | undefined;
  await test.step('A runs its window and fires (dry run); B stays armed', async () => {
    doneA = await runDryRun(r, a, r.aEnd);
    expect((await snipeOf(r, b.id)).state).toBe('armed');
    // Resolved before the end: not judged yet, the group waits for a read after the end.
    expect((await groupRecord(r)).results[a.id]).toMatchObject({ verdict: 'checking', attempts: 0, dryRun: true });
  });

  await test.step("5 s after A's end the group reads A: closed below the max, so the win is confirmed and B is disarmed", async () => {
    await groupCheck(r, doneA as Snipe);
    const stopped = await waitForState(r, b.id, ['killed', 'resolved'], 'the group never stopped B');
    expect(stopped).toMatchObject({ state: 'killed', outcome: 'killed' });
    const g = await groupRecord(r);
    expect(g.results[a.id]).toMatchObject({ verdict: 'confirmed', dryRun: true, attempts: 1 });
    expect(g.cancels[b.id]).toMatchObject({ ok: true });
    // Through the runner's public disarm: the reducer's own disarm audit, by the user, naming the group.
    const disarm = (await auditFor(r, b.id)).find((e) => e.kind === 'snipe.disarm');
    expect(disarm).toMatchObject({ dryRun: true, details: { by: 'user', why: `bid group "${GROUP}" already won 1 of 1` } });
    expect(kinds(await auditFor(r, b.id))).toContain('group.cancel');
    // The check read A after its end, authenticated (the snipe lane carries the session).
    const read = (await fakeLog()).filter((e) => e.path.endsWith(`/${String(ITEM_A)}`) && (e.fakeNowMs ?? 0) >= r.aEnd - SKEW_MS);
    expect(read.length).toBeGreaterThanOrEqual(1);
    expect(read[0]?.hasBearer).toBe(true);
    const told = (await notifications(r)).filter((n) => n.title === `Bid group "${GROUP}": won 1 of 1`);
    expect(told.map((n) => n.message)).toEqual(['Stopped "Lot of 12 Hot Wheels Cars Assorted Loose".']);
  });

  await test.step('B never runs: through its end, nothing fires, nothing is read for it, nothing is sent', async () => {
    const stoppedAt = (await advance(r.options, 0)).now;
    await advanceUntil(r, r.bEnd + 10 * SEC);
    expect((await snipeOf(r, b.id)).state).toBe('killed');
    expect(kinds(await auditFor(r, b.id))).not.toContain('bid.dry-run');
    const bReads = (await fakeLog()).filter((e) => e.path.endsWith(`/${String(ITEM_B)}`) && (e.fakeNowMs ?? 0) >= stoppedAt);
    expect(bReads, 'no read for B after it was stopped').toEqual([]);
    await expectZeroBidWrites(r);
  });

  await test.step('the dashboard shows the items, N, the wins so far and that the group is done', async () => {
    const { page, section } = await openGroups(r);
    try {
      const card = groupCard(section, GROUP);
      await expect(card.getByText(`Win at most 1. Wins so far: 1 of at most 1 (dry run: would have won).`)).toBeVisible();
      await expect(card.getByText('Done: the group won what it may win.')).toBeVisible();
      const items = card.getByRole('list', { name: `Items in ${GROUP}` });
      await expect(items.getByText(/^Vintage Pyrex .*: Would have won \(dry run, confirmed at the close\)\. Ends /)).toBeVisible();
      await expect(items.getByText(/^Lot of 12 Hot Wheels Cars Assorted Loose: Stopped by the group \(it had won 1\)\. Ends /)).toBeVisible();
      await expect(card.getByRole('note')).toHaveCount(0);
    } finally {
      await page.close();
    }
    expectNoUnexpectedHosts();
  });
});

test('an unconfirmed win does not cancel: A is still open when read (soft close), so the group keeps going and B fires', async () => {
  const r = await rig();
  const { a, b } = await makeGroup(r);

  let doneA: Snipe | undefined;
  await test.step('A fires (dry run); then a late competitor bid extends A past its end (soft close)', async () => {
    doneA = await runDryRun(r, a, r.aEnd);
    await setScenario({ bidding: { items: { [String(ITEM_A)]: { endsAtMs: r.aEnd + 60 * MIN } } } });
  });

  await test.step("the group's reads after A's end see it still open: nothing is confirmed, nothing is cancelled", async () => {
    await groupCheck(r, doneA as Snipe);
    const g = await groupRecord(r);
    expect(g.results[a.id]).toMatchObject({ verdict: 'checking', why: 'the auction was still open when read' });
    expect(g.cancels).toEqual({});
    expect((await snipeOf(r, b.id)).state).toBe('armed');
  });

  let doneB: Snipe | undefined;
  await test.step('B runs its whole window and fires: the group never stopped it', async () => {
    doneB = await runDryRun(r, b, r.bEnd);
    expect(doneB).toMatchObject({ state: 'resolved', outcome: 'dry-run' });
    expect(kinds(await auditFor(r, b.id))).toContain('bid.dry-run');
    expect(kinds(await auditFor(r, b.id))).not.toContain('snipe.disarm');
    const g = await groupRecord(r);
    expect(g.results[a.id]?.verdict).toBe('checking');
    expect(g.results[a.id]?.attempts).toBeGreaterThanOrEqual(4);
    expect(g.cancels).toEqual({});
    // Said plainly, once the fast checks were spent: the group keeps bidding, so more than N may be won.
    const warned = (await notifications(r)).filter((n) => n.title === `Bid group "${GROUP}": win not confirmed`);
    expect(warned).toHaveLength(1);
    expect(warned[0]?.message).toMatch(
      /^"Vintage Pyrex .*" may have been won, but the win is not confirmed \(the auction was still open when read\)\. The group keeps bidding on its other item, so you could win more than 1\.$/,
    );
    await expectZeroBidWrites(r);
  });

  await test.step('the dashboard says plainly that the group risks winning more than N', async () => {
    const { page, section } = await openGroups(r);
    try {
      const card = groupCard(section, GROUP);
      await expect(card.getByText(/Wins so far: \d of at most 1 \(dry run: would have won\)\./)).toBeVisible();
      const risks = card.getByRole('note', { name: `Risks in ${GROUP}` });
      await expect(risks).toContainText('Could win more than 1:');
      await expect(risks).toContainText('is not confirmed yet (the auction was still open when read); still checking. Until it is, the group keeps bidding, so you could win more than 1.');
      const items = card.getByRole('list', { name: `Items in ${GROUP}` });
      await expect(items.getByText(/^Vintage Pyrex .*: Checking whether it would have won\. Ends /)).toBeVisible();
    } finally {
      await page.close();
    }
    expectNoUnexpectedHosts();
  });

  // The state the dashboard read must match what the background stored.
  const { local } = await stateHook(r.options);
  expect(Object.keys((local['sbw:snipeGroups'] as SnipeGroupsRecord).groups)).toHaveLength(1);
});
