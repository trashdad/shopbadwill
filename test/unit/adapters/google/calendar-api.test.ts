import { describe, expect, it } from 'vitest';

import { GoogleCalendarApi } from '../../../../src/adapters/google/calendar-api';
import { normalizeEvent, rawTimeToMs } from '../../../../src/adapters/google/schemas';
import { GcalEventSchema, type GcalEventBody } from '../../../../src/domain/calendar/types';
import { CalendarApiError, GoogleAuthError, HttpNetworkError, HttpTimeoutError } from '../../../../src/ports/errors';
import { FakeClock } from '../../../fakes/ports/fake-clock';
import { FakeGoogleAuth } from '../../../fakes/ports/fake-google-auth';
import { FakeHttp } from '../../../fakes/ports/fake-http';

const BASE = 'https://www.googleapis.com/calendar/v3';

/** Records requested sleeps and fires them on the next microtask. */
class RecordingClock extends FakeClock {
  readonly delays: number[] = [];
  override setTimeout(fn: () => void, ms: number): number {
    this.delays.push(ms);
    queueMicrotask(fn);
    return 0;
  }
}

const gerr = (code: number, reason: string, message = 'm') => ({
  status: code,
  bodyText: JSON.stringify({ error: { code, message, errors: [{ message, domain: 'global', reason }] } }),
});
const rawEvent = (over: Record<string, unknown> = {}) => ({
  kind: 'calendar#event',
  etag: '"e1"',
  id: 'sbv1g0abc',
  status: 'confirmed',
  summary: 'SGW ends: lamp',
  description: 'd',
  start: { dateTime: '2026-10-08T02:18:30Z', timeZone: 'UTC' },
  end: { dateTime: '2026-10-08T02:33:30Z', timeZone: 'UTC' },
  reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 60 }] },
  extendedProperties: { private: { sbwItemId: '1', sbwGen: '0', sbwState: 'open' } },
  ...over,
});
const ok = (body: unknown, headers?: Record<string, string>) => ({ status: 200, bodyText: JSON.stringify(body), ...(headers ? { headers } : {}) });

function setup(opts: { random?: () => number; maxAttempts?: number; auth?: FakeGoogleAuth; minRetryDelayMs?: number } = {}) {
  const http = new FakeHttp(new FakeClock());
  const clock = new RecordingClock();
  const auth = opts.auth ?? new FakeGoogleAuth({ connected: true });
  const api = new GoogleCalendarApi({
    http,
    auth,
    clock,
    random: opts.random ?? (() => 1),
    // The backoff-shape tests below look at the raw curve; the 1 s floor has its own test.
    minRetryDelayMs: opts.minRetryDelayMs ?? 0,
    ...(opts.maxAttempts === undefined ? {} : { maxAttempts: opts.maxAttempts }),
  });
  return { http, clock, auth, api };
}
const body: GcalEventBody & { id: string } = {
  id: 'sbv1g0abc',
  summary: 's',
  description: 'd',
  start: { dateTime: '2026-10-08T02:18:30.000Z', timeZone: 'UTC' },
  end: { dateTime: '2026-10-08T02:33:30.000Z', timeZone: 'UTC' },
  reminders: { useDefault: false, overrides: [{ method: 'popup', minutes: 60 }] },
  extendedProperties: { private: { sbwItemId: '1', sbwGen: '0', sbwState: 'open' } },
};
async function code(p: Promise<unknown>): Promise<{ code: string; status: number | undefined }> {
  try {
    await p;
  } catch (e) {
    if (e instanceof CalendarApiError) return { code: e.code, status: e.status };
    throw e;
  }
  throw new Error('expected CalendarApiError');
}

