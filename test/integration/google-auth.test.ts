// T-62 integration: PkceRefreshProvider over the real browser adapters
// (BrowserHttp + real fetch, storage over WXT's fakeBrowser), against
//   - the in-process fake Google server (loopback; MSW lets it through) for the
//     whole lifecycle: consent, exchange, Calendar, refresh, invalid_grant, revoke;
//   - MSW on Google's production hostnames for what the fake cannot script
//     (a Calendar that keeps answering 401, transport failures, the error table).
// Ruling R6: nothing here reaches a real Google host. MSW fails any request to
// a non-loopback host that has no handler (test/setup/vitest.setup.ts), and
// the guard below also fails the test if one is attempted.
import { http, HttpResponse } from 'msw';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { browser } from 'wxt/browser';

import { BrowserClock } from '../../src/adapters/browser/clock';
import { BrowserHttp } from '../../src/adapters/browser/http';
import { createStorageAreas } from '../../src/adapters/browser/storage';
import { PkceRefreshProvider, type GoogleClientConfig, type WebAuthFlow } from '../../src/adapters/google/auth-pkce';
import { GoogleCalendarApi } from '../../src/adapters/google/calendar-api';
import { AuthStatusSchema, type GoogleAuthErrorCode } from '../../src/domain/calendar/types';
import { STORAGE_KEYS } from '../../src/domain/storage/schema';
import { CalendarApiError, GoogleAuthError } from '../../src/ports/errors';
import { startFakeGoogle, type FakeGoogle } from '../fakes/fake-google-server/server';
import { FakeAuditLog } from '../fakes/ports/fake-audit-log';
import { mswServer } from '../setup/vitest.setup';

const SCOPE = 'https://www.googleapis.com/auth/calendar.app.created';
const CHROME_REDIRECT = 'https://gjbekijbmjlkdildfknfbcfnhjhohmlh.chromiumapp.org/';
const FF_HASH = '3f855aad165e9bf088575dff75668afa3e901fb1';
const FF_ALLIZOM = `https://${FF_HASH}.extensions.allizom.org/`;
const FF_LOOPBACK = `http://127.0.0.1/mozoauth2/${FF_HASH}`;
const CLIENT_ID = 'cid-int.apps.googleusercontent.com';
const SECRET = 'GOCSPX-integration-secret';
const PROD_TOKEN = 'https://oauth2.googleapis.com/token';
const PROD_REVOKE = 'https://oauth2.googleapis.com/revoke';
const PROD_CAL = 'https://www.googleapis.com/calendar/v3';
const HOUR = 3_600_000;

/** Wall clock that tests can move forward (token expiry), in step with the fake's clock. */
class ShiftClock extends BrowserClock {
  offset = 0;
  override now(): number {
    return Date.now() + this.offset;
  }
}

/**
 * Plays the browser's part in launchWebAuthFlow: loads the authorize URL
 * (the fake's /authorize answers with a 302 to the redirect URI) and returns
 * the redirect it was sent to, optionally tampered with.
 */
class LoopbackWebAuthFlow implements WebAuthFlow {
  readonly launches: Array<{ url: string; interactive: boolean }> = [];
  tamper: ((redirect: URL) => void) | undefined;

  constructor(private readonly redirectUrl: string) {}

  getRedirectURL(): string {
    return this.redirectUrl;
  }

  async launchWebAuthFlow(details: { url: string; interactive: boolean }): Promise<string | undefined> {
    this.launches.push({ ...details });
    const res = await fetch(details.url, { redirect: 'manual' });
    const location = res.headers.get('location');
    if (res.status !== 302 || location === null) throw new Error('Authorization page could not be loaded.');
    const back = new URL(location);
    this.tamper?.(back);
    return back.toString();
  }
}

const produced: unknown[] = [];
const audits: FakeAuditLog[] = [];
const offHost: string[] = [];

let fake: FakeGoogle | undefined;

beforeEach(() => {
  // R6 guard: record any attempt at a real Google host (MSW also refuses unhandled ones).
  mswServer.events.on('request:start', ({ request }) => {
    const host = new URL(request.url).hostname;
    if (host === 'accounts.google.com') offHost.push(request.url);
  });
});

