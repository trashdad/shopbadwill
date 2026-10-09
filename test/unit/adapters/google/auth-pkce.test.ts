// T-62: PkceRefreshProvider and the PKCE helpers. No network: FakeHttp stands
// in for Google's token and revoke endpoints, a scripted fake stands in for
// `identity.launchWebAuthFlow`. Every token value a test mints is registered,
// and the last test checks that none of them (or anything shaped like a Google
// token) reached an error, an audit entry or the console (ruling R1).
import fc from 'fast-check';
import { afterAll, beforeAll, describe, expect, expectTypeOf, it, vi, type MockInstance } from 'vitest';

import {
  CALENDAR_SCOPE,
  GOOGLE_OAUTH_ENDPOINTS,
  PkceRefreshProvider,
  classifyTokenFailure,
  redirectUriFor,
  type GoogleClientConfig,
  type PkceRefreshProviderDeps,
  type WebAuthFlow,
} from '../../../../src/adapters/google/auth-pkce';
import { GoogleCalendarApi } from '../../../../src/adapters/google/calendar-api';
import {
  base64UrlEncode,
  challengeS256,
  createState,
  createVerifier,
  isValidVerifier,
  verifierFromBytes,
} from '../../../../src/adapters/google/pkce';
import { AuthStatusSchema, type GoogleAuthErrorCode } from '../../../../src/domain/calendar/types';
import { STORAGE_KEYS } from '../../../../src/domain/storage/schema';
import { CalendarApiError, GoogleAuthError, HttpNetworkError, HttpTimeoutError } from '../../../../src/ports/errors';
import type { HttpRequest } from '../../../../src/ports/http';
import { FakeAuditLog } from '../../../fakes/ports/fake-audit-log';
import { FakeClock } from '../../../fakes/ports/fake-clock';
import { FakeHttp, type HttpStep } from '../../../fakes/ports/fake-http';
import { FakeStorageAreas } from '../../../fakes/ports/fake-storage';

const T0 = 1_760_000_000_000;
const DAY = 86_400_000;
const AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN = 'https://oauth2.googleapis.com/token';
const REVOKE = 'https://oauth2.googleapis.com/revoke';
const CAL = 'https://www.googleapis.com/calendar/v3';
const SCOPE = 'https://www.googleapis.com/auth/calendar.app.created';
const CHROME_REDIRECT = 'https://gjbekijbmjlkdildfknfbcfnhjhohmlh.chromiumapp.org/';
const FF_HASH = '3f855aad165e9bf088575dff75668afa3e901fb1';
const FF_ALLIZOM = `https://${FF_HASH}.extensions.allizom.org/`;
const FF_LOOPBACK = `http://127.0.0.1/mozoauth2/${FF_HASH}`;
const CLIENT_ID = 'cid-123.apps.googleusercontent.com';
const SECRET = 'GOCSPX-unit-secret-value';

// ── token values: every one is registered for the R1 leak check ────────────

const SECRETS = new Set<string>([SECRET]);
let minted = 0;
function mint(prefix: string): string {
  minted += 1;
  const value = `${prefix}${String(minted)}q${Math.random().toString(36).slice(2, 10)}`;
  SECRETS.add(value);
  return value;
}
const newAccess = () => mint('ya29.unit-');
const newRefresh = () => mint('1//0unit-');
const newCode = () => mint('4/0Aunit-');

// ── fakes ──────────────────────────────────────────────────────────────────

type Respond = (authUrl: URL) => string | undefined | Error;

class FakeIdentity implements WebAuthFlow {
  readonly calls: Array<{ url: string; interactive: boolean }> = [];
  redirectUrl = CHROME_REDIRECT;
  /** Default: Google's success redirect, echoing state, with a fresh code and the granted scope. */
  respond: Respond = (u) => {
    const back = new URL(u.searchParams.get('redirect_uri') ?? '');
    back.searchParams.set('state', u.searchParams.get('state') ?? '');
    back.searchParams.set('code', newCode());
    back.searchParams.set('scope', SCOPE);
    return back.toString();
  };

  getRedirectURL(): string {
    return this.redirectUrl;
  }

  launchWebAuthFlow(details: { url: string; interactive: boolean }): Promise<string | undefined> {
    this.calls.push({ ...details });
    const r = this.respond(new URL(details.url));
    return r instanceof Error ? Promise.reject(r) : Promise.resolve(r);
  }
}

class FakeBadge {
  readonly states: boolean[] = [];
  set(on: boolean): void {
    this.states.push(on);
  }
}

interface World {
  clock: FakeClock;
  http: FakeHttp;
  storage: FakeStorageAreas;
  identity: FakeIdentity;
  audit: FakeAuditLog;
  badge: FakeBadge;
  config: { value: GoogleClientConfig | undefined };
  provider: PkceRefreshProvider;
}

const worlds: World[] = [];
const produced: unknown[] = [];

function world(
  opts: { config?: GoogleClientConfig | null; redirect?: string; configFromStorage?: boolean; extraDeps?: Record<string, unknown> } = {},
): World {
  const clock = new FakeClock(T0);
  const http = new FakeHttp(clock);
  const storage = new FakeStorageAreas();
  const identity = new FakeIdentity();
  if (opts.redirect !== undefined) identity.redirectUrl = opts.redirect;
  const audit = new FakeAuditLog(clock);
  const badge = new FakeBadge();
  const config = { value: opts.config === null ? undefined : (opts.config ?? { clientId: CLIENT_ID }) };
  // T-70's shape (controller ruling 2): the client id and secret the user saved, read back from storage.
  const fromStorage = async (): Promise<GoogleClientConfig | undefined> => {
    const rec = await storage.local.get<{ clientId?: string; clientSecret?: string }>(STORAGE_KEYS.google);
    if (rec?.clientId === undefined) return undefined;
    return rec.clientSecret === undefined ? { clientId: rec.clientId } : { clientId: rec.clientId, clientSecret: rec.clientSecret };
  };
  const provider = new PkceRefreshProvider({
    storage,
    http,
    clock,
    identity,
    clientConfig: opts.configFromStorage === true ? fromStorage : () => config.value,
    badge,
    audit,
    ...(opts.extraDeps as unknown as Partial<PkceRefreshProviderDeps> | undefined),
  });
  const w = { clock, http, storage, identity, audit, badge, config, provider };
  worlds.push(w);
  return w;
}

/** Awaits a rejection, records it for the leak check, and returns it as a GoogleAuthError. */
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

const json = (body: unknown, status = 200): HttpStep => ({ status, bodyText: JSON.stringify(body) });
const oauthErr = (status: number, error: string, description?: string): HttpStep =>
  json(description === undefined ? { error } : { error, error_description: description }, status);
const googleErr = (status: number, reason: string): HttpStep =>
  json({ error: { code: status, message: 'm', errors: [{ message: 'm', domain: 'usageLimits', reason }] } }, status);

function tokenOk(
  over: { access?: string; refresh?: string | null; scope?: string | null; expiresIn?: number; refreshExpiresIn?: number } = {},
): HttpStep {
  const body: Record<string, unknown> = {
    access_token: over.access ?? newAccess(),
    expires_in: over.expiresIn ?? 3599,
    token_type: 'Bearer',
  };
  if (over.refreshExpiresIn !== undefined) body['refresh_token_expires_in'] = over.refreshExpiresIn;
  if (over.scope !== null) body['scope'] = over.scope ?? SCOPE;
  if (over.refresh !== null && over.refresh !== undefined) body['refresh_token'] = over.refresh;
  return json(body);
}

/** Parsed form bodies of the requests sent to `url`. */
function forms(w: World, url: string): Array<Record<string, string>> {
  return w.http.requests.filter((r) => r.url === url).map((r) => Object.fromEntries(new URLSearchParams(r.body ?? '')));
}

