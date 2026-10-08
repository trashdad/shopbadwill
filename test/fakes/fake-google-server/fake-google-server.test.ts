// @vitest-environment node
/* eslint-disable @typescript-eslint/no-non-null-assertion, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return, @typescript-eslint/restrict-template-expressions -- test code reads loosely-typed JSON from the fake */
import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { RawCalendarSchema, RawEventSchema, RawEventsListSchema, RawGoogleErrorSchema, RawTokenResponseSchema } from './schemas';
import { startFakeGoogle, type FakeGoogle, type Scenario } from './server';

const APP_CREATED = 'https://www.googleapis.com/auth/calendar.app.created';
const EVENTS = 'https://www.googleapis.com/auth/calendar.events';
// RFC 7636 Appendix B
const RFC_VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
const RFC_CHALLENGE = 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM';
const REDIRECT = 'http://127.0.0.1/cb';
const DAY = 86_400_000;

let fake: FakeGoogle | undefined;
afterEach(async () => {
  await fake?.close();
  fake = undefined;
});
async function start(scenario?: Scenario): Promise<FakeGoogle> {
  fake = await startFakeGoogle({ port: 0, scenario });
  return fake;
}

async function authorize(f: FakeGoogle, challenge: string, scope = APP_CREATED, extra: Record<string, string> = {}) {
  const u = new URL('/authorize', f.url);
  const q = {
    client_id: 'cid', redirect_uri: REDIRECT, response_type: 'code', scope, state: 'st1',
    code_challenge: challenge, code_challenge_method: 'S256', access_type: 'offline', prompt: 'consent', ...extra,
  };
  for (const [k, v] of Object.entries(q)) u.searchParams.set(k, v);
  const res = await fetch(u, { redirect: 'manual' });
  expect(res.status).toBe(302);
  return new URL(res.headers.get('location')!);
}
function form(f: FakeGoogle, path: string, params: Record<string, string>) {
  return fetch(new URL(path, f.url), {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  });
}
async function tokens(f: FakeGoogle, scope = APP_CREATED) {
  const loc = await authorize(f, RFC_CHALLENGE, scope);
  const res = await form(f, '/token', {
    grant_type: 'authorization_code', code: loc.searchParams.get('code')!, code_verifier: RFC_VERIFIER,
    client_id: 'cid', redirect_uri: REDIRECT,
  });
  expect(res.status).toBe(200);
  return RawTokenResponseSchema.parse(await res.json());
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;
function api(f: FakeGoogle, token: string) {
  return async (method: string, path: string, body?: unknown) => {
    const res = await fetch(new URL(`/calendar/v3${path}`, f.url), {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, headers: res.headers, json: (text ? JSON.parse(text) : undefined) as Json };
  };
}
const eventBody = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  summary: 'SGW ends: thing',
  description: 'd',
  start: { dateTime: '2026-10-08T02:18:30.000Z', timeZone: 'UTC' },
  end: { dateTime: '2026-10-08T02:33:30.000Z', timeZone: 'UTC' },
  reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 60 }, { method: 'popup', minutes: 15 }] },
  extendedProperties: { private: { sbwItemId: '1', sbwGen: '0', sbwState: 'open' } },
  ...extra,
});
async function setup(scenario?: Scenario) {
  const f = await start(scenario);
  const t = await tokens(f);
  const call = api(f, t.access_token);
  const cal = await call('POST', '/calendars', { summary: 'ShopGoodwill Auctions', timeZone: 'UTC' });
  expect(cal.status).toBe(200);
  const calId = encodeURIComponent(cal.json['id']);
  return { f, t, call, calId };
}

