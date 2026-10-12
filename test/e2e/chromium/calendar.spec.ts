// T-72: calendar sync end to end, in a real Chromium, on the TEST build
// (.output/chrome-mv3-test: SBW_TEST=1), against the fake Google server
// (test/fakes/fake-google-server, FAKE_GOOGLE: this run's port). The arc per PLAN §6 T-72:
//
//   connect (options page: paste the client, Connect; the harness approves the
//   consent window through `sbw:test:googleAuth`) → turn calendar events on
//   (T-70b's prompt) → sync → events with 60/15/5 on our dedicated calendar
//   → end-time change → PATCH of the same event → browser restart (overrides
//   re-applied from the harness, T-59 R2) → unwatch → DELETE of our event only
//   → `invalid_grant` → badge `!` and pending links, no writes → reconnect →
//   the pending links drain exactly once. A second test: dry-run on → zero
//   Google writes, audit entries only.
//
// What runs for real: the background's PkceRefreshProvider, GoogleCalendarApi,
// CalendarSink, calendar-sync job, the T-86 badge and the options page. What
// is stubbed: only the consent window (src/test-hooks/google-auth-stub.ts; a
// headless browser cannot drive Google's consent UI). The harness plays the
// user there: it loads the consent URL on the fake (which answers 302 to the
// chromiumapp redirect with a code) and hands the redirect back.
//
// Every claim about Google is asserted from the fake server's own request log
// and state (`/__admin/state`), not only from extension storage. Nothing can
// leave the machine: `sbw:test:baseUrl` points every Google host at the fake,
// and the route aborts (and fails the spec on) any other host, including a
// background request that still names a real Google origin. Time moves only
// through `sbw:test:advance` (fake time; no sleeps).
//
// Isolation: the fake runs once per Playwright run and keeps its calendars, so
// each test starts its own scenario with `forbidCalendarList` (Google's
// published table omits calendar.app.created for calendarList.list): a fresh
// profile then always creates its own calendar instead of adopting one an
// earlier test left behind, and request-log assertions start at a mark.
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { expect, test, type BrowserContext, type Page, type Worker } from '@playwright/test';

import { CALENDAR_SCOPE } from '../../../src/adapters/google/auth-pkce';
import { CALENDAR_DESCRIPTION, CALENDAR_MARKER, CALENDAR_SUMMARY } from '../../../src/adapters/google/calendar-sink';
import type { AuditEntry } from '../../../src/domain/audit/types';
import type { Settings } from '../../../src/domain/settings/schema';
import type { CalendarState } from '../../../src/domain/storage/schema';
import type { TrackedItem } from '../../../src/domain/types';
import { GOOGLE_AUTH_HOOK } from '../../../src/test-hooks/google-auth-stub';
import { seed, testExtensionDir } from './fixtures';
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
  verifyRewrite,
  type RouteGuard,
} from './helpers/harness';
import { DAY, HOUR, MIN } from './helpers/time';
import { FAKE_GOOGLE } from './network';

// ── Fixed values ─────────────────────────────────────────────────────────────

/** The background's fake clock (an instant in the past, so real-time-scheduled alarms stay days ahead of it). */
const ANCHOR_MS = Date.UTC(2026, 9, 8, 15, 0, 0);
/** A made-up OAuth client: the fake requires exactly these (proves the provider sends what the user pasted). */
const CLIENT_ID = '1234567890-sbwe2efake.apps.googleusercontent.com';
const CLIENT_SECRET = 'fake-e2e-client-secret';
/** src/background/jobs/calendar-sync.ts: SYNC_ALARM and DEBOUNCE_MS (not imported: that module pulls in wxt/browser). */
const SYNC_ALARM = 'sbw:calendar-sync';
const DEBOUNCE_MS = 60_000;

// Tracked auctions (calendar on unless noted).
const ITEM_A = 290000101;
const ITEM_B = 290000102;
const ITEM_C = 290000103; // calendar off: never on Google
const ITEM_D = 290000104; // added while the token is lost
const ITEM_E = 290000105; // dry-run test
const ITEM_F = 290000106; // dry-run test
const ITEM_G = 290000107; // adoption tests

const eventId = (itemId: number, generation = 0): string => `sbv${String(itemId)}g${String(generation)}`;

function trackedItem(itemId: number, title: string, endMs: number, calendar = true): TrackedItem {
  return {
    itemId,
    title,
    endTime: new Date(endMs).toISOString(),
    sellerId: 4242,
    reasons: [{ kind: 'manual' }],
    favoriteState: 'none',
    calendar,
    addedAt: ANCHOR_MS,
    updatedAt: ANCHOR_MS,
  };
}

// ── The fake Google server (Node side) ───────────────────────────────────────

interface GoogleRequest {
  method: string;
  path: string;
  query: string;
  status?: number;
}
interface FakeEvent {
  id: string;
  status: string;
  summary: string;
  start: { dateTime: string };
  reminders: { useDefault: boolean; overrides?: Array<{ method: string; minutes: number }> };
  extendedProperties?: { private?: Record<string, string> };
  sequence: number;
}
interface FakeCalendar {
  id: string;
  summary: string;
  description?: string;
  appCreated: boolean;
  primary?: boolean;
  events: FakeEvent[];
}
interface FakeGoogleState {
  requests: GoogleRequest[];
  calendars: FakeCalendar[];
}