function seedConnected(w: World, over: { refresh?: string; access?: { token: string; expiresAt: number }; secret?: string } = {}) {
  const refresh = over.refresh ?? newRefresh();
  w.storage.local.seed({
    [STORAGE_KEYS.google]: {
      provider: 'pkce',
      clientId: CLIENT_ID,
      ...(over.secret === undefined ? {} : { clientSecret: over.secret }),
      refreshToken: refresh,
      grantedScopes: [SCOPE],
      connectedAt: T0 - 3 * DAY,
    },
  });
  if (over.access) w.storage.session.seed({ [STORAGE_KEYS.googleAccess]: over.access });
  return refresh;
}

/** Everything both storage areas hold. */
const snapshot = (w: World) => ({ local: w.storage.local.dump(), session: w.storage.session.dump() });

/** After a disconnect (ruling 5): no token, scope or expiry anywhere; the client config kept. */
function expectTokensCleared(w: World, secret?: string): void {
  expect(w.storage.session.dump()).toEqual({});
  expect(w.storage.local.dump()).toEqual({
    [STORAGE_KEYS.google]: {
      provider: 'pkce',
      clientId: CLIENT_ID,
      ...(secret === undefined ? {} : { clientSecret: secret }),
      grantedScopes: [],
      connectedAt: T0 - 3 * DAY,
    },
  });
}

// ── console spies (R1: the provider never logs a token) ────────────────────

const consoleSpies: MockInstance[] = [];
beforeAll(() => {
  for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const) consoleSpies.push(vi.spyOn(console, m));
});

// ═══════════════════════════════════════════════════════════════════════════

describe('PKCE helpers (RFC 7636)', () => {
  it('reproduces the RFC 7636 Appendix B example', async () => {
    const octets = new Uint8Array([
      116, 24, 223, 180, 151, 153, 224, 37, 79, 250, 96, 125, 216, 173, 187, 186, 22, 212, 37, 77, 105, 214, 191, 240, 91,
      88, 5, 88, 83, 132, 141, 121,
    ]);
    const verifier = verifierFromBytes(octets);
    expect(verifier).toBe('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk');
    expect(await challengeS256(verifier)).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');
  });

  it('base64url-encodes without padding', () => {
    expect(base64UrlEncode(new Uint8Array([0xfb, 0xff]))).toBe('-_8');
    expect(base64UrlEncode(new Uint8Array([]))).toBe('');
  });

  it('draws the verifier from crypto.getRandomValues: 43 chars of the unreserved set', () => {
    const spy = vi.spyOn(globalThis.crypto, 'getRandomValues');
    const v = createVerifier();
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
    expect(v).toMatch(/^[A-Za-z0-9\-._~]{43,128}$/);
    expect(v).toHaveLength(43);
    expect(isValidVerifier(v)).toBe(true);
    expect(createVerifier()).not.toBe(v);
  });

  it('any 32..96 random bytes give a 43..128-char verifier (property)', () => {
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 32, maxLength: 96 }), (bytes) => {
        const v = verifierFromBytes(bytes);
        return v.length >= 43 && v.length <= 128 && /^[A-Za-z0-9\-._~]+$/.test(v) && isValidVerifier(v);
      }),
    );
  });

  it('rejects verifiers outside RFC 7636 §4.1', async () => {
    expect(() => verifierFromBytes(new Uint8Array(31))).toThrow(RangeError);
    expect(() => verifierFromBytes(new Uint8Array(97))).toThrow(RangeError);
    expect(isValidVerifier('a'.repeat(42))).toBe(false);
    expect(isValidVerifier('a'.repeat(129))).toBe(false);
    expect(isValidVerifier(`${'a'.repeat(42)}+`)).toBe(false);
    await expect(challengeS256('short')).rejects.toThrow(RangeError);
  });

  it('takes no random source: crypto.getRandomValues only (type-level, checked by tsc)', () => {
    expectTypeOf(createVerifier).parameters.toEqualTypeOf<[]>();
    expectTypeOf(createState).parameters.toEqualTypeOf<[]>();
    expectTypeOf<PkceRefreshProviderDeps>().not.toHaveProperty('random');
  });

  it('draws state from crypto.getRandomValues (at least 128 bits, URL-safe, never repeated)', () => {
    const spy = vi.spyOn(globalThis.crypto, 'getRandomValues');
    const states = new Set(Array.from({ length: 50 }, () => createState()));
    expect(spy).toHaveBeenCalledTimes(50);
    spy.mockRestore();
    expect(states.size).toBe(50);
    for (const s of states) expect(s).toMatch(/^[A-Za-z0-9_-]{22,}$/);
  });
});

describe('redirect URI per browser', () => {
  it('Chrome: the chromiumapp.org URL from getRedirectURL(), unchanged', () => {
    expect(redirectUriFor(CHROME_REDIRECT)).toBe(CHROME_REDIRECT);
  });

  it('Firefox: the loopback form of the allizom hash', () => {
    expect(redirectUriFor(FF_ALLIZOM)).toBe(FF_LOOPBACK);
  });

  it('anything else is not configured', () => {
    for (const bad of ['', 'https://evil.example/', 'http://gjbekijbmjlkdildfknfbcfnhjhohmlh.chromiumapp.org/', 'https://x.extensions.allizom.org.evil/']) {
      expect(() => redirectUriFor(bad)).toThrow(GoogleAuthError);
    }
  });
});