describe('token endpoint and PKCE', () => {
  it('accepts the RFC 7636 Appendix B verifier/challenge pair', async () => {
    expect(createHash('sha256').update(RFC_VERIFIER).digest('base64url')).toBe(RFC_CHALLENGE);
    const f = await start();
    const t = await tokens(f);
    expect(t.refresh_token).toBeTruthy();
    expect(t.scope).toBe(APP_CREATED);
    expect(t.expires_in).toBeGreaterThan(3000);
  });

  it('rejects a wrong verifier with invalid_grant, and a failed attempt burns the code', async () => {
    const f = await start();
    const loc = await authorize(f, RFC_CHALLENGE);
    const code = loc.searchParams.get('code')!;
    const bad = await form(f, '/token', { grant_type: 'authorization_code', code, code_verifier: 'x'.repeat(43), client_id: 'cid', redirect_uri: REDIRECT });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as Json)['error']).toBe('invalid_grant');
    const good = await form(f, '/token', { grant_type: 'authorization_code', code, code_verifier: RFC_VERIFIER, client_id: 'cid', redirect_uri: REDIRECT });
    expect(((await good.json()) as Json)['error']).toBe('invalid_grant');
  });

  it('echoes state and refuses non-S256 challenges at /authorize', async () => {
    const f = await start();
    const loc = await authorize(f, RFC_CHALLENGE);
    expect(loc.searchParams.get('state')).toBe('st1');
    const plain = await authorize(f, RFC_CHALLENGE, APP_CREATED, { code_challenge_method: 'plain' });
    expect(plain.searchParams.get('error')).toBe('invalid_request');
  });

  it('issues no refresh token without access_type=offline', async () => {
    const f = await start();
    const loc = await authorize(f, RFC_CHALLENGE, APP_CREATED, { access_type: 'online' });
    const res = await form(f, '/token', { grant_type: 'authorization_code', code: loc.searchParams.get('code')!, code_verifier: RFC_VERIFIER, client_id: 'cid', redirect_uri: REDIRECT });
    expect(((await res.json()) as Json)['refresh_token']).toBeUndefined();
  });

  it('refresh grant returns a new access token and no refresh token', async () => {
    const f = await start();
    const t = await tokens(f);
    const res = await form(f, '/token', { grant_type: 'refresh_token', refresh_token: t.refresh_token!, client_id: 'cid' });
    expect(res.status).toBe(200);
    const r = RawTokenResponseSchema.parse(await res.json());
    expect(r.access_token).not.toBe(t.access_token);
    expect(r.refresh_token).toBeUndefined();
  });

  it('enforces client_secret when the scenario sets one', async () => {
    const f = await start({ clientSecret: 's3' });
    const loc = await authorize(f, RFC_CHALLENGE);
    const code = loc.searchParams.get('code')!;
    const res = await form(f, '/token', { grant_type: 'authorization_code', code, code_verifier: RFC_VERIFIER, client_id: 'cid', redirect_uri: REDIRECT });
    expect(res.status).toBe(401);
    expect(((await res.json()) as Json)['error']).toBe('invalid_client');
  });

  it('invalid_grant scenario fails every refresh', async () => {
    const f = await start();
    const t = await tokens(f);
    f.setScenario({ invalidGrant: true });
    const res = await form(f, '/token', { grant_type: 'refresh_token', refresh_token: t.refresh_token!, client_id: 'cid' });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' });
  });

  it('7-day Testing expiry: refresh token dies after 7 days of fake time', async () => {
    const f = await start({ testingMode: true });
    const t = await tokens(f);
    f.advanceClock(7 * DAY - 1000);
    expect((await form(f, '/token', { grant_type: 'refresh_token', refresh_token: t.refresh_token!, client_id: 'cid' })).status).toBe(200);
    f.advanceClock(2000);
    const res = await form(f, '/token', { grant_type: 'refresh_token', refresh_token: t.refresh_token!, client_id: 'cid' });
    expect(((await res.json()) as Json)['error']).toBe('invalid_grant');
  });

  it('without testingMode the refresh token outlives 7 days', async () => {
    const f = await start();
    const t = await tokens(f);
    f.advanceClock(30 * DAY);
    expect((await form(f, '/token', { grant_type: 'refresh_token', refresh_token: t.refresh_token!, client_id: 'cid' })).status).toBe(200);
  });

  it('reports the scopes the user actually granted', async () => {
    const f = await start({ grantedScopes: [EVENTS] });
    const t = await tokens(f, `${APP_CREATED} ${EVENTS}`);
    expect(t.scope).toBe(EVENTS);
  });

  it('consent denial redirects with access_denied', async () => {
    const f = await start({ denyConsent: true });
    expect((await authorize(f, RFC_CHALLENGE)).searchParams.get('error')).toBe('access_denied');
  });
});