async function googleState(): Promise<FakeGoogleState> {
  const res = await fetch(`${FAKE_GOOGLE}/__admin/state`);
  expect(res.status).toBe(200);
  return (await res.json()) as FakeGoogleState;
}

/** A fresh scenario for every test (the fake keeps it across tests). */
async function googleScenario(patch: Record<string, unknown>): Promise<void> {
  const res = await fetch(`${FAKE_GOOGLE}/__admin/scenario`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  });
  expect(res.status).toBe(200);
}

const RESET_SCENARIO = {
  revive: true,
  invalidGrant: false,
  testingMode: false,
  denyConsent: false,
  rateLimitNext: 0,
  forbidCalendarList: true,
  clientId: CLIENT_ID,
  clientSecret: CLIENT_SECRET,
};

/**
 * The adoption tests list calendars, so they start with the fake holding only
 * the primary calendar: earlier tests' calendars (all marked) would otherwise
 * be adopted first.
 */
async function resetCalendars(): Promise<void> {
  const res = await fetch(`${FAKE_GOOGLE}/__admin/reset-calendars`, { method: 'POST' });
  expect(res.status, 'the fake Google server has no reset-calendars route (a stale fake Google server?)').toBe(200);
}

/** The request-log position now: later assertions read only what came after it. */
async function mark(): Promise<number> {
  return (await googleState()).requests.length;
}

/** Requests after `from`, admin calls excluded, paths decoded (calendar ids carry an encoded `@`). */
async function requestsSince(from: number): Promise<GoogleRequest[]> {
  return (await googleState()).requests
    .slice(from)
    .filter((r) => !r.path.startsWith('/__admin/'))
    .map((r) => ({ ...r, path: decodeURIComponent(r.path) }));
}

const isCalendarApi = (r: GoogleRequest): boolean => r.path.startsWith('/calendar/v3/');
const isWrite = (r: GoogleRequest): boolean => isCalendarApi(r) && r.method !== 'GET';
/** "METHOD /path status", with our calendar id shown as <cal>. */
const show = (reqs: GoogleRequest[], calId?: string): string[] =>
  reqs.map((r) => {
    const p = calId === undefined ? r.path : r.path.replaceAll(calId, '<cal>');
    return `${r.method} ${p} ${String(r.status)}`;
  });

async function fakeCalendar(id: string): Promise<FakeCalendar> {
  const cal = (await googleState()).calendars.find((c) => c.id === id);
  if (cal === undefined) throw new Error(`the fake has no calendar ${id}`);
  return cal;
}

/**
 * The user adds an event of their own to the ShopGoodwill Auctions calendar
 * by hand (here: a direct Calendar API call with a separate grant on the
 * fake). The extension must never write it.
 */
async function addForeignEvent(calendarId: string): Promise<string> {
  const accessToken = await byHandToken();
  const res = await fetch(`${FAKE_GOOGLE}/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`, {
    method: 'POST',
    headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      summary: 'Dentist (added by hand)',
      start: { dateTime: new Date(ANCHOR_MS + 4 * DAY).toISOString() },
      end: { dateTime: new Date(ANCHOR_MS + 4 * DAY + HOUR).toISOString() },
    }),
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { id: string }).id;
}

/**
 * A calendar that already exists on the account before this profile connects
 * (an earlier install, or another app), made through the API with a separate
 * grant, so the fake marks it app-created and the extension's narrow scope
 * can list it. `description` carries our private marker, or not.
 */
async function addExistingCalendar(description?: string): Promise<string> {
  const accessToken = await byHandToken();
  const res = await fetch(`${FAKE_GOOGLE}/calendar/v3/calendars`, {
    method: 'POST',
    headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ summary: CALENDAR_SUMMARY, timeZone: 'UTC', ...(description === undefined ? {} : { description }) }),
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { id: string }).id;
}

/** An access token from a separate grant on the fake (the user by hand, not the extension). */
async function byHandToken(): Promise<string> {
  const verifier = randomBytes(32).toString('base64url');
  const authorize = new URL(`${FAKE_GOOGLE}/o/oauth2/v2/auth`);
  authorize.search = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: 'https://user.example/callback',
    response_type: 'code',
    scope: CALENDAR_SCOPE,
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
    code_challenge_method: 'S256',
    state: 'by-hand',
  }).toString();
  const consent = await fetch(authorize, { redirect: 'manual' });
  const code = new URL(consent.headers.get('location') ?? '').searchParams.get('code') ?? '';
  const token = await fetch(`${FAKE_GOOGLE}/token`, {
    method: 'POST',
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      redirect_uri: 'https://user.example/callback',
      code_verifier: verifier,
    }),
  });
  expect(token.status).toBe(200);
  return ((await token.json()) as { access_token: string }).access_token;
}