describe('normalizeEvent (lenient)', () => {
  it('normalizes a full event to GcalEvent', () => {
    const ev = normalizeEvent(rawEvent());
    expect(GcalEventSchema.safeParse(ev).success).toBe(true);
    expect(ev).toMatchObject({ id: 'sbv1g0abc', etag: '"e1"', start: { dateTime: '2026-10-08T02:18:30.000Z', timeZone: 'UTC' } });
  });

  it('survives a missing description and missing reminders.overrides (after a stamp)', () => {
    const ev = normalizeEvent(rawEvent({ description: undefined, reminders: { useDefault: false } }));
    expect(ev?.description).toBe('');
    expect(ev?.reminders).toEqual({ useDefault: false, overrides: [] });
  });

  it('converts a user-edited time zone to UTC', () => {
    const ev = normalizeEvent(
      rawEvent({
        start: { dateTime: '2026-10-07T19:18:30-07:00', timeZone: 'America/Los_Angeles' },
        end: { dateTime: '2026-10-07T19:33:30-07:00', timeZone: 'America/Los_Angeles' },
      }),
    );
    expect(ev?.start).toEqual({ dateTime: '2026-10-08T02:18:30.000Z', timeZone: 'UTC' });
    expect(ev?.end.dateTime).toBe('2026-10-08T02:33:30.000Z');
  });

  it('resolves a naive dateTime plus a named zone', () => {
    expect(rawTimeToMs({ dateTime: '2026-10-07T19:18:30', timeZone: 'America/Los_Angeles' })).toBe(Date.parse('2026-10-08T02:18:30Z'));
    expect(rawTimeToMs({ dateTime: '2026-12-07T19:18:30', timeZone: 'America/Los_Angeles' })).toBe(Date.parse('2026-12-08T03:18:30Z'));
    expect(rawTimeToMs({ dateTime: '2026-10-07T19:18:30', timeZone: 'Not/AZone' })).toBe(Date.parse('2026-10-07T19:18:30Z'));
  });

  it('handles an all-day event, a cancelled stub, a missing end and junk fields', () => {
    expect(normalizeEvent(rawEvent({ start: { date: '2026-10-08' }, end: { date: '2026-10-09' } }))?.start.dateTime).toBe('2026-10-08T00:00:00.000Z');
    const stub = normalizeEvent({ id: 'sbv1g0abc', status: 'cancelled' });
    expect(stub).toMatchObject({ status: 'cancelled', summary: '', start: { dateTime: '1970-01-01T00:00:00.000Z' } });
    expect(normalizeEvent(rawEvent({ end: undefined }))?.end.dateTime).toBe('2026-10-08T02:33:30.000Z');
    const junk = normalizeEvent(
      rawEvent({
        status: 'weird',
        summary: 42,
        reminders: { overrides: [{ method: 'sms', minutes: 5 }, 'x', { method: 'popup', minutes: -3 }, { method: 'email', minutes: 10.4 }] },
        extendedProperties: { private: { sbwState: 'nope' } },
      }),
    );
    expect(junk).toMatchObject({
      status: 'confirmed',
      summary: '',
      reminders: { overrides: [{ method: 'popup', minutes: 0 }, { method: 'email', minutes: 10 }] },
      extendedProperties: { private: { sbwItemId: '', sbwGen: '', sbwState: 'open' } },
    });
  });

  it('caps reminders at 5 and rejects a body with no id', () => {
    const many = Array.from({ length: 8 }, (_, i) => ({ method: 'popup', minutes: i }));
    expect(normalizeEvent(rawEvent({ reminders: { overrides: many } }))?.reminders.overrides).toHaveLength(5);
    expect(normalizeEvent({ status: 'confirmed' })).toBeUndefined();
    expect(normalizeEvent('nope')).toBeUndefined();
  });
});