describe('connect()', () => {
  it('opens the S256 PKCE consent URL interactively, with offline access, prompt=consent and the one scope', async () => {
    const w = world();
    w.http.on(TOKEN, tokenOk({ refresh: newRefresh() }));
    await w.provider.connect();

    expect(w.identity.calls).toHaveLength(1);
    const call = w.identity.calls[0];
    expect(call?.interactive).toBe(true);
    const u = new URL(call?.url ?? '');
    expect(`${u.origin}${u.pathname}`).toBe(AUTH);
    const p = Object.fromEntries(u.searchParams);
    expect(p).toMatchObject({
      client_id: CLIENT_ID,
      redirect_uri: CHROME_REDIRECT,
      response_type: 'code',
      scope: SCOPE,
      code_challenge_method: 'S256',
      access_type: 'offline',
      prompt: 'consent',
    });
    expect(p['state']).toMatch(/^[A-Za-z0-9_-]{22,}$/);

    // The challenge is S256 of the verifier sent with the exchange.
    const [exchange] = forms(w, TOKEN);
    expect(exchange?.['code_verifier']).toMatch(/^[A-Za-z0-9\-._~]{43,128}$/);
    expect(await challengeS256(exchange?.['code_verifier'] ?? '')).toBe(p['code_challenge']);
  });

  it('exchanges the code at the token endpoint (form POST, no cookies, no secret unless configured)', async () => {
    const w = world();
    w.http.on(TOKEN, tokenOk({ refresh: newRefresh() }));
    await w.provider.connect();

    const req = w.http.requests[0];
    expect(req?.url).toBe(TOKEN);
    expect(req?.method).toBe('POST');
    expect(req?.credentials).toBe('omit');
    expect(req?.headers?.['content-type']).toBe('application/x-www-form-urlencoded');
    const f = forms(w, TOKEN)[0] ?? {};
    expect(Object.keys(f).sort()).toEqual(['client_id', 'code', 'code_verifier', 'grant_type', 'redirect_uri']);
    expect(f).toMatchObject({ grant_type: 'authorization_code', client_id: CLIENT_ID, redirect_uri: CHROME_REDIRECT });
    expect(f['code']).toMatch(/^4\/0Aunit-/);
  });

  it('sends client_secret only when one is configured', async () => {
    const w = world({ config: { clientId: CLIENT_ID, clientSecret: SECRET } });
    w.http.on(TOKEN, tokenOk({ refresh: newRefresh() }));
    await w.provider.connect();
    expect(forms(w, TOKEN)[0]?.['client_secret']).toBe(SECRET);

    const blank = world({ config: { clientId: CLIENT_ID, clientSecret: '   ' } });
    blank.http.on(TOKEN, tokenOk({ refresh: newRefresh() }));
    await blank.provider.connect();
    expect(forms(blank, TOKEN)[0]).not.toHaveProperty('client_secret');
  });

  it('stores the refresh token in storage.local only and the access token in storage.session only', async () => {
    const w = world();
    const refresh = newRefresh();
    const access = newAccess();
    w.http.on(TOKEN, tokenOk({ refresh, access, expiresIn: 3599 }));
    const status = await w.provider.connect();

    const { local, session } = snapshot(w);
    expect(Object.keys(local)).toEqual([STORAGE_KEYS.google]);
    expect(local[STORAGE_KEYS.google]).toEqual({
      provider: 'pkce',
      clientId: CLIENT_ID,
      refreshToken: refresh,
      grantedScopes: [SCOPE],
      connectedAt: T0,
    });
    expect(Object.keys(session)).toEqual([STORAGE_KEYS.googleAccess]);
    expect(session[STORAGE_KEYS.googleAccess]).toEqual({ token: access, expiresAt: T0 + 3_599_000 });
    expect(JSON.stringify(local)).not.toContain(access);
    expect(JSON.stringify(session)).not.toContain(refresh);

    expect(AuthStatusSchema.parse(status)).toEqual({
      connected: true,
      provider: 'pkce',
      grantedScopes: [SCOPE],
      refreshTokenAgeDays: 0,
      needsInteraction: false,
      configured: true,
    });
    expect(await w.provider.getAccessToken({ interactive: false })).toBe(access);
    expect(w.audit.kinds).toEqual(['google.connect']);
    expect(w.badge.states).toEqual([false]);
  });

  it('keeps the configured secret with the credentials, for refreshing', async () => {
    const w = world({ config: { clientId: CLIENT_ID, clientSecret: SECRET } });
    w.http.on(TOKEN, tokenOk({ refresh: newRefresh() }));
    await w.provider.connect();
    expect(w.storage.local.dump()[STORAGE_KEYS.google]).toMatchObject({ clientSecret: SECRET });
  });

  it('Firefox: uses the loopback redirect in both the consent URL and the exchange', async () => {
    const w = world({ redirect: FF_ALLIZOM });
    w.http.on(TOKEN, tokenOk({ refresh: newRefresh() }));
    await w.provider.connect();
    expect(new URL(w.identity.calls[0]?.url ?? '').searchParams.get('redirect_uri')).toBe(FF_LOOPBACK);
    expect(forms(w, TOKEN)[0]?.['redirect_uri']).toBe(FF_LOOPBACK);
  });

  it('rejects a state mismatch: no exchange, nothing stored', async () => {
    const w = world();
    w.http.on(TOKEN, tokenOk({ refresh: newRefresh() }));
    const cases: Respond[] = [
      () => `${CHROME_REDIRECT}?state=forged&code=${encodeURIComponent(newCode())}&scope=${encodeURIComponent(SCOPE)}`,
      () => `${CHROME_REDIRECT}?code=${encodeURIComponent(newCode())}&scope=${encodeURIComponent(SCOPE)}`,
      (u) => `${CHROME_REDIRECT}?state=${u.searchParams.get('state') ?? ''}x&code=${encodeURIComponent(newCode())}`,
      () => `${CHROME_REDIRECT}?state=forged&error=access_denied`,
    ];
    for (const respond of cases) {
      w.identity.respond = respond;
      const e = await fails(w.provider.connect());
      expect(e.code).toBe('unauthorized');
      expect(e.message).toMatch(/state/i);
    }
    expect(w.http.requests).toHaveLength(0);
    expect(snapshot(w)).toEqual({ local: {}, session: {} });
    expect((await w.provider.status()).lastError).toBe('unauthorized');
  });

  it('rejects an answer that came back to any other address, before reading its code', async () => {
    const w = world();
    w.http.on(TOKEN, tokenOk({ refresh: newRefresh() }));
    const elsewhere = [
      'https://evil.example/cb',
      'https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/',
      'http://gjbekijbmjlkdildfknfbcfnhjhohmlh.chromiumapp.org/',
      'https://gjbekijbmjlkdildfknfbcfnhjhohmlh.chromiumapp.org.evil.example/',
      'https://gjbekijbmjlkdildfknfbcfnhjhohmlh.chromiumapp.org.evil.com/',
      'https://gjbekijbmjlkdildfknfbcfnhjhohmlh.chromiumapp.org:8443/',
      'https://gjbekijbmjlkdildfknfbcfnhjhohmlh.chromiumapp.org@evil.example/',
    ];
    for (const base of elsewhere) {
      w.identity.respond = (u) => `${base}?state=${u.searchParams.get('state') ?? ''}&code=c`;
      const e = await fails(w.provider.connect());
      expect(e.code, base).toBe('unauthorized');
      expect(e.message).toMatch(/address/);
    }
    expect(w.http.requests).toHaveLength(0);
    expect(snapshot(w)).toEqual({ local: {}, session: {} });
  });

  it('Firefox: accepts the answer at the loopback or at getRedirectURL(), nowhere else', async () => {
    for (const base of [FF_LOOPBACK, FF_ALLIZOM]) {
      const w = world({ redirect: FF_ALLIZOM });
      w.http.on(TOKEN, tokenOk({ refresh: newRefresh() }));
      w.identity.respond = (u) => `${base}?state=${u.searchParams.get('state') ?? ''}&code=${encodeURIComponent(newCode())}`;
      expect((await w.provider.connect()).connected).toBe(true);
    }
    const w = world({ redirect: FF_ALLIZOM });
    w.identity.respond = (u) => `http://127.0.0.1/mozoauth2/${'0'.repeat(40)}?state=${u.searchParams.get('state') ?? ''}&code=c`;
    expect((await fails(w.provider.connect())).code).toBe('unauthorized');
    expect(w.http.requests).toHaveLength(0);
  });

  it('Firefox: the loopback matches on a path boundary, so `<hash>evil` is another address', async () => {
    const w = world({ redirect: FF_ALLIZOM });
    w.http.on(TOKEN, tokenOk({ refresh: newRefresh() }));
    for (const suffix of ['evil', '0', '.evil', '-x']) {
      w.identity.respond = (u) => `${FF_LOOPBACK}${suffix}?state=${u.searchParams.get('state') ?? ''}&code=c`;
      const e = await fails(w.provider.connect());
      expect(e.code, suffix).toBe('unauthorized');
      expect(e.message).toMatch(/address/);
    }
    expect(w.http.requests).toHaveLength(0);
    // A sub-path of the loopback is still the loopback.
    w.identity.respond = (u) => `${FF_LOOPBACK}/?state=${u.searchParams.get('state') ?? ''}&code=${encodeURIComponent(newCode())}`;
    expect((await w.provider.connect()).connected).toBe(true);
  });

  it('reads code and state from the query only, never from the fragment', async () => {
    const w = world();
    const real = newCode();
    const planted = newCode();
    w.http.on(TOKEN, tokenOk({ refresh: newRefresh() }));
    w.identity.respond = (u) => `${CHROME_REDIRECT}?state=${u.searchParams.get('state') ?? ''}#code=${encodeURIComponent(planted)}`;
    expect((await fails(w.provider.connect())).code).toBe('unauthorized');
    w.identity.respond = (u) => `${CHROME_REDIRECT}#state=${u.searchParams.get('state') ?? ''}&code=${encodeURIComponent(planted)}`;
    expect((await fails(w.provider.connect())).code).toBe('unauthorized');
    expect(w.http.requests).toHaveLength(0);
    w.identity.respond = (u) =>
      `${CHROME_REDIRECT}?state=${u.searchParams.get('state') ?? ''}&code=${encodeURIComponent(real)}#code=${encodeURIComponent(planted)}`;
    await w.provider.connect();
    expect(forms(w, TOKEN).map((f) => f['code'])).toEqual([real]);
  });

  it('randomness is not injectable: a random source passed in deps is ignored', async () => {
    const w = world({ extraDeps: { random: (n: number) => new Uint8Array(n) } });
    w.http.on(TOKEN, tokenOk({ refresh: newRefresh() }));
    const spy = vi.spyOn(globalThis.crypto, 'getRandomValues');
    await w.provider.connect();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
    const zeros = base64UrlEncode(new Uint8Array(32));
    expect(new URL(w.identity.calls[0]?.url ?? '').searchParams.get('state')).not.toBe(zeros);
    expect(forms(w, TOKEN)[0]?.['code_verifier']).not.toBe(zeros);
  });

  it('uses a fresh state and verifier for every attempt', async () => {
    const w = world();
    w.http.on(TOKEN, tokenOk({ refresh: newRefresh() }));
    await w.provider.connect();
    await w.provider.connect();
    const [a, b] = w.identity.calls.map((c) => new URL(c.url).searchParams);
    expect(a?.get('state')).not.toBe(b?.get('state'));
    expect(a?.get('code_challenge')).not.toBe(b?.get('code_challenge'));
    const [fa, fb] = forms(w, TOKEN);
    expect(fa?.['code_verifier']).not.toBe(fb?.['code_verifier']);
  });

  it('a cancelled or denied consent is user_cancelled and stores nothing', async () => {
    const w = world();
    w.identity.respond = (u) => `${CHROME_REDIRECT}?state=${u.searchParams.get('state') ?? ''}&error=access_denied`;
    expect((await fails(w.provider.connect())).code).toBe('user_cancelled');
    w.identity.respond = () => new Error('The user did not approve access.');
    expect((await fails(w.provider.connect())).code).toBe('user_cancelled');
    w.identity.respond = () => new Error('User cancelled or denied access.');
    expect((await fails(w.provider.connect())).code).toBe('user_cancelled');
    w.identity.respond = () => undefined;
    expect((await fails(w.provider.connect())).code).toBe('user_cancelled');
    w.identity.respond = () => new Error('Authorization page could not be loaded.');
    expect((await fails(w.provider.connect())).code).toBe('offline');
    expect(w.http.requests).toHaveLength(0);
    expect(snapshot(w)).toEqual({ local: {}, session: {} });
  });

  it('an error redirect other than access_denied is not_configured (e.g. redirect_uri_mismatch)', async () => {
    const w = world();
    w.identity.respond = (u) => `${CHROME_REDIRECT}?state=${u.searchParams.get('state') ?? ''}&error=redirect_uri_mismatch`;
    expect((await fails(w.provider.connect())).code).toBe('not_configured');
    w.identity.respond = (u) => `${CHROME_REDIRECT}?state=${u.searchParams.get('state') ?? ''}`;
    expect((await fails(w.provider.connect())).code).toBe('unauthorized');
    expect(w.http.requests).toHaveLength(0);
  });

  it('scope check: a grant without calendar.app.created is insufficient_scope, revoked, and stores nothing', async () => {
    const w = world();
    const refresh = newRefresh();
    w.http.on(TOKEN, tokenOk({ refresh, scope: '' }));
    w.http.on(REVOKE, json({}));
    const e = await fails(w.provider.connect());
    expect(e.code).toBe('insufficient_scope');
    expect(forms(w, REVOKE)).toEqual([{ token: refresh }]);
    expect(snapshot(w)).toEqual({ local: {}, session: {} });
    expect(await w.provider.status()).toMatchObject({ connected: false, lastError: 'insufficient_scope' });
  });

  it('exact scope: a broader grant is revoked and refused, and nothing is stored', async () => {
    const broader = [
      `${SCOPE} https://www.googleapis.com/auth/calendar`,
      `openid ${SCOPE}`,
      'https://www.googleapis.com/auth/calendar',
    ];
    for (const scope of broader) {
      const w = world();
      const refresh = newRefresh();
      w.http.on(TOKEN, tokenOk({ refresh, scope }));
      w.http.on(REVOKE, json({}));
      const e = await fails(w.provider.connect());
      expect(e.code, scope).toBe('insufficient_scope');
      expect(forms(w, REVOKE)).toEqual([{ token: refresh }]);
      expect(snapshot(w)).toEqual({ local: {}, session: {} });
    }
    // The same scope listed twice is still exactly the one scope.
    const w = world();
    w.http.on(TOKEN, tokenOk({ refresh: newRefresh(), scope: `${SCOPE} ${SCOPE}` }));
    expect((await w.provider.connect()).connected).toBe(true);
  });

  it('the revoke of a refused grant is best effort: its failure does not change the error', async () => {
    const w = world();
    w.http.on(TOKEN, tokenOk({ refresh: newRefresh(), scope: `${SCOPE} openid` }));
    w.http.on(REVOKE, { error: new HttpNetworkError('Failed to fetch') });
    expect((await fails(w.provider.connect())).code).toBe('insufficient_scope');
    expect(forms(w, REVOKE)).toHaveLength(1);
    expect(snapshot(w)).toEqual({ local: {}, session: {} });
  });

  it('scope check: falls back to the redirect scope when the token response has none', async () => {
    const w = world();
    w.http.on(TOKEN, tokenOk({ refresh: newRefresh(), scope: null }));
    expect((await w.provider.connect()).grantedScopes).toEqual([SCOPE]);
  });

  it('a token response without a refresh token is refused and its access token revoked', async () => {
    const w = world();
    const access = newAccess();
    w.http.on(TOKEN, tokenOk({ access, refresh: null }));
    w.http.on(REVOKE, json({}));
    expect((await fails(w.provider.connect())).code).toBe('needs_interaction');
    expect(forms(w, REVOKE)).toEqual([{ token: access }]);
    expect(snapshot(w)).toEqual({ local: {}, session: {} });
  });

  it('not configured: no client id → not_configured, no consent window', async () => {
    const w = world({ config: null });
    expect((await fails(w.provider.connect())).code).toBe('not_configured');
    w.config.value = { clientId: '  ' };
    expect((await fails(w.provider.connect())).code).toBe('not_configured');
    expect(w.identity.calls).toHaveLength(0);
  });

  it('an unsupported redirect URL is not_configured, with no consent window', async () => {
    const w = world({ redirect: 'https://example.test/' });
    expect((await fails(w.provider.connect())).code).toBe('not_configured');
    expect(w.identity.calls).toHaveLength(0);
  });

  it('concurrent connect() calls share one consent window', async () => {
    const w = world();
    w.http.on(TOKEN, tokenOk({ refresh: newRefresh() }));
    const [a, b] = await Promise.all([w.provider.connect(), w.provider.connect()]);
    expect(w.identity.calls).toHaveLength(1);
    expect(a).toEqual(b);
  });
});

