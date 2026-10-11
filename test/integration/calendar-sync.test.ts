// T-67 integration: CalendarSink + the calendar sync job over the real adapters
// (BrowserHttp + real fetch, storage over WXT's fakeBrowser, Repo, GoogleCalendarApi,
// PkceRefreshProvider) against the in-process fake Google server on loopback.
// Ruling R5: nothing here reaches a real Google host (MSW refuses unhandled
// non-loopback requests, test/setup/vitest.setup.ts).
import { afterEach, describe, expect, it } from 'vitest';
import { browser } from 'wxt/browser';

import { BrowserClock } from '../../src/adapters/browser/clock';
import { BrowserHttp } from '../../src/adapters/browser/http';
import { createStorageAreas } from '../../src/adapters/browser/storage';
import { PkceRefreshProvider, type WebAuthFlow } from '../../src/adapters/google/auth-pkce';
import { GoogleCalendarApi } from '../../src/adapters/google/calendar-api';
import {
  CALENDAR_DESCRIPTION,
  CALENDAR_MARKER,
  CALENDAR_SUMMARY,
  RequestLimiter,
  SYNC_STATE_KEY,
  deleteEventRef,
  parseDeleteEventRef,
} from '../../src/adapters/google/calendar-sink';
import { createCalendarHandlers, createCalendarUndoExecutors } from '../../src/background/handlers/calendar';
import type { BackgroundContext } from '../../src/background/context';
import { CalendarSync, buildDesired, registerReminderSink, type ReminderSink } from '../../src/background/jobs/calendar-sync';
import { executeCalendarUpsert } from '../../src/background/jobs/steps/calendar-upsert';
import step from '../../src/background/jobs/steps/calendar-upsert';
import { eventIdFor } from '../../src/domain/calendar/event-id';
import type { CalendarLink, DesiredEvent } from '../../src/domain/calendar/types';
import type { Settings } from '../../src/domain/settings/schema';
import { Repo } from '../../src/domain/storage/repo';
import { STORAGE_KEYS } from '../../src/domain/storage/schema';
import type { CalendarApi } from '../../src/ports/calendar';
import { startFakeGoogle, type FakeGoogle, type Scenario } from '../fakes/fake-google-server/server';
import { FakeAuditLog } from '../fakes/ports/fake-audit-log';
import { FakeClock } from '../fakes/ports/fake-clock';
import { FakeNotifier } from '../fakes/ports/fake-notifier';
import { FakePermissions } from '../fakes/ports/fake-permissions';
import { FakeSwitches } from '../fakes/ports/fake-switches';

const CLIENT_ID = 'cid-cal.apps.googleusercontent.com';
const HOUR = 3_600_000;
const MIN = 60_000;

class ShiftClock extends BrowserClock {
  offset = 0;
  override now(): number {
    return Date.now() + this.offset;
  }
}

class LoopbackWebAuthFlow implements WebAuthFlow {
  getRedirectURL(): string {
    return 'https://gjbekijbmjlkdildfknfbcfnhjhohmlh.chromiumapp.org/';
  }
  async launchWebAuthFlow(details: { url: string; interactive: boolean }): Promise<string | undefined> {
    const res = await fetch(details.url, { redirect: 'manual' });
    const location = res.headers.get('location');
    if (res.status !== 302 || location === null) throw new Error('Authorization page could not be loaded.');
    return location;
  }
}

let fake: FakeGoogle | undefined;
afterEach(async () => {
  await fake?.close();
  fake = undefined;
});

let nextItem = 9_000_000;

function must<T>(v: T | undefined | null): T {
  if (v === undefined || v === null) throw new Error('expected a value');
  return v;
}

interface EventView {
  id: string;
  status: string;
  summary: string;
  description: string;
  start: { dateTime: string };
  reminders: { overrides: unknown[] };
  extendedProperties: { private: Record<string, string> };
}

interface Rig {
  fake: FakeGoogle;
  clock: ShiftClock;
  repo: Repo;
  audit: FakeAuditLog;
  switches: FakeSwitches;
  notifier: FakeNotifier;
  permissions: FakePermissions;
  badge: boolean[];
  provider: PkceRefreshProvider;
  api: CalendarApi;
  sync: CalendarSync;
  /** Rebuilds the job (a worker restart): same storage, new memory. */
  restart(wrap?: (api: CalendarApi) => CalendarApi): CalendarSync;
  track(opts?: { endsInMs?: number; calendar?: boolean; title?: string; outcome?: 'won' | 'lost' }): Promise<number>;
  setTracked(itemId: number, patch: Partial<{ endTime: string; calendar: boolean; outcome: 'won' | 'lost' | 'unknown' }>): Promise<void>;
  settings(patch: (s: Settings) => void): Promise<void>;
  writes(): string[];
  calendarId(): string;
  events(): EventView[];
}