describe('GoogleCalendarApi requests and responses', () => {
  it('eventsInsert POSTs the body with a bearer token and returns the normalized event', async () => {
    const { api, http } = setup();
    http.on(`${BASE}/calendars/cal%40x/events`, ok(rawEvent()));
    const ev = await api.eventsInsert('cal@x', body);
    expect(ev.id).toBe('sbv1g0abc');
    const req = http.requests[0];
    expect(req).toMatchObject({ method: 'POST', credentials: 'omit' });
    expect(req?.headers?.['authorization']).toMatch(/^Bearer fake-token-/);
    expect(JSON.parse(req?.body ?? '')).toMatchObject({ id: 'sbv1g0abc', summary: 's' });
  });

  it('calendarsInsert and calendarListGet return ids; list 404 is null', async () => {
    const { api, http } = setup();
    http.on(`${BASE}/calendars`, ok({ kind: 'calendar#calendar', id: 'c1@group.calendar.google.com', summary: 'x' }));
    expect(await api.calendarsInsert('ShopGoodwill Auctions', 'UTC')).toEqual({ id: 'c1@group.calendar.google.com' });
    expect(JSON.parse(http.requests[0]?.body ?? '')).toEqual({ summary: 'ShopGoodwill Auctions', timeZone: 'UTC' });
    http.on(`${BASE}/users/me/calendarList/c1`, ok({ id: 'c1', accessRole: 'owner' }));
    expect(await api.calendarListGet('c1')).toEqual({ id: 'c1' });
    http.on(`${BASE}/users/me/calendarList/gone`, gerr(404, 'notFound'));
    expect(await api.calendarListGet('gone')).toBeNull();
  });

  it('eventsGet returns cancelled events and null for 404/410', async () => {
    const { api, http } = setup();
    http.on(`${BASE}/calendars/c/events/a`, ok({ id: 'a', status: 'cancelled' }));
    expect((await api.eventsGet('c', 'a'))?.status).toBe('cancelled');
    http.on(`${BASE}/calendars/c/events/b`, gerr(404, 'notFound'));
    expect(await api.eventsGet('c', 'b')).toBeNull();
    http.on(`${BASE}/calendars/c/events/d`, gerr(410, 'deleted'));
    expect(await api.eventsGet('c', 'd')).toBeNull();
  });

  it('eventsDelete is a no-op on 404/410 and succeeds on 204; patch 404 is not-found', async () => {
    const { api, http } = setup();
    http.on(`${BASE}/calendars/c/events/a`, { status: 204 });
    await api.eventsDelete('c', 'a');
    http.on(`${BASE}/calendars/c/events/b`, gerr(404, 'notFound'));
    await api.eventsDelete('c', 'b');
    http.on(`${BASE}/calendars/c/events/d`, gerr(410, 'deleted'));
    await api.eventsDelete('c', 'd');
    expect(await code(api.eventsPatch('c', 'b', { summary: 'x' }))).toEqual({ code: 'not-found', status: 404 });
  });

  it('eventsPatch sends only the patch', async () => {
    const { api, http } = setup();
    http.on(`${BASE}/calendars/c/events/a`, ok(rawEvent({ summary: 'new' })));
    const ev = await api.eventsPatch('c', 'a', { summary: 'new' });
    expect(ev.summary).toBe('new');
    expect(http.requests[0]).toMatchObject({ method: 'PATCH', body: '{"summary":"new"}' });
  });

  it('calendarListList returns id, summary and description and follows pages', async () => {
    const { api, http } = setup();
    http.on(`${BASE}/users/me/calendarList`, (req) =>
      req.url.includes('pageToken=p2')
        ? ok({ items: [{ id: 'marked@group.calendar.google.com', summary: 'Renamed', description: 'sbw:dedicated-calendar' }] })
        : ok({
            items: [{ id: 'c1', summary: 'ShopGoodwill Auctions' }, { summary: 'no id' }],
            nextPageToken: 'p2',
          }),
    );
    const out = await api.calendarListList();
    expect(out).toEqual([
      { id: 'c1', summary: 'ShopGoodwill Auctions' },
      { id: 'marked@group.calendar.google.com', summary: 'Renamed', description: 'sbw:dedicated-calendar' },
    ]);
    expect(new URL(http.requests[0]?.url ?? '').pathname).toBe('/calendar/v3/users/me/calendarList');
  });

  it('eventsListByPrivateProp encodes the filter and follows pages', async () => {
    const { api, http } = setup();
    http.on(`${BASE}/calendars/c/events`, (req) =>
      req.url.includes('pageToken=p2') ? ok({ items: [rawEvent({ id: 'sbv2g0abc' })] }) : ok({ items: [rawEvent(), { description: 'no id' }], nextPageToken: 'p2' }),
    );
    const out = await api.eventsListByPrivateProp('c', 'sbwItemId', 'a&b=1');
    expect(out.map((e) => e.id)).toEqual(['sbv1g0abc', 'sbv2g0abc']);
    expect(new URL(http.requests[0]?.url ?? '').searchParams.get('privateExtendedProperty')).toBe('sbwItemId=a&b=1');
  });

  it('a 2xx with a non-JSON or id-less body is a schema error', async () => {
    const { api, http } = setup();
    http.on(`${BASE}/calendars/c/events/a`, { status: 200, bodyText: '<html>' });
    expect((await code(api.eventsGet('c', 'a'))).code).toBe('schema');
    http.on(`${BASE}/calendars`, ok({ summary: 'no id' }));
    expect((await code(api.calendarsInsert('s', 'UTC'))).code).toBe('schema');
  });
});