afterEach(async () => {
  mswServer.events.removeAllListeners();
  await fake?.close();
  fake = undefined;
});

interface Rig {
  provider: PkceRefreshProvider;
  identity: LoopbackWebAuthFlow;
  clock: ShiftClock;
  audit: FakeAuditLog;
  badge: boolean[];
  config: { value: GoogleClientConfig | undefined };
  calendar: GoogleCalendarApi;
}

function rig(opts: { base?: string; redirect?: string; config?: GoogleClientConfig } = {}): Rig {
  const clock = new ShiftClock();
  const identity = new LoopbackWebAuthFlow(opts.redirect ?? CHROME_REDIRECT);
  const audit = new FakeAuditLog(clock);
  audits.push(audit);
  const badge: boolean[] = [];
  const config: { value: GoogleClientConfig | undefined } = { value: opts.config ?? { clientId: CLIENT_ID } };
  const httpAdapter = new BrowserHttp({ isOnline: () => true });
  const base = opts.base;
  const provider = new PkceRefreshProvider({
    storage: createStorageAreas(),
    http: httpAdapter,
    clock,
    identity,
    clientConfig: () => config.value,
    badge: {
      set: (on) => {
        badge.push(on);
      },
    },
    audit,
    ...(base === undefined
      ? {}
      : { endpoints: { authorize: `${base}/o/oauth2/v2/auth`, token: `${base}/token`, revoke: `${base}/revoke` } }),
  });
  const calendar = new GoogleCalendarApi({
    http: provider.authorizedHttp(httpAdapter),
    auth: provider,
    clock,
    maxAttempts: 1,
    ...(base === undefined ? {} : { baseUrl: `${base}/calendar/v3` }),
  });
  return { provider, identity, clock, audit, badge, config, calendar };
}

async function fails(p: Promise<unknown>): Promise<GoogleAuthError> {
  try {
    await p;
  } catch (e) {
    produced.push(e);
    expect(e).toBeInstanceOf(GoogleAuthError);
    return e as GoogleAuthError;
  }
  throw new Error('expected a rejection');
}

const local = async () => browser.storage.local.get(null);
const session = async () => browser.storage.session.get(null);
const tokenPosts = () => (fake?.state.requests ?? []).filter((r) => r.method === 'POST' && r.path === '/token');