// ── The browser side ─────────────────────────────────────────────────────────

interface Session {
  context: BrowserContext;
  worker: Worker;
  options: Page;
  extId: string;
}

/**
 * Launches (or relaunches) the browser over `profile` and prepares the fresh
 * background: base URLs at the fakes (proved for buyerapi and every Google
 * host), the fake clock anchored, the consent stand-in installed. All of it is
 * in memory, so it runs again after every restart (T-59 R2).
 */
async function start(ext: string, profile: string, guard: RouteGuard, at: number): Promise<Session> {
  const { context, worker } = await launchInto(ext, profile, (route) => guard.fulfil(route));
  try {
    const options = await openOptions(context, worker);
    await applyBaseUrl(options);
    await verifyBaseUrl(worker);
    for (const host of ['https://www.googleapis.com', 'https://oauth2.googleapis.com', 'https://accounts.google.com']) {
      await verifyRewrite(worker, `${host}/__admin/state`);
    }
    await anchorClock(options, at);
    const extId = new URL(worker.url()).host;
    const stub = await callHook(options, GOOGLE_AUTH_HOOK, { op: 'install' });
    expect(stub, JSON.stringify(stub)).toEqual({ ok: true, value: { redirectUrl: `https://${extId}.chromiumapp.org/` } });
    return { context, worker, options, extId };
  } catch (e) {
    // Never leave a browser holding the profile: the caller only closes what start() returned.
    await context.close();
    throw e;
  }
}

/** Removes a test profile. A failure here is reported, never allowed to hide the test's own result. */
function removeProfile(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch (e) {
    console.warn(`could not remove the test profile ${dir}: ${String(e)}`);
  }
}

/**
 * The user's part of the consent window: wait for the provider to open it,
 * check what it asks for, load it on the fake, hand the redirect back.
 */
async function approveConsent(s: Session): Promise<void> {
  const box: { pending: { url: string; fakeUrl: string } | null } = { pending: null };
  await expect
    .poll(
      async () => {
        const reply = await callHook(s.options, GOOGLE_AUTH_HOOK, { op: 'pending' });
        expect(reply.ok, reply.error).toBe(true);
        box.pending = reply.value as { url: string; fakeUrl: string } | null;
        return box.pending !== null;
      },
      { message: 'the Google consent window never opened', timeout: 15_000 },
    )
    .toBe(true);
  const { url, fakeUrl } = box.pending as { url: string; fakeUrl: string };
  const asked = new URL(url);
  const redirect = `https://${s.extId}.chromiumapp.org/`;
  expect(`${asked.origin}${asked.pathname}`).toBe('https://accounts.google.com/o/oauth2/v2/auth');
  expect(Object.fromEntries([...asked.searchParams].filter(([k]) => !['state', 'code_challenge'].includes(k)))).toEqual({
    client_id: CLIENT_ID,
    redirect_uri: redirect,
    response_type: 'code',
    scope: CALENDAR_SCOPE,
    code_challenge_method: 'S256',
    access_type: 'offline',
    prompt: 'consent',
  });
  expect(fakeUrl).toBe(`${FAKE_GOOGLE}${asked.pathname}${asked.search}`);
  const consent = await fetch(fakeUrl, { redirect: 'manual' });
  expect(consent.status).toBe(302);
  const back = consent.headers.get('location') ?? '';
  expect(back.startsWith(`${redirect}?`), back).toBe(true);
  const done = await callHook(s.options, GOOGLE_AUTH_HOOK, { op: 'complete', responseUrl: back });
  expect(done, JSON.stringify(done)).toEqual({ ok: true, value: { completed: true } });
}

/** Options page → Google Calendar section: paste the client, press Connect, approve. */
async function connectFromOptions(s: Session): Promise<void> {
  const section = s.options.locator('#section-google');
  await section.locator('#g-client-id').fill(CLIENT_ID);
  await section.locator('#g-client-secret').fill(CLIENT_SECRET);
  await section.getByRole('button', { name: 'Connect to Google Calendar' }).click();
  await approveConsent(s);
  await expect(section.getByText('Connected to Google Calendar.')).toBeVisible();
}

async function badgeText(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const chrome = (globalThis as unknown as { chrome: { action: { getBadgeText(d: object): Promise<string> } } }).chrome;
    return chrome.action.getBadgeText({});
  });
}

async function calendarState(page: Page): Promise<CalendarState> {
  const { local } = await stateHook(page);
  return (local['sbw:calendar'] as CalendarState | undefined) ?? { links: {} };
}

async function trackedMap(page: Page): Promise<Record<string, TrackedItem>> {
  const { local } = await stateHook(page);
  return (local['sbw:tracked'] as Record<string, TrackedItem> | undefined) ?? {};
}

/**
 * Writes `sbw:tracked` as the background's own writers do (the post-end read
 * moves `endTime` when an auction was extended; the job adds matches) and
 * lets the 60 s debounce that change schedules fire in fake time.
 */