describe('error mapping', () => {
  const cases: Array<[string, { status: number; bodyText: string }, string]> = [
    ['409 duplicate -> conflict', gerr(409, 'duplicate'), 'conflict'],
    ['401 -> auth', gerr(401, 'authError'), 'auth'],
    ['403 insufficientPermissions -> insufficient-scope', gerr(403, 'insufficientPermissions'), 'insufficient-scope'],
    ['403 forbidden -> insufficient-scope', gerr(403, 'forbidden'), 'insufficient-scope'],
    ['403 accessNotConfigured -> insufficient-scope', gerr(403, 'accessNotConfigured'), 'insufficient-scope'],
    ['403 forbiddenForNonOrganizer -> other', gerr(403, 'forbiddenForNonOrganizer'), 'other'],
    ['403 notACalendarUser -> other', gerr(403, 'notACalendarUser'), 'other'],
    ['403 HTML proxy body -> other', { status: 403, bodyText: '<html>blocked</html>' }, 'other'],
    ['403 dailyLimitExceeded -> rate-limited', gerr(403, 'dailyLimitExceeded'), 'rate-limited'],
    ['400 -> other', gerr(400, 'invalid'), 'other'],
  ];
  for (const [name, res, expected] of cases) {
    it(name, async () => {
      const { api, http, clock } = setup();
      http.on(BASE, res);
      expect((await code(api.eventsInsert('c', body))).code).toBe(expected);
      expect(http.requests).toHaveLength(1); // none of these retry
      expect(clock.delays).toEqual([]);
    });
  }

  it('maps HttpNetworkError to offline without retrying, and a timeout to other', async () => {
    const { api, http } = setup();
    http.on(`${BASE}/calendars/c/events/a`, { error: new HttpNetworkError('Failed to fetch') });
    expect((await code(api.eventsGet('c', 'a'))).code).toBe('offline');
    expect(http.requests).toHaveLength(1);
    http.on(`${BASE}/calendars/c/events/t`, { error: new HttpTimeoutError(1) });
    expect((await code(api.eventsGet('c', 't'))).code).toBe('other');
  });

  it('maps GoogleAuthError codes before any request', async () => {
    const auth = new FakeGoogleAuth({ connected: true });
    const { api, http } = setup({ auth });
    http.on(BASE, ok(rawEvent()));
    const expected: Array<[GoogleAuthError['code'], string]> = [
      ['invalid_grant', 'auth'],
      ['needs_interaction', 'auth'],
      ['insufficient_scope', 'insufficient-scope'],
      ['rate_limited', 'rate-limited'],
      ['offline', 'offline'],
    ];
    for (const [authCode, calCode] of expected) {
      auth.failNext = authCode;
      expect((await code(api.eventsGet('c', 'a'))).code).toBe(calCode);
    }
    expect(http.requests).toHaveLength(0);
  });
});

describe('calendarsInsert is not retried (non-idempotent)', () => {
  for (const [name, step] of [
    ['503', gerr(503, 'backendError')],
    ['429', gerr(429, 'rateLimitExceeded')],
    ['timeout', { error: new HttpTimeoutError(1) }],
  ] as const) {
    it(name, async () => {
      const { api, http, clock } = setup();
      http.on(`${BASE}/calendars`, step);
      await code(api.calendarsInsert('s', 'UTC'));
      expect(http.requests).toHaveLength(1);
      expect(clock.delays).toEqual([]);
    });
  }

  it('keeps the status in the message of an unmapped 403', async () => {
    const { api, http } = setup();
    http.on(BASE, gerr(403, 'notACalendarUser'));
    const e = await api.eventsGet('c', 'a').catch((x: unknown) => x);
    expect(e).toMatchObject({ code: 'other', status: 403, message: expect.stringContaining('403') as string });
  });
});

