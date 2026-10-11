// Fake Google: the OAuth token endpoint (+ a minimal /authorize) and a Calendar v3 subset.
// Mirrors Google's wire shapes (field names, error bodies, status codes). Nothing here talks
// to the real Google. Do not import `wxt/browser`.
import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { EVENT_ID_RE, RawCalendarInsertBodySchema, RawEventBodySchema } from './schemas';

export const SCOPE_BASE = 'https://www.googleapis.com/auth/';
const S = {
  calendar: `${SCOPE_BASE}calendar`,
  calendarReadonly: `${SCOPE_BASE}calendar.readonly`,
  events: `${SCOPE_BASE}calendar.events`,
  eventsReadonly: `${SCOPE_BASE}calendar.events.readonly`,
  calendarList: `${SCOPE_BASE}calendar.calendarlist`,
  calendarListReadonly: `${SCOPE_BASE}calendar.calendarlist.readonly`,
  appCreated: `${SCOPE_BASE}calendar.app.created`,
};
const ACCESS_TOKEN_TTL_S = 3599;
const CODE_TTL_MS = 10 * 60_000;
const TESTING_REFRESH_TTL_MS = 7 * 86_400_000;

export interface Scenario {
  /** S-5: does patching a `cancelled` event bring it back? true: yes (status from the patch, else 'confirmed'); false: 404. Default true. */
  revive?: boolean;
  /** Every refresh_token grant fails with invalid_grant. */
  invalidGrant?: boolean;
  /** App is in "Testing": refresh tokens die 7 days (fake clock) after issue. */
  testingMode?: boolean;
  /** If set, /token requires this client_secret (else 401 invalid_client). */
  clientSecret?: string;
  /** If set, /token and /authorize require this client_id. */
  clientId?: string;
  /** If set, the consent screen grants only these scopes (intersected with the requested ones). */
  grantedScopes?: string[];
  /** /authorize redirects with error=access_denied. */
  denyConsent?: boolean;
  /** The next N Calendar API calls (after auth) get 429 rateLimitExceeded with Retry-After: 1. */
  rateLimitNext?: number;
  /**
   * calendarList.list returns 403 insufficientPermissions.
   * Google's published auth table for that method omits `calendar.app.created`.
   */
  forbidCalendarList?: boolean;
}

export interface FakeEvent {
  [k: string]: unknown;
  kind: 'calendar#event';
  etag: string;
  id: string;
  status: 'confirmed' | 'tentative' | 'cancelled';
  htmlLink: string;
  created: string;
  updated: string;
  iCalUID: string;
  sequence: number;
}
export interface FakeCalendar {
  id: string;
  summary: string;
  timeZone: string;
  /** Set by calendars.insert when the body carries one. A private marker lives here. */
  description?: string;
  /** Created through calendars.insert (what calendar.app.created may touch). */
  appCreated: boolean;
  events: Map<string, FakeEvent>;
}
export interface RequestRecord { method: string; path: string; query: string; status?: number }

export interface FakeGoogle {
  url: string;
  close(): Promise<void>;
  /** Resolved scenario (defaults applied). */
  readonly scenario: Required<Pick<Scenario, 'revive' | 'invalidGrant' | 'testingMode' | 'denyConsent' | 'rateLimitNext'>> & Scenario;
  setScenario(patch: Scenario): void;
  /** Move the fake clock forward (token expiry, 7-day Testing expiry). */
  advanceClock(ms: number): void;
  now(): number;
  /** Add a calendar the app did not create (e.g. a second account calendar). */
  seedCalendar(id: string, summary: string): void;
  readonly state: {
    requests: RequestRecord[];
    calendars: Map<string, FakeCalendar>;
    revokedCount: number;
  };
}

interface RefreshRec { token: string; scopes: string[]; issuedAt: number; revoked: boolean; accessTokens: Set<string> }
interface AccessRec { token: string; scopes: string[]; expiresAt: number; revoked: boolean }
interface CodeRec { challenge: string; scopes: string[]; redirectUri: string; offline: boolean; createdAt: number }

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const rand = (n = 16) => randomBytes(n).toString('hex');