async function rig(opts: { connect?: boolean; scenario?: Scenario } = {}): Promise<Rig> {
  fake = await startFakeGoogle({ port: 0, scenario: { clientId: CLIENT_ID, ...opts.scenario } });
  const clock = new ShiftClock();
  const storage = createStorageAreas();
  const repo = new Repo(storage, clock);
  const audit = new FakeAuditLog(clock);
  const switches = new FakeSwitches();
  const notifier = new FakeNotifier();
  const permissions = new FakePermissions({ permissions: ['notifications'] });
  const badge: boolean[] = [];
  const http = new BrowserHttp({ isOnline: () => true });
  const base = fake.url;
  const provider = new PkceRefreshProvider({
    storage,
    http,
    clock,
    identity: new LoopbackWebAuthFlow(),
    clientConfig: () => ({ clientId: CLIENT_ID }),
    badge: { set: () => undefined },
    audit,
    endpoints: { authorize: `${base}/o/oauth2/v2/auth`, token: `${base}/token`, revoke: `${base}/revoke` },
  });
  const api = new GoogleCalendarApi({
    http: provider.authorizedHttp(http),
    auth: provider,
    clock,
    maxAttempts: 1,
    baseUrl: `${base}/calendar/v3`,
  });
  const mk = (wrap?: (a: CalendarApi) => CalendarApi): CalendarSync =>
    new CalendarSync({
      repo,
      audit,
      clock,
      storage: storage.local,
      api: wrap === undefined ? api : wrap(api),
      switches,
      google: provider,
      notifier,
      permissions,
      badge: { set: (on) => void badge.push(on) },
      minIntervalMs: 0,
    });
  const r: Rig = {
    fake,
    clock,
    repo,
    audit,
    switches,
    notifier,
    permissions,
    badge,
    provider,
    api,
    sync: mk(),
    restart: (wrap) => {
      r.sync = mk(wrap);
      return r.sync;
    },
    async track(o = {}) {
      const itemId = nextItem++;
      const endTime = new Date(Date.now() + (o.endsInMs ?? 5 * HOUR)).toISOString();
      await repo.update(STORAGE_KEYS.tracked, (cur) => ({
        ...cur,
        [itemId]: {
          itemId,
          title: o.title ?? `Pyrex bowl ${String(itemId)}`,
          endTime,
          sellerId: 7,
          reasons: [{ kind: 'manual' }],
          favoriteState: 'none',
          calendar: o.calendar ?? true,
          ...(o.outcome === undefined ? {} : { outcome: o.outcome }),
          addedAt: Date.now(),
          updatedAt: Date.now(),
        },
      }));
      return itemId;
    },
    async setTracked(itemId, patch) {
      await repo.update(STORAGE_KEYS.tracked, (cur) => {
        const t = cur[itemId];
        return t === undefined ? cur : { ...cur, [itemId]: { ...t, ...patch } };
      });
    },
    async settings(patch) {
      const s = structuredClone(await repo.get(STORAGE_KEYS.settings));
      patch(s);
      await repo.set(STORAGE_KEYS.settings, s);
    },
    writes: () => (r.fake.state.requests).filter((q) => q.path.includes('/calendar/v3') && q.method !== 'GET').map((q) => `${q.method} ${q.path.replace(/.*\/calendar\/v3/, '')}`),
    calendarId: () => {
      const cal = [...r.fake.state.calendars.values()].find((c) => c.appCreated);
      if (cal === undefined) throw new Error('no calendar was created');
      return cal.id;
    },
    events: () => {
      const cal = [...r.fake.state.calendars.values()].find((c) => c.appCreated);
      return cal === undefined ? [] : [...cal.events.values()].map((e) => e as unknown as EventView);
    },
  };
  await r.settings((s) => {
    s.calendar.enabled = true;
    s.dryRun.calendar = false;
  });
  if (opts.connect !== false) await provider.connect();
  return r;
}

const calendarRequests = (r: Rig): number => r.fake.state.requests.filter((q) => q.path.includes('/calendar/v3')).length;
const links = async (r: Rig): Promise<Record<number, CalendarLink>> => (await r.repo.get(STORAGE_KEYS.calendar)).links;

describe('first sync', () => {
  it('creates the calendar exactly once and inserts one event per tracked item with 60/15/5 reminders', async () => {
    const r = await rig();
    const a = await r.track();
    const b = await r.track();
    const report = await r.sync.syncNow('test');
    expect(report).toMatchObject({ status: 'synced', changed: 2 });

    const created = r.fake.state.requests.filter((q) => q.method === 'POST' && q.path.endsWith('/calendars'));
    expect(created).toHaveLength(1);
    expect([...r.fake.state.calendars.values()].filter((c) => c.appCreated)).toHaveLength(1);
    expect((await r.repo.get(STORAGE_KEYS.calendar)).calendarId).toBe(r.calendarId());

    const events = r.events();
    expect(events.map((e) => e.id).sort()).toEqual([eventIdFor(a, 0), eventIdFor(b, 0)].sort());
    const ev = must(events.find((e) => e.id === eventIdFor(a, 0)));
    expect(ev.reminders).toMatchObject({ useDefault: false, overrides: [{ method: 'popup', minutes: 60 }, { method: 'popup', minutes: 15 }, { method: 'popup', minutes: 5 }] });
    expect(ev.extendedProperties.private).toMatchObject({ sbwItemId: String(a), sbwGen: '0', sbwState: 'open' });
    expect(ev.description).not.toContain('Current price');
    expect(Object.values(await links(r)).map((l) => l.status)).toEqual(['synced', 'synced']);
  });

  it('R3: a second sync with nothing changed makes zero Google writes (and no Calendar request at all)', async () => {
    const r = await rig();
    await r.track();
    await r.sync.syncNow('one');
    const before = r.fake.state.requests.length;
    const writesBefore = r.writes().length;
    const report = await r.sync.syncNow('two');
    expect(report.status).toBe('synced');
    expect(report.changed).toBe(0);
    expect(r.writes().length).toBe(writesBefore);
    expect(r.fake.state.requests.length).toBe(before); // not even a read
  });
});

