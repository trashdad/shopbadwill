// T-62: PkceRefreshProvider, the primary GoogleAuthProvider on both browsers
// (PLAN §1.6, §3.8). `identity.launchWebAuthFlow` + authorization code + S256
// PKCE + a refresh token, so the background can get access tokens unattended.
//
// Client config (controller ruling 2): the OAuth client id and secret come
// ONLY from the injected `clientConfig()`, read on every connect and refresh.
// T-70 supplies it from the settings the user saved; nothing here reads
// wxt.config or build-time env, and the copy kept in `sbw:google` is never
// used to authenticate. A config change lifts a remembered token-endpoint
// refusal; a grant made with another client id needs a reconnect.
//
// Storage (ruling R1): the refresh token lives in storage.local (`sbw:google`,
// GoogleCredentials) and the access token in storage.session only
// (`sbw:googleAccess`). disconnect() clears the tokens, the granted scopes and
// the access expiry, and keeps the client config (ruling 5). No token, code,
// verifier or secret is ever logged, put in an audit entry, or put in an error
// message: errors carry an HTTP status and Google's short error code at most,
// and a `cause` only for transport errors (which never contain request bodies).
//
// Grants are exact: the granted scope set must be {calendar.app.created}. A
// grant refused at connect (no refresh token, scope missing, scope broader) is
// revoked, best effort; a broader grant found on refresh is revoked too.
//
// Choices that wait on spike S-4 (not yet run) are marked `S-4 pending:`.
import type { AuditEntry, AuditLog } from '../../domain/audit/types';
import type { AuthStatus, GoogleAuthErrorCode } from '../../domain/calendar/types';
import { GoogleAccessSchema, STORAGE_KEYS, type GoogleAccess } from '../../domain/storage/schema';
import { GoogleCredentialsSchema, type EpochMs, type GoogleCredentials } from '../../domain/types';
import type { Clock } from '../../ports/clock';
import { GoogleAuthError, HttpNetworkError, HttpTimeoutError } from '../../ports/errors';
import type { GoogleAuthProvider } from '../../ports/google-auth';
import type { Http, HttpResponse } from '../../ports/http';
import type { StorageAreas } from '../../ports/storage';
import { challengeS256, createState, createVerifier } from './pkce';
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
   * client may require it even with PKCE; it is non-confidential and never
   * enters the repo (PLAN §1.6).
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
  /** The only source of the OAuth client (ruling 2); undefined (or a blank id) = not configured. */
  clientConfig: () => GoogleClientConfig | undefined | Promise<GoogleClientConfig | undefined>;
  badge: NeedsInteractionBadge;
  /** Connect, disconnect and needs-interaction events (codes and booleans only). */
  audit?: Pick<AuditLog, 'append'>;
  /** Tests point these at the fake Google server. */
  endpoints?: Partial<{ authorize: string; token: string; revoke: string }>;
  requestTimeoutMs?: number;
}

/**
 * What status() and connect() return: the port's AuthStatus, plus the refresh
 * token's expiry when Google states one (`refresh_token_expires_in`). The
 * frozen AuthStatusSchema has no such field and strips it in messages; it is
 * kept in memory and re-learned on the next refresh after a worker restart.
 */
export type PkceAuthStatus = AuthStatus & {
  /**
   * S-4 pending: an app left in "Testing" gets refresh tokens that die 7 days
   * after consent; S-4 checks whether Google states that here, so the UI can
   * warn before the daily sync starts failing with invalid_grant.
   */
  refreshTokenExpiresAt?: EpochMs;
};

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
const BROADER_MESSAGE = 'Google granted more than the calendar.app.created scope, so the grant was revoked';

type PkceCredentials = GoogleCredentials & { refreshToken: string };
/** A token-endpoint refusal that retrying with the same client cannot fix. */
type Refusal = { code: 'unauthorized' | 'not_configured'; config: GoogleClientConfig };

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