async function changeTracked(s: Session, edit: (cur: Record<string, TrackedItem>) => Record<string, TrackedItem>): Promise<void> {
  await seed(s.worker, { 'sbw:tracked': edit(await trackedMap(s.options)) });
  await fireDebounce(s);
}

/** The tracked change scheduled the debounce alarm; 60 s of fake time later it fires (and starts the sync). */
async function fireDebounce(s: Session): Promise<void> {
  await expect
    .poll(async () => (await testState(s.options)).alarms.some((a) => a.name === SYNC_ALARM), {
      message: 'the tracked change did not schedule the calendar debounce',
    })
    .toBe(true);
  const { fired } = await advance(s.options, DEBOUNCE_MS);
  expect(fired).toContain(SYNC_ALARM);
}

/**
 * Waits for the sync to have finished: `calendar.syncNow` joins a running
 * sync and runs one more pass, and answers when both are done. With nothing
 * left to do that pass makes no Google call (the callers check the log).
 */
async function settle(s: Session): Promise<void> {
  await sendMsg(s.options, 'calendar.syncNow');
}

async function setDryRun(s: Session, calendar: boolean): Promise<void> {
  const settings = (await sendMsg(s.options, 'settings.get')) as Settings;
  await sendMsg(s.options, 'settings.set', { dryRun: { ...settings.dryRun, calendar } });
}

const calendarAudits = (entries: AuditEntry[]): AuditEntry[] => entries.filter((e) => e.kind.startsWith('calendar.'));

// ── The tests ────────────────────────────────────────────────────────────────

