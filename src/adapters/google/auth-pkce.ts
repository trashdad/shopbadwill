// T-62: PkceRefreshProvider, the primary GoogleAuthProvider on both browsers
// (PLAN §1.6, §3.8). `identity.launchWebAuthFlow` + authorization code + S256
// PKCE + a refresh token, so the background can get access tokens unattended.
//
// Storage (ruling R1): the refresh token lives in storage.local (`sbw:google`,
// GoogleCredentials) and the access token in storage.session only
// (`sbw:googleAccess`). No token, code, verifier or secret is ever logged, put
// in an audit entry, or put in an error message: errors carry an HTTP status
// and Google's short error code at most, and a `cause` only for transport
// errors (which never contain request bodies).
//
// Choices that wait on spike S-4 (not yet run) are marked `S-4 pending:`.
import type { AuditEntry, AuditLog } from '../../domain/audit/types';
import type { AuthStatus, GoogleAuthErrorCode } from '../../domain/calendar/types';
import { GoogleAccessSchema, STORAGE_KEYS, type GoogleAccess } from '../../domain/storage/schema';
import { GoogleCredentialsSchema, type GoogleCredentials } from '../../domain/types';
import type { Clock } from '../../ports/clock';
import { GoogleAuthError, HttpNetworkError, HttpTimeoutError } from '../../ports/errors';
import type { GoogleAuthProvider } from '../../ports/google-auth';
import type { Http, HttpResponse } from '../../ports/http';
import type { StorageAreas } from '../../ports/storage';
import { challengeS256, createState, createVerifier, cryptoRandomBytes, type RandomBytes } from './pkce';
import { RawGoogleErrorSchema } from './schemas';
import { OAuthErrorSchema, TokenResponseSchema, type TokenResponse } from './token-schemas';

/** The one scope (PLAN §1.6): only calendars this app created. */
export const CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar.app.created';

export const GOOGLE_OAUTH_ENDPOINTS = Object.freeze({
  authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
  token: 'https://oauth2.googleapis.com/token',
  revoke: 'https://oauth2.googleapis.com/revoke',
});

export interface GoogleClientConfig {
  clientId: string;
  /**
   * S-4 pending: sent to the token endpoint only when set. A Web application
   * client may require it even with PKCE; it is non-confidential (it ships in
   * the build) and never enters the repo (PLAN §1.6).
   */
  clientSecret?: string;
}

/** The two `identity` functions this provider needs (injected: src/adapters/google may not touch `browser`). */
export interface WebAuthFlow {
  launchWebAuthFlow(details: { url: string; interactive: boolean }): Promise<string | undefined>;
  getRedirectURL(): string;
}

/** The "reconnect Google" action badge. */
export interface NeedsInteractionBadge {
  set(on: boolean): void | Promise<void>;
}

export interface PkceRefreshProviderDeps {
  storage: StorageAreas;
  http: Http;
  clock: Clock;
  identity: WebAuthFlow;
  /** The OAuth client for this browser's build; undefined (or a blank id) = not configured. */
  clientConfig: () => GoogleClientConfig | undefined | Promise<GoogleClientConfig | undefined>;
  badge: NeedsInteractionBadge;
  /** Connect, disconnect and needs-interaction events (codes and booleans only). */
  audit?: Pick<AuditLog, 'append'>;
  /** Tests point these at the fake Google server. */
  endpoints?: Partial<{ authorize: string; token: string; revoke: string }>;
  random?: RandomBytes;
  requestTimeoutMs?: number;
}

const DAY_MS = 86_400_000;
/** An access token this close to expiry is refreshed first. */
const EXPIRY_SKEW_MS = 60_000;
const DEFAULT_TIMEOUT_MS = 15_000;
/** 403 reasons that mean "slow down" rather than "not allowed". */
const RATE_REASONS = new Set(['rateLimitExceeded', 'userRateLimitExceeded', 'quotaExceeded', 'dailyLimitExceeded']);
/** Google's short OAuth error codes; anything else is left out of messages. */
const OAUTH_CODE_RE = /^[a-z_]{1,64}$/;
const BEARER_RE = /^Bearer\s+(\S+)$/i;
const CHROMIUMAPP_RE = /^https:\/\/[a-p]{32}\.chromiumapp\.org\/$/;
const ALLIZOM_RE = /^https:\/\/([0-9a-f]{8,64})\.extensions\.allizom\.org\/$/;
// S-4 pending: the browsers' launchWebAuthFlow rejection texts (Chrome "The
// user did not approve access.", Firefox "User cancelled or denied access.")
// are matched loosely; anything else (e.g. "Authorization page could not be
// loaded.") is treated as offline. S-4 records the real texts.
const CANCELLED_RE = /did not approve|cancel|denied|closed/i;
const REVOKE_HINT = 'remove ShopBadwill at https://myaccount.google.com/connections';