describe('getAccessToken()', () => {
  it('returns a cached access token that is not near expiry, with no network', async () => {
    const w = world();
    const access = newAccess();
    seedConnected(w, { access: { token: access, expiresAt: T0 + 10 * 60_000 } });
    expect(await w.provider.getAccessToken({ interactive: false })).toBe(access);
    expect(w.http.requests).toHaveLength(0);
  });

  it('refreshes an expired or nearly expired token with the refresh grant (no UI)', async () => {
    const w = world();
    const refresh = seedConnected(w, { access: { token: newAccess(), expiresAt: T0 + 30_000 } });
    const fresh = newAccess();
    w.http.on(TOKEN, tokenOk({ access: fresh, expiresIn: 3599 }));

    expect(await w.provider.getAccessToken({ interactive: false })).toBe(fresh);
    expect(forms(w, TOKEN)).toEqual([{ grant_type: 'refresh_token', refresh_token: refresh, client_id: CLIENT_ID }]);
    expect(w.storage.session.dump()[STORAGE_KEYS.googleAccess]).toEqual({ token: fresh, expiresAt: T0 + 3_599_000 });
    // The refresh token is unchanged when Google does not rotate it.
    expect(w.storage.local.dump()[STORAGE_KEYS.google]).toMatchObject({ refreshToken: refresh });
    expect(w.identity.calls).toHaveLength(0);
  });

  it('the refresh grant takes the client id and secret from clientConfig, not from a stored copy', async () => {
    const w = world({ config: { clientId: CLIENT_ID, clientSecret: SECRET } });
    seedConnected(w, { secret: 'GOCSPX-stale-stored-copy' });
    w.http.on(TOKEN, tokenOk());
    await w.provider.getAccessToken({ interactive: false });
    expect(forms(w, TOKEN)[0]).toMatchObject({ client_id: CLIENT_ID, client_secret: SECRET });

    const plain = world();
    seedConnected(plain, { secret: 'GOCSPX-stale-stored-copy' });
    plain.http.on(TOKEN, tokenOk());
    await plain.provider.getAccessToken({ interactive: false });
    expect(forms(plain, TOKEN)[0]).not.toHaveProperty('client_secret');
  });

  it('with no client config, a stored grant cannot refresh: not_configured, no request', async () => {
    const w = world({ config: null });
    seedConnected(w);
    expect((await fails(w.provider.getAccessToken({ interactive: false }))).code).toBe('not_configured');
    expect(w.http.requests).toHaveLength(0);
  });

  it('a grant made with another client id needs a reconnect, with no request', async () => {
    const w = world({ config: { clientId: 'other-client.apps.googleusercontent.com' } });
    seedConnected(w);
    expect((await fails(w.provider.getAccessToken({ interactive: false }))).code).toBe('needs_interaction');
    expect(w.http.requests).toHaveLength(0);
  });

  it('a 401 or setup error from the token endpoint is remembered until the config changes', async () => {
    const cases: Array<[HttpStep, GoogleAuthErrorCode]> = [
      [oauthErr(401, 'invalid_client'), 'unauthorized'],
      [oauthErr(400, 'invalid_request', 'client_secret is missing.'), 'not_configured'],
    ];
    for (const [step, code] of cases) {
      const w = world();
      seedConnected(w);
      w.http.on(TOKEN, step);
      expect((await fails(w.provider.getAccessToken({ interactive: false }))).code).toBe(code);
      expect((await fails(w.provider.getAccessToken({ interactive: false }))).code).toBe(code);
      expect((await fails(w.provider.getAccessToken({ interactive: false }))).code).toBe(code);
      expect(forms(w, TOKEN)).toHaveLength(1);
      expect(w.identity.calls).toHaveLength(0);
      // The user fixes the client secret: the next background call tries again.
      w.config.value = { clientId: CLIENT_ID, clientSecret: SECRET };
      w.http.on(TOKEN, tokenOk());
      await w.provider.getAccessToken({ interactive: false });
      expect(forms(w, TOKEN)).toHaveLength(2);
    }
  });

  it('connect lifts a remembered token-endpoint refusal', async () => {
    const w = world();
    seedConnected(w);
    w.http.on(TOKEN, oauthErr(401, 'invalid_client'), tokenOk({ refresh: newRefresh() }), tokenOk());
    await fails(w.provider.getAccessToken({ interactive: false }));
    await w.provider.connect();
    w.clock.advance(2 * 3_600_000);
    await w.provider.getAccessToken({ interactive: false });
    expect(forms(w, TOKEN).map((f) => f['grant_type'])).toEqual(['refresh_token', 'authorization_code', 'refresh_token']);
  });

  it('transient failures are not remembered', async () => {
    const w = world();
    seedConnected(w);
    w.http.on(TOKEN, { error: new HttpNetworkError('Failed to fetch') }, googleErr(429, 'rateLimitExceeded'), { status: 503, bodyText: '' }, tokenOk());
    for (let i = 0; i < 3; i++) await fails(w.provider.getAccessToken({ interactive: false }));
    await w.provider.getAccessToken({ interactive: false });
    expect(forms(w, TOKEN)).toHaveLength(4);
  });

  it('stores a rotated refresh token in storage.local', async () => {
    const w = world();
    seedConnected(w);
    const rotated = newRefresh();
    w.http.on(TOKEN, tokenOk({ refresh: rotated }));
    await w.provider.getAccessToken({ interactive: false });
    expect(w.storage.local.dump()[STORAGE_KEYS.google]).toMatchObject({ refreshToken: rotated, connectedAt: T0 - 3 * DAY });
  });

  it('concurrent callers share one refresh', async () => {
    const w = world();
    seedConnected(w);
    const fresh = newAccess();
    w.http.on(TOKEN, tokenOk({ access: fresh }));
    const tokens = await Promise.all([1, 2, 3].map(() => w.provider.getAccessToken({ interactive: false })));
    expect(tokens).toEqual([fresh, fresh, fresh]);
    expect(forms(w, TOKEN)).toHaveLength(1);
  });

  it('interactive:false never calls launchWebAuthFlow, in any state', async () => {
    // Not configured, not connected.
    const a = world({ config: null });
    expect((await fails(a.provider.getAccessToken({ interactive: false }))).code).toBe('not_configured');
    // Configured, not connected.
    const b = world();
    expect((await fails(b.provider.getAccessToken({ interactive: false }))).code).toBe('needs_interaction');
    // Connected, refresh refused, then flagged.
    const c = world();
    seedConnected(c);
    c.http.on(TOKEN, oauthErr(400, 'invalid_grant', 'Token has been expired or revoked.'));
    expect((await fails(c.provider.getAccessToken({ interactive: false }))).code).toBe('invalid_grant');
    expect((await fails(c.provider.getAccessToken({ interactive: false }))).code).toBe('needs_interaction');
    // Connected, refresh fails for other reasons.
    const d = world();
    seedConnected(d);
    d.http.on(TOKEN, { error: new HttpNetworkError('Failed to fetch') }, googleErr(429, 'rateLimitExceeded'), oauthErr(400, 'invalid_scope'));
    for (let i = 0; i < 3; i++) await fails(d.provider.getAccessToken({ interactive: false }));

    for (const w of [a, b, c, d]) expect(w.identity.calls).toHaveLength(0);
  });

  it('invalid_grant clears nothing but sets needsInteraction, the badge and an audit entry', async () => {
    const w = world();
    seedConnected(w, { access: { token: newAccess(), expiresAt: T0 - 1 } });
    w.http.on(TOKEN, oauthErr(400, 'invalid_grant', 'Token has been expired or revoked.'));
    const before = snapshot(w);

    const e = await fails(w.provider.getAccessToken({ interactive: false }));
    expect(e.code).toBe('invalid_grant');
    expect(snapshot(w)).toEqual(before);

    const status = AuthStatusSchema.parse(await w.provider.status());
    expect(status).toMatchObject({ connected: true, provider: 'pkce', needsInteraction: true, lastError: 'invalid_grant' });
    expect(w.badge.states).toEqual([true]);
    expect(w.audit.entries.map((x) => [x.actor, x.kind, x.details])).toEqual([
      ['calendar', 'google.needsInteraction', { error: 'invalid_grant' }],
    ]);

    // Flagged: later background calls fail fast, with no request and no repeat badge or audit.
    expect((await fails(w.provider.getAccessToken({ interactive: false }))).code).toBe('needs_interaction');
    expect(forms(w, TOKEN)).toHaveLength(1);
    expect(w.badge.states).toEqual([true]);
    expect(w.audit.kinds).toEqual(['google.needsInteraction']);
    expect(snapshot(w)).toEqual(before);
  });

  it('a failing badge or audit log never breaks auth', async () => {
    const w = world();
    seedConnected(w);
    w.badge.set = () => {
      throw new Error('badge unavailable');
    };
    w.audit.append = () => Promise.reject(new Error('audit unavailable'));
    w.http.on(TOKEN, oauthErr(400, 'invalid_grant'));
    expect((await fails(w.provider.getAccessToken({ interactive: false }))).code).toBe('invalid_grant');
    expect(await w.provider.status()).toMatchObject({ needsInteraction: true, lastError: 'invalid_grant' });
  });

  it('interactive:true after invalid_grant reconnects through the consent window and clears the flag', async () => {
    const w = world();
    seedConnected(w);
    const fresh = newAccess();
    w.http.on(TOKEN, oauthErr(400, 'invalid_grant'), tokenOk({ access: fresh, refresh: newRefresh() }));
    await fails(w.provider.getAccessToken({ interactive: false }));

    expect(await w.provider.getAccessToken({ interactive: true })).toBe(fresh);
    expect(w.identity.calls).toHaveLength(1);
    expect(await w.provider.status()).toMatchObject({ connected: true, needsInteraction: false });
    expect((await w.provider.status()).lastError).toBeUndefined();
    expect(w.badge.states).toEqual([true, false]);
  });

  it('interactive:true when never connected runs the consent flow', async () => {
    const w = world();
    const access = newAccess();
    w.http.on(TOKEN, tokenOk({ access, refresh: newRefresh() }));
    expect(await w.provider.getAccessToken({ interactive: true })).toBe(access);
    expect(w.identity.calls).toHaveLength(1);
  });

  it('scope check on refresh: a grant that lost calendar.app.created needs interaction', async () => {
    const w = world();
    seedConnected(w);
    const before = snapshot(w);
    w.http.on(TOKEN, tokenOk({ scope: '' }));
    expect((await fails(w.provider.getAccessToken({ interactive: false }))).code).toBe('insufficient_scope');
    expect(snapshot(w)).toEqual(before);
    expect(forms(w, REVOKE)).toHaveLength(0);
    expect(await w.provider.status()).toMatchObject({ needsInteraction: true, lastError: 'insufficient_scope' });
  });

  it('exact scope on refresh: a broader grant is revoked and refused, and nothing is stored', async () => {
    const w = world();
    const refresh = seedConnected(w);
    const before = snapshot(w);
    w.http.on(TOKEN, tokenOk({ scope: `${SCOPE} https://www.googleapis.com/auth/calendar`, refresh: newRefresh() }));
    w.http.on(REVOKE, json({}));
    expect((await fails(w.provider.getAccessToken({ interactive: false }))).code).toBe('insufficient_scope');
    expect(forms(w, REVOKE)).toEqual([{ token: refresh }]);
    expect(snapshot(w)).toEqual(before);
    expect(await w.provider.status()).toMatchObject({ needsInteraction: true, lastError: 'insufficient_scope' });
    expect(w.identity.calls).toHaveLength(0);
  });

  it('a credentials record of another provider is not a PKCE connection', async () => {
    const w = world();
    w.storage.local.seed({
      [STORAGE_KEYS.google]: { provider: 'chrome-identity', clientId: CLIENT_ID, grantedScopes: [SCOPE], connectedAt: T0 },
    });
    expect((await fails(w.provider.getAccessToken({ interactive: false }))).code).toBe('needs_interaction');
    expect(await w.provider.status()).toMatchObject({ connected: false, provider: 'none' });
  });
});