test('calendar sync: connect, 60/15/5 events, patch, delete, invalid_grant, reconnect drains once', async () => {
  test.setTimeout(240_000);
  const guard = createRouteGuard();
  const profile = mkdtempSync(path.join(os.tmpdir(), 'sbw-e2e-calendar-'));
  const ext = testExtensionDir();
  /** Each auction's end time as the test last set it (A moves twice: soft-close extensions). */
  const ends = new Map<number, number>([
    [ITEM_A, ANCHOR_MS + 3 * DAY + 2 * HOUR],
    [ITEM_B, ANCHOR_MS + 4 * DAY],
    [ITEM_C, ANCHOR_MS + 5 * DAY],
    [ITEM_D, ANCHOR_MS + 6 * DAY],
  ]);
  const endOf = (itemId: number): number => {
    const at = ends.get(itemId);
    if (at === undefined) throw new Error(`no end time for ${String(itemId)}`);
    return at;
  };
  const endIso = (itemId: number): string => new Date(endOf(itemId)).toISOString();
  const hold: { s: Session | undefined; calId: string; foreignId: string } = { s: undefined, calId: '', foreignId: '' };
  const session = (): Session => {
    if (hold.s === undefined) throw new Error('the browser is not running');
    return hold.s;
  };
  try {
    await googleScenario(RESET_SCENARIO);
    const testStart = await mark();
    hold.s = await start(ext, profile, guard, ANCHOR_MS);

    await test.step('tracked auctions; Google not connected; calendar events off (the default)', async () => {
      const s = session();
      await seed(s.worker, {
        'sbw:tracked': {
          [ITEM_A]: trackedItem(ITEM_A, 'Pyrex Butterprint mixing bowl set', endOf(ITEM_A)),
          [ITEM_B]: trackedItem(ITEM_B, 'Vintage Fire-King jadeite mug', endOf(ITEM_B)),
          [ITEM_C]: trackedItem(ITEM_C, 'Corningware casserole (not on the calendar)', endOf(ITEM_C), false),
        },
      });
      const settings = (await sendMsg(s.options, 'settings.get')) as Settings;
      expect(settings.calendar).toMatchObject({ enabled: false, mode: 'dedicated', reminders: [60, 15, 5] });
      expect(settings.dryRun.calendar).toBe(true);
      // Live calendar writes for this test (against the fake only). No SGW
      // session exists at any point: calendar writes are not gated by it.
      await setDryRun(s, false);
      expect((await stateHook(s.options)).local['sbw:sgwSession']).toBeUndefined();
    });

    await test.step('connect from the options page: real PKCE code exchange on the fake', async () => {
      const s = session();
      const from = await mark();
      await connectFromOptions(s);
      const status = (await sendMsg(s.options, 'calendar.status')) as { connected: boolean; grantedScopes: string[] };
      expect(status).toMatchObject({ connected: true, provider: 'pkce', grantedScopes: [CALENDAR_SCOPE], needsInteraction: false });
      // The harness's consent page load, then the background's code exchange.
      // Calendar events are still off: no Calendar call yet.
      expect(show(await requestsSince(from))).toEqual(['GET /o/oauth2/v2/auth 302', 'POST /token 200']);
    });

    await test.step('turn calendar events on (the T-70b prompt): events on our dedicated calendar', async () => {
      const s = session();
      const from = await mark();
      await s.options.locator('#section-google').getByRole('button', { name: 'Turn on calendar events now?' }).click();
      await expect
        .poll(async () => {
          const links = (await calendarState(s.options)).links;
          return [links[ITEM_A]?.status, links[ITEM_B]?.status, links[ITEM_C]?.status];
        })
        .toEqual(['synced', 'synced', undefined]);
      await settle(s);

      const state = await calendarState(s.options);
      hold.calId = state.calendarId ?? '';
      const calId = hold.calId;
      expect(calId, 'the extension stored the calendar it created').toMatch(/^[0-9a-f]+@group\.calendar\.google\.com$/);
      const reqs = await requestsSince(from);
      // One look for an existing calendar (forbidden for this scope), one
      // calendar created, one insert per calendar item. Nothing else.
      expect(show(reqs, calId)).toEqual([
        'GET /calendar/v3/users/me/calendarList 403',
        'POST /calendar/v3/calendars 200',
        'POST /calendar/v3/calendars/<cal>/events 200',
        'POST /calendar/v3/calendars/<cal>/events 200',
      ]);

      // The calendar the extension writes to is the one it created: ours, marked, not primary.
      const cal = await fakeCalendar(calId);
      expect(cal).toMatchObject({ summary: CALENDAR_SUMMARY, appCreated: true });
      expect(cal.description).toContain(CALENDAR_MARKER);
      expect(cal.primary).toBeUndefined();
      expect((await fakeCalendar('primary')).events).toEqual([]);

      // Each event: our id, our private marker, the auction end, popups at 60/15/5.
      expect(cal.events.map((e) => e.id).sort()).toEqual([eventId(ITEM_A), eventId(ITEM_B)]);
      for (const itemId of [ITEM_A, ITEM_B]) {
        const ev = cal.events.find((e) => e.id === eventId(itemId));
        expect(ev, `event for ${String(itemId)}`).toMatchObject({
          status: 'confirmed',
          sequence: 0,
          start: { dateTime: endIso(itemId) },
          reminders: {
            useDefault: false,
            overrides: [
              { method: 'popup', minutes: 60 },
              { method: 'popup', minutes: 15 },
              { method: 'popup', minutes: 5 },
            ],
          },
          extendedProperties: { private: { sbwItemId: String(itemId), sbwGen: '0', sbwState: 'open' } },
        });
      }
      expect(await badgeText(s.options)).toBe('');
    });

    await test.step('the user adds an event of their own to that calendar (it must never be touched)', async () => {
      hold.foreignId = await addForeignEvent(hold.calId);
    });

    await test.step('an end-time change (soft close) is a PATCH of the same event, never a duplicate', async () => {
      const s = session();
      const from = await mark();
      ends.set(ITEM_A, endOf(ITEM_A) + 2 * MIN);
      await changeTracked(s, (cur) => ({ ...cur, [ITEM_A]: trackedItem(ITEM_A, 'Pyrex Butterprint mixing bowl set', endOf(ITEM_A)) }));
      await expect
        .poll(async () => (await fakeCalendar(hold.calId)).events.find((e) => e.id === eventId(ITEM_A))?.start.dateTime)
        .toBe(endIso(ITEM_A));
      await settle(s);

      expect(show(await requestsSince(from), hold.calId)).toEqual([
        `GET /calendar/v3/calendars/<cal>/events/${eventId(ITEM_A)} 200`,
        `PATCH /calendar/v3/calendars/<cal>/events/${eventId(ITEM_A)} 200`,
      ]);
      const cal = await fakeCalendar(hold.calId);
      expect(cal.events.map((e) => e.id).sort()).toEqual([eventId(ITEM_A), eventId(ITEM_B), hold.foreignId].sort());
      expect(cal.events.find((e) => e.id === eventId(ITEM_A))).toMatchObject({ status: 'confirmed', sequence: 1 });
    });

    await test.step('browser restart: the overrides and the stand-in come back from the harness (T-59 R2)', async () => {
      const before = await advance(session().options, 0);
      const from = await mark();
      await session().context.close();
      hold.s = undefined;
      hold.s = await start(ext, profile, guard, before.now + MIN);
      // The restart's own startup sync found everything in sync: no Google call.
      expect(show(await requestsSince(from))).toEqual([]);
      expect(await badgeText(session().options)).toBe('');
    });

    await test.step('unwatch deletes our event only', async () => {
      const s = session();
      const from = await mark();
      await sendMsg(s.options, 'tracked.remove', { itemId: ITEM_B });
      await fireDebounce(s);
      await expect.poll(async () => (await calendarState(s.options)).links[ITEM_B]?.status).toBe('deleted');
      await settle(s);

      // storage.session died with the browser: the access token is refreshed
      // first, through the token-host override; the calendar is re-verified
      // once per worker; then the ownership read and the one DELETE.
      expect(show(await requestsSince(from), hold.calId)).toEqual([
        'POST /token 200',
        'GET /calendar/v3/users/me/calendarList/<cal> 200',
        `GET /calendar/v3/calendars/<cal>/events/${eventId(ITEM_B)} 200`,
        `DELETE /calendar/v3/calendars/<cal>/events/${eventId(ITEM_B)} 204`,
      ]);
      const cal = await fakeCalendar(hold.calId);
      const byId = new Map(cal.events.map((e) => [e.id, e]));
      expect(byId.get(eventId(ITEM_B))?.status).toBe('cancelled');
      expect(byId.get(eventId(ITEM_A))).toMatchObject({ status: 'confirmed', sequence: 1 });
      expect(byId.get(hold.foreignId)).toMatchObject({ status: 'confirmed', sequence: 0 });
    });

    await test.step('invalid_grant: badge "!", new links kept pending, no Google writes', async () => {
      const s = session();
      await googleScenario({ invalidGrant: true });
      const from = await mark();
      // The access token goes stale, so the next call must refresh, and Google refuses the grant.
      await advance(s.options, 2 * HOUR);
      ends.set(ITEM_A, endOf(ITEM_A) + 3 * MIN);
      const syncedA = (await calendarState(s.options)).links[ITEM_A];
      await changeTracked(s, (cur) => ({
        ...cur,
        [ITEM_A]: trackedItem(ITEM_A, 'Pyrex Butterprint mixing bowl set', endOf(ITEM_A)),
        [ITEM_D]: trackedItem(ITEM_D, 'Le Creuset dutch oven, 5.5 qt', endOf(ITEM_D)),
      }));
      await expect.poll(async () => badgeText(s.options), { message: 'the reconnect badge never showed' }).toBe('!');
      await expect.poll(async () => (await calendarState(s.options)).links[ITEM_D]?.status).toBe('pending');
      // A second sync while the grant is dead calls nothing at all.
      await settle(s);

      const reqs = await requestsSince(from);
      expect(show(reqs), 'only the refused refresh reached Google').toEqual(['POST /token 400']);
      expect(reqs.filter(isWrite)).toEqual([]);
      const links = (await calendarState(s.options)).links;
      expect(links[ITEM_D]).toMatchObject({ status: 'pending', eventId: eventId(ITEM_D), calendarId: hold.calId });
      // The end-time change waits too: A's link still holds the last synced state.
      expect(links[ITEM_A]).toEqual(syncedA);
      expect(links[ITEM_B]?.status).toBe('deleted');
      expect((await fakeCalendar(hold.calId)).events.find((e) => e.id === eventId(ITEM_A))?.sequence).toBe(1);
      expect(await badgeText(s.options)).toBe('!');
      const status = (await sendMsg(s.options, 'calendar.status')) as { connected: boolean; needsInteraction: boolean; lastError?: string };
      expect(status).toMatchObject({ connected: true, needsInteraction: true, lastError: 'invalid_grant' });
      const audit = await auditEntries(s.options);
      expect(audit.filter((e) => e.kind === 'google.needsInteraction').map((e) => e.details)).toEqual([{ error: 'invalid_grant' }]);
      expect(audit.filter((e) => e.kind === 'calendar.needs-reconnect')).toHaveLength(1);
    });

    await test.step('reconnect from the options page: the pending links drain exactly once', async () => {
      const s = session();
      await googleScenario({ invalidGrant: false });
      const from = await mark();
      await s.options.reload();
      const section = s.options.locator('#section-google');
      await expect(section.getByText('Google needs you to sign in again.')).toBeVisible();
      await section.getByRole('button', { name: 'Reconnect Google' }).click();
      await approveConsent(s);
      await expect(section.getByText('Connected to Google Calendar.')).toBeVisible();
      await expect
        .poll(async () => {
          const links = (await calendarState(s.options)).links;
          return [links[ITEM_D]?.status, (await fakeCalendar(hold.calId)).events.find((e) => e.id === eventId(ITEM_A))?.start.dateTime];
        })
        .toEqual(['synced', endIso(ITEM_A)]);
      await settle(s);
      // Once more, later: still nothing to send.
      await advance(s.options, 10 * MIN);
      await settle(s);

      const reqs = await requestsSince(from);
      const calls = show(reqs, hold.calId);
      expect(calls.slice(0, 2)).toEqual(['GET /o/oauth2/v2/auth 302', 'POST /token 200']);
      expect(calls.slice(2).sort()).toEqual(
        [
          `GET /calendar/v3/calendars/<cal>/events/${eventId(ITEM_A)} 200`,
          `PATCH /calendar/v3/calendars/<cal>/events/${eventId(ITEM_A)} 200`,
          'POST /calendar/v3/calendars/<cal>/events 200',
        ].sort(),
      );
      const cal = await fakeCalendar(hold.calId);
      const byId = new Map(cal.events.map((e) => [e.id, e]));
      expect(byId.get(eventId(ITEM_D))).toMatchObject({
        status: 'confirmed',
        sequence: 0,
        start: { dateTime: endIso(ITEM_D) },
        reminders: {
          useDefault: false,
          overrides: [
            { method: 'popup', minutes: 60 },
            { method: 'popup', minutes: 15 },
            { method: 'popup', minutes: 5 },
          ],
        },
        extendedProperties: { private: { sbwItemId: String(ITEM_D), sbwGen: '0', sbwState: 'open' } },
      });
      expect(byId.get(eventId(ITEM_A))).toMatchObject({ status: 'confirmed', sequence: 2 });
      expect(byId.get(eventId(ITEM_B))?.status).toBe('cancelled');
      expect(byId.get(hold.foreignId)).toMatchObject({ status: 'confirmed', sequence: 0 });
      expect(cal.events).toHaveLength(4);
      expect(Object.values((await calendarState(s.options)).links).map((l) => [l.itemId, l.status])).toEqual(
        expect.arrayContaining([
          [ITEM_A, 'synced'],
          [ITEM_B, 'deleted'],
          [ITEM_D, 'synced'],
        ]),
      );
      await expect.poll(async () => badgeText(s.options)).toBe('');
    });

    await test.step('every Google call went to the fake, and only to our calendar', async () => {
      const all = await requestsSince(testStart);
      const ours = `/calendar/v3/calendars/${hold.calId}/events`;
      for (const r of all.filter(isWrite)) {
        if (r.path === '/calendar/v3/calendars') continue; // the one calendar insert
        // Writes into a calendar: only ours (the harness's own foreign event excepted), never primary.
        expect(r.path.startsWith(ours), `${r.method} ${r.path}`).toBe(true);
        expect(r.path.endsWith(`/${hold.foreignId}`), `${r.method} ${r.path} touched the user's own event`).toBe(false);
      }
      expect(guard.unexpected, `unexpected hosts: ${guard.unexpected.join(', ')}`).toEqual([]);
    });
  } finally {
    await hold.s?.context.close();
    removeProfile(profile);
  }
});