function deepMerge(base: Json, patch: Json): Json {
  const out: Json = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) Reflect.deleteProperty(out, k);
    else if (isObj(v) && isObj(out[k])) out[k] = deepMerge(out[k], v);
    else out[k] = v;
  }
  return out;
}

const RFC3339_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const RFC3339_NAIVE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?$/;

export async function startFakeGoogle(opts: { port?: number; host?: string; scenario?: Scenario } = {}): Promise<FakeGoogle> {
  const scenario: FakeGoogle['scenario'] = { revive: true, invalidGrant: false, testingMode: false, denyConsent: false, rateLimitNext: 0, ...opts.scenario };
  let clockOffset = 0;
  const now = () => Date.now() + clockOffset;
  const iso = () => new Date(now()).toISOString();

  const calendars = new Map<string, FakeCalendar>();
  const codes = new Map<string, CodeRec>();
  const refreshTokens = new Map<string, RefreshRec>();
  const accessTokens = new Map<string, AccessRec>();
  const state: FakeGoogle['state'] = { requests: [], calendars, revokedCount: 0 };

  const seedCalendar = (id: string, summary: string, appCreated = false) =>
    calendars.set(id, { id, summary, timeZone: 'UTC', appCreated, events: new Map() });
  seedCalendar('primary', 'Primary');

  // ---- response helpers --------------------------------------------------
  const send = (res: ServerResponse, status: number, body?: unknown, headers: Record<string, string> = {}): undefined => {
    const payload = body === undefined ? '' : JSON.stringify(body);
    res.writeHead(status, {
      'content-type': 'application/json; charset=UTF-8',
      'access-control-allow-origin': '*',
      ...headers,
    });
    res.end(payload);
    return undefined;
  };
  const gerr = (res: ServerResponse, code: number, reason: string, message: string, extra: { status?: string; domain?: string; headers?: Record<string, string> } = {}): undefined => {
    const error: Json = { code, message, errors: [{ message, domain: extra.domain ?? 'global', reason }] };
    if (extra.status) error['status'] = extra.status;
    send(res, code, { error }, extra.headers);
  };
  const oerr = (res: ServerResponse, status: number, error: string, description?: string): undefined => { send(res, status, description === undefined ? { error } : { error, error_description: description }, { 'cache-control': 'no-store' }); };

  const readBody = (req: IncomingMessage) =>
    new Promise<string>((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => { resolve(Buffer.concat(chunks).toString('utf8')); });
      req.on('error', reject);
    });

  // ---- OAuth -------------------------------------------------------------
  const clientOk = (res: ServerResponse, clientId: string | null, clientSecret: string | null): boolean => {
    if (scenario.clientId !== undefined && clientId !== scenario.clientId) {
      oerr(res, 401, 'invalid_client', 'The OAuth client was not found.');
      return false;
    }
    if (scenario.clientSecret !== undefined && clientSecret !== scenario.clientSecret) {
      oerr(res, 401, 'invalid_client', 'Unauthorized');
      return false;
    }
    return true;
  };

  const mintAccess = (scopes: string[], rec?: RefreshRec) => {
    const token = `ya29.fake-${rand(12)}`;
    accessTokens.set(token, { token, scopes, expiresAt: now() + ACCESS_TOKEN_TTL_S * 1000, revoked: false });
    rec?.accessTokens.add(token);
    return token;
  };

  function handleAuthorize(url: URL, res: ServerResponse) {
    const p = url.searchParams;
    const redirect = p.get('redirect_uri');
    if (!redirect) { send(res, 400, { error: 'invalid_request', error_description: 'Missing required parameter: redirect_uri' }); return; }
    const back = new URL(redirect);
    const state_ = p.get('state');
    const fail = (error: string) => {
      back.searchParams.set('error', error);
      if (state_ !== null) back.searchParams.set('state', state_);
      res.writeHead(302, { location: back.toString() });
      res.end();
    };
    if (scenario.clientId !== undefined && p.get('client_id') !== scenario.clientId) { fail('invalid_client'); return; }
    if (p.get('response_type') !== 'code') { fail('unsupported_response_type'); return; }
    const challenge = p.get('code_challenge');
    if (!challenge || p.get('code_challenge_method') !== 'S256') { fail('invalid_request'); return; }
    if (scenario.denyConsent) { fail('access_denied'); return; }
    const requested = (p.get('scope') ?? '').split(' ').filter(Boolean);
    const scopes = scenario.grantedScopes ? requested.filter((s) => (scenario.grantedScopes ?? []).includes(s)) : requested;
    const code = `4/0Afake-${rand(16)}`;
    codes.set(code, { challenge, scopes, redirectUri: redirect, offline: p.get('access_type') === 'offline', createdAt: now() });
    back.searchParams.set('code', code);
    if (state_ !== null) back.searchParams.set('state', state_);
    back.searchParams.set('scope', scopes.join(' '));
    res.writeHead(302, { location: back.toString() });
    res.end();
  }

  async function handleToken(req: IncomingMessage, res: ServerResponse) {
    const f = new URLSearchParams(await readBody(req));
    if (!clientOk(res, f.get('client_id'), f.get('client_secret'))) return;
    const grant = f.get('grant_type');
    const respond = (scopes: string[], rec: RefreshRec | undefined, withRefresh: boolean) => {
      const body: Json = { access_token: mintAccess(scopes, rec), expires_in: ACCESS_TOKEN_TTL_S, scope: scopes.join(' '), token_type: 'Bearer' };
      if (withRefresh && rec) body['refresh_token'] = rec.token;
      send(res, 200, body, { 'cache-control': 'no-store' });
    };
    if (grant === 'authorization_code') {
      const code = f.get('code') ?? '';
      const rec = codes.get(code);
      codes.delete(code); // single use, even when the attempt fails
      if (!rec || now() - rec.createdAt > CODE_TTL_MS) { oerr(res, 400, 'invalid_grant', 'Bad Request'); return; }
      if (f.get('redirect_uri') !== rec.redirectUri) { oerr(res, 400, 'redirect_uri_mismatch', 'Bad Request'); return; }
      const verifier = f.get('code_verifier');
      if (!verifier) { oerr(res, 400, 'invalid_grant', 'Missing code verifier.'); return; }
      if (createHash('sha256').update(verifier).digest('base64url') !== rec.challenge) { oerr(res, 400, 'invalid_grant', 'Invalid code verifier.'); return; }
      let refresh: RefreshRec | undefined;
      if (rec.offline) {
        refresh = { token: `1//0fake-${rand(20)}`, scopes: rec.scopes, issuedAt: now(), revoked: false, accessTokens: new Set() };
        refreshTokens.set(refresh.token, refresh);
      }
      respond(rec.scopes, refresh, true); return;
    }
    if (grant === 'refresh_token') {
      const rec = refreshTokens.get(f.get('refresh_token') ?? '');
      const dead = !rec || rec.revoked || scenario.invalidGrant || (scenario.testingMode && now() - rec.issuedAt > TESTING_REFRESH_TTL_MS);
      if (!rec || dead) { oerr(res, 400, 'invalid_grant', 'Token has been expired or revoked.'); return; }
      respond(rec.scopes, rec, false); return;
    }
    oerr(res, 400, 'unsupported_grant_type', 'Invalid grant_type');
  }

  async function handleRevoke(req: IncomingMessage, res: ServerResponse) {
    const token = new URLSearchParams(await readBody(req)).get('token') ?? '';
    const rt = refreshTokens.get(token);
    if (rt && !rt.revoked) {
      rt.revoked = true;
      for (const a of rt.accessTokens) {
        const at = accessTokens.get(a);
        if (at) at.revoked = true;
      }
      state.revokedCount++;
      send(res, 200, {}, { 'cache-control': 'no-store' }); return;
    }
    const at = accessTokens.get(token);
    if (at && !at.revoked) {
      at.revoked = true;
      state.revokedCount++;
      send(res, 200, {}, { 'cache-control': 'no-store' }); return;
    }
    oerr(res, 400, 'invalid_token', 'Token expired or revoked');
  }

  // ---- Calendar v3 -------------------------------------------------------
  const hasAny = (have: string[], want: string[]) => want.some((s) => have.includes(s));

  /** Returns the calendar, or null after having sent the error. */
  function authCalendar(res: ServerResponse, calId: string, scopes: string[], op: 'calendarList' | 'events', write: boolean): FakeCalendar | null {
    const cal = calendars.get(calId);
    if (!cal) {
      gerr(res, 404, 'notFound', 'Not Found');
      return null;
    }
    const broad =
      op === 'calendarList'
        ? hasAny(scopes, [S.calendar, S.calendarReadonly, S.calendarList, S.calendarListReadonly])
        : write
          ? hasAny(scopes, [S.calendar, S.events])
          : hasAny(scopes, [S.calendar, S.calendarReadonly, S.events, S.eventsReadonly]);
    const narrow = scopes.includes(S.appCreated) && cal.appCreated;
    if (!broad && !narrow) {
      gerr(res, 403, 'insufficientPermissions', 'Request had insufficient authentication scopes.', { status: 'PERMISSION_DENIED' });
      return null;
    }
    return cal;
  }

  /** Validates an event body (insert: full; patch: only what is present). Sends 400 and returns false on failure. */
  function validateEvent(res: ServerResponse, b: Json, full: boolean): boolean {
    const bad = (msg: string) => {
      gerr(res, 400, 'invalid', msg, { status: 'INVALID_ARGUMENT' });
      return false;
    };
    if (full && !b['start']) return bad('Missing end time.');
    if (full && !b['end']) return bad('Missing end time.');
    for (const k of ['start', 'end'] as const) {
      const v = b[k];
      if (v === undefined) continue;
      if (!isObj(v) || typeof v['dateTime'] !== 'string') return bad('Invalid value for: ' + k);
      const dt = v['dateTime'];
      const okTz = typeof v['timeZone'] === 'string' && RFC3339_NAIVE.test(dt);
      if (!(RFC3339_OFFSET.test(dt) || okTz) || Number.isNaN(Date.parse(okTz && !RFC3339_OFFSET.test(dt) ? `${dt}Z` : dt))) {
        return bad('Invalid value for: ' + k + '.dateTime (RFC3339 with offset, or paired with timeZone, required)');
      }
    }
    const r = b['reminders'];
    if (isObj(r)) {
      const ov = r['overrides'];
      if (Array.isArray(ov) && ov.length > 5) return bad('The maximum number of override reminders is 5.');
      if (r['useDefault'] === true && Array.isArray(ov) && ov.length > 0) return bad('Cannot specify both default reminders and overrides at the same time.');
    }
    return true;
  }

  const newEtag = () => `"${rand(8)}"`;

  async function handleCalendar(req: IncomingMessage, res: ServerResponse, url: URL) {
    const auth = req.headers.authorization ?? '';
    const tok = /^Bearer (.+)$/.exec(auth)?.[1];
    const at = tok ? accessTokens.get(tok) : undefined;
    if (!at || at.revoked || at.expiresAt <= now()) {
      gerr(res, 401, 'authError', 'Request had invalid authentication credentials. Expected OAuth 2 access token, login cookie or other valid authentication credential. See https://developers.google.com/identity/sign-in/web/devconsole-project.', { status: 'UNAUTHENTICATED' }); return;
    }
    if (scenario.rateLimitNext > 0) {
      scenario.rateLimitNext--;
      gerr(res, 429, 'rateLimitExceeded', 'Rate Limit Exceeded', { domain: 'usageLimits', headers: { 'retry-after': '1' } }); return;
    }
    const scopes = at.scopes;
    const segs = url.pathname.replace(/^\/calendar\/v3\//, '').split('/').map(decodeURIComponent);
    const m = req.method ?? 'GET';
    const parseBody = async (): Promise<Json | null> => {
      const text = await readBody(req);
      try {
        const v: unknown = text ? JSON.parse(text) : {};
        if (isObj(v)) return v;
      } catch { /* fallthrough */ }
      gerr(res, 400, 'parseError', 'Parse Error');
      return null;
    };

    // calendars.insert
    if (m === 'POST' && segs.length === 1 && segs[0] === 'calendars') {
      if (!hasAny(scopes, [S.calendar, S.appCreated])) {
        gerr(res, 403, 'insufficientPermissions', 'Request had insufficient authentication scopes.', { status: 'PERMISSION_DENIED' }); return;
      }
      const b = await parseBody();
      if (!b) return;
      const parsed = RawCalendarInsertBodySchema.safeParse(b);
      if (!parsed.success) { gerr(res, 400, 'required', 'Missing summary.', { status: 'INVALID_ARGUMENT' }); return; }
      const id = `${rand(16)}@group.calendar.google.com`;
      const cal: FakeCalendar = {
        id,
        summary: parsed.data.summary,
        timeZone: parsed.data.timeZone ?? 'UTC',
        ...(parsed.data.description === undefined ? {} : { description: parsed.data.description }),
        appCreated: true,
        events: new Map(),
      };
      calendars.set(id, cal);
      const created: Json = { kind: 'calendar#calendar', etag: newEtag(), id, summary: cal.summary, timeZone: cal.timeZone };
      if (cal.description !== undefined) created['description'] = cal.description;
      send(res, 200, created); return;
    }

    // calendarList.list (before calendarList.get: that one has the calendar id segment)
    if (m === 'GET' && segs.length === 3 && segs[0] === 'users' && segs[1] === 'me' && segs[2] === 'calendarList') {
      const broad = hasAny(scopes, [S.calendar, S.calendarReadonly, S.calendarList, S.calendarListReadonly]);
      const narrow = scopes.includes(S.appCreated);
      if (scenario.forbidCalendarList === true || (!broad && !narrow)) {
        gerr(res, 403, 'insufficientPermissions', 'Request had insufficient authentication scopes.', { status: 'PERMISSION_DENIED' });
        return;
      }
      const visible = [...calendars.values()].filter((c) => broad || c.appCreated);
      const max = Math.min(Math.max(Number(url.searchParams.get('maxResults') ?? 250) || 250, 1), 250);
      const offset = Number(Buffer.from(url.searchParams.get('pageToken') ?? '', 'base64url').toString() || 0) || 0;
      const slice = visible.slice(offset, offset + max);
      const items = slice.map((cal) => {
        const entry: Json = {
          kind: 'calendar#calendarListEntry',
          etag: newEtag(),
          id: cal.id,
          summary: cal.summary,
          timeZone: cal.timeZone,
          accessRole: 'owner',
        };
        if (cal.description !== undefined) entry['description'] = cal.description;
        return entry;
      });
      const body: Json = { kind: 'calendar#calendarList', etag: newEtag(), items };
      if (offset + max < visible.length) body['nextPageToken'] = Buffer.from(String(offset + max)).toString('base64url');
      send(res, 200, body); return;
    }

    // calendarList.get
    if (m === 'GET' && segs.length === 4 && segs[0] === 'users' && segs[1] === 'me' && segs[2] === 'calendarList') {
      const cal = authCalendar(res, segs[3] ?? '', scopes, 'calendarList', false);
      if (!cal) return;
      send(res, 200, { kind: 'calendar#calendarListEntry', etag: newEtag(), id: cal.id, summary: cal.summary, timeZone: cal.timeZone, accessRole: 'owner' }); return;
    }

    if (segs[0] === 'calendars' && segs[2] === 'events' && segs.length >= 3 && segs.length <= 4) {
      const calId = segs[1] ?? '';
      const eventId = segs[3];

      if (eventId === undefined && m === 'POST') {
        const cal = authCalendar(res, calId, scopes, 'events', true);
        if (!cal) return;
        const b = await parseBody();
        if (!b) return;
        if (!RawEventBodySchema.safeParse(b).success) { gerr(res, 400, 'invalid', 'Invalid value', { status: 'INVALID_ARGUMENT' }); return; }
        const id = typeof b['id'] === 'string' ? b['id'] : rand(13).slice(0, 26).replace(/[w-z]/g, 'a');
        if (!EVENT_ID_RE.test(id)) { gerr(res, 400, 'invalid', 'Invalid resource id value.', { status: 'INVALID_ARGUMENT' }); return; }
        if (!validateEvent(res, b, true)) return;
        if (cal.events.has(id)) { gerr(res, 409, 'duplicate', 'The requested identifier already exists.'); return; }
        const ts = iso();
        const status = b['status'] === 'cancelled' || b['status'] === 'tentative' ? b['status'] : 'confirmed';
        const reminders = isObj(b['reminders']) ? { useDefault: false, ...b['reminders'] } : { useDefault: true };
        const ev: FakeEvent = {
          ...b, kind: 'calendar#event', etag: newEtag(), id, status, htmlLink: `https://www.google.com/calendar/event?eid=${id}`,
          created: ts, updated: ts, iCalUID: `${id}@google.com`, sequence: 0, reminders,
        };
        cal.events.set(id, ev);
        send(res, 200, ev); return;
      }

      if (eventId === undefined && m === 'GET') {
        const cal = authCalendar(res, calId, scopes, 'events', false);
        if (!cal) return;
        const filters: Array<[string, string]> = [];
        for (const raw of url.searchParams.getAll('privateExtendedProperty')) {
          const i = raw.indexOf('=');
          if (i <= 0) { gerr(res, 400, 'invalid', 'Invalid privateExtendedProperty value; expected key=value.', { status: 'INVALID_ARGUMENT' }); return; }
          filters.push([raw.slice(0, i), raw.slice(i + 1)]);
        }
        const showDeleted = url.searchParams.get('showDeleted') === 'true';
        const max = Math.min(Math.max(Number(url.searchParams.get('maxResults') ?? 250) || 250, 1), 2500);
        const offset = Number(Buffer.from(url.searchParams.get('pageToken') ?? '', 'base64url').toString() || 0) || 0;
        const all = [...cal.events.values()].filter((e) => {
          if (e.status === 'cancelled' && !showDeleted) return false;
          const priv = (isObj(e['extendedProperties']) && isObj((e['extendedProperties'])['private']) ? (e['extendedProperties'])['private'] : {});
          return filters.every(([k, v]) => priv[k] === v);
        });
        const items = all.slice(offset, offset + max);
        const body: Json = { kind: 'calendar#events', etag: newEtag(), summary: cal.summary, timeZone: cal.timeZone, items };
        if (offset + max < all.length) body['nextPageToken'] = Buffer.from(String(offset + max)).toString('base64url');
        send(res, 200, body); return;
      }

      if (eventId !== undefined) {
        const write = m !== 'GET';
        const cal = authCalendar(res, calId, scopes, 'events', write);
        if (!cal) return;
        const ev = cal.events.get(eventId);
        if (m === 'GET') { if (ev) send(res, 200, ev); else gerr(res, 404, 'notFound', 'Not Found'); return; }
        if (m === 'DELETE') {
          if (!ev) { gerr(res, 404, 'notFound', 'Not Found'); return; }
          if (ev.status === 'cancelled') { gerr(res, 410, 'deleted', 'Resource has been deleted'); return; }
          ev.status = 'cancelled';
          ev.updated = iso();
          ev.etag = newEtag();
          send(res, 204); return;
        }
        if (m === 'PATCH') {
          const b = await parseBody();
          if (!b) return;
          if (!RawEventBodySchema.safeParse(b).success) { gerr(res, 400, 'invalid', 'Invalid value', { status: 'INVALID_ARGUMENT' }); return; }
          if (!ev) { gerr(res, 404, 'notFound', 'Not Found'); return; }
          if (ev.status === 'cancelled' && !scenario.revive) { gerr(res, 404, 'notFound', 'Not Found'); return; }
          if (!validateEvent(res, b, false)) return;
          const rest = { ...b };
          Reflect.deleteProperty(rest, 'id');
          const merged = deepMerge(ev, rest) as FakeEvent;
          if (ev.status === 'cancelled') merged.status = (typeof b['status'] === 'string' ? b['status'] : 'confirmed') as FakeEvent['status'];
          merged.sequence = ev.sequence + 1;
          merged.updated = iso();
          merged.etag = newEtag();
          cal.events.set(eventId, merged);
          send(res, 200, merged); return;
        }
      }
    }
    gerr(res, 404, 'notFound', 'Not Found');
  }

  // ---- admin (for the CLI process; in-process users call the handle) -----
  async function handleAdmin(req: IncomingMessage, res: ServerResponse, url: URL) {
    const body = async () => {
      const t = await readBody(req);
      return (t ? JSON.parse(t) : {}) as Json;
    };
    if (req.method === 'POST' && url.pathname === '/__admin/scenario') {
      Object.assign(scenario, await body());
      send(res, 200, scenario); return;
    }
    if (req.method === 'POST' && url.pathname === '/__admin/advance-clock') {
      const ms = Number((await body())['ms']);
      if (!Number.isFinite(ms)) { send(res, 400, { error: 'ms required' }); return; }
      clockOffset += ms;
      send(res, 200, { now: now() }); return;
    }
    if (req.method === 'GET' && url.pathname === '/__admin/state') {
      send(res, 200, {
        now: now(), scenario, revokedCount: state.revokedCount, requests: state.requests,
        calendars: [...calendars.values()].map((c) => ({ ...c, events: [...c.events.values()] })),
      }); return;
    }
    gerr(res, 404, 'notFound', 'Not Found');
  }

  // ---- HTTP server -------------------------------------------------------
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const rec: RequestRecord = { method: req.method ?? 'GET', path: url.pathname, query: url.search };
    state.requests.push(rec);
    res.on('finish', () => { rec.status = res.statusCode; });
    const run = async () => {
      if (req.method === 'OPTIONS') {
        res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET,POST,PATCH,PUT,DELETE' });
        return res.end();
      }
      const p = url.pathname;
      if (p.startsWith('/__admin/')) return handleAdmin(req, res, url);
      if ((p === '/authorize' || p === '/o/oauth2/v2/auth') && req.method === 'GET') { handleAuthorize(url, res); return; }
      if ((p === '/token' || p === '/oauth2/v4/token') && req.method === 'POST') return handleToken(req, res);
      if ((p === '/revoke' || p === '/o/oauth2/revoke') && req.method === 'POST') return handleRevoke(req, res);
      if (p.startsWith('/calendar/v3/')) return handleCalendar(req, res, url);
      gerr(res, 404, 'notFound', 'Not Found');
    };
    run().catch((e: unknown) => {
      if (!res.headersSent) gerr(res, 500, 'backendError', e instanceof Error ? e.message : 'Internal Error');
      else res.end();
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 0, opts.host ?? '127.0.0.1', () => { resolve(); });
  });
  const addr = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${String(addr.port)}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => { resolve(); });
      }),
    scenario,
    setScenario: (patch) => { Object.assign(scenario, patch); },
    advanceClock: (ms) => { clockOffset += ms; },
    now,
    seedCalendar: (id, summary) => seedCalendar(id, summary, false),
    state,
  };
}