describe('401 from Calendar → one refresh, then the error surfaces', () => {
  function connectedWithCalendar() {
    const w = world();
    const first = newAccess();
    seedConnected(w, { access: { token: first, expiresAt: T0 + 30 * 60_000 } });
    const api = new GoogleCalendarApi({ http: w.provider.authorizedHttp(w.http), auth: w.provider, clock: w.clock, maxAttempts: 1 });
    return { w, first, api };
  }
  const calendarRequests = (w: World) => w.http.requests.filter((r) => r.url.startsWith(CAL));
  const bearer = (r: HttpRequest | undefined) => r?.headers?.['authorization'];
  const unauthorized = googleErr(401, 'authError');

  it('a 401 refreshes once and resends once with the new token', async () => {
    const { w, first, api } = connectedWithCalendar();
    const second = newAccess();
    w.http.on(TOKEN, tokenOk({ access: second }));
    w.http.on(`${CAL}/users/me/calendarList/`, unauthorized, json({ id: 'c1' }));

    expect(await api.calendarListGet('c1')).toEqual({ id: 'c1' });
    expect(forms(w, TOKEN)).toHaveLength(1);
    expect(calendarRequests(w).map(bearer)).toEqual([`Bearer ${first}`, `Bearer ${second}`]);
    expect(await w.provider.getAccessToken({ interactive: false })).toBe(second);
  });

  it('a second 401 surfaces (CalendarApiError auth) after exactly one refresh', async () => {
    const { w, api } = connectedWithCalendar();
    w.http.on(TOKEN, tokenOk());
    w.http.on(`${CAL}/users/me/calendarList/`, unauthorized);

    const e = await api.calendarListGet('c1').catch((x: unknown) => x);
    produced.push(e);
    expect(e).toBeInstanceOf(CalendarApiError);
    expect(e).toMatchObject({ code: 'auth', status: 401 });
    expect(forms(w, TOKEN)).toHaveLength(1);
    expect(calendarRequests(w)).toHaveLength(2);
    expect((await w.provider.status()).lastError).toBe('unauthorized');
    expect(w.identity.calls).toHaveLength(0);
  });

  it('when the refresh itself fails, the original 401 surfaces without a resend', async () => {
    const { w, api } = connectedWithCalendar();
    w.http.on(TOKEN, oauthErr(400, 'invalid_grant'));
    w.http.on(`${CAL}/users/me/calendarList/`, unauthorized);

    const e = await api.calendarListGet('c1').catch((x: unknown) => x);
    produced.push(e);
    expect(e).toMatchObject({ code: 'auth', status: 401 });
    expect(calendarRequests(w)).toHaveLength(1);
    expect(await w.provider.status()).toMatchObject({ needsInteraction: true, lastError: 'invalid_grant' });
  });

  it('non-401 answers and requests without a bearer pass through untouched', async () => {
    const { w } = connectedWithCalendar();
    const http = w.provider.authorizedHttp(w.http);
    w.http.on(`${CAL}/x`, googleErr(403, 'insufficientPermissions'));
    w.http.on(`${CAL}/nobearer`, unauthorized);
    const base = { method: 'GET', timeoutMs: 1000, credentials: 'omit' } as const;
    expect((await http.send({ ...base, url: `${CAL}/x`, headers: { authorization: 'Bearer abc' } })).status).toBe(403);
    expect((await http.send({ ...base, url: `${CAL}/nobearer` })).status).toBe(401);
    expect(forms(w, TOKEN)).toHaveLength(0);
    expect(w.http.requests).toHaveLength(2);
  });

  it('a 401 for a token that was already replaced does not drop the newer one', async () => {
    const { w } = connectedWithCalendar();
    const http = w.provider.authorizedHttp(w.http);
    const current = (w.storage.session.dump()[STORAGE_KEYS.googleAccess] as { token: string }).token;
    w.http.on(`${CAL}/y`, unauthorized, json({}));
    const res = await http.send({ url: `${CAL}/y`, method: 'GET', timeoutMs: 1000, credentials: 'omit', headers: { Authorization: 'Bearer stale-one' } });
    expect(res.status).toBe(200);
    expect(forms(w, TOKEN)).toHaveLength(0);
    // The resend keeps the caller's header spelling.
    expect(calendarRequests(w)[1]?.headers).toEqual({ Authorization: `Bearer ${current}` });
  });
});