describe('ensureCalendar looks up our calendar before creating one', () => {
  it('adopts our marked calendar instead of creating a second one', async () => {
    const r = await rig();
    // The insert reached Google and the worker died before the id was saved.
    const seeded = await r.api.calendarsInsert(CALENDAR_SUMMARY, 'UTC', CALENDAR_DESCRIPTION);
    const itemId = await r.track();
    await r.sync.syncNow('recover');
    const created = [...r.fake.state.calendars.values()].filter((c) => c.appCreated);
    expect(created.map((c) => c.id)).toEqual([seeded.id]);
    expect((await r.repo.get(STORAGE_KEYS.calendar)).calendarId).toBe(seeded.id);
    expect([...must(r.fake.state.calendars.get(seeded.id)).events.keys()]).toEqual([eventIdFor(itemId, 0)]);
    expect(r.fake.state.requests.filter((q) => q.method === 'POST' && q.path.endsWith('/calendars'))).toHaveLength(1);
  });

  it('adopts the same calendar after a rename when the saved id was lost', async () => {
    const r = await rig();
    const itemId = await r.track();
    await r.sync.syncNow('one');
    const saved = must((await r.repo.get(STORAGE_KEYS.calendar)).calendarId);
    const cal = must(r.fake.state.calendars.get(saved));
    // The marker is what a rename must not hide. The summary alone would miss it.
    expect(cal.description ?? '').toContain('sbw:dedicated-calendar');
    cal.summary = 'Renamed by the user';
    await r.repo.update(STORAGE_KEYS.calendar, (c) => ({ links: c.links }));
    const posts = r.fake.state.requests.filter((q) => q.method === 'POST' && q.path.endsWith('/calendars')).length;
    await r.sync.syncNow('two');
    expect([...r.fake.state.calendars.values()].filter((c) => c.appCreated).map((c) => c.id)).toEqual([saved]);
    expect((await r.repo.get(STORAGE_KEYS.calendar)).calendarId).toBe(saved);
    expect(r.fake.state.requests.filter((q) => q.method === 'POST' && q.path.endsWith('/calendars')).length).toBe(posts);
    expect(must(r.fake.state.calendars.get(saved)).events.has(eventIdFor(itemId, 0))).toBe(true);
  });

  it('never adopts a calendar on its summary alone, or an unrelated app calendar', async () => {
    const r = await rig();
    r.fake.seedCalendar('user-cal@example.com', CALENDAR_SUMMARY);
    // Listed (visible to this grant) and named exactly like ours, but without our marker.
    const unmarked = 'unmarked@group.calendar.google.com';
    r.fake.state.calendars.set(unmarked, { id: unmarked, summary: CALENDAR_SUMMARY, timeZone: 'UTC', appCreated: true, events: new Map() });
    r.fake.state.calendars.set('other@group.calendar.google.com', {
      id: 'other@group.calendar.google.com',
      summary: 'Other app calendar',
      timeZone: 'UTC',
      appCreated: true,
      events: new Map(),
    });
    const itemId = await r.track();
    await r.sync.syncNow('one');
    const saved = must((await r.repo.get(STORAGE_KEYS.calendar)).calendarId);
    expect([unmarked, 'user-cal@example.com', 'other@group.calendar.google.com']).not.toContain(saved);
    for (const id of [unmarked, 'user-cal@example.com', 'other@group.calendar.google.com']) {
      expect(r.fake.state.calendars.get(id)?.events.size).toBe(0);
      expect(r.writes().filter((w) => w.includes(encodeURIComponent(id)))).toEqual([]);
    }
    expect(must(r.fake.state.calendars.get(saved)).description ?? '').toContain(CALENDAR_MARKER);
    expect(must(r.fake.state.calendars.get(saved)).events.has(eventIdFor(itemId, 0))).toBe(true);
  });

  it('never adopts a marked calendar the user does not own, or the primary calendar', async () => {
    const r = await rig();
    // A ShopBadwill calendar someone shared with this user, and a primary calendar
    // whose description happens to carry the marker: both listed, neither ours to write.
    const shared = 'shared@group.calendar.google.com';
    const primary = 'me@example.com';
    r.fake.state.calendars.set(shared, {
      id: shared, summary: CALENDAR_SUMMARY, description: CALENDAR_DESCRIPTION, accessRole: 'writer', timeZone: 'UTC', appCreated: true, events: new Map(),
    });
    r.fake.state.calendars.set(primary, {
      id: primary, summary: 'Me', description: CALENDAR_MARKER, primary: true, timeZone: 'UTC', appCreated: true, events: new Map(),
    });
    const itemId = await r.track();
    await r.sync.syncNow('one');
    const saved = must((await r.repo.get(STORAGE_KEYS.calendar)).calendarId);
    expect([shared, primary]).not.toContain(saved);
    for (const id of [shared, primary]) {
      expect(r.fake.state.calendars.get(id)?.events.size).toBe(0);
      expect(r.writes().filter((w) => w.includes(encodeURIComponent(id)))).toEqual([]);
    }
    expect(must(r.fake.state.calendars.get(saved)).events.has(eventIdFor(itemId, 0))).toBe(true);
  });

  it('after the saved calendar is deleted, reuses a leftover with our marker instead of creating another', async () => {
    const r = await rig();
    const itemId = await r.track();
    await r.sync.syncNow('one');
    const saved = must((await r.repo.get(STORAGE_KEYS.calendar)).calendarId);
    const leftoverId = 'leftover123@group.calendar.google.com';
    r.fake.state.calendars.set(leftoverId, {
      id: leftoverId,
      summary: CALENDAR_SUMMARY,
      description: CALENDAR_DESCRIPTION,
      timeZone: 'UTC',
      appCreated: true,
      events: new Map(),
    });
    r.fake.state.calendars.delete(saved);
    // The live worker already verified the saved id. A new worker is what notices it is gone.
    // An end-time change is what makes the sync look: a no-op run never opens the calendar.
    r.restart();
    await r.setTracked(itemId, { endTime: new Date(Date.now() + 9 * HOUR).toISOString() });
    await r.sync.syncNow('two');
    expect([...r.fake.state.calendars.values()].filter((c) => c.appCreated).map((c) => c.id)).toEqual([leftoverId]);
    expect((await r.repo.get(STORAGE_KEYS.calendar)).calendarId).toBe(leftoverId);
    expect(must(r.fake.state.calendars.get(leftoverId)).events.has(eventIdFor(itemId, 0))).toBe(true);
  });

  it('still creates the calendar when listing is forbidden for this scope', async () => {
    const r = await rig({ scenario: { forbidCalendarList: true } });
    const itemId = await r.track();
    const report = await r.sync.syncNow('one');
    expect(report.status).toBe('synced');
    expect(r.notifier.sent.filter((n) => n.id === 'sbw:calendar:reconnect')).toHaveLength(0);
    const ours = [...r.fake.state.calendars.values()].filter((c) => c.appCreated);
    expect(ours).toHaveLength(1);
    expect(must(ours[0]).events.has(eventIdFor(itemId, 0))).toBe(true);
  });
});