type PkceCredentials = GoogleCredentials & { refreshToken: string };

/**
 * The redirect URI for this browser, from `identity.getRedirectURL()`.
 *
 * S-4 pending: Chrome pairs `https://<ext-id>.chromiumapp.org/` with a Web
 * application client; Firefox pairs the loopback `http://127.0.0.1/mozoauth2/<hash>`
 * (Firefox 86+, the hash from getRedirectURL()'s allizom host) with a Desktop
 * app client. If S-4 rules the loopback out, Firefox would use the allizom
 * URL itself with the Web client.
 */
export function redirectUriFor(browserRedirectUrl: string): string {
  if (CHROMIUMAPP_RE.test(browserRedirectUrl)) return browserRedirectUrl;
  const hash = ALLIZOM_RE.exec(browserRedirectUrl)?.[1];
  if (hash !== undefined) return `http://127.0.0.1/mozoauth2/${hash}`;
  throw new GoogleAuthError('not_configured', 'unsupported identity redirect URL');
}

/** Google's short error code and 403 reasons from an error body; nothing else is read. */
function errorBody(bodyText: string): { error?: string; reasons: string[] } {
  let raw: unknown;
  try {
    raw = JSON.parse(bodyText);
  } catch {
    return { reasons: [] };
  }
  const oauth = OAuthErrorSchema.safeParse(raw);
  if (oauth.success) return OAUTH_CODE_RE.test(oauth.data.error) ? { error: oauth.data.error, reasons: [] } : { reasons: [] };
  const google = RawGoogleErrorSchema.safeParse(raw);
  if (!google.success) return { reasons: [] };
  return { reasons: (google.data.error?.errors ?? []).flatMap((e) => (e.reason === undefined ? [] : [e.reason])) };
}

/**
 * Maps a non-2xx answer from the token (or revoke) endpoint to the port's
 * error code. Transport failures (HttpNetworkError, HttpTimeoutError) are
 * 'offline'; see `toAuthError`.
 */
export function classifyTokenFailure(status: number, bodyText: string): GoogleAuthErrorCode {
  const { error, reasons } = errorBody(bodyText);
  if (status === 400) {
    if (error === 'invalid_grant') return 'invalid_grant';
    if (error === 'invalid_scope') return 'insufficient_scope';
    // S-4 pending: a client that needs its secret answers 400 invalid_request
    // ("client_secret is missing."); a wrong redirect, redirect_uri_mismatch.
    // Both are setup problems.
    return 'not_configured';
  }
  if (status === 401) return 'unauthorized';
  if (status === 403) return reasons.some((r) => RATE_REASONS.has(r)) ? 'rate_limited' : 'insufficient_scope';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'offline';
  return 'not_configured';
}

function httpFailure(what: string, res: HttpResponse): GoogleAuthError {
  const { error } = errorBody(res.bodyText);
  const detail = error === undefined ? '' : ` (${error})`;
  return new GoogleAuthError(classifyTokenFailure(res.status, res.bodyText), `${what} answered ${String(res.status)}${detail}`);
}

/** Any failure as a GoogleAuthError. Only transport errors are kept as `cause`. */
function toAuthError(e: unknown): GoogleAuthError {
  if (e instanceof GoogleAuthError) return e;
  if (e instanceof HttpNetworkError || e instanceof HttpTimeoutError) {
    return new GoogleAuthError('offline', 'could not reach Google', { cause: e });
  }
  return new GoogleAuthError('offline', 'the request to Google failed');
}

function launchFailure(e: unknown): GoogleAuthError {
  const message = e instanceof Error ? e.message : String(e);
  return CANCELLED_RE.test(message)
    ? new GoogleAuthError('user_cancelled', 'the Google sign-in was cancelled')
    : new GoogleAuthError('offline', 'the Google sign-in window could not complete');
}