test('calendar dry-run: audit entries only, the Google server receives zero writes', async () => {
  test.setTimeout(180_000);
  const guard = createRouteGuard();
  const profile = mkdtempSync(path.join(os.tmpdir(), 'sbw-e2e-calendar-'));
  const ext = testExtensionDir();
  let s: Session | undefined;
  try {
    await googleScenario(RESET_SCENARIO);
    const testStart = await mark();
    s = await start(ext, profile, guard, ANCHOR_MS);
    const opened = s;

    await seed(opened.worker, {
      'sbw:tracked': {
        [ITEM_E]: trackedItem(ITEM_E, 'Hall teapot, Aladdin, cobalt', ANCHOR_MS + 2 * DAY),
        [ITEM_F]: trackedItem(ITEM_F, 'Homer Laughlin Fiesta pitcher', ANCHOR_MS + 3 * DAY),
      },
    });
    // Connected, so only dry-run stands between the sync and Google (the default: on).
    await connectFromOptions(opened);
    expect(((await sendMsg(opened.options, 'settings.get')) as Settings).dryRun.calendar).toBe(true);
    const from = await mark();

    await test.step('the calendar toggle (T-70b) turns events on: dry-run audits the inserts', async () => {
      const toggle = opened.options.locator('#g-calendar-enabled');
      await expect(toggle).toBeEnabled();
      await toggle.click();
      await expect(toggle).toBeChecked();
      await expect
        .poll(async () =>
          calendarAudits(await auditEntries(opened.options))
            .filter((e) => e.kind === 'calendar.insert')
            .map((e) => e.itemId)
            .sort(),
        )
        .toEqual([ITEM_E, ITEM_F]);
      await settle(opened);
    });

    await test.step('an end-time change and an unwatch: still audit only', async () => {
      await changeTracked(opened, (cur) => ({ ...cur, [ITEM_E]: trackedItem(ITEM_E, 'Hall teapot, Aladdin, cobalt', ANCHOR_MS + 2 * DAY + 2 * MIN) }));
      await expect
        .poll(async () => calendarAudits(await auditEntries(opened.options)).filter((e) => e.itemId === ITEM_E).length)
        .toBe(2);
      await settle(opened);
      await sendMsg(opened.options, 'tracked.remove', { itemId: ITEM_F });
      await fireDebounce(opened);
      await settle(opened);
    });

    await test.step('zero Google calls; every op is a dry-run audit entry; no links', async () => {
      const reqs = await requestsSince(from);
      expect(show(reqs), 'dry-run made a Google call').toEqual([]);
      // Across the whole test, Google saw only the sign-in (consent page and code exchange): no Calendar API call at all.
      expect(show((await requestsSince(testStart)).filter(isCalendarApi))).toEqual([]);
      expect(show(await requestsSince(testStart))).toEqual(['GET /o/oauth2/v2/auth 302', 'POST /token 200']);
      const audits = calendarAudits(await auditEntries(opened.options));
      expect(audits.map((e) => [e.kind, e.itemId, e.dryRun])).toEqual([
        ['calendar.insert', ITEM_E, true],
        ['calendar.insert', ITEM_F, true],
        ['calendar.insert', ITEM_E, true],
      ]);
      const state = await calendarState(opened.options);
      expect(state.calendarId).toBeUndefined();
      expect(state.links).toEqual({});
      expect(guard.unexpected, `unexpected hosts: ${guard.unexpected.join(', ')}`).toEqual([]);
    });
  } finally {
    await s?.context.close();
    removeProfile(profile);
  }
});