describe('changes', () => {
  it('an end-time change produces exactly one patch', async () => {
    const r = await rig();
    const id = await r.track();
    await r.sync.syncNow('one');
    const later = new Date(Date.now() + 9 * HOUR).toISOString();
    await r.setTracked(id, { endTime: later });
    const report = await r.sync.syncNow('two');
    expect(report.changed).toBe(1);
    expect(r.writes().filter((w) => w.startsWith('PATCH'))).toEqual([`PATCH /calendars/${encodeURIComponent(r.calendarId())}/events/${eventIdFor(id, 0)}`]);
    const ev = must(r.events()[0]);
    expect(new Date(ev.start.dateTime).toISOString().slice(0, 19)).toBe(later.slice(0, 19));
    expect((r.audit.kinds)).toContain('calendar.patch');
  });

  it('unwatching deletes the event and marks the link deleted', async () => {
    const r = await rig();
    const id = await r.track();
    await r.sync.syncNow('one');
    await r.setTracked(id, { calendar: false });
    const report = await r.sync.syncNow('two');
    expect(report.changed).toBe(1);
    expect(r.writes().filter((w) => w.startsWith('DELETE'))).toHaveLength(1);
    expect(r.events()[0]?.status).toBe('cancelled');
    expect((await links(r))[id]?.status).toBe('deleted');
    // and again: nothing more to do
    const n = r.writes().length;
    await r.sync.syncNow('three');
    expect(r.writes().length).toBe(n);
  });

  it('a decided auction is stamped WON once: retitled, reminders cleared, no second write', async () => {
    const r = await rig();
    const id = await r.track({ title: 'Pyrex bowl' });
    await r.sync.syncNow('one');
    await r.setTracked(id, { outcome: 'won' });
    await r.sync.syncNow('two');
    const ev = must(r.events()[0]);
    expect(ev.summary).toBe('WON: Pyrex bowl');
    expect(ev.reminders.overrides).toEqual([]);
    expect(ev.extendedProperties.private.sbwState).toBe('won');
    const n = r.writes().length;
    await r.sync.syncNow('three');
    expect(r.writes().length).toBe(n);
  });

  it('the sink port stamps with the final price, once', async () => {
    const r = await rig();
    const id = await r.track({ title: 'Lamp' });
    await r.sync.syncNow('one');
    await r.sync.sink.stamp(id, 'lost', 1250);
    const ev = must(r.events()[0]);
    expect(ev.summary).toBe('LOST: Lamp');
    expect(ev.description).toContain('Final price: $12.50');
    const n = r.writes().length;
    await r.sync.sink.stamp(id, 'lost', 1250);
    expect(r.writes().length).toBe(n);
  });
});