/** The authorization code from the redirect, after the state check. */
function readRedirect(responseUrl: string, expectedState: string): { code: string; scope?: string } {
  let params: URLSearchParams;
  try {
    params = new URL(responseUrl).searchParams;
  } catch {
    throw new GoogleAuthError('unauthorized', 'the sign-in redirect was malformed');
  }
  // First: an answer not bound to this request is rejected, whatever it says.
  if (params.get('state') !== expectedState) {
    throw new GoogleAuthError('unauthorized', 'OAuth state mismatch: the sign-in answer was not for this request');
  }
  const error = params.get('error');
  if (error !== null) {
    if (error === 'access_denied') throw new GoogleAuthError('user_cancelled', 'the Google sign-in was declined');
    throw new GoogleAuthError('not_configured', `Google refused the sign-in${OAUTH_CODE_RE.test(error) ? ` (${error})` : ''}`);
  }
  const code = params.get('code');
  if (code === null || code === '') throw new GoogleAuthError('unauthorized', 'the sign-in redirect carried no authorization code');
  const scope = params.get('scope');
  return scope === null ? { code } : { code, scope };
}

const splitScopes = (scope: string): string[] => scope.split(' ').filter((s) => s !== '');

export class PkceRefreshProvider implements GoogleAuthProvider {
  private readonly storage: StorageAreas;
  private readonly http: Http;
  private readonly clock: Clock;
  private readonly identity: WebAuthFlow;
  private readonly clientConfig: PkceRefreshProviderDeps['clientConfig'];
  private readonly badge: NeedsInteractionBadge;
  private readonly audit: Pick<AuditLog, 'append'> | undefined;
  private readonly endpoints: { authorize: string; token: string; revoke: string };
  private readonly random: RandomBytes;
  private readonly timeoutMs: number;

  /**
   * Set by invalid_grant (or a lost scope) on refresh, cleared by connect or
   * disconnect. In memory: after a worker restart the next refresh finds the
   * same answer and sets it again.
   */
  private needsInteraction = false;
  private lastError: GoogleAuthErrorCode | undefined;
  /** Bumped when connect writes and when disconnect clears: a refresh begun before cannot write after. */
  private epoch = 0;
  private refreshing: Promise<string> | undefined;
  private authorizing: Promise<string> | undefined;
  /** Serializes storage writes (refresh results vs. disconnect's clear). */
  private lock: Promise<unknown> = Promise.resolve();

