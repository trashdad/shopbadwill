// T-64: Google Calendar v3 adapter behind the `CalendarApi` port (PLAN §3.8).
// Every response is parsed with the lenient schemas in ./schemas.ts and
// normalized to `GcalEvent`. Every failure surfaces as a `CalendarApiError`.
import type { GcalEvent, GcalEventBody } from '../../domain/calendar/types';
import type { Clock } from '../../ports/clock';
import type { CalendarApi } from '../../ports/calendar';
import { CalendarApiError, GoogleAuthError, HttpNetworkError, HttpTimeoutError, type CalendarApiErrorCode } from '../../ports/errors';
import type { GoogleAuthProvider } from '../../ports/google-auth';
import type { Http, HttpRequest, HttpResponse } from '../../ports/http';
import { RawCalendarListEntrySchema, RawCalendarListSchema, RawCalendarSchema, RawEventsListSchema, RawGoogleErrorSchema, normalizeEvent } from './schemas';

export const CALENDAR_BASE_URL = 'https://www.googleapis.com/calendar/v3';

export interface GoogleCalendarApiOptions {
  http: Http;
  auth: GoogleAuthProvider;
  /** Used only for backoff sleeps. */
  clock: Clock;
  baseUrl?: string;
  /** Total tries per call, first included. Default 5. */
  maxAttempts?: number;
  /** First backoff ceiling. Default 500 ms; it doubles per retry. */
  baseDelayMs?: number;
  /** Backoff ceiling. Default 16 000 ms. */
  maxDelayMs?: number;
  /** A Retry-After above this is not waited for: the call fails now. Default 60 000 ms. */
  maxRetryAfterMs?: number;
  requestTimeoutMs?: number;
  /** [0, 1) source for jitter; injectable for tests. */
  random?: () => number;
}

/** 403 reasons that mean "slow down" (retried with backoff). */
const RETRYABLE_RATE_REASONS = new Set(['rateLimitExceeded', 'userRateLimitExceeded']);
/** 403 reasons that are quota, not burst: reported as rate-limited but not retried. */
const QUOTA_REASONS = new Set(['quotaExceeded', 'dailyLimitExceeded', 'dailyLimitExceededUnreg']);
/** 403 reasons that mean the grant is not enough (the only ones that may prompt a reconnect). */
const SCOPE_REASONS = new Set(['insufficientPermissions', 'forbidden', 'accessNotConfigured']);
const MAX_LIST_PAGES = 20;

interface Failure {
  code: CalendarApiErrorCode;
  retryable: boolean;
}

/** Reasons from Google's `error.errors[]`, empty when the body is not Google's envelope. */
function errorReasons(bodyText: string): { reasons: string[]; message?: string } {
  try {
    const parsed = RawGoogleErrorSchema.safeParse(JSON.parse(bodyText));
    if (!parsed.success) return { reasons: [] };
    const err = parsed.data.error;
    const reasons = (err?.errors ?? []).flatMap((e) => (e.reason === undefined ? [] : [e.reason]));
    return err?.message === undefined ? { reasons } : { reasons, message: err.message };
  } catch {
    return { reasons: [] };
  }
}

function classify(status: number, reasons: string[]): Failure {
  if (status === 401) return { code: 'auth', retryable: false };
  if (status === 403) {
    if (reasons.some((r) => RETRYABLE_RATE_REASONS.has(r))) return { code: 'rate-limited', retryable: true };
    if (reasons.some((r) => QUOTA_REASONS.has(r))) return { code: 'rate-limited', retryable: false };
    if (reasons.some((r) => SCOPE_REASONS.has(r))) return { code: 'insufficient-scope', retryable: false };
    // forbiddenForNonOrganizer, notACalendarUser, proxy/HTML 403s: reconnecting would not help.
    return { code: 'other', retryable: false };
  }
  if (status === 404 || status === 410) return { code: 'not-found', retryable: false };
  if (status === 409) return { code: 'conflict', retryable: false };
  if (status === 429) return { code: 'rate-limited', retryable: true };
  if (status >= 500) return { code: 'other', retryable: true };
  return { code: 'other', retryable: false };
}

/** Retry-After as ms: delta-seconds or an HTTP date. Undefined when absent or unparseable. */
function parseRetryAfter(value: string | undefined, nowMs: number): number | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (/^\d+(\.\d+)?$/.test(trimmed)) return Math.round(Number(trimmed) * 1000);
  const at = new Date(trimmed).getTime();
  return Number.isNaN(at) ? undefined : Math.max(0, at - nowMs);
}

function header(res: HttpResponse, name: string): string | undefined {
  for (const [k, v] of Object.entries(res.headers)) if (k.toLowerCase() === name) return v;
  return undefined;
}

function authErrorToCalendarError(e: GoogleAuthError): CalendarApiError {
  const code: CalendarApiErrorCode =
    e.code === 'insufficient_scope' ? 'insufficient-scope' : e.code === 'rate_limited' ? 'rate-limited' : e.code === 'offline' ? 'offline' : 'auth';
  return new CalendarApiError(code, `Google auth: ${e.code}`, { cause: e });
}