describe('409 on insert', () => {
  it('a cancelled event under the id: get -> bump-generation inserts under g1 and never reuses the id', async () => {
    const r = await rig();
    const id = await r.track();
    await r.sync.syncNow('one');
    await r.setTracked(id, { calendar: false });
    await r.sync.syncNow('two'); // event cancelled
    // lose the link (as after a crash), then want it again
    await r.repo.update(STORAGE_KEYS.calendar, (c) => ({ ...c, links: {} }));
    await r.setTracked(id, { calendar: true });
    await r.sync.syncNow('three');
    const reqs = r.fake.state.requests.filter((q) => q.path.includes('/events'));
    expect(reqs.some((q) => q.method === 'POST' && q.status === 409)).toBe(true);
    expect(r.events().map((e) => [e.id, e.status]).sort()).toEqual([[eventIdFor(id, 0), 'cancelled'], [eventIdFor(id, 1), 'confirmed']]);
    expect((await links(r))[id]).toMatchObject({ eventId: eventIdFor(id, 1), generation: 1, status: 'synced' });
  });

  it('revive strategy: get -> patch brings the cancelled event back under the same id', async () => {
    const r = await rig();
    r.restart();
    const strategic = new CalendarSync({
      repo: r.repo, audit: r.audit, clock: r.clock, storage: createStorageAreas().local, api: r.api, switches: r.switches,
      google: r.provider, notifier: r.notifier, permissions: r.permissions, badge: { set: () => undefined }, minIntervalMs: 0, strategy: 'revive',
    });
    const id = await r.track();
    await strategic.syncNow('one');
    await r.setTracked(id, { calendar: false });
    await strategic.syncNow('two');
    await r.repo.update(STORAGE_KEYS.calendar, (c) => ({ ...c, links: {} }));
    await r.setTracked(id, { calendar: true });
    await strategic.syncNow('three');
    expect(r.events().map((e) => [e.id, e.status])).toEqual([[eventIdFor(id, 0), 'confirmed']]);
  });

  it('R3: a restart between a write and its link save adopts the event: no duplicate, no extra insert', async () => {
    const r = await rig();
    const ids = [await r.track(), await r.track(), await r.track()];
    let inserts = 0;
    // The worker dies right after the second event reached Google, before its link was saved.
    r.restart((api) => ({
      calendarsInsert: (s, tz, description) => api.calendarsInsert(s, tz, description),
      calendarListGet: (c) => api.calendarListGet(c),
      calendarListList: () => api.calendarListList(),
      eventsGet: (c, e) => api.eventsGet(c, e),
      eventsPatch: (c, e, p) => api.eventsPatch(c, e, p),
      eventsDelete: (c, e) => api.eventsDelete(c, e),
      eventsListByPrivateProp: (c, k, v) => api.eventsListByPrivateProp(c, k, v),
      eventsInsert: async (c, b) => {
        inserts += 1;
        const out = await api.eventsInsert(c, b);
        if (inserts === 2) throw new Error('worker killed');
        return out;
      },
    }));
    const first = await r.sync.syncNow('one');
    expect(first.errors).toBe(1);
    expect(r.events()).toHaveLength(3);
    // New worker, same storage, past the retry backoff.
    r.restart();
    r.clock.offset += 10 * MIN;
    const second = await r.sync.syncNow('two');
    expect(second.errors).toBe(0);
    expect(r.events()).toHaveLength(3);
    expect(r.events().map((e) => e.id).sort()).toEqual(ids.map((i) => eventIdFor(i, 0)).sort());
    expect(Object.values(await links(r)).every((l) => l.status === 'synced')).toBe(true);
    const n = r.writes().length;
    await r.sync.syncNow('three');
    expect(r.writes().length).toBe(n);
  });
});

describe('ownership guard (R2)', () => {
  it('an event without our private property under our id is never patched or deleted; other events are never touched', async () => {
    const r = await rig();
    const id = await r.track();
    // The user's own event on the same calendar.
    await r.sync.syncNow('one');
    const cal = [...r.fake.state.calendars.values()].find((c) => c.appCreated);
    if (cal === undefined) throw new Error('no calendar');
    cal.events.set('userevent01', { ...structuredClone(must(cal.events.get(eventIdFor(id, 0)))), id: 'userevent01', summary: 'Dentist' });
    // Someone stripped our property from our event (it is no longer ours).
    const mine = must(cal.events.get(eventIdFor(id, 0)));
    mine['extendedProperties'] = { private: {} };
    delete (cal.events.get('userevent01') as Record<string, unknown>)['extendedProperties'];
    const strippedBefore = JSON.stringify(cal.events.get(eventIdFor(id, 0)));
    const userBefore = JSON.stringify(cal.events.get('userevent01'));

    await r.setTracked(id, { endTime: new Date(Date.now() + 20 * HOUR).toISOString() });
    await r.sync.syncNow('two');
    expect(r.writes().filter((w) => w.startsWith('PATCH'))).toEqual([]);
    expect(JSON.stringify(cal.events.get(eventIdFor(id, 0)))).toBe(strippedBefore);
    expect((await links(r))[id]).toMatchObject({ status: 'error' });
    expect(r.audit.kinds).toContain('calendar.refused');

    await r.setTracked(id, { calendar: false });
    await r.sync.syncNow('three');
    expect(r.writes().filter((w) => w.startsWith('DELETE'))).toEqual([]);
    expect(JSON.stringify(cal.events.get(eventIdFor(id, 0)))).toBe(strippedBefore);
    expect(JSON.stringify(cal.events.get('userevent01'))).toBe(userBefore);
    expect(r.writes().filter((w) => w.includes('userevent01'))).toEqual([]);
  });

  it('a foreign event under our id at insert time (409) is left alone and our event goes in under g1', async () => {
    const r = await rig();
    const id = await r.track();
    await r.sync.syncNow('one'); // creates the calendar
    const cal = must([...r.fake.state.calendars.values()].find((c) => c.appCreated));
    const ours = must(cal.events.get(eventIdFor(id, 0)));
    cal.events.set(eventIdFor(id, 0), { ...ours, extendedProperties: { private: {} }, summary: 'not ours' });
    await r.repo.update(STORAGE_KEYS.calendar, (c) => ({ ...c, links: {} }));
    const writes0 = r.writes().length;
    await r.sync.syncNow('two');
    expect(cal.events.get(eventIdFor(id, 0))?.['summary']).toBe('not ours');
    expect(cal.events.get(eventIdFor(id, 1))?.['summary']).toContain('Pyrex');
    expect(r.writes().slice(writes0).every((w) => w.startsWith('POST'))).toBe(true);
  });
});