describe('disconnect()', () => {
  it('revokes the refresh token at the revoke endpoint, then clears storage', async () => {
    const w = world();
    const refresh = seedConnected(w, { access: { token: newAccess(), expiresAt: T0 + 60 * 60_000 } });
    let heldAtRevoke: unknown;
    w.http.on(REVOKE, () => {
      heldAtRevoke = w.storage.local.dump()[STORAGE_KEYS.google];
      return json({});
    });

    await w.provider.disconnect();
    const req = w.http.requests[0];
    expect(req).toMatchObject({ url: REVOKE, method: 'POST', credentials: 'omit' });
    expect(req?.headers?.['content-type']).toBe('application/x-www-form-urlencoded');
    expect(forms(w, REVOKE)).toEqual([{ token: refresh }]);
    expect(heldAtRevoke).toMatchObject({ refreshToken: refresh });
    expectTokensCleared(w);
    expect(AuthStatusSchema.parse(await w.provider.status())).toEqual({
      connected: false,
      provider: 'none',
      grantedScopes: [],
      needsInteraction: false,
      configured: true,
    });
    expect(w.audit.entries.map((x) => [x.kind, x.details])).toEqual([['google.disconnect', { revoked: true }]]);
  });

  it('a token Google already considers invalid counts as revoked', async () => {
    const w = world();
    seedConnected(w);
    w.http.on(REVOKE, oauthErr(400, 'invalid_token', 'Token expired or revoked'));
    await w.provider.disconnect();
    expectTokensCleared(w);
    expect((await w.provider.status()).lastError).toBeUndefined();
  });

  it('when the revoke fails, storage is still cleared and the failure is reported', async () => {
    const w = world();
    seedConnected(w, { access: { token: newAccess(), expiresAt: T0 + 60 * 60_000 } });
    w.http.on(REVOKE, { error: new HttpNetworkError('Failed to fetch') });

    const e = await fails(w.provider.disconnect());
    expect(e.code).toBe('offline');
    expect(e.message).toMatch(/myaccount\.google\.com/);
    expectTokensCleared(w);
    expect(await w.provider.status()).toMatchObject({ connected: false, lastError: 'offline' });
    expect(w.audit.entries.map((x) => [x.kind, x.details])).toEqual([['google.disconnect', { revoked: false, revokeError: 'offline' }]]);
  });

  it('with nothing to revoke it sends nothing and still clears both areas', async () => {
    const w = world();
    w.storage.session.seed({ [STORAGE_KEYS.googleAccess]: { token: newAccess(), expiresAt: T0 + 60_000 } });
    await w.provider.disconnect();
    expect(w.http.requests).toHaveLength(0);
    expect(snapshot(w)).toEqual({ local: {}, session: {} });
  });

  it('clears a needsInteraction flag and its badge', async () => {
    const w = world();
    seedConnected(w);
    w.http.on(TOKEN, oauthErr(400, 'invalid_grant'));
    w.http.on(REVOKE, json({}));
    await fails(w.provider.getAccessToken({ interactive: false }));
    await w.provider.disconnect();
    expect(await w.provider.status()).toMatchObject({ connected: false, needsInteraction: false });
    expect(w.badge.states).toEqual([true, false]);
  });

  it('a refresh still in flight when disconnect() clears storage writes nothing back', async () => {
    const w = world();
    seedConnected(w);
    w.http.on(TOKEN, { ...tokenOk({ refresh: newRefresh() }), latencyMs: 100 });
    w.http.on(REVOKE, json({}));

    const pending = w.provider.getAccessToken({ interactive: false });
    await w.provider.disconnect();
    w.clock.advance(100);
    expect((await fails(pending)).code).toBe('needs_interaction');
    expectTokensCleared(w);
  });

  it('keeps the client config (T-70 stored settings): a reconnect works without re-entering it', async () => {
    const w = world({ configFromStorage: true });
    seedConnected(w, { secret: SECRET, access: { token: newAccess(), expiresAt: T0 + 60 * 60_000 } });
    w.http.on(REVOKE, json({}));
    await w.provider.disconnect();
    expectTokensCleared(w, SECRET);
    expect(await w.provider.status()).toMatchObject({ connected: false, configured: true, grantedScopes: [] });

    const refresh = newRefresh();
    w.http.on(TOKEN, tokenOk({ refresh }));
    expect(await w.provider.connect()).toMatchObject({ connected: true, grantedScopes: [SCOPE] });
    expect(forms(w, TOKEN)[0]).toMatchObject({ grant_type: 'authorization_code', client_id: CLIENT_ID, client_secret: SECRET });
    expect(w.storage.local.dump()[STORAGE_KEYS.google]).toMatchObject({ clientId: CLIENT_ID, clientSecret: SECRET, refreshToken: refresh });
  });

  it('drops grant data that is not client config (account), and an invalid record entirely', async () => {
    const w = world();
    w.storage.local.seed({
      [STORAGE_KEYS.google]: {
        provider: 'pkce',
        clientId: CLIENT_ID,
        refreshToken: newRefresh(),
        grantedScopes: [SCOPE],
        connectedAt: T0 - 3 * DAY,
        account: 'someone@example.test',
      },
    });
    w.http.on(REVOKE, json({}));
    await w.provider.disconnect();
    expectTokensCleared(w);

    const bad = world();
    bad.storage.local.seed({ [STORAGE_KEYS.google]: { provider: 'pkce', refreshToken: newRefresh() } });
    await bad.provider.disconnect();
    expect(snapshot(bad)).toEqual({ local: {}, session: {} });
  });
});

