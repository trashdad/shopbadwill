// @vitest-environment node
// Runs GoogleCalendarApi (over BrowserHttp + real fetch) against the in-process fake Google server.
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { BrowserHttp } from '../../../src/adapters/browser/http';
import { GoogleCalendarApi } from '../../../src/adapters/google/calendar-api';
import { RawEventSchema as LenientRawEventSchema, normalizeEvent } from '../../../src/adapters/google/schemas';
import { GcalEventSchema, type GcalEventBody } from '../../../src/domain/calendar/types';
import { CalendarApiError } from '../../../src/ports/errors';
import type { GoogleAuthProvider } from '../../../src/ports/google-auth';
import { FakeClock } from '../../fakes/ports/fake-clock';
import { RawEventSchema as FakeRawEventSchema, RawEventsListSchema as FakeRawListSchema } from '../../fakes/fake-google-server/schemas';
import { startFakeGoogle, type FakeGoogle, type Scenario } from '../../fakes/fake-google-server/server';

const SCOPE = 'https://www.googleapis.com/auth/';
const VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const CHALLENGE = createHash('sha256').update(VERIFIER).digest('base64url');
const REDIRECT = 'http://127.0.0.1/cb';

let fake: FakeGoogle;
beforeEach(async () => {
  fake = await startFakeGoogle({ port: 0 });
});
afterEach(async () => {
  await fake.close();
});

async function accessToken(scope: string): Promise<string> {
  const u = new URL('/authorize', fake.url);
  for (const [k, v] of Object.entries({
    client_id: 'cid', redirect_uri: REDIRECT, response_type: 'code', scope, state: 's',
    code_challenge: CHALLENGE, code_challenge_method: 'S256', access_type: 'offline',
  })) u.searchParams.set(k, v);
  const loc = new URL((await fetch(u, { redirect: 'manual' })).headers.get('location') ?? '');
  const res = await fetch(new URL('/token', fake.url), {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code', code: loc.searchParams.get('code') ?? '', code_verifier: VERIFIER, client_id: 'cid', redirect_uri: REDIRECT,
    }),
  });
  return ((await res.json()) as { access_token: string }).access_token;
}

/** Records the backoff sleeps and fires them at once. */
class RecordingClock extends FakeClock {
  readonly delays: number[] = [];
  override setTimeout(fn: () => void, ms: number): number {
    this.delays.push(ms);
    queueMicrotask(fn);
    return 0;
  }
}

async function makeApi(scope = `${SCOPE}calendar`, scenario?: Scenario) {
  if (scenario) fake.setScenario(scenario);
  const token = await accessToken(scope);
  const auth: GoogleAuthProvider = {
    getAccessToken: () => Promise.resolve(token),
    connect: () => Promise.reject(new Error('unused')),
    disconnect: () => Promise.reject(new Error('unused')),
    status: () => Promise.reject(new Error('unused')),
  };
  const clock = new RecordingClock();
  const api = new GoogleCalendarApi({
    http: new BrowserHttp({ isOnline: () => true }), auth, clock, baseUrl: `${fake.url}/calendar/v3`, random: () => 1,
  });
  return { api, clock };
}

const bodyFor = (id: string, itemId = '1'): GcalEventBody & { id: string } => ({
  id,
  summary: 'SGW ends: lamp',
  description: 'desc',
  start: { dateTime: '2026-10-08T02:18:30.000Z', timeZone: 'UTC' },
  end: { dateTime: '2026-10-08T02:33:30.000Z', timeZone: 'UTC' },
  reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 60 }, { method: 'popup', minutes: 15 }, { method: 'popup', minutes: 5 }] },
  extendedProperties: { private: { sbwItemId: itemId, sbwGen: '0', sbwState: 'open' } },
  source: { title: 'ShopGoodwill', url: 'https://shopgoodwill.com/item/1' },
});
async function failure(p: Promise<unknown>): Promise<CalendarApiError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof CalendarApiError) return e;
    throw e;
  }
  throw new Error('expected CalendarApiError');
}