describe('disconnected', () => {
  it('queues pending links, makes no Google call, and raises the badge', async () => {
    const r = await rig({ connect: false });
    const a = await r.track();
    const b = await r.track();
    const report = await r.sync.syncNow('test');
    expect(report).toMatchObject({ status: 'pending', pending: 2, changed: 0 });
    expect(r.fake.state.requests).toHaveLength(0);
    const l = await links(r);
    expect([l[a]?.status, l[b]?.status]).toEqual(['pending', 'pending']);
    expect(l[a]?.eventId).toBe(eventIdFor(a, 0));
    expect(r.badge).toContain(true);
    // Idempotent while waiting.
    await r.sync.syncNow('again');
    expect(r.fake.state.requests).toHaveLength(0);
  });

  it('pending links are inserted after a connect (under the real calendar id)', async () => {
    const r = await rig({ connect: false });
    const a = await r.track();
    await r.sync.syncNow('one');
    await r.provider.connect();
    const report = await r.sync.syncNow('two');
    expect(report).toMatchObject({ status: 'synced', changed: 1, pending: 0 });
    expect(r.events().map((e) => e.id)).toEqual([eventIdFor(a, 0)]);
    expect((await links(r))[a]).toMatchObject({ status: 'synced', calendarId: r.calendarId() });
  });

  it('calendar disabled: nothing happens, not even a status call', async () => {
    const r = await rig({ connect: false });
    await r.settings((s) => {
      s.calendar.enabled = false;
    });
    await r.track();
    expect((await r.sync.syncNow('x')).status).toBe('disabled');
    expect(await links(r)).toEqual({});
  });
});

describe('invalid_grant', () => {
  it('stops at the first failure, queues the rest, and notifies once per day (not per item)', async () => {
    const r = await rig();
    await r.track();
    await r.track();
    await r.track();
    r.fake.setScenario({ invalidGrant: true });
    r.clock.offset += 2 * HOUR; // our cached access token has lapsed: the next call must refresh
    r.fake.advanceClock(2 * HOUR);

    const first = await r.sync.syncNow('one');
    expect(first.status).toBe('needs-reconnect');
    expect(calendarRequests(r)).toBe(0);
    expect(r.notifier.sent.filter((n) => n.id === 'sbw:calendar:reconnect')).toHaveLength(1);
    expect(r.badge).toContain(true);
    expect(Object.values(await links(r)).map((l) => l.status)).toEqual(['pending', 'pending', 'pending']);

    await r.sync.syncNow('two');
    await r.sync.syncNow('three');
    expect(r.notifier.sent.filter((n) => n.id === 'sbw:calendar:reconnect')).toHaveLength(1);
    expect(calendarRequests(r)).toBe(0);

    // Next local day: told again, once.
    r.clock.offset += 26 * HOUR;
    await r.sync.syncNow('four');
    await r.sync.syncNow('five');
    expect(r.notifier.sent.filter((n) => n.id === 'sbw:calendar:reconnect')).toHaveLength(2);
  });
});

describe('dry run', () => {
  it('writes an audit entry only: no Google request, no link, and no repeat audit', async () => {
    const r = await rig();
    await r.settings((s) => {
      s.dryRun.calendar = true;
    });
    r.switches.block('calendar', 'dry run');
    const id = await r.track();
    const report = await r.sync.syncNow('test');
    expect(report.status).toBe('synced');
    expect(r.fake.state.requests.filter((q) => q.path.includes('/calendar/v3'))).toHaveLength(0);
    const entries = r.audit.entries.filter((e) => e.kind === 'calendar.insert');
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ actor: 'calendar', itemId: id, dryRun: true });
    expect(entries[0]?.undo).toBeUndefined();
    expect((await r.repo.get(STORAGE_KEYS.calendar)).calendarId).toBeUndefined();
    expect(await links(r)).toEqual({});
    await r.sync.syncNow('again');
    expect(r.audit.entries.filter((e) => e.kind === 'calendar.insert')).toHaveLength(1);
  });

  it('the kill switch (or health) blocks writes without auditing a dry run', async () => {
    const r = await rig();
    r.switches.killAll('kill switch');
    await r.track();
    const report = await r.sync.syncNow('test');
    expect(report.status).toBe('blocked');
    expect(calendarRequests(r)).toBe(0);
    expect(r.audit.kinds.filter((k) => k === 'calendar.insert')).toEqual([]);
  });
});