describe('against the fake Google server', () => {
  it('Chrome: consent → exchange → Calendar → expired token refreshes once → revoke on disconnect', async () => {
    fake = await startFakeGoogle({ port: 0, scenario: { clientId: CLIENT_ID } });
    const r = rig({ base: fake.url });

    const status = AuthStatusSchema.parse(await r.provider.connect());
    expect(status).toMatchObject({ connected: true, provider: 'pkce', grantedScopes: [SCOPE], needsInteraction: false, configured: true });
    expect(r.identity.launches).toHaveLength(1);
    expect(r.identity.launches[0]?.interactive).toBe(true);
    const auth = new URL(r.identity.launches[0]?.url ?? '');
    expect(auth.searchParams.get('redirect_uri')).toBe(CHROME_REDIRECT);
    expect(auth.searchParams.get('code_challenge_method')).toBe('S256');

    // Refresh token in storage.local only; access token in storage.session only.
    const l = await local();
    const s = await session();
    const creds = l[STORAGE_KEYS.google] as { refreshToken: string };
    const access = s[STORAGE_KEYS.googleAccess] as { token: string };
    expect(creds.refreshToken).toMatch(/^1\/\/0fake-/);
    expect(access.token).toMatch(/^ya29\.fake-/);
    expect(JSON.stringify(l)).not.toContain(access.token);
    expect(JSON.stringify(s)).not.toContain(creds.refreshToken);

    // calendar.app.created lets the app create and use its own calendar.
    const { id } = await r.calendar.calendarsInsert('ShopGoodwill Auctions', 'UTC');
    expect(await r.calendar.calendarListGet(id)).toEqual({ id });
    expect(tokenPosts()).toHaveLength(1); // the exchange only

    // Google expires the access token while our cache still trusts it: 401 → one refresh → resend.
    fake.advanceClock(HOUR);
    expect(await r.calendar.calendarListGet(id)).toEqual({ id });
    expect(tokenPosts()).toHaveLength(2);
    const fresh = (await session())[STORAGE_KEYS.googleAccess] as { token: string };
    expect(fresh.token).not.toBe(access.token);

    // Our own expiry: refreshed before use, no 401 round trip.
    r.clock.offset = 2 * HOUR;
    fake.advanceClock(HOUR);
    const before401s = fake.state.requests.filter((q) => q.status === 401).length;
    await r.calendar.calendarListGet(id);
    expect(tokenPosts()).toHaveLength(3);
    expect(fake.state.requests.filter((q) => q.status === 401)).toHaveLength(before401s);

    // Disconnect revokes at Google, then clears both areas.
    await r.provider.disconnect();
    expect(fake.state.revokedCount).toBe(1);
    expect(await local()).not.toHaveProperty(STORAGE_KEYS.google);
    expect(await session()).not.toHaveProperty(STORAGE_KEYS.googleAccess);
    expect(await r.provider.status()).toMatchObject({ connected: false, provider: 'none' });
    expect(r.audit.kinds).toEqual(['google.connect', 'google.disconnect']);
    expect((await fails(r.provider.getAccessToken({ interactive: false }))).code).toBe('needs_interaction');
    expect(r.identity.launches).toHaveLength(1);
  });

  it('Firefox: the loopback redirect works end to end', async () => {
    fake = await startFakeGoogle({ port: 0 });
    const r = rig({ base: fake.url, redirect: FF_ALLIZOM });
    await r.provider.connect();
    expect(new URL(r.identity.launches[0]?.url ?? '').searchParams.get('redirect_uri')).toBe(FF_LOOPBACK);
    await r.calendar.calendarsInsert('ShopGoodwill Auctions', 'UTC');
  });

  it('client_secret is sent only when configured; a client that requires one fails without it', async () => {
    fake = await startFakeGoogle({ port: 0, scenario: { clientSecret: SECRET } });
    const r = rig({ base: fake.url });
    expect((await fails(r.provider.connect())).code).toBe('unauthorized');
    expect(await local()).not.toHaveProperty(STORAGE_KEYS.google);

    r.config.value = { clientId: CLIENT_ID, clientSecret: SECRET };
    await r.provider.connect();
    // The refresh grant reuses the stored secret.
    r.clock.offset = 2 * HOUR;
    fake.advanceClock(2 * HOUR);
    await r.calendar.calendarsInsert('ShopGoodwill Auctions', 'UTC');
    expect(tokenPosts().map((q) => q.status)).toEqual([401, 200, 200]);
  });

  it('a redirect whose state was tampered with is rejected before any exchange', async () => {
    fake = await startFakeGoogle({ port: 0 });
    const r = rig({ base: fake.url });
    r.identity.tamper = (back) => {
      back.searchParams.set('state', 'attacker');
    };
    expect((await fails(r.provider.connect())).code).toBe('unauthorized');
    expect(tokenPosts()).toHaveLength(0);
    expect(await local()).toEqual({});
  });

  it('declined consent is user_cancelled', async () => {
    fake = await startFakeGoogle({ port: 0, scenario: { denyConsent: true } });
    const r = rig({ base: fake.url });
    expect((await fails(r.provider.connect())).code).toBe('user_cancelled');
  });

  it('scope check: a consent screen that withholds the calendar scope stores nothing', async () => {
    fake = await startFakeGoogle({ port: 0, scenario: { grantedScopes: [] } });
    const r = rig({ base: fake.url });
    expect((await fails(r.provider.connect())).code).toBe('insufficient_scope');
    expect(await local()).toEqual({});
    expect(await session()).toEqual({});
  });

  it('invalid_grant in the background: nothing cleared, needsInteraction + badge, no window, the 401 surfaces', async () => {
    fake = await startFakeGoogle({ port: 0 });
    const r = rig({ base: fake.url });
    await r.provider.connect();
    const { id } = await r.calendar.calendarsInsert('ShopGoodwill Auctions', 'UTC');

    fake.setScenario({ invalidGrant: true });
    fake.advanceClock(HOUR); // Google expires the access token
    const before = { local: await local(), session: await session() };

    const e = await r.calendar.calendarListGet(id).catch((x: unknown) => x);
    produced.push(e);
    expect(e).toBeInstanceOf(CalendarApiError);
    expect(e).toMatchObject({ code: 'auth', status: 401 });
    expect(tokenPosts()).toHaveLength(2); // exchange + one refresh

    // The 401 dropped the dead access token; the refresh token is untouched.
    expect(await local()).toEqual(before.local);
    expect(await r.provider.status()).toMatchObject({ connected: true, needsInteraction: true, lastError: 'invalid_grant' });
    expect(r.badge).toEqual([false, true]);
    expect(r.identity.launches).toHaveLength(1);

    // Later background work fails fast, with no request.
    const snapshot = { local: await local(), session: await session() };
    expect((await fails(r.provider.getAccessToken({ interactive: false }))).code).toBe('needs_interaction');
    expect(tokenPosts()).toHaveLength(2);
    expect({ local: await local(), session: await session() }).toEqual(snapshot);

    // A user gesture reconnects.
    fake.setScenario({ invalidGrant: false });
    await r.provider.connect();
    expect(await r.provider.status()).toMatchObject({ connected: true, needsInteraction: false });
    expect(await r.calendar.calendarListGet(id)).toEqual({ id });
    expect(r.badge.at(-1)).toBe(false);
  });
});