// ── T-117: adopting an existing dedicated calendar ───────────────────────────
//
// Here calendarList.list is allowed, so a fresh profile looks for a calendar
// of ours before creating one. Only a calendar whose description carries our
// private marker qualifies; the name alone never does (calendar-sink.ts
// findDedicated). Both existing calendars are app-created on the fake, so the
// extension's narrow scope does list them: the marker is the only difference.

/**
 * Fresh profile, one tracked auction, live calendar writes against the fake:
 * connect, turn calendar events on, wait for the event. Returns the requests
 * that step made and the calendar the extension settled on.
 */
async function connectAndSync(s: Session): Promise<{ reqs: GoogleRequest[]; calId: string }> {
  await seed(s.worker, { 'sbw:tracked': { [ITEM_G]: trackedItem(ITEM_G, 'Fenton hobnail milk glass vase', ANCHOR_MS + 2 * DAY) } });
  await setDryRun(s, false);
  await connectFromOptions(s);
  const from = await mark();
  await s.options.locator('#section-google').getByRole('button', { name: 'Turn on calendar events now?' }).click();
  await expect.poll(async () => (await calendarState(s.options)).links[ITEM_G]?.status).toBe('synced');
  await settle(s);
  const calId = (await calendarState(s.options)).calendarId ?? '';
  return { reqs: await requestsSince(from), calId };
}