describe('R4: courtesy', () => {
  it('the limiter keeps at least 1 s between request starts', async () => {
    const clock = new FakeClock();
    const limiter = new RequestLimiter(clock, 1000);
    const starts: number[] = [];
    const calls = [0, 1, 2].map(() => limiter.run(() => Promise.resolve(starts.push(clock.monotonic()))));
    // The first call starts at once; each later one waits on the clock. Let microtasks settle, then tick.
    for (let i = 0; i < 4; i++) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      clock.advance(1000);
    }
    await Promise.all(calls);
    expect(starts).toHaveLength(3);
    const [s0, s1, s2] = starts.map((x) => must(x));
    expect(must(s1) - must(s0)).toBeGreaterThanOrEqual(1000);
    expect(must(s2) - must(s1)).toBeGreaterThanOrEqual(1000);
  });

  it('the limiter also keeps 1 s after a slow call ends (its retries inside the adapter count)', async () => {
    const clock = new FakeClock();
    const limiter = new RequestLimiter(clock, 1000);
    let firstEnded = 0;
    let secondStarted = 0;
    const first = limiter.run(() => {
      clock.advance(1500); // the call (with an adapter-internal retry) took 1.5 s
      firstEnded = clock.monotonic();
      return Promise.resolve();
    });
    const second = limiter.run(() => {
      secondStarted = clock.monotonic();
      return Promise.resolve();
    });
    for (let i = 0; i < 4; i++) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      clock.advance(500);
    }
    await Promise.all([first, second]);
    expect(secondStarted - firstEnded).toBeGreaterThanOrEqual(1000);
  });

  it('the stamp port respects a recorded cooldown: no request until it ends', async () => {
    const r = await rig();
    const id = await r.track();
    await r.sync.syncNow('one');
    await browser.storage.local.set({ [SYNC_STATE_KEY]: { cooldownUntil: r.clock.now() + 5 * MIN, cooldownCount: 1 } });
    const reqs = calendarRequests(r);
    await expect(r.sync.sink.stamp(id, 'won')).rejects.toThrow(/cooling down/);
    expect(calendarRequests(r)).toBe(reqs);
  });

  it('a 429 halts the run, records a persisted cooldown, and the next sync makes no request until it ends', async () => {
    const r = await rig();
    await r.track();
    await r.track();
    r.fake.setScenario({ rateLimitNext: 100 });
    const first = await r.sync.syncNow('one');
    expect(first.status).toBe('cooling-down');
    const used = calendarRequests(r);
    expect(used).toBe(1); // stopped at the first 429, not one per item
    const state = (await browser.storage.local.get(SYNC_STATE_KEY))[SYNC_STATE_KEY] as { cooldownUntil: number };
    expect(state.cooldownUntil).toBeGreaterThan(Date.now());
    expect(r.audit.kinds).toContain('calendar.cooldown');

    r.fake.setScenario({ rateLimitNext: 0 });
    const second = await r.sync.syncNow('two');
    expect(second.status).toBe('cooling-down');
    expect(calendarRequests(r)).toBe(used);

    // After the cooldown it carries on (a restarted worker reads it from storage).
    r.restart();
    r.clock.offset += 2 * MIN;
    const third = await r.sync.syncNow('three');
    expect(third.status).toBe('synced');
    expect(r.events()).toHaveLength(2);
  });
});