describe('backoff', () => {
  it('by default a retry never comes sooner than 1 s (Google calls are paced at 1 request/second, T-67)', async () => {
    const http = new FakeHttp(new FakeClock());
    const clock = new RecordingClock();
    const api = new GoogleCalendarApi({ http, auth: new FakeGoogleAuth({ connected: true }), clock, random: () => 0 });
    http.on(BASE, gerr(429, 'rateLimitExceeded'), gerr(503, 'backendError'), { ...gerr(429, 'rateLimitExceeded'), headers: { 'retry-after': '0' } }, ok(rawEvent()));
    await api.eventsInsert('c', body);
    expect(http.requests).toHaveLength(4);
    expect(clock.delays).toEqual([1000, 1000, 1000]);
  });

  it('retries 429 with exponential delays (equal jitter) then succeeds', async () => {
    const { api, http, clock } = setup({ random: () => 1 });
    http.on(BASE, gerr(429, 'rateLimitExceeded'), gerr(429, 'rateLimitExceeded'), gerr(503, 'backendError'), ok(rawEvent()));
    expect((await api.eventsInsert('c', body)).id).toBe('sbv1g0abc');
    expect(http.requests).toHaveLength(4);
    expect(clock.delays).toEqual([500, 1000, 2000]); // random=1 -> full ceiling
  });

  it('jitter keeps the delay within [ceiling/2, ceiling]', async () => {
    const { api, http, clock } = setup({ random: () => 0 });
    http.on(BASE, gerr(500, 'backendError'), ok(rawEvent()));
    await api.eventsInsert('c', body);
    expect(clock.delays).toEqual([250]);
  });

  it('retries 403 rateLimitExceeded and userRateLimitExceeded, then reports rate-limited at the cap', async () => {
    const { api, http, clock } = setup({ maxAttempts: 3 });
    http.on(BASE, gerr(403, 'userRateLimitExceeded'));
    expect(await code(api.eventsInsert('c', body))).toEqual({ code: 'rate-limited', status: 403 });
    expect(http.requests).toHaveLength(3);
    expect(clock.delays).toHaveLength(2);
  });

  it('gives up on a persistent 5xx as other, capped by maxAttempts', async () => {
    const { api, http } = setup({ maxAttempts: 4 });
    http.on(BASE, gerr(502, 'backendError'));
    expect(await code(api.eventsGet('c', 'a'))).toEqual({ code: 'other', status: 502 });
    expect(http.requests).toHaveLength(4);
  });

  it('caps the delay at maxDelayMs', async () => {
    const http = new FakeHttp(new FakeClock());
    const clock = new RecordingClock();
    const api = new GoogleCalendarApi({
      http, auth: new FakeGoogleAuth({ connected: true }), clock, random: () => 1, maxAttempts: 8, baseDelayMs: 1000, maxDelayMs: 3000,
    });
    http.on(BASE, gerr(503, 'backendError'));
    await code(api.eventsGet('c', 'a'));
    expect(clock.delays).toEqual([1000, 2000, 3000, 3000, 3000, 3000, 3000]);
  });

  it('honors Retry-After (seconds and HTTP date) over the computed backoff', async () => {
    const { api, http, clock } = setup();
    const inFive = new Date(clock.now() + 5000).toUTCString();
    http.on(`${BASE}/calendars/c/events/a`, { ...gerr(429, 'rateLimitExceeded'), headers: { 'retry-after': '2' } }, ok(rawEvent()));
    await api.eventsGet('c', 'a');
    http.on(`${BASE}/calendars/c/events/b`, { ...gerr(503, 'backendError'), headers: { 'Retry-After': inFive } }, ok(rawEvent()));
    await api.eventsGet('c', 'b');
    expect(clock.delays[0]).toBe(2000);
    expect(clock.delays[1]).toBeGreaterThanOrEqual(4000);
    expect(clock.delays[1]).toBeLessThanOrEqual(5000);
  });

  it('fails at once when Retry-After exceeds the tolerated wait', async () => {
    const { api, http, clock } = setup();
    http.on(BASE, { ...gerr(429, 'rateLimitExceeded'), headers: { 'retry-after': '3600' } });
    expect((await code(api.eventsGet('c', 'a'))).code).toBe('rate-limited');
    expect(http.requests).toHaveLength(1);
    expect(clock.delays).toEqual([]);
  });

  it('does not retry quota exhaustion, conflict or auth failures', async () => {
    const { api, http } = setup();
    http.on(BASE, gerr(403, 'quotaExceeded'));
    expect((await code(api.eventsGet('c', 'a'))).code).toBe('rate-limited');
    expect(http.requests).toHaveLength(1);
  });

  it('fetches a fresh token for every attempt', async () => {
    const { api, http, auth } = setup();
    http.on(BASE, gerr(429, 'rateLimitExceeded'), ok(rawEvent()));
    await api.eventsGet('c', 'a');
    expect(auth.tokensIssued).toBe(2);
    expect(auth.calls.every((c) => c.interactive === false)).toBe(true);
  });
});