export class GoogleCalendarApi implements CalendarApi {
  private readonly http: Http;
  private readonly auth: GoogleAuthProvider;
  private readonly clock: Clock;
  private readonly baseUrl: string;
  private readonly maxAttempts: number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly maxRetryAfterMs: number;
  private readonly timeoutMs: number;
  private readonly random: () => number;

  constructor(opts: GoogleCalendarApiOptions) {
    this.http = opts.http;
    this.auth = opts.auth;
    this.clock = opts.clock;
    this.baseUrl = (opts.baseUrl ?? CALENDAR_BASE_URL).replace(/\/+$/, '');
    this.maxAttempts = Math.max(1, Math.floor(opts.maxAttempts ?? 5));
    this.baseDelayMs = opts.baseDelayMs ?? 500;
    this.maxDelayMs = opts.maxDelayMs ?? 16_000;
    this.maxRetryAfterMs = opts.maxRetryAfterMs ?? 60_000;
    this.timeoutMs = opts.requestTimeoutMs ?? 15_000;
    this.random = opts.random ?? Math.random;
  }

  /**
   * NOT idempotent: Google assigns the id, so a retry after a lost response
   * would create a duplicate calendar. This call therefore never retries
   * (5xx, 429 and timeouts surface as errors). The caller (T-67
   * `ensureCalendar`) must reconcile possible duplicates by listing calendars
   * before creating a new one.
   */
  async calendarsInsert(summary: string, timeZone: string, description?: string): Promise<{ id: string }> {
    const body: { summary: string; timeZone: string; description?: string } = { summary, timeZone };
    if (description !== undefined) body.description = description;
    const res = await this.request('POST', '/calendars', { body, noRetry: true });
    const parsed = RawCalendarSchema.safeParse(this.json(res));
    if (!parsed.success) throw new CalendarApiError('schema', 'calendars.insert: response has no id', { status: res.status });
    return { id: parsed.data.id };
  }

  /**
   * One page is not enough: a dedicated calendar past the first page must
   * still be found, or the caller would create a duplicate.
   */
  async calendarListList(): Promise<Array<{ id: string; summary: string; description?: string }>> {
    const out: Array<{ id: string; summary: string; description?: string }> = [];
    let pageToken: string | undefined;
    for (let page = 0; page < MAX_LIST_PAGES; page++) {
      const q = new URLSearchParams({ maxResults: '250' });
      if (pageToken !== undefined) q.set('pageToken', pageToken);
      const res = await this.request('GET', `/users/me/calendarList?${q.toString()}`);
      const parsed = RawCalendarListSchema.safeParse(this.json(res));
      if (!parsed.success) throw new CalendarApiError('schema', 'calendarList.list: response is not an object', { status: res.status });
      for (const item of parsed.data.items ?? []) {
        const entry = RawCalendarListEntrySchema.safeParse(item);
        if (!entry.success) continue;
        const row: { id: string; summary: string; description?: string } = { id: entry.data.id, summary: entry.data.summary ?? '' };
        if (entry.data.description !== undefined) row.description = entry.data.description;
        out.push(row);
      }
      pageToken = parsed.data.nextPageToken;
      if (pageToken === undefined || pageToken === '') return out;
    }
    throw new CalendarApiError('other', `calendarList.list: more than ${String(MAX_LIST_PAGES)} pages`);
  }

  async calendarListGet(calendarId: string): Promise<{ id: string } | null> {
    const res = await this.request('GET', `/users/me/calendarList/${encodeURIComponent(calendarId)}`, { notFoundOk: true });
    if (res.status === 404 || res.status === 410) return null;
    const parsed = RawCalendarSchema.safeParse(this.json(res));
    if (!parsed.success) throw new CalendarApiError('schema', 'calendarList.get: response has no id', { status: res.status });
    return { id: parsed.data.id };
  }

  async eventsInsert(calendarId: string, body: GcalEventBody & { id: string }): Promise<GcalEvent> {
    const res = await this.request('POST', this.eventsPath(calendarId), { body });
    return this.event(res, 'events.insert');
  }

  /**
   * Returns a cancelled event with status 'cancelled' (the one read that can
   * see one), or null for 404/410. A normalized event whose
   * `extendedProperties.private.sbwItemId` is '' is NOT ours (a user event or
   * one stripped by hand): callers must not patch or delete it.
   */
  async eventsGet(calendarId: string, eventId: string): Promise<GcalEvent | null> {
    const res = await this.request('GET', this.eventsPath(calendarId, eventId), { notFoundOk: true });
    if (res.status === 404 || res.status === 410) return null;
    return this.event(res, 'events.get');
  }

  async eventsPatch(calendarId: string, eventId: string, patch: Partial<GcalEventBody>): Promise<GcalEvent> {
    const res = await this.request('PATCH', this.eventsPath(calendarId, eventId), { body: patch });
    return this.event(res, 'events.patch');
  }