describe('error taxonomy (token endpoint)', () => {
  const TABLE: Array<[string, HttpStep, GoogleAuthErrorCode, boolean]> = [
    ['400 invalid_grant', oauthErr(400, 'invalid_grant', 'Bad Request'), 'invalid_grant', true],
    ['400 invalid_scope', oauthErr(400, 'invalid_scope'), 'insufficient_scope', true],
    ['400 invalid_request (client_secret is missing)', oauthErr(400, 'invalid_request', 'client_secret is missing.'), 'not_configured', false],
    ['400 not JSON', { status: 400, bodyText: '<html>Bad Request</html>' }, 'not_configured', false],
    ['401 invalid_client', oauthErr(401, 'invalid_client', 'Unauthorized'), 'unauthorized', false],
    ['401 unauthorized_client', oauthErr(401, 'unauthorized_client'), 'unauthorized', false],
    ['403 access_denied', oauthErr(403, 'access_denied'), 'insufficient_scope', true],
    ['403 rateLimitExceeded', googleErr(403, 'rateLimitExceeded'), 'rate_limited', false],
    ['403 userRateLimitExceeded', googleErr(403, 'userRateLimitExceeded'), 'rate_limited', false],
    ['403 quotaExceeded', googleErr(403, 'quotaExceeded'), 'rate_limited', false],
    ['429', { status: 429, bodyText: '' }, 'rate_limited', false],
    ['429 with a Google body', googleErr(429, 'rateLimitExceeded'), 'rate_limited', false],
    ['500', { status: 500, bodyText: '' }, 'offline', false],
    ['503', googleErr(503, 'backendError'), 'offline', false],
    ['network failure', { error: new HttpNetworkError('Failed to fetch') }, 'offline', false],
    ['timeout', { error: new HttpTimeoutError(15_000) }, 'offline', false],
    ['200 that is not JSON', { status: 200, bodyText: '<html>captive portal</html>' }, 'offline', false],
    ['200 without an access token', json({ token_type: 'Bearer', expires_in: 3599 }), 'offline', false],
  ];

  it.each(TABLE.map(([name, step, code, needsInteraction]) => ({ name, step, code, needsInteraction })))(
    '$name → $code',
    async ({ step, code, needsInteraction }) => {
    const w = world();
    seedConnected(w);
    w.http.on(TOKEN, step);
    const e = await fails(w.provider.getAccessToken({ interactive: false }));
    expect(e.code).toBe(code);
    expect(await w.provider.status()).toMatchObject({ lastError: code, needsInteraction });
    expect(w.identity.calls).toHaveLength(0);
    },
  );

  it('the same mapping applies to the code exchange in connect()', async () => {
    for (const [, step, code] of TABLE) {
      const w = world();
      w.http.on(TOKEN, step);
      expect((await fails(w.provider.connect())).code).toBe(code);
      expect(snapshot(w)).toEqual({ local: {}, session: {} });
    }
  });

  it('classifyTokenFailure is the pure form of the table', () => {
    expect(classifyTokenFailure(400, JSON.stringify({ error: 'invalid_grant' }))).toBe('invalid_grant');
    expect(classifyTokenFailure(401, '')).toBe('unauthorized');
    expect(classifyTokenFailure(403, '')).toBe('insufficient_scope');
    expect(classifyTokenFailure(429, '')).toBe('rate_limited');
    expect(classifyTokenFailure(502, '')).toBe('offline');
    expect(classifyTokenFailure(404, '')).toBe('not_configured');
  });

  it('error messages carry the status and the OAuth error code only', async () => {
    const w = world();
    seedConnected(w);
    w.http.on(TOKEN, oauthErr(400, 'invalid_request', 'client_secret is missing. secret=GOCSPX-oops'));
    const e = await fails(w.provider.getAccessToken({ interactive: false }));
    expect(e.message).toContain('400');
    expect(e.message).toContain('invalid_request');
    expect(e.message).not.toContain('GOCSPX');
    expect(e.message).not.toContain('client_secret is missing');
  });
});