describe('against MSW on Google production hostnames', () => {
  async function seedConnected(r: Rig, accessExpiresAt: number): Promise<void> {
    await browser.storage.local.set({
      [STORAGE_KEYS.google]: {
        provider: 'pkce',
        clientId: CLIENT_ID,
        refreshToken: '1//0msw-refresh-token',
        grantedScopes: [SCOPE],
        connectedAt: r.clock.now(),
      },
    });
    await browser.storage.session.set({ [STORAGE_KEYS.googleAccess]: { token: 'ya29.msw-access-1', expiresAt: accessExpiresAt } });
  }

  it('a Calendar that keeps answering 401: one refresh, then CalendarApiError auth surfaces', async () => {
    const hits = { token: 0, calendar: [] as string[] };
    mswServer.use(
      http.post(PROD_TOKEN, async ({ request }) => {
        hits.token += 1;
        const form = new URLSearchParams(await request.text());
        expect(form.get('grant_type')).toBe('refresh_token');
        return HttpResponse.json({ access_token: 'ya29.msw-access-2', expires_in: 3599, scope: SCOPE, token_type: 'Bearer' });
      }),
      http.get(`${PROD_CAL}/users/me/calendarList/:id`, ({ request }) => {
        hits.calendar.push(request.headers.get('authorization') ?? '');
        return HttpResponse.json({ error: { code: 401, message: 'Invalid Credentials', errors: [{ reason: 'authError' }] } }, { status: 401 });
      }),
    );
    const r = rig();
    await seedConnected(r, r.clock.now() + HOUR);

    const e = await r.calendar.calendarListGet('c1').catch((x: unknown) => x);
    produced.push(e);
    expect(e).toBeInstanceOf(CalendarApiError);
    expect(e).toMatchObject({ code: 'auth', status: 401 });
    expect(hits.token).toBe(1);
    expect(hits.calendar).toEqual(['Bearer ya29.msw-access-1', 'Bearer ya29.msw-access-2']);
    expect((await r.provider.status()).lastError).toBe('unauthorized');
  });

  it('revoke failure: storage is still cleared and the failure is reported', async () => {
    mswServer.use(http.post(PROD_REVOKE, () => HttpResponse.error()));
    const r = rig();
    await seedConnected(r, r.clock.now() + HOUR);

    const e = await fails(r.provider.disconnect());
    expect(e.code).toBe('offline');
    expect(e.message).toContain('myaccount.google.com');
    expect(await local()).not.toHaveProperty(STORAGE_KEYS.google);
    expect(await session()).not.toHaveProperty(STORAGE_KEYS.googleAccess);
    expect(await r.provider.status()).toMatchObject({ connected: false, lastError: 'offline' });
    expect(r.audit.entries.map((x) => x.details)).toEqual([{ revoked: false, revokeError: 'offline' }]);
  });

  it('revoke posts the refresh token as a form to the production revoke endpoint', async () => {
    const seen: string[] = [];
    mswServer.use(
      http.post(PROD_REVOKE, async ({ request }) => {
        seen.push(request.headers.get('content-type') ?? '', await request.text());
        return HttpResponse.json({});
      }),
    );
    const r = rig();
    await seedConnected(r, r.clock.now() + HOUR);
    await r.provider.disconnect();
    expect(seen).toEqual(['application/x-www-form-urlencoded', 'token=1%2F%2F0msw-refresh-token']);
    expect(await local()).toEqual({});
  });

  const TABLE: Array<{ name: string; respond: () => Response; code: GoogleAuthErrorCode }> = [
    { name: '400 invalid_grant', respond: () => HttpResponse.json({ error: 'invalid_grant', error_description: 'Bad Request' }, { status: 400 }), code: 'invalid_grant' },
    { name: '400 invalid_request', respond: () => HttpResponse.json({ error: 'invalid_request', error_description: 'client_secret is missing.' }, { status: 400 }), code: 'not_configured' },
    { name: '401 invalid_client', respond: () => HttpResponse.json({ error: 'invalid_client' }, { status: 401 }), code: 'unauthorized' },
    { name: '403 access_denied', respond: () => HttpResponse.json({ error: 'access_denied' }, { status: 403 }), code: 'insufficient_scope' },
    {
      name: '403 rateLimitExceeded',
      respond: () => HttpResponse.json({ error: { code: 403, message: 'm', errors: [{ reason: 'rateLimitExceeded' }] } }, { status: 403 }),
      code: 'rate_limited',
    },
    { name: '429', respond: () => new HttpResponse(null, { status: 429, headers: { 'retry-after': '30' } }), code: 'rate_limited' },
    { name: 'network error', respond: () => HttpResponse.error(), code: 'offline' },
  ];

  it.each(TABLE)('error taxonomy over real fetch: $name → $code', async ({ respond, code }) => {
    let calls = 0;
    mswServer.use(
      http.post(PROD_TOKEN, () => {
        calls += 1;
        return respond();
      }),
    );
    const r = rig();
    await seedConnected(r, r.clock.now() - 1);
    const before = { local: await local(), session: await session() };
    expect((await fails(r.provider.getAccessToken({ interactive: false }))).code).toBe(code);
    expect(calls).toBe(1);
    expect({ local: await local(), session: await session() }).toEqual(before);
    expect(r.identity.launches).toHaveLength(0);
  });
});