  constructor(deps: PkceRefreshProviderDeps) {
    this.storage = deps.storage;
    this.http = deps.http;
    this.clock = deps.clock;
    this.identity = deps.identity;
    this.clientConfig = deps.clientConfig;
    this.badge = deps.badge;
    this.audit = deps.audit;
    this.endpoints = { ...GOOGLE_OAUTH_ENDPOINTS, ...deps.endpoints };
    this.random = deps.random ?? cryptoRandomBytes;
    this.timeoutMs = deps.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** interactive:false (the background) never opens a window: it uses the cache or the refresh token, or throws. */
  async getAccessToken(opts: { interactive: boolean }): Promise<string> {
    // Taken before any read: a disconnect that clears storage after this point voids this call's writes.
    const epoch = this.epoch;
    const cached = await this.readAccess();
    if (cached !== undefined && cached.expiresAt - EXPIRY_SKEW_MS > this.clock.now()) return cached.token;

    const creds = await this.readCredentials();
    if (creds === undefined) {
      if (opts.interactive) return this.authorize();
      const configured = (await this.config()) !== undefined;
      throw new GoogleAuthError(configured ? 'needs_interaction' : 'not_configured', 'Google is not connected');
    }
    if (this.needsInteraction) {
      if (opts.interactive) return this.authorize();
      throw new GoogleAuthError('needs_interaction', 'Google needs the user to reconnect');
    }
    try {
      return await this.refresh(creds, epoch);
    } catch (e) {
      // A dead or narrowed grant: a user gesture may fix it right now.
      if (opts.interactive && e instanceof GoogleAuthError && (e.code === 'invalid_grant' || e.code === 'insufficient_scope')) {
        return this.authorize();
      }
      throw e;
    }
  }

  /** User gesture only: opens Google's consent window. */
  async connect(): Promise<AuthStatus> {
    await this.authorize();
    return this.status();
  }

  /**
   * Revokes the refresh token at Google, then clears both storage areas. If
   * the revoke fails, storage is still cleared and the failure is thrown
   * afterwards (and kept as `lastError`), so the user can remove the grant by hand.
   */
  async disconnect(): Promise<void> {
    const creds = await this.readCredentials();
    let revokeError: GoogleAuthError | undefined;
    if (creds !== undefined) {
      try {
        await this.revoke(creds.refreshToken);
      } catch (e) {
        revokeError = toAuthError(e);
      }
    }
    await this.withLock(async () => {
      this.epoch += 1;
      await this.storage.local.remove([STORAGE_KEYS.google]);
      await this.storage.session.remove([STORAGE_KEYS.googleAccess]);
    });
    this.needsInteraction = false;
    this.lastError = revokeError?.code;
    await this.setBadge(false);
    if (creds !== undefined) {
      await this.record({
        actor: 'user',
        kind: 'google.disconnect',
        details: revokeError === undefined ? { revoked: true } : { revoked: false, revokeError: revokeError.code },
      });
    }
    if (revokeError !== undefined) {
      throw new GoogleAuthError(
        revokeError.code,
        `Disconnected on this computer, but Google did not confirm the revoke; ${REVOKE_HINT}`,
        { cause: revokeError },
      );
    }
  }

  async status(): Promise<AuthStatus> {
    const creds = await this.readCredentials();
    const configured = creds !== undefined || (await this.config()) !== undefined;
    const common = {
      needsInteraction: creds !== undefined && this.needsInteraction,
      configured,
      ...(this.lastError === undefined ? {} : { lastError: this.lastError }),
    };
    if (creds === undefined) return { connected: false, provider: 'none', grantedScopes: [], ...common };
    return {
      connected: true,
      provider: 'pkce',
      ...(creds.account === undefined ? {} : { account: creds.account }),
      grantedScopes: [...creds.grantedScopes],
      refreshTokenAgeDays: Math.max(0, Math.floor((this.clock.now() - creds.connectedAt) / DAY_MS)),
      ...common,
    };
  }

  /**
   * Wraps the Http given to the Calendar adapter: a 401 to a request that
   * carried a Bearer token drops that token, refreshes once (interactive:false)
   * and resends once. A second 401, or a failed refresh, returns the 401 as is,
   * so the caller surfaces it (CalendarApiError 'auth').
   */
  authorizedHttp(inner: Http): Http {
    return {
      send: async (req) => {
        const res = await inner.send(req);
        if (res.status !== 401) return res;
        const headers = req.headers ?? {};
        const name = Object.keys(headers).find((k) => k.toLowerCase() === 'authorization');
        const sent = name === undefined ? undefined : BEARER_RE.exec(headers[name] ?? '')?.[1];
        if (name === undefined || sent === undefined) return res;
        let token: string;
        try {
          await this.invalidateAccessToken(sent);
          token = await this.getAccessToken({ interactive: false });
        } catch {
          return res;
        }
        const retry = await inner.send({ ...req, headers: { ...headers, [name]: `Bearer ${token}` } });
        if (retry.status === 401) this.lastError = 'unauthorized';
        return retry;
      },
    };
  }

  /** Drops the cached access token if it is still `token` (a 401 proved it dead). */
  private async invalidateAccessToken(token: string): Promise<void> {
    await this.withLock(async () => {
      if ((await this.readAccess())?.token === token) await this.storage.session.remove([STORAGE_KEYS.googleAccess]);
    });
  }

  // ── consent flow ─────────────────────────────────────────────────────────

  private authorize(): Promise<string> {
    this.authorizing ??= this.runConsent().finally(() => {
      this.authorizing = undefined;
    });
    return this.authorizing;
  }

  private async runConsent(): Promise<string> {
    try {
      return await this.consent();
    } catch (e) {
      const err = toAuthError(e);
      this.lastError = err.code;
      throw err;
    }
  }

  private async consent(): Promise<string> {
    const config = await this.config();
    if (config === undefined) throw new GoogleAuthError('not_configured', 'no Google OAuth client id is configured');
    let redirectUri: string;
    try {
      redirectUri = redirectUriFor(this.identity.getRedirectURL());
    } catch (e) {
      throw e instanceof GoogleAuthError ? e : new GoogleAuthError('not_configured', 'the identity API is unavailable');
    }

    const verifier = createVerifier(this.random);
    const state = createState(this.random);
    const url = new URL(this.endpoints.authorize);
    url.search = new URLSearchParams({
      client_id: config.clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: CALENDAR_SCOPE,
      state,
      code_challenge: await challengeS256(verifier),
      code_challenge_method: 'S256',
      access_type: 'offline',
      prompt: 'consent',
    }).toString();

    let responseUrl: string | undefined;
    try {
      responseUrl = await this.identity.launchWebAuthFlow({ url: url.toString(), interactive: true });
    } catch (e) {
      throw launchFailure(e);
    }
    if (responseUrl === undefined || responseUrl === '') throw new GoogleAuthError('user_cancelled', 'the Google sign-in window was closed');
    const { code, scope: redirectScope } = readRedirect(responseUrl, state);

    const form: Record<string, string> = {
      grant_type: 'authorization_code',
      code,
      client_id: config.clientId,
      redirect_uri: redirectUri,
      code_verifier: verifier,
    };
    // S-4 pending: the secret is sent only when one is configured.
    if (config.clientSecret !== undefined) form['client_secret'] = config.clientSecret;
    const token = await this.tokenRequest(form);

    if (token.refresh_token === undefined) {
      throw new GoogleAuthError('needs_interaction', 'Google returned no refresh token, so background refresh is impossible');
    }
    const grantedScopes = splitScopes(token.scope ?? redirectScope ?? '');
    if (!grantedScopes.includes(CALENDAR_SCOPE)) {
      throw new GoogleAuthError('insufficient_scope', 'the calendar permission was not granted');
    }
    const creds: PkceCredentials = {
      provider: 'pkce',
      clientId: config.clientId,
      // S-4 pending: kept only when configured, for the refresh grant.
      ...(config.clientSecret === undefined ? {} : { clientSecret: config.clientSecret }),
      refreshToken: token.refresh_token,
      grantedScopes,
      connectedAt: this.clock.now(),
    };
    await this.withLock(async () => {
      this.epoch += 1;
      await this.storage.local.set({ [STORAGE_KEYS.google]: creds });
      await this.writeAccess(token);
    });
    this.needsInteraction = false;
    this.lastError = undefined;
    await this.setBadge(false);
    await this.record({ actor: 'user', kind: 'google.connect', details: { provider: 'pkce', scopes: grantedScopes.join(' ') } });
    return token.access_token;
  }

  // ── refresh ──────────────────────────────────────────────────────────────

  /** One refresh at a time; concurrent callers share it. */
  private refresh(creds: PkceCredentials, epoch: number): Promise<string> {
    this.refreshing ??= this.runRefresh(creds, epoch).finally(() => {
      this.refreshing = undefined;
    });
    return this.refreshing;
  }

  private async runRefresh(creds: PkceCredentials, epoch: number): Promise<string> {
    const form: Record<string, string> = {
      grant_type: 'refresh_token',
      refresh_token: creds.refreshToken,
      client_id: creds.clientId,
    };
    // S-4 pending: the secret goes with the refresh grant only if one was configured at connect.
    if (creds.clientSecret !== undefined && creds.clientSecret !== '') form['client_secret'] = creds.clientSecret;

    let token: TokenResponse;
    try {
      token = await this.tokenRequest(form);
    } catch (e) {
      throw await this.refreshFailure(toAuthError(e), epoch);
    }
    const grantedScopes = token.scope === undefined ? creds.grantedScopes : splitScopes(token.scope);
    if (!grantedScopes.includes(CALENDAR_SCOPE)) {
      throw await this.refreshFailure(new GoogleAuthError('insufficient_scope', 'the Google grant no longer includes the calendar scope'), epoch);
    }

    const rotated = token.refresh_token !== undefined && token.refresh_token !== creds.refreshToken;
    const scopesChanged = grantedScopes.join(' ') !== creds.grantedScopes.join(' ');
    const accessToken = await this.withLock(async () => {
      if (epoch !== this.epoch) throw new GoogleAuthError('needs_interaction', 'Google was disconnected or reconnected during a refresh');
      if (rotated || scopesChanged) {
        const next: PkceCredentials = { ...creds, grantedScopes, ...(rotated ? { refreshToken: token.refresh_token } : {}) };
        await this.storage.local.set({ [STORAGE_KEYS.google]: next });
      }
      await this.writeAccess(token);
      return token.access_token;
    });
    this.lastError = undefined;
    return accessToken;
  }

  /**
   * Records a refresh failure. invalid_grant and a lost scope need the user:
   * the flag and the badge go up, and nothing is cleared (the brief).
   */
  private async refreshFailure(err: GoogleAuthError, epoch: number): Promise<GoogleAuthError> {
    if (epoch !== this.epoch) return err;
    this.lastError = err.code;
    if ((err.code === 'invalid_grant' || err.code === 'insufficient_scope') && !this.needsInteraction) {
      this.needsInteraction = true;
      await this.setBadge(true);
      await this.record({ actor: 'calendar', kind: 'google.needsInteraction', details: { error: err.code } });
    }
    return err;
  }

  // ── HTTP ─────────────────────────────────────────────────────────────────

  private async tokenRequest(form: Record<string, string>): Promise<TokenResponse> {
    const res = await this.postForm(this.endpoints.token, form);
    if (res.status < 200 || res.status >= 300) throw httpFailure('token endpoint', res);
    let raw: unknown;
    try {
      raw = JSON.parse(res.bodyText);
    } catch {
      throw new GoogleAuthError('offline', 'the token endpoint did not answer with JSON');
    }
    const parsed = TokenResponseSchema.safeParse(raw);
    if (!parsed.success) throw new GoogleAuthError('offline', 'the token endpoint answer failed validation');
    return parsed.data;
  }

  private async revoke(token: string): Promise<void> {
    const res = await this.postForm(this.endpoints.revoke, { token });
    if (res.status >= 200 && res.status < 300) return;
    // Already expired or revoked at Google: nothing is left to revoke.
    if (res.status === 400 && errorBody(res.bodyText).error === 'invalid_token') return;
    throw httpFailure('revoke endpoint', res);
  }

  private async postForm(url: string, form: Record<string, string>): Promise<HttpResponse> {
    try {
      return await this.http.send({
        url,
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: new URLSearchParams(form).toString(),
        timeoutMs: this.timeoutMs,
        credentials: 'omit',
      });
    } catch (e) {
      throw toAuthError(e);
    }
  }

  // ── storage and config ───────────────────────────────────────────────────

  private async readCredentials(): Promise<PkceCredentials | undefined> {
    const parsed = GoogleCredentialsSchema.safeParse(await this.storage.local.get<unknown>(STORAGE_KEYS.google));
    if (!parsed.success || parsed.data.provider !== 'pkce') return undefined;
    const { refreshToken } = parsed.data;
    return refreshToken === undefined || refreshToken === '' ? undefined : { ...parsed.data, refreshToken };
  }

  private async readAccess(): Promise<GoogleAccess | undefined> {
    const parsed = GoogleAccessSchema.safeParse(await this.storage.session.get<unknown>(STORAGE_KEYS.googleAccess));
    return parsed.success ? parsed.data : undefined;
  }

  private async writeAccess(token: TokenResponse): Promise<void> {
    const access: GoogleAccess = { token: token.access_token, expiresAt: this.clock.now() + Math.round(token.expires_in * 1000) };
    await this.storage.session.set({ [STORAGE_KEYS.googleAccess]: access });
  }

  private async config(): Promise<GoogleClientConfig | undefined> {
    let raw: GoogleClientConfig | undefined;
    try {
      raw = await this.clientConfig();
    } catch {
      return undefined;
    }
    const clientId = raw?.clientId.trim() ?? '';
    if (clientId === '') return undefined;
    const clientSecret = raw?.clientSecret?.trim() ?? '';
    return clientSecret === '' ? { clientId } : { clientId, clientSecret };
  }

  private withLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.lock.then(fn, fn);
    this.lock = run.catch(() => undefined);
    return run;
  }

  // ── side channels: never allowed to break auth ───────────────────────────

  private async setBadge(on: boolean): Promise<void> {
    try {
      await this.badge.set(on);
    } catch {
      // A badge failure must not fail sign-in or refresh.
    }
  }

  private async record(e: Omit<AuditEntry, 'seq' | 'at'>): Promise<void> {
    try {
      await this.audit?.append(e);
    } catch {
      // Audit is best effort here.
    }
  }
}