describe('late add, reminder sinks, undo, handlers', () => {
  it('an event inserted for an auction ending in under 60 minutes sends one immediate notification', async () => {
    const r = await rig();
    const id = await r.track({ endsInMs: 30 * MIN, title: 'Last minute vase' });
    await r.sync.syncNow('one');
    const late = r.notifier.sent.filter((n) => n.id === `sbw:notify:late:${String(id)}`);
    expect(late).toHaveLength(1);
    expect(late[0]?.notification.title).toMatch(/^Ends in \d+ min: Last minute vase/);
    await r.setTracked(id, { endTime: new Date(Date.now() + 40 * MIN).toISOString() });
    await r.sync.syncNow('two');
    expect(r.notifier.sent.filter((n) => n.id === `sbw:notify:late:${String(id)}`)).toHaveLength(1);
  });

  it('every registered ReminderSink gets each event once, and removal when the item is decided', async () => {
    const r = await rig();
    const calls: string[] = [];
    const sink: ReminderSink = {
      name: 'test-sink',
      upsert: (e: DesiredEvent) => {
        calls.push(`upsert ${String(e.itemId)}`);
        return Promise.resolve();
      },
      remove: (itemId) => {
        calls.push(`remove ${String(itemId)}`);
        return Promise.resolve();
      },
    };
    const off = registerReminderSink(sink);
    try {
      const id = await r.track();
      await r.sync.syncNow('one');
      await r.sync.syncNow('two');
      expect(calls).toEqual([`upsert ${String(id)}`]);
      await r.setTracked(id, { outcome: 'lost' });
      await r.sync.syncNow('three');
      expect(calls).toEqual([`upsert ${String(id)}`, `remove ${String(id)}`]);
    } finally {
      off();
    }
  });

  function fakeCtx(r: Rig): BackgroundContext {
    return {
      repo: r.repo,
      audit: r.audit,
      clock: r.clock,
      storage: createStorageAreas(),
      calendarApi: r.api,
      switches: r.switches,
      google: r.provider,
      notifier: r.notifier,
      permissions: r.permissions,
      googleNeedsInteraction: { get: () => false, set: () => undefined, subscribe: () => () => undefined },
    } as unknown as BackgroundContext;
  }

  it('deleteEvent undo: the ref is documented, the event is deleted through the guard and not re-added', async () => {
    const r = await rig();
    const id = await r.track();
    await r.sync.syncNow('one');
    const entry = r.audit.entries.find((e) => e.kind === 'calendar.insert');
    expect(entry?.undo).toEqual({ kind: 'deleteEvent', ref: deleteEventRef(id, eventIdFor(id, 0)) });
    expect(parseDeleteEventRef(entry?.undo?.ref ?? '')).toEqual({ itemId: id, eventId: eventIdFor(id, 0) });
    expect(parseDeleteEventRef('deleteEvent:1:../x')).toBeUndefined();

    const ctx = fakeCtx(r);
    // The context's own sync instance shares nothing with r.sync except storage; that is the point.
    await createCalendarUndoExecutors(ctx).deleteEvent(entry?.undo?.ref ?? '', must(entry));
    expect(r.events()[0]?.status).toBe('cancelled');
    expect((await r.repo.get(STORAGE_KEYS.tracked))[id]?.calendar).toBe(false);
    const n = r.writes().length;
    await r.sync.syncNow('two');
    expect(r.writes().length).toBe(n);

    // Idempotent: a second run (a restart before the `undo` audit entry) writes nothing.
    const reqs = calendarRequests(r);
    await createCalendarUndoExecutors(ctx).deleteEvent(entry?.undo?.ref ?? '', must(entry));
    expect(calendarRequests(r)).toBe(reqs);
    expect(r.writes().length).toBe(n);

    // Put back on the calendar later: a fresh generation, the cancelled id is never reused or touched.
    await r.setTracked(id, { calendar: true });
    await r.sync.syncNow('three');
    expect(r.events().map((e) => [e.id, e.status]).sort()).toEqual([[eventIdFor(id, 0), 'cancelled'], [eventIdFor(id, 1), 'confirmed']]);
    expect(r.writes().slice(n)).toEqual([`POST /calendars/${encodeURIComponent(r.calendarId())}/events`]);
    expect((await links(r))[id]).toMatchObject({ eventId: eventIdFor(id, 1), status: 'synced' });
  });

  it('deleteEvent undo while Google is disconnected is refused without any Google request', async () => {
    const r = await rig();
    const id = await r.track();
    await r.sync.syncNow('one');
    const entry = must(r.audit.entries.find((e) => e.kind === 'calendar.insert'));
    await r.provider.disconnect();
    const reqs = calendarRequests(r);
    await expect(createCalendarUndoExecutors(fakeCtx(r)).deleteEvent(entry.undo?.ref ?? '', entry)).rejects.toThrow(/not now/);
    expect(calendarRequests(r)).toBe(reqs);
    expect(r.events()[0]?.status).toBe('confirmed');
    expect((await r.repo.get(STORAGE_KEYS.tracked))[id]?.calendar).toBe(true);
    expect((await links(r))[id]?.status).toBe('synced');
  });

  it('deleteEvent undo is refused while calendar writes are off', async () => {
    const r = await rig();
    const id = await r.track();
    await r.sync.syncNow('one');
    r.switches.killAll('kill switch');
    const entry = must(r.audit.entries.find((e) => e.kind === 'calendar.insert'));
    await expect(createCalendarUndoExecutors(fakeCtx(r)).deleteEvent(entry.undo?.ref ?? '', entry)).rejects.toThrow(/not now/);
    expect(r.events()[0]?.status).toBe('confirmed');
    expect((await r.repo.get(STORAGE_KEYS.tracked))[id]?.calendar).toBe(true);
  });

  it('calendar.ics builds the file from tracked items without any Google call', async () => {
    const r = await rig({ connect: false });
    const a = await r.track({ title: 'Teapot' });
    const out = await createCalendarHandlers(fakeCtx(r))['calendar.ics']({ itemIds: [a, 424242] }, {} as never);
    expect(out.ics).toContain('BEGIN:VCALENDAR');
    expect(out.ics.match(/BEGIN:VEVENT/g)).toHaveLength(1);
    expect(out.ics).toContain('SUMMARY:Teapot');
    expect(out.ics.match(/BEGIN:VALARM/g)).toHaveLength(3);
    expect(r.fake.state.requests).toHaveLength(0);
  });

  it('the calendarUpsert step executor syncs and reports done; default export is { kind, run }', async () => {
    const r = await rig({ connect: false });
    const id = await r.track();
    expect(step.kind).toBe('calendarUpsert');
    expect(step.run).toBe(executeCalendarUpsert);
    const outcome = await executeCalendarUpsert({ kind: 'calendarUpsert', itemId: id }, { repo: r.repo, ctx: fakeCtx(r) });
    expect(outcome).toEqual({ kind: 'calendarUpsert', done: true });
    expect((await links(r))[id]?.status).toBe('pending'); // disconnected: queued, no call
    expect(r.fake.state.requests).toHaveLength(0);
    expect(await executeCalendarUpsert({ kind: 'notifyDigest' }, { repo: r.repo, ctx: fakeCtx(r) })).toMatchObject({ kind: 'error', retryable: false });
  });

  it('buildDesired leaves out an ended, undecided auction that has no live event, and keeps the stable description', async () => {
    const r = await rig();
    const ended = await r.track({ endsInMs: -HOUR });
    const open = await r.track();
    const settings = await r.repo.get(STORAGE_KEYS.settings);
    const tracked = await r.repo.get(STORAGE_KEYS.tracked);
    const d = buildDesired(tracked, {}, settings, Date.now());
    expect(d.map((e) => e.itemId)).toEqual([open]);
    expect(d.map((e) => e.itemId)).not.toContain(ended);
  });
});