describe('revoke', () => {
  it('revoking the refresh token invalidates it and its access tokens', async () => {
    const { f, t, call } = await setup();
    const res = await form(f, '/revoke', { token: t.refresh_token! });
    expect(res.status).toBe(200);
    expect((await call('POST', '/calendars', { summary: 'x' })).status).toBe(401);
    const again = await form(f, '/token', { grant_type: 'refresh_token', refresh_token: t.refresh_token!, client_id: 'cid' });
    expect(((await again.json()) as Json)['error']).toBe('invalid_grant');
    expect(f.state.revokedCount).toBe(1);
  });

  it('unknown token gives 400 invalid_token', async () => {
    const f = await start();
    const res = await form(f, '/revoke', { token: 'nope' });
    expect(res.status).toBe(400);
    expect(((await res.json()) as Json)['error']).toBe('invalid_token');
  });
});

describe('calendar auth and scope enforcement', () => {
  it('401 with a bad or expired access token', async () => {
    const f = await start();
    const t = await tokens(f);
    const bad = await api(f, 'garbage')('POST', '/calendars', { summary: 'x' });
    expect(bad.status).toBe(401);
    RawGoogleErrorSchema.parse(bad.json);
    f.advanceClock(3600 * 1000 + 1);
    expect((await api(f, t.access_token)('POST', '/calendars', { summary: 'x' })).status).toBe(401);
  });

  it('calendar.app.created can use its own calendar but not others', async () => {
    const { f, call, calId } = await setup();
    f.seedCalendar('someone@example.com', 'Other');
    expect((await call('GET', `/users/me/calendarList/${calId}`)).status).toBe(200);
    for (const other of ['primary', encodeURIComponent('someone@example.com')]) {
      const res = await call('POST', `/calendars/${other}/events`, eventBody('abcde'));
      expect(res.status).toBe(403);
      expect(res.json['error'].errors[0].reason).toBe('insufficientPermissions');
      expect(res.json['error'].status).toBe('PERMISSION_DENIED');
    }
    expect((await call('GET', '/users/me/calendarList/primary')).status).toBe(403);
  });

  it('calendar.events alone cannot insert calendars but can write the primary calendar', async () => {
    const f = await start();
    const t = await tokens(f, EVENTS);
    const call = api(f, t.access_token);
    expect((await call('POST', '/calendars', { summary: 'x' })).status).toBe(403);
    expect((await call('POST', '/calendars/primary/events', eventBody('abcde'))).status).toBe(200);
  });
});

describe('calendars', () => {
  it('calendars.insert returns a calendar resource; calendarList.get finds it; unknown is 404', async () => {
    const { call, calId } = await setup();
    const got = await call('GET', `/users/me/calendarList/${calId}`);
    expect(got.json['summary']).toBe('ShopGoodwill Auctions');
    const ins = await call('POST', '/calendars', { summary: 'Other', timeZone: 'America/Los_Angeles' });
    RawCalendarSchema.parse(ins.json);
    const missing = await call('GET', `/users/me/calendarList/${encodeURIComponent('zzz@group.calendar.google.com')}`);
    expect(missing.status).toBe(404);
    expect(missing.json['error'].errors[0].reason).toBe('notFound');
  });

  it('calendars.insert without summary is 400', async () => {
    const { call } = await setup();
    expect((await call('POST', '/calendars', {})).status).toBe(400);
  });
});