describe('status()', () => {
  it('not configured and not connected', async () => {
    const w = world({ config: null });
    expect(AuthStatusSchema.parse(await w.provider.status())).toEqual({
      connected: false,
      provider: 'none',
      grantedScopes: [],
      needsInteraction: false,
      configured: false,
    });
  });

  it('connected: provider, scopes and the refresh-token age in whole days', async () => {
    const w = world();
    seedConnected(w);
    w.clock.advance(DAY / 2);
    expect(AuthStatusSchema.parse(await w.provider.status())).toEqual({
      connected: true,
      provider: 'pkce',
      grantedScopes: [SCOPE],
      refreshTokenAgeDays: 3,
      needsInteraction: false,
      configured: true,
    });
  });

  it('configured follows clientConfig only (ruling 2), even with a stored connection', async () => {
    const w = world({ config: null });
    seedConnected(w);
    expect(await w.provider.status()).toMatchObject({ connected: true, configured: false });
  });

  it('surfaces refresh_token_expires_in as refreshTokenExpiresAt (connect and refresh)', async () => {
    const w = world();
    w.http.on(TOKEN, tokenOk({ refresh: newRefresh(), refreshExpiresIn: 604_799 }), tokenOk({ refreshExpiresIn: 518_400 }));
    expect(await w.provider.connect()).toMatchObject({ refreshTokenExpiresAt: T0 + 604_799_000 });
    w.clock.advance(DAY);
    expect(await w.provider.status()).toMatchObject({ refreshTokenExpiresAt: T0 + 604_799_000 });
    await w.provider.getAccessToken({ interactive: false });
    expect(forms(w, TOKEN)).toHaveLength(2);
    expect(await w.provider.status()).toMatchObject({ refreshTokenExpiresAt: T0 + DAY + 518_400_000 });

    w.http.on(REVOKE, json({}));
    await w.provider.disconnect();
    expect(await w.provider.status()).not.toHaveProperty('refreshTokenExpiresAt');
  });

  it('without refresh_token_expires_in, status() has no expiry', async () => {
    const w = world();
    w.http.on(TOKEN, tokenOk({ refresh: newRefresh() }));
    expect(await w.provider.connect()).not.toHaveProperty('refreshTokenExpiresAt');
  });

  it('an invalid stored record is ignored (not connected), never thrown', async () => {
    const w = world();
    w.storage.local.seed({ [STORAGE_KEYS.google]: { provider: 'pkce', refreshToken: 42 } });
    w.storage.session.seed({ [STORAGE_KEYS.googleAccess]: { token: '' } });
    expect(await w.provider.status()).toMatchObject({ connected: false });
    expect((await fails(w.provider.getAccessToken({ interactive: false }))).code).toBe('needs_interaction');
  });

  it('the default endpoints are Google production URLs', () => {
    expect(GOOGLE_OAUTH_ENDPOINTS).toEqual({ authorize: AUTH, token: TOKEN, revoke: REVOKE });
    expect(CALENDAR_SCOPE).toBe(SCOPE);
  });
});

// ── R1: no token in any error, audit entry or console line ─────────────────

const GOOGLE_TOKEN_SHAPES = [/ya29\./, /1\/\/0[A-Za-z0-9_-]/, /4\/0A[A-Za-z0-9_-]/, /GOCSPX-/, /Bearer\s+[A-Za-z0-9._~+/-]{6,}/];

function serialize(value: unknown, depth = 0): string {
  if (depth > 5) return '';
  if (value instanceof Error) {
    const own: Record<string, unknown> = {};
    for (const k of Object.getOwnPropertyNames(value)) own[k] = (value as unknown as Record<string, unknown>)[k];
    return [value.name, value.message, value.stack ?? '', safeJson(own), serialize(value.cause, depth + 1)].join('\n');
  }
  return safeJson(value);
}

function safeJson(value: unknown): string {
  try {
    return value === undefined ? '' : JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** Every secret a test sent or received, including verifiers and codes harvested from requests. */
function allSecrets(): string[] {
  const out = new Set(SECRETS);
  for (const w of worlds) {
    for (const r of w.http.requests) {
      const f = new URLSearchParams(r.body ?? '');
      for (const k of ['code', 'code_verifier', 'refresh_token', 'client_secret', 'token']) {
        const v = f.get(k);
        if (v !== null && v.length >= 8) out.add(v);
      }
    }
  }
  return [...out];
}

function leaks(): string[] {
  const items: unknown[] = [...produced];
  for (const w of worlds) items.push(...w.audit.entries);
  for (const spy of consoleSpies) items.push(...spy.mock.calls);
  const secrets = allSecrets();
  const found: string[] = [];
  for (const item of items) {
    const text = serialize(item);
    for (const s of secrets) if (text.includes(s)) found.push(`secret value in: ${text.slice(0, 120)}`);
    for (const re of GOOGLE_TOKEN_SHAPES) if (re.test(text)) found.push(`${String(re)} in: ${text.slice(0, 120)}`);
  }
  return found;
}

afterAll(() => {
  expect(leaks()).toEqual([]);
});

describe('R1: tokens never reach errors, audit entries or logs', () => {
  it('every error and audit entry produced in this file is token-free', () => {
    const audits = worlds.flatMap((w) => w.audit.entries);
    // Not vacuous: the suite above produced many errors and audit entries.
    expect(produced.length).toBeGreaterThan(40);
    expect(audits.length).toBeGreaterThan(5);
    expect(allSecrets().length).toBeGreaterThan(40);
    expect(leaks()).toEqual([]);
  });

  it('the provider itself never writes to the console', () => {
    for (const spy of consoleSpies) expect(spy).not.toHaveBeenCalled();
  });
});