  async eventsDelete(calendarId: string, eventId: string): Promise<void> {
    await this.request('DELETE', this.eventsPath(calendarId, eventId), { notFoundOk: true });
  }

  /**
   * Cancelled events are EXCLUDED from the list (Google's default; use
   * `eventsGet` to see one). Follows nextPageToken. A result with
   * `sbwItemId === ''` is NOT ours: callers must not patch or delete it.
   */
  async eventsListByPrivateProp(calendarId: string, key: string, value: string): Promise<GcalEvent[]> {
    const out: GcalEvent[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < MAX_LIST_PAGES; page++) {
      const q = new URLSearchParams({ privateExtendedProperty: `${key}=${value}`, maxResults: '250', singleEvents: 'true' });
      if (pageToken !== undefined) q.set('pageToken', pageToken);
      const res = await this.request('GET', `${this.eventsPath(calendarId)}?${q.toString()}`);
      const parsed = RawEventsListSchema.safeParse(this.json(res));
      if (!parsed.success) throw new CalendarApiError('schema', 'events.list: response is not an object', { status: res.status });
      for (const item of parsed.data.items ?? []) {
        // A malformed item (no id) is skipped; one bad row must not hide the others.
        const ev = normalizeEvent(item);
        if (ev !== undefined) out.push(ev);
      }
      pageToken = parsed.data.nextPageToken;
      if (pageToken === undefined || pageToken === '') return out;
    }
    throw new CalendarApiError('other', `events.list: more than ${String(MAX_LIST_PAGES)} pages`);
  }

  // ---- internals ---------------------------------------------------------

  private eventsPath(calendarId: string, eventId?: string): string {
    const base = `/calendars/${encodeURIComponent(calendarId)}/events`;
    return eventId === undefined ? base : `${base}/${encodeURIComponent(eventId)}`;
  }

  private json(res: HttpResponse): unknown {
    try {
      return JSON.parse(res.bodyText);
    } catch (cause) {
      throw new CalendarApiError('schema', 'response is not JSON', { status: res.status, cause });
    }
  }

  private event(res: HttpResponse, what: string): GcalEvent {
    const ev = normalizeEvent(this.json(res));
    if (ev === undefined) throw new CalendarApiError('schema', `${what}: response is not an event`, { status: res.status });
    return ev;
  }

  private async token(): Promise<string> {
    try {
      return await this.auth.getAccessToken({ interactive: false });
    } catch (e) {
      if (e instanceof GoogleAuthError) throw authErrorToCalendarError(e);
      throw new CalendarApiError('auth', 'could not get an access token', { cause: e });
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      this.clock.setTimeout(resolve, ms);
    });
  }

  /** Sends with backoff. Returns a 2xx response, or a 404/410 when `notFoundOk`. Throws CalendarApiError otherwise. */
  private async request(
    method: HttpRequest['method'],
    path: string,
    opts: { body?: unknown; notFoundOk?: boolean; noRetry?: boolean } = {},
  ): Promise<HttpResponse> {
    for (let attempt = 1; ; attempt++) {
      const token = await this.token();
      const req: HttpRequest = {
        url: `${this.baseUrl}${path}`,
        method,
        headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
        timeoutMs: this.timeoutMs,
        credentials: 'omit',
      };
      if (opts.body !== undefined) {
        req.body = JSON.stringify(opts.body);
        req.headers = { ...req.headers, 'content-type': 'application/json' };
      }

      let res: HttpResponse;
      try {
        res = await this.http.send(req);
      } catch (e) {
        if (e instanceof HttpNetworkError) throw new CalendarApiError('offline', e.message, { cause: e });
        if (e instanceof HttpTimeoutError) throw new CalendarApiError('other', e.message, { cause: e });
        throw new CalendarApiError('other', 'HTTP request failed', { cause: e });
      }

      if (res.status >= 200 && res.status < 300) return res;
      if (opts.notFoundOk === true && (res.status === 404 || res.status === 410)) return res;

      const { reasons, message } = errorReasons(res.bodyText);
      const failure = classify(res.status, reasons);
      const fail = (): CalendarApiError =>
        new CalendarApiError(failure.code, `${method} ${path} -> ${String(res.status)}${message === undefined ? '' : `: ${message}`}`, {
          status: res.status,
        });
      if (!failure.retryable || opts.noRetry === true || attempt >= this.maxAttempts) throw fail();

      const retryAfter = parseRetryAfter(header(res, 'retry-after'), this.clock.now());
      if (retryAfter !== undefined && retryAfter > this.maxRetryAfterMs) throw fail();
      await this.sleep(retryAfter ?? this.backoffMs(attempt));
    }
  }

  /** Exponential with equal jitter: half the ceiling plus a random half. */
  private backoffMs(attempt: number): number {
    const ceiling = Math.min(this.maxDelayMs, this.baseDelayMs * 2 ** (attempt - 1));
    return Math.round(ceiling / 2 + (this.random() * ceiling) / 2);
  }
}