describe('events', () => {
  it('insert returns an event resource; get returns it', async () => {
    const { call, calId } = await setup();
    const ins = await call('POST', `/calendars/${calId}/events`, eventBody('sbv1g0'));
    expect(ins.status).toBe(200);
    const ev = RawEventSchema.parse(ins.json);
    expect(ev.status).toBe('confirmed');
    expect(ev.extendedProperties?.private?.['sbwItemId']).toBe('1');
    const got = await call('GET', `/calendars/${calId}/events/sbv1g0`);
    expect(got.json['summary']).toBe('SGW ends: thing');
  });

  it('409 on duplicate id', async () => {
    const { call, calId } = await setup();
    await call('POST', `/calendars/${calId}/events`, eventBody('sbv1g0'));
    const dup = await call('POST', `/calendars/${calId}/events`, eventBody('sbv1g0'));
    expect(dup.status).toBe(409);
    expect(dup.json['error'].errors[0].reason).toBe('duplicate');
    expect(dup.json['error'].message).toBe('The requested identifier already exists.');
  });

  it('rejects invalid ids and bad reminders', async () => {
    const { call, calId } = await setup();
    for (const id of ['sgw123', 'abcd', 'ABCDE', 'sbv-1']) {
      const r = await call('POST', `/calendars/${calId}/events`, eventBody(id));
      expect(r.status, id).toBe(400);
      expect(r.json['error'].errors[0].reason).toBe('invalid');
    }
    const six = Array.from({ length: 6 }, (_, i) => ({ method: 'popup', minutes: i + 1 }));
    const r = await call('POST', `/calendars/${calId}/events`, eventBody('abcde', { reminders: { useDefault: false, overrides: six } }));
    expect(r.status).toBe(400);
    const badMethod = await call('POST', `/calendars/${calId}/events`, eventBody('abcdf', { reminders: { useDefault: false, overrides: [{ method: 'sms', minutes: 5 }] } }));
    expect(badMethod.status).toBe(400);
  });

  it('rejects dateTime with neither an offset nor a timeZone', async () => {
    const { call, calId } = await setup();
    const r = await call('POST', `/calendars/${calId}/events`, eventBody('abcde', { start: { dateTime: '2026-10-08T02:18:30' }, end: { dateTime: '2026-10-08T02:33:30', timeZone: 'UTC' } }));
    expect(r.status).toBe(400);
  });

  it('delete then get returns status cancelled; re-insert is still 409; second delete is 410', async () => {
    const { call, calId } = await setup();
    await call('POST', `/calendars/${calId}/events`, eventBody('sbv1g0'));
    expect((await call('DELETE', `/calendars/${calId}/events/sbv1g0`)).status).toBe(204);
    const got = await call('GET', `/calendars/${calId}/events/sbv1g0`);
    expect(got.status).toBe(200);
    expect(got.json['status']).toBe('cancelled');
    expect((await call('POST', `/calendars/${calId}/events`, eventBody('sbv1g0'))).status).toBe(409);
    const again = await call('DELETE', `/calendars/${calId}/events/sbv1g0`);
    expect(again.status).toBe(410);
    expect(again.json['error'].errors[0].reason).toBe('deleted');
    expect((await call('DELETE', `/calendars/${calId}/events/nothere`)).status).toBe(404);
    expect((await call('GET', `/calendars/${calId}/events/nothere`)).status).toBe(404);
  });

  it('patch merges nested objects and replaces arrays', async () => {
    const { call, calId } = await setup();
    await call('POST', `/calendars/${calId}/events`, eventBody('sbv1g0'));
    const p = await call('PATCH', `/calendars/${calId}/events/sbv1g0`, {
      summary: 'WON: thing',
      reminders: { useDefault: false, overrides: [] },
      extendedProperties: { private: { sbwState: 'won' } },
    });
    expect(p.status).toBe(200);
    expect(p.json['summary']).toBe('WON: thing');
    expect(p.json['description']).toBe('d');
    expect(p.json['reminders'].overrides).toEqual([]);
    expect(p.json['extendedProperties'].private).toEqual({ sbwItemId: '1', sbwGen: '0', sbwState: 'won' });
    expect(p.json['sequence']).toBe(1);
  });

  it('patch on a missing event is 404', async () => {
    const { call, calId } = await setup();
    expect((await call('PATCH', `/calendars/${calId}/events/nothere`, { summary: 'x' })).status).toBe(404);
  });

  it('S-5 revive:true: patching a cancelled event with status confirmed revives it', async () => {
    const { call, calId } = await setup({ revive: true });
    await call('POST', `/calendars/${calId}/events`, eventBody('sbv1g0'));
    await call('DELETE', `/calendars/${calId}/events/sbv1g0`);
    const p = await call('PATCH', `/calendars/${calId}/events/sbv1g0`, { status: 'confirmed', summary: 'back' });
    expect(p.status).toBe(200);
    expect(p.json['status']).toBe('confirmed');
    expect((await call('GET', `/calendars/${calId}/events/sbv1g0`)).json['summary']).toBe('back');
  });

  it('S-5 revive:false: patching a cancelled event fails with 404 and it stays cancelled', async () => {
    const { call, calId } = await setup({ revive: false });
    await call('POST', `/calendars/${calId}/events`, eventBody('sbv1g0'));
    await call('DELETE', `/calendars/${calId}/events/sbv1g0`);
    const p = await call('PATCH', `/calendars/${calId}/events/sbv1g0`, { status: 'confirmed' });
    expect(p.status).toBe(404);
    expect((await call('GET', `/calendars/${calId}/events/sbv1g0`)).json['status']).toBe('cancelled');
  });

  it('revive defaults to true and can be flipped at runtime', async () => {
    const { f, call, calId } = await setup();
    expect(f.scenario.revive).toBe(true);
    await call('POST', `/calendars/${calId}/events`, eventBody('sbv1g0'));
    await call('DELETE', `/calendars/${calId}/events/sbv1g0`);
    f.setScenario({ revive: false });
    expect((await call('PATCH', `/calendars/${calId}/events/sbv1g0`, { status: 'confirmed' })).status).toBe(404);
  });
});