// ── R1 and R6 ──────────────────────────────────────────────────────────────

const TOKEN_SHAPES = [/ya29\./, /1\/\/0[A-Za-z0-9_-]/, /4\/0A[A-Za-z0-9_-]/, /GOCSPX-/, /Bearer\s+[A-Za-z0-9._~+/-]{6,}/];

function serialize(value: unknown, depth = 0): string {
  if (depth > 5) return '';
  if (value instanceof Error) {
    const own: Record<string, unknown> = {};
    for (const k of Object.getOwnPropertyNames(value)) own[k] = (value as unknown as Record<string, unknown>)[k];
    let json: string;
    try {
      json = JSON.stringify(own);
    } catch {
      json = '';
    }
    return [value.name, value.message, value.stack ?? '', json, serialize(value.cause, depth + 1)].join('\n');
  }
  return value === undefined ? '' : JSON.stringify(value);
}

function leaks(): string[] {
  const items = [...produced, ...audits.flatMap((a) => a.entries)];
  return items.flatMap((item) => {
    const text = serialize(item);
    return TOKEN_SHAPES.filter((re) => re.test(text)).map((re) => `${String(re)} in ${text.slice(0, 120)}`);
  });
}

afterAll(() => {
  expect(leaks()).toEqual([]);
  expect(offHost).toEqual([]);
});

describe('R1/R6', () => {
  it('no error or audit entry carries a token, and no request went to a real Google host', () => {
    expect(produced.length).toBeGreaterThan(10);
    expect(audits.flatMap((a) => a.entries).length).toBeGreaterThan(3);
    expect(leaks()).toEqual([]);
    expect(offHost).toEqual([]);
  });
});