describe('GoogleCalendarApi against the fake Google server', () => {
  it('every fake response validates: raw (fake + lenient schemas) and normalized', async () => {
    const { api } = await makeApi();
    const { id: calId } = await api.calendarsInsert('ShopGoodwill Auctions', 'UTC');
    expect(await api.calendarListGet(calId)).toEqual({ id: calId });

    const inserted = await api.eventsInsert(calId, bodyFor('sbv1g0abc'));
    expect(GcalEventSchema.safeParse(inserted).success).toBe(true);
    expect(inserted).toMatchObject({ id: 'sbv1g0abc', status: 'confirmed', summary: 'SGW ends: lamp', source: { url: 'https://shopgoodwill.com/item/1' } });
    expect(inserted.reminders.overrides).toHaveLength(3);

    const patched = await api.eventsPatch(calId, 'sbv1g0abc', { summary: 'WON: lamp', reminders: { useDefault: false, overrides: [] } });
    expect(patched.summary).toBe('WON: lamp');
    expect(patched.reminders.overrides).toEqual([]);

    // Raw shapes straight from the server satisfy both the fake's strict schema and ours.
    const state = fake.state.calendars.get(calId);
    for (const raw of state?.events.values() ?? []) {
      expect(FakeRawEventSchema.safeParse(raw).success).toBe(true);
      expect(LenientRawEventSchema.safeParse(raw).success).toBe(true);
      expect(GcalEventSchema.safeParse(normalizeEvent(raw)).success).toBe(true);
    }
    const listRes = await fetch(`${fake.url}/__admin/state`);
    expect(listRes.status).toBe(200);
    const listed = await api.eventsListByPrivateProp(calId, 'sbwItemId', '1');
    expect(listed.map((e) => e.id)).toEqual(['sbv1g0abc']);
    expect(FakeRawListSchema.safeParse({ kind: 'calendar#events', etag: 'e', summary: 's', timeZone: 'UTC', items: [...(state?.events.values() ?? [])] }).success).toBe(true);
    expect(await api.eventsListByPrivateProp(calId, 'sbwItemId', '999')).toEqual([]);
  });

  it('409 on a duplicate id -> conflict', async () => {
    const { api } = await makeApi();
    const { id } = await api.calendarsInsert('c', 'UTC');
    await api.eventsInsert(id, bodyFor('sbv1g0abc'));
    const e = await failure(api.eventsInsert(id, bodyFor('sbv1g0abc')));
    expect(e).toMatchObject({ code: 'conflict', status: 409 });
  });

  it('delete: cancelled event reads back as cancelled; second delete (410) and missing (404) are no-ops', async () => {
    const { api } = await makeApi();
    const { id } = await api.calendarsInsert('c', 'UTC');
    await api.eventsInsert(id, bodyFor('sbv1g0abc'));
    await api.eventsDelete(id, 'sbv1g0abc');
    expect((await api.eventsGet(id, 'sbv1g0abc'))?.status).toBe('cancelled');
    await api.eventsDelete(id, 'sbv1g0abc');
    await api.eventsDelete(id, 'sbv9g0zzz');
    expect(await api.eventsGet(id, 'sbv9g0zzz')).toBeNull();
    expect(await api.eventsListByPrivateProp(id, 'sbwItemId', '1')).toEqual([]);
  });

  it('S-5 both ways: patching a cancelled event revives it, or is not-found when revive is off', async () => {
    const { api } = await makeApi();
    const { id } = await api.calendarsInsert('c', 'UTC');
    await api.eventsInsert(id, bodyFor('sbv1g0abc'));
    await api.eventsDelete(id, 'sbv1g0abc');
    expect((await api.eventsPatch(id, 'sbv1g0abc', { summary: 'back' })).status).toBe('confirmed');
    await api.eventsDelete(id, 'sbv1g0abc');
    fake.setScenario({ revive: false });
    expect((await failure(api.eventsPatch(id, 'sbv1g0abc', { summary: 'x' }))).code).toBe('not-found');
  });

  it('missing calendar: calendarList.get -> null; events on it -> not-found', async () => {
    const { api } = await makeApi();
    expect(await api.calendarListGet('nope@group.calendar.google.com')).toBeNull();
    expect((await failure(api.eventsInsert('nope@group.calendar.google.com', bodyFor('sbv1g0abc')))).code).toBe('not-found');
  });

  it('forbidden/insufficientPermissions -> insufficient-scope (calendar.app.created on a foreign calendar)', async () => {
    const { api } = await makeApi(`${SCOPE}calendar.app.created`);
    const own = await api.calendarsInsert('c', 'UTC');
    await api.eventsInsert(own.id, bodyFor('sbv1g0abc')); // app-created calendar is allowed
    const e = await failure(api.eventsInsert('primary', bodyFor('sbv2g0abc')));
    expect(e).toMatchObject({ code: 'insufficient-scope', status: 403 });
  });

  it('read-only scope cannot write -> insufficient-scope', async () => {
    const { api } = await makeApi(`${SCOPE}calendar.readonly`);
    expect((await failure(api.eventsInsert('primary', bodyFor('sbv1g0abc')))).code).toBe('insufficient-scope');
    expect(await api.eventsGet('primary', 'sbv1g0abc')).toBeNull();
  });

  it('rateLimitExceeded -> backoff honoring Retry-After: 1, then success', async () => {
    const { api, clock } = await makeApi(`${SCOPE}calendar`, { rateLimitNext: 2 });
    const { id } = await api.calendarsInsert('c', 'UTC');
    expect(id).toContain('@group.calendar.google.com');
    expect(clock.delays).toEqual([1000, 1000]);
    expect(fake.state.requests.filter((r) => r.status === 429)).toHaveLength(2);
  });

  it('rateLimitExceeded beyond the attempt cap -> rate-limited', async () => {
    const { api, clock } = await makeApi(`${SCOPE}calendar`, { rateLimitNext: 100 });
    const e = await failure(api.calendarsInsert('c', 'UTC'));
    expect(e).toMatchObject({ code: 'rate-limited', status: 429 });
    expect(clock.delays).toHaveLength(4); // 5 attempts, 4 sleeps
  });

  it('an expired access token -> auth', async () => {
    const { api } = await makeApi();
    fake.advanceClock(2 * 3600_000);
    expect((await failure(api.calendarListGet('primary'))).code).toBe('auth');
  });

  it('a stopped server -> offline', async () => {
    const { api } = await makeApi();
    await fake.close();
    expect((await failure(api.calendarListGet('primary'))).code).toBe('offline');
    fake = await startFakeGoogle({ port: 0 }); // so afterEach has something to close
  });

  it('a hand-edited event (other zone, no description, no overrides) is read without error', async () => {
    const { api } = await makeApi();
    const { id } = await api.calendarsInsert('c', 'UTC');
    await api.eventsInsert(id, bodyFor('sbv1g0abc'));
    const stored = fake.state.calendars.get(id)?.events.get('sbv1g0abc');
    if (!stored) throw new Error('missing');
    Reflect.deleteProperty(stored, 'description');
    stored['start'] = { dateTime: '2026-10-07T19:18:30-07:00', timeZone: 'America/Los_Angeles' };
    stored['end'] = { dateTime: '2026-10-07T19:33:30-07:00', timeZone: 'America/Los_Angeles' };
    stored['reminders'] = { useDefault: false };
    const ev = await api.eventsGet(id, 'sbv1g0abc');
    expect(ev).toMatchObject({ description: '', start: { dateTime: '2026-10-08T02:18:30.000Z', timeZone: 'UTC' }, reminders: { overrides: [] } });
  });
});