/** Whether the answer came back to one of `accepted`, judged on origin + path only. */
function deliveredTo(url: URL, accepted: readonly string[]): boolean {
  const at = `${url.origin}${url.pathname}`;
  return accepted.some((p) => at === p || at.startsWith(p.endsWith('/') ? p : `${p}/`));
}

/**
 * The authorization code from the redirect. In order: the answer must come
 * back to an accepted address, then carry this request's state; only then is
 * anything else read, and only from the query (never the fragment).
 */
function readRedirect(responseUrl: string, expectedState: string, accepted: readonly string[]): { code: string; scope?: string } {
  let url: URL;
  try {
    url = new URL(responseUrl);
  } catch {
    throw new GoogleAuthError('unauthorized', 'the sign-in redirect was malformed');
  }
  if (!deliveredTo(url, accepted)) {
    throw new GoogleAuthError('unauthorized', 'the sign-in answer came back to an unexpected address');
  }
  const params = url.searchParams;
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

/** The distinct granted scopes. */
const splitScopes = (scope: string): string[] => [...new Set(scope.split(' ').filter((s) => s !== ''))];

/** 'exact' = {calendar.app.created}; 'broader' = anything else is in it; 'missing' = empty. */
function scopeVerdict(scopes: readonly string[]): 'exact' | 'broader' | 'missing' {
  if (scopes.some((s) => s !== CALENDAR_SCOPE)) return 'broader';
  return scopes.includes(CALENDAR_SCOPE) ? 'exact' : 'missing';
}

const sameClient = (a: GoogleClientConfig, b: GoogleClientConfig): boolean =>
  a.clientId === b.clientId && a.clientSecret === b.clientSecret;

export class PkceRefreshProvider implements GoogleAuthProvider {
  private readonly storage: StorageAreas;
  private readonly http: Http;
  private readonly clock: Clock;
  private readonly identity: WebAuthFlow;
  private readonly clientConfig: PkceRefreshProviderDeps['clientConfig'];
  private readonly badge: NeedsInteractionBadge;
  private readonly audit: Pick<AuditLog, 'append'> | undefined;
  private readonly endpoints: { authorize: string; token: string; revoke: string };
  private readonly timeoutMs: number;

  /**
   * Set by invalid_grant (or a wrong scope) on refresh, cleared by connect or
   * disconnect. In memory (ruling 4): after a worker restart the next refresh
   * finds the same answer and sets it again.
   */
  private needsInteraction = false;
  /** A 401 or setup refusal from the token endpoint, kept like needsInteraction until connect or a config change. */
  private refusal: Refusal | undefined;
  private lastError: GoogleAuthErrorCode | undefined;
  /** From `refresh_token_expires_in`, when Google states one. */
  private refreshTokenExpiresAt: EpochMs | undefined;
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
    this.timeoutMs = deps.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** interactive:false (the background) never opens a window: it uses the cache or the refresh token, or throws. */
  async getAccessToken(opts: { interactive: boolean }): Promise<string> {
    // Taken before any read: a disconnect that clears storage after this point voids this call's writes.
    const epoch = this.epoch;
    const cached = await this.readAccess();
    if (cached !== undefined && cached.expiresAt - EXPIRY_SKEW_MS > this.clock.now()) return cached.token;

    const creds = await this.readCredentials();
    const config = await this.config();
    if (creds === undefined) {
      if (opts.interactive) return this.authorize();
      throw new GoogleAuthError(config === undefined ? 'not_configured' : 'needs_interaction', 'Google is not connected');
    }
    if (this.needsInteraction) {
      if (opts.interactive) return this.authorize();
      throw new GoogleAuthError('needs_interaction', 'Google needs the user to reconnect');
    }
    if (config === undefined) throw new GoogleAuthError('not_configured', 'no Google OAuth client is configured');
    if (config.clientId !== creds.clientId) {
      // The refresh token is bound to the client that obtained it.
      if (opts.interactive) return this.authorize();
      throw new GoogleAuthError('needs_interaction', 'the Google grant belongs to another OAuth client; reconnect');
    }
    if (this.refusal !== undefined) {
      if (!sameClient(this.refusal.config, config)) this.refusal = undefined;
      else if (!opts.interactive) {
        throw new GoogleAuthError(this.refusal.code, 'Google refused this OAuth client; fix the client settings or reconnect');
      }
    }
    try {
      return await this.refresh(creds, config, epoch);
    } catch (e) {
      // A dead or wrong grant: a user gesture may fix it right now.
      if (opts.interactive && e instanceof GoogleAuthError && (e.code === 'invalid_grant' || e.code === 'insufficient_scope')) {
        return this.authorize();
      }
      throw e;
    }
  }

  /** User gesture only: opens Google's consent window. */
  async connect(): Promise<PkceAuthStatus> {
    await this.authorize();
    return this.status();
  }

  /**
   * Revokes the refresh token at Google, then clears the tokens, granted scopes
   * and expiry, keeping the client config (ruling 5). If the revoke fails, the
   * tokens are still cleared and the failure is thrown afterwards (and kept as
   * `lastError`), so the user can remove the grant by hand.
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
      await this.storage.session.remove([STORAGE_KEYS.googleAccess]);
      const kept = configOnly(await this.storage.local.get<unknown>(STORAGE_KEYS.google));
      if (kept === undefined) await this.storage.local.remove([STORAGE_KEYS.google]);
      else await this.storage.local.set({ [STORAGE_KEYS.google]: kept });
    });
    this.needsInteraction = false;
    this.refusal = undefined;
    this.refreshTokenExpiresAt = undefined;
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

  async status(): Promise<PkceAuthStatus> {
    const creds = await this.readCredentials();
    const configured = (await this.config()) !== undefined;
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
      ...(this.refreshTokenExpiresAt === undefined ? {} : { refreshTokenExpiresAt: this.refreshTokenExpiresAt }),
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
    let browserRedirect: string;
    let redirectUri: string;
    try {
      browserRedirect = this.identity.getRedirectURL();
      redirectUri = redirectUriFor(browserRedirect);
    } catch (e) {
      throw e instanceof GoogleAuthError ? e : new GoogleAuthError('not_configured', 'the identity API is unavailable');
    }
    // S-4 pending: which URL Firefox's launchWebAuthFlow hands back for the
    // loopback flow (the loopback itself, or getRedirectURL()) is unconfirmed,
    // so both are accepted. On Chrome the two are the same URL.
    const accepted = [redirectUri, browserRedirect];

    const verifier = createVerifier();
    const state = createState();
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
    const { code, scope: redirectScope } = readRedirect(responseUrl, state, accepted);

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

    const refreshToken = token.refresh_token;
    if (refreshToken === undefined) {
      throw await this.refuseGrant(
        token,
        new GoogleAuthError('needs_interaction', 'Google returned no refresh token, so background refresh is impossible'),
      );
    }
    const grantedScopes = splitScopes(token.scope ?? redirectScope ?? '');
    const verdict = scopeVerdict(grantedScopes);
    if (verdict === 'missing') {
      throw await this.refuseGrant(token, new GoogleAuthError('insufficient_scope', 'the calendar permission was not granted'));
    }
    if (verdict === 'broader') throw await this.refuseGrant(token, new GoogleAuthError('insufficient_scope', BROADER_MESSAGE));

    const creds: PkceCredentials = {
      provider: 'pkce',
      clientId: config.clientId,
      // Kept beside the client id as the user's saved config; never read back to authenticate (ruling 2).
      ...(config.clientSecret === undefined ? {} : { clientSecret: config.clientSecret }),
      refreshToken,
      grantedScopes,
      connectedAt: this.clock.now(),
    };
    await this.withLock(async () => {
      this.epoch += 1;
      await this.storage.local.set({ [STORAGE_KEYS.google]: creds });
      await this.writeAccess(token);
    });
    this.needsInteraction = false;
    this.refusal = undefined;
    this.lastError = undefined;
    this.refreshTokenExpiresAt = this.refreshExpiry(token);
    await this.setBadge(false);
    await this.record({ actor: 'user', kind: 'google.connect', details: { provider: 'pkce', scopes: grantedScopes.join(' ') } });
    return token.access_token;
  }

  /** Revokes a grant refused at connect (best effort) and hands back the error to throw. */
  private async refuseGrant(token: TokenResponse, err: GoogleAuthError): Promise<GoogleAuthError> {
    await this.revokeQuietly(token.refresh_token ?? token.access_token);
    return err;
  }

  // ── refresh ──────────────────────────────────────────────────────────────

  /** One refresh at a time; concurrent callers share it. */
  private refresh(creds: PkceCredentials, config: GoogleClientConfig, epoch: number): Promise<string> {
    this.refreshing ??= this.runRefresh(creds, config, epoch).finally(() => {
      this.refreshing = undefined;
    });
    return this.refreshing;
  }

  private async runRefresh(creds: PkceCredentials, config: GoogleClientConfig, epoch: number): Promise<string> {
    const form: Record<string, string> = {
      grant_type: 'refresh_token',
      refresh_token: creds.refreshToken,
      client_id: config.clientId,
    };
    // S-4 pending: the secret goes with the refresh grant only when one is configured.
    if (config.clientSecret !== undefined) form['client_secret'] = config.clientSecret;

    let token: TokenResponse;
    try {
      token = await this.tokenRequest(form);
    } catch (e) {
      throw await this.refreshFailure(toAuthError(e), epoch, config);
    }
    const grantedScopes = token.scope === undefined ? creds.grantedScopes : splitScopes(token.scope);
    const verdict = scopeVerdict(grantedScopes);
    if (verdict === 'broader') {
      // More than this app may hold: revoke the whole grant (best effort) and store nothing.
      await this.revokeQuietly(creds.refreshToken);
      throw await this.refreshFailure(new GoogleAuthError('insufficient_scope', BROADER_MESSAGE), epoch, config);
    }
    if (verdict === 'missing') {
      throw await this.refreshFailure(
        new GoogleAuthError('insufficient_scope', 'the Google grant no longer includes the calendar scope'),
        epoch,
        config,
      );
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
    this.refusal = undefined;
    this.refreshTokenExpiresAt = this.refreshExpiry(token) ?? this.refreshTokenExpiresAt;
    return accessToken;
  }

  /**
   * Records a refresh failure. invalid_grant and a wrong scope need the user:
   * the flag and the badge go up, and nothing is cleared (the brief). A 401 or
   * a setup refusal is remembered for this client config, so background calls
   * stop asking until connect or a config change.
   */
  private async refreshFailure(err: GoogleAuthError, epoch: number, config: GoogleClientConfig): Promise<GoogleAuthError> {
    if (epoch !== this.epoch) return err;
    this.lastError = err.code;
    if (err.code === 'unauthorized' || err.code === 'not_configured') this.refusal = { code: err.code, config };
    if ((err.code === 'invalid_grant' || err.code === 'insufficient_scope') && !this.needsInteraction) {
      this.needsInteraction = true;
      await this.setBadge(true);
      await this.record({ actor: 'calendar', kind: 'google.needsInteraction', details: { error: err.code } });
    }
    return err;
  }

  private refreshExpiry(token: TokenResponse): EpochMs | undefined {
    const seconds = token.refresh_token_expires_in;
    return seconds === undefined ? undefined : this.clock.now() + Math.round(seconds * 1000);
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

  private async revokeQuietly(token: string): Promise<void> {
    try {
      await this.revoke(token);
    } catch {
      // Best effort: the grant is refused either way.
    }
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

/**
 * What disconnect() leaves of `sbw:google` (ruling 5): the client config only.
 * The refresh token, granted scopes and account go; `connectedAt` stays
 * because the frozen schema requires it. An invalid record is dropped whole.
 */
function configOnly(raw: unknown): GoogleCredentials | undefined {
  const parsed = GoogleCredentialsSchema.safeParse(raw);
  if (!parsed.success) return undefined;
  const { provider, clientId, clientSecret, connectedAt } = parsed.data;
  return { provider, clientId, ...(clientSecret === undefined ? {} : { clientSecret }), grantedScopes: [], connectedAt };
}