async function adoptionTest(body: (s: Session) => Promise<void>): Promise<void> {
  const guard = createRouteGuard();
  const profile = mkdtempSync(path.join(os.tmpdir(), 'sbw-e2e-calendar-'));
  let s: Session | undefined;
  try {
    await googleScenario({ ...RESET_SCENARIO, forbidCalendarList: false });
    await resetCalendars();
    s = await start(testExtensionDir(), profile, guard, ANCHOR_MS);
    await body(s);
    expect(guard.unexpected, `unexpected hosts: ${guard.unexpected.join(', ')}`).toEqual([]);
  } finally {
    await s?.context.close();
    await googleScenario(RESET_SCENARIO);
    removeProfile(profile);
  }
}

const namedLikeOurs = async (): Promise<FakeCalendar[]> => (await googleState()).calendars.filter((c) => c.summary === CALENDAR_SUMMARY);

test('calendar adoption: an existing calendar carrying our private marker is adopted; no second calendar', async () => {
  test.setTimeout(120_000);
  await adoptionTest(async (s) => {
    // A same-named decoy first (listed before ours), then the marked one.
    const decoy = await addExistingCalendar('My own auction notes');
    const marked = await addExistingCalendar(CALENDAR_DESCRIPTION);
    const { reqs, calId } = await connectAndSync(s);

    expect(calId, 'the extension adopted the marked calendar').toBe(marked);
    // One list, no calendar insert, the one event insert into the adopted calendar.
    expect(show(reqs, marked)).toEqual(['GET /calendar/v3/users/me/calendarList 200', 'POST /calendar/v3/calendars/<cal>/events 200']);
    expect((await namedLikeOurs()).map((c) => c.id)).toEqual([decoy, marked]);
    expect((await fakeCalendar(marked)).events.map((e) => [e.id, e.status])).toEqual([[eventId(ITEM_G), 'confirmed']]);
    expect((await fakeCalendar(decoy)).events).toEqual([]);
    const audits = calendarAudits(await auditEntries(s.options));
    expect(audits.filter((e) => e.kind === 'calendar.adopted').map((e) => e.ref)).toEqual([marked]);
    expect(audits.filter((e) => e.kind === 'calendar.create')).toEqual([]);
  });
});

test('calendar adoption: a same-named calendar WITHOUT our marker is never adopted', async () => {
  test.setTimeout(120_000);
  await adoptionTest(async (s) => {
    const decoy = await addExistingCalendar();
    const { reqs, calId } = await connectAndSync(s);

    expect(calId).not.toBe(decoy);
    expect(calId).toMatch(/^[0-9a-f]+@group\.calendar\.google\.com$/);
    // The list found nothing of ours, so the extension created its own calendar.
    expect(show(reqs, calId)).toEqual([
      'GET /calendar/v3/users/me/calendarList 200',
      'POST /calendar/v3/calendars 200',
      'POST /calendar/v3/calendars/<cal>/events 200',
    ]);
    expect((await namedLikeOurs()).map((c) => c.id)).toEqual([decoy, calId]);
    expect((await fakeCalendar(calId)).description).toContain(CALENDAR_MARKER);
    expect((await fakeCalendar(calId)).events.map((e) => e.id)).toEqual([eventId(ITEM_G)]);
    // The decoy was never touched.
    expect((await fakeCalendar(decoy)).events).toEqual([]);
    expect(reqs.filter((r) => r.path.includes(decoy))).toEqual([]);
    const audits = calendarAudits(await auditEntries(s.options));
    expect(audits.filter((e) => e.kind === 'calendar.adopted')).toEqual([]);
    expect(audits.filter((e) => e.kind === 'calendar.create').map((e) => e.ref)).toEqual([calId]);
  });
});