describe('events.list', () => {
  it('filters by privateExtendedProperty, ANDs repeats, hides cancelled unless showDeleted', async () => {
    const { call, calId } = await setup();
    const mk = (id: string, item: string, state: string) =>
      call('POST', `/calendars/${calId}/events`, eventBody(id, { extendedProperties: { private: { sbwItemId: item, sbwState: state } } }));
    await mk('aaaaa', '1', 'open');
    await mk('bbbbb', '1', 'won');
    await mk('ccccc', '2', 'open');
    const q = (s: string) => call('GET', `/calendars/${calId}/events?${s}`);
    const one = await q('privateExtendedProperty=sbwItemId%3D1');
    const list = RawEventsListSchema.parse(one.json);
    expect(list.items.map((e) => e.id).sort()).toEqual(['aaaaa', 'bbbbb']);
    const both = await q('privateExtendedProperty=sbwItemId%3D1&privateExtendedProperty=sbwState%3Dwon');
    expect(both.json['items'].map((e: Json) => e['id'])).toEqual(['bbbbb']);
    await call('DELETE', `/calendars/${calId}/events/aaaaa`);
    expect((await q('privateExtendedProperty=sbwItemId%3D1')).json['items']).toHaveLength(1);
    expect((await q('privateExtendedProperty=sbwItemId%3D1&showDeleted=true')).json['items']).toHaveLength(2);
    expect((await q('privateExtendedProperty=sbwItemId')).status).toBe(400);
  });

  it('paginates with maxResults and pageToken', async () => {
    const { call, calId } = await setup();
    for (const id of ['aaaaa', 'bbbbb', 'ccccc']) await call('POST', `/calendars/${calId}/events`, eventBody(id));
    const p1 = await call('GET', `/calendars/${calId}/events?maxResults=2`);
    expect(p1.json['items']).toHaveLength(2);
    const p2 = await call('GET', `/calendars/${calId}/events?maxResults=2&pageToken=${p1.json['nextPageToken']}`);
    expect(p2.json['items']).toHaveLength(1);
    expect(p2.json['nextPageToken']).toBeUndefined();
  });
});

describe('429 scenario', () => {
  it('rateLimitNext: N calendar calls get 429 with Retry-After then recover', async () => {
    const { f, call, calId } = await setup();
    f.setScenario({ rateLimitNext: 2 });
    for (let i = 0; i < 2; i++) {
      const r = await call('GET', `/calendars/${calId}/events`);
      expect(r.status).toBe(429);
      expect(r.headers.get('retry-after')).toBe('1');
      expect(r.json['error'].errors[0].reason).toBe('rateLimitExceeded');
    }
    expect((await call('GET', `/calendars/${calId}/events`)).status).toBe(200);
  });
});

describe('server plumbing', () => {
  it('records requests, binds 127.0.0.1, 404s unknown routes in Google error shape', async () => {
    const { f, call } = await setup();
    expect(f.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const r = await call('GET', '/nope');
    expect(r.status).toBe(404);
    RawGoogleErrorSchema.parse(r.json);
    expect(f.state.requests.some((x) => x.method === 'POST' && x.path === '/token')).toBe(true);
  });

  it('admin routes drive the scenario and clock over HTTP (for the CLI process)', async () => {
    const f = await start();
    const t = await tokens(f);
    await fetch(new URL('/__admin/scenario', f.url), { method: 'POST', body: JSON.stringify({ invalidGrant: true }) });
    const res = await form(f, '/token', { grant_type: 'refresh_token', refresh_token: t.refresh_token!, client_id: 'cid' });
    expect(((await res.json()) as Json)['error']).toBe('invalid_grant');
    const adv = await fetch(new URL('/__admin/advance-clock', f.url), { method: 'POST', body: JSON.stringify({ ms: 5000 }) });
    expect(adv.status).toBe(200);
  });
});
