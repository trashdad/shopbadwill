// T-69: the ntfy ReminderSink (T-67's ReminderSink seam, I-34). Every request
// goes through MSW (test/setup/vitest.setup.ts refuses any real host), never to
// the real ntfy.sh. Covered: the three brief tests (5 days out → deferred; cancel
// → DELETE with the stored seq; disabled → no network) plus no-permission,
// topic redaction (R3), message privacy (R4), restart idempotency, end-time
// change republish, pacing, backoff and the registration hook.
import { HttpResponse, http } from 'msw';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { BrowserHttp } from '../../../../src/adapters/browser/http';
import {
  EMPTY_NTFY_STATE,
  NTFY_SERVER,
  NtfySink,
  buildMessage,
  fingerprintOf,
  ntfyRequest,
  sequenceId,
  type NtfyStore,
} from '../../../../src/adapters/ntfy/ntfy-sink';
import { CalendarSync } from '../../../../src/background/jobs/calendar-sync';
import { register } from '../../../../src/background/jobs/ntfy-reminders';
import type { DesiredEvent } from '../../../../src/domain/calendar/types';
import { Repo } from '../../../../src/domain/storage/repo';
import { STORAGE_KEYS, type NtfyState } from '../../../../src/domain/storage/schema';
import { formatDual } from '../../../../src/domain/time/pacific';
import type { JobRun } from '../../../../src/domain/watches/schema';
import type { CalendarApi } from '../../../../src/ports/calendar';
import { mswServer } from '../../../setup/vitest.setup';
import { FakeAuditLog } from '../../../fakes/ports/fake-audit-log';
import { FakeClock } from '../../../fakes/ports/fake-clock';
import { FakePermissions } from '../../../fakes/ports/fake-permissions';
import { FakeStorageAreas } from '../../../fakes/ports/fake-storage';
import { FakeSwitches } from '../../../fakes/ports/fake-switches';

const T0 = 1_750_000_000_000;
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const TOPIC = 'sbw-abcdefghijklmnopqrstuvwxyz';
const TIME_ZONE = 'America/New_York';

interface Captured {
  kind: 'post' | 'delete';
  url: string;
  headers: Record<string, string>;
  body: string;
  at: number;
}

/** In-memory NtfyStore mirroring the Repo wiring in ntfy-reminders.ts. */
class MemStore implements NtfyStore {
  state: NtfyState;
  constructor(seed: NtfyState = structuredClone(EMPTY_NTFY_STATE)) {
    this.state = structuredClone(seed);
  }
  load(): Promise<NtfyState> {
    return Promise.resolve(structuredClone(this.state));
  }
  update(fn: (s: NtfyState) => NtfyState): Promise<NtfyState> {
    this.state = structuredClone(fn(structuredClone(this.state)));
    return Promise.resolve(structuredClone(this.state));
  }
}

function desiredEvent(itemId: number, endInMs: number, gen = 0): DesiredEvent {
  return {
    itemId,
    generation: gen,
    title: 'Pyrex bowl',
    // Never sent anywhere (R4): prices, the max bid, anything the calendar description holds.
    description: 'Ends: soon\nCurrent price: $25.00\nYour max bid: $75.00',
    startUtc: new Date(T0 + endInMs).toISOString(),
    durationMin: 15,
    sourceUrl: `https://shopgoodwill.com/item/${String(itemId)}`,
    reminders: [
      { method: 'popup', minutes: 60 },
      { method: 'popup', minutes: 15 },
      { method: 'popup', minutes: 5 },
    ],
    privateProps: { sbwItemId: String(itemId), sbwGen: String(gen), sbwState: 'open' },
  };
}

interface Rig {
  clock: FakeClock;
  audit: FakeAuditLog;
  permissions: FakePermissions;
  store: MemStore;
  requests: Captured[];
  sink: NtfySink;
  /** Rebuilds the sink over the same store and clock (a worker restart). */
  restart(opts?: { enabled?: boolean }): NtfySink;
}

/** Installs MSW ntfy handlers that record every request and answer 200 by default. */
function installNtfy(
  requests: Captured[],
  clock: FakeClock,
  behavior?: (kind: 'post' | 'delete', n: number) => { status: number } | 'error',
): void {
  let posts = 0;
  let deletes = 0;
  mswServer.use(
    http.post(`${NTFY_SERVER}/:topic`, async ({ request }) => {
      posts += 1;
      const answer = behavior === undefined ? { status: 200 } : behavior('post', posts);
      const headers: Record<string, string> = {};
      request.headers.forEach((value, key) => {
        headers[key.toLowerCase()] = value;
      });
      requests.push({ kind: 'post', url: request.url, headers, body: await request.text(), at: clock.monotonic() });
      if (answer === 'error') return HttpResponse.error();
      return new HttpResponse(null, { status: answer.status });
    }),
    http.delete(`${NTFY_SERVER}/:topic/:seq`, ({ request }) => {
      deletes += 1;
      const answer = behavior === undefined ? { status: 200 } : behavior('delete', deletes);
      requests.push({ kind: 'delete', url: request.url, headers: {}, body: '', at: clock.monotonic() });
      if (answer === 'error') return HttpResponse.error();
      return new HttpResponse(null, { status: answer.status });
    }),
  );
}

function rig(
  opts: { enabled?: boolean; granted?: boolean; server?: string; topic?: string; minIntervalMs?: number } = {},
): Rig {
  const clock = new FakeClock(T0);
  const audit = new FakeAuditLog(clock);
  const permissions = new FakePermissions(opts.granted === false ? {} : { origins: ['https://ntfy.sh/*'] });
  const store = new MemStore();
  const requests: Captured[] = [];
  installNtfy(requests, clock);
  const current = {
    ntfy: { enabled: opts.enabled ?? true, server: opts.server ?? NTFY_SERVER, topic: opts.topic ?? TOPIC },
    timeZone: TIME_ZONE,
  };
  const mk = (): NtfySink =>
    new NtfySink({
      http: new BrowserHttp({ now: () => clock.now() }),
      clock,
      permissions,
      audit,
      settings: () => Promise.resolve(structuredClone(current)),
      store,
      minIntervalMs: opts.minIntervalMs ?? 0,
    });
  const r: Rig = {
    clock,
    audit,
    permissions,
    store,
    requests,
    sink: mk(),
    restart: (o = {}) => {
      if (o.enabled !== undefined) current.ntfy.enabled = o.enabled;
      r.sink = mk();
      return r.sink;
    },
  };
  return r;
}

/** Advances the FakeClock so pacers and awaits make progress. */
async function pump(clock: FakeClock, rounds = 50): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (clock.pendingTimers > 0) clock.advance(1000);
    else await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

async function until<T>(clock: FakeClock, fn: () => T | undefined, tries = 200): Promise<T> {
  for (let i = 0; i < tries; i++) {
    const v = fn();
    if (v !== undefined) return v;
    await new Promise<void>((resolve) => setImmediate(resolve));
    clock.advance(1000); // also drives the sink's 1 s pacer (the registered sink uses the production default)
  }
  throw new Error('condition was not met in time');
}

afterEach(() => {
  vi.restoreAllMocks();
});

// ── Wire shape (R5: provisional, one function) ───────────────────────────────

describe('ntfyRequest (provisional wire shape)', () => {
  it('builds the publish request: POST https://ntfy.sh/<topic>, plain text, the five headers', () => {
    const req = ntfyRequest('publish', 'sbw-abc', {
      seq: 'sbw-1-15-0',
      title: 'Pyrex bowl',
      body: 'Ends in 15 min',
      clickUrl: 'https://shopgoodwill.com/item/1',
      fireAt: T0 + 15 * MIN,
    });
    expect(req.url).toBe(`${NTFY_SERVER}/sbw-abc`);
    expect(req.method).toBe('POST');
    expect(req.body).toBe('Ends in 15 min');
    expect(req.credentials).toBe('omit');
    expect(req.headers).toEqual({
      'X-Title': 'Pyrex bowl',
      'X-Click': 'https://shopgoodwill.com/item/1',
      'X-Tags': 'hourglass',
      'X-Delay': String(Math.floor((T0 + 15 * MIN) / 1000)),
      'X-Sequence-ID': 'sbw-1-15-0',
    });
  });

  it('builds the cancel request: DELETE https://ntfy.sh/<topic>/<seq>', () => {
    const req = ntfyRequest('cancel', 'sbw-abc', { seq: 'sbw-1-15-0' });
    expect(req.url).toBe(`${NTFY_SERVER}/sbw-abc/sbw-1-15-0`);
    expect(req.method).toBe('DELETE');
    expect(req.headers).toBeUndefined();
    expect(req.body).toBeUndefined();
  });
});

describe('ids and message content', () => {
  it('sequenceId is deterministic per item, lead and generation', () => {
    expect(sequenceId(279250057, 15, 0)).toBe('sbw-279250057-15-0');
    expect(sequenceId(279250057, 15, 1)).toBe('sbw-279250057-15-1');
  });

  it('fingerprintOf covers the end time, generation and reminder minutes', () => {
    const e = desiredEvent(1, 2 * HOUR);
    expect(fingerprintOf(e)).toBe(`${e.startUtc}|0|60,15,5`);
    expect(fingerprintOf({ ...e, generation: 1 })).toBe(`${e.startUtc}|1|60,15,5`);
    expect(fingerprintOf(desiredEvent(1, 3 * HOUR))).not.toBe(fingerprintOf(e));
  });

  it('buildMessage holds only the title, the lead and the end time in the user zone; the link is separate', () => {
    const e = desiredEvent(1, 2 * HOUR);
    const msg = buildMessage(e, 15, TIME_ZONE);
    expect(msg.title).toBe('Pyrex bowl');
    expect(msg.clickUrl).toBe('https://shopgoodwill.com/item/1');
    expect(msg.body).toBe(`Ends in 15 min — ends ${formatDual(new Date(e.startUtc).getTime(), TIME_ZONE)}`);
    expect(msg.body).not.toContain('$');
    expect(msg.body).not.toContain('max bid');
  });
});

// ── R2: opt-in gate ──────────────────────────────────────────────────────────

describe('opt-in gate (R2)', () => {
  it('disabled → zero requests and a recorded status (the brief test)', async () => {
    const r = rig({ enabled: false });
    await r.sink.upsert(desiredEvent(1, 2 * HOUR));
    expect(r.requests).toHaveLength(0);
    expect(r.store.state.status).toBe('disabled');
    expect(r.store.state.items).toEqual({});
    expect(r.audit.entries.find((x) => x.kind === 'ntfy.status')?.details).toEqual({ status: 'disabled' });
  });

  it('no permission → zero requests and status needs-permission', async () => {
    const r = rig({ granted: false });
    await r.sink.upsert(desiredEvent(1, 2 * HOUR));
    expect(r.requests).toHaveLength(0);
    expect(r.store.state.status).toBe('needs-permission');
    expect(r.audit.entries.find((x) => x.kind === 'ntfy.status')?.details).toEqual({ status: 'needs-permission' });
  });

  it('a server other than https://ntfy.sh is refused (v1 supports only ntfy.sh)', async () => {
    const r = rig({ server: 'https://evil.example' });
    await r.sink.upsert(desiredEvent(1, 2 * HOUR));
    expect(r.requests).toHaveLength(0);
    expect(r.store.state.status).toBe('disabled');
  });

  it('an invalid topic is refused', async () => {
    const r = rig({ topic: 'not a topic!' });
    await r.sink.upsert(desiredEvent(1, 2 * HOUR));
    expect(r.requests).toHaveLength(0);
    expect(r.store.state.status).toBe('disabled');
  });

  it('the status is recorded once per change, and cleared when the sink runs again', async () => {
    const r = rig({ enabled: false });
    await r.sink.upsert(desiredEvent(1, 2 * HOUR));
    await r.sink.upsert(desiredEvent(1, 2 * HOUR));
    expect(r.audit.entries.filter((x) => x.kind === 'ntfy.status')).toHaveLength(1);

    r.restart({ enabled: true });
    await r.sink.upsert(desiredEvent(1, 2 * HOUR));
    expect(r.store.state.status).toBeUndefined();
    expect(r.audit.entries.filter((x) => x.kind === 'ntfy.status')).toHaveLength(2);
    expect(r.audit.entries.filter((x) => x.kind === 'ntfy.status').at(-1)?.details).toEqual({ status: 'ok' });
  });
});

// ── Scheduling and deferral (R5, R6) ─────────────────────────────────────────

describe('scheduling and deferral', () => {
  it('two hours out: publishes all three leads with the exact wire shape and stores them scheduled', async () => {
    const r = rig();
    const e = desiredEvent(7, 2 * HOUR);
    await r.sink.upsert(e);
    const endMs = new Date(e.startUtc).getTime();
    expect(r.requests.map((x) => x.kind)).toEqual(['post', 'post', 'post']);
    for (const [i, lead] of [60, 15, 5].entries()) {
      const req = r.requests[i];
      if (req === undefined) throw new Error('missing request');
      expect(req.url).toBe(`${NTFY_SERVER}/${TOPIC}`);
      expect(req.headers['x-title']).toBe('Pyrex bowl');
      expect(req.headers['x-click']).toBe('https://shopgoodwill.com/item/7');
      expect(req.headers['x-tags']).toBe('hourglass');
      expect(req.headers['x-delay']).toBe(String(Math.floor((endMs - lead * MIN) / 1000)));
      expect(req.headers['x-sequence-id']).toBe(sequenceId(7, lead, 0));
      expect(req.body).toContain(`Ends in ${String(lead)} min`);
      expect(req.body).toContain('ends');
    }
    const item = r.store.state.items['7'];
    expect(item?.fingerprint).toBe(fingerprintOf(e));
    expect(item?.entries.map((x) => x.status)).toEqual(['scheduled', 'scheduled', 'scheduled']);
    expect(item?.entries.map((x) => x.fireAt)).toEqual([endMs - 60 * MIN, endMs - 15 * MIN, endMs - 5 * MIN]);
    expect(r.audit.entries.filter((x) => x.kind === 'ntfy.published')).toHaveLength(3);
  });

  it('five days out (the brief test): nothing is sent and every lead is marked deferred', async () => {
    const r = rig();
    await r.sink.upsert(desiredEvent(7, 5 * DAY));
    expect(r.requests).toHaveLength(0);
    const item = r.store.state.items['7'];
    expect(item?.entries.map((x) => x.status)).toEqual(['deferred', 'deferred', 'deferred']);
    expect(r.audit.entries.filter((x) => x.kind === 'ntfy.deferred')).toHaveLength(3);
    expect(r.audit.entries.some((x) => x.kind === 'ntfy.published')).toBe(false);
  });

  it('a lead already past (within 10 s) is skipped entirely', async () => {
    const r = rig();
    await r.sink.upsert(desiredEvent(7, 2 * MIN));
    expect(r.requests).toHaveLength(0);
    expect(r.store.state.items['7']?.entries).toEqual([]);
  });

  it('promotes deferred leads when upsert is called again inside the 3-day window (the daily re-call)', async () => {
    const r = rig();
    const e = desiredEvent(7, 5 * DAY);
    await r.sink.upsert(e);
    expect(r.requests).toHaveLength(0);
    r.clock.advance(3 * DAY + 2 * HOUR); // now inside the window
    await r.sink.upsert(e);
    expect(r.requests.map((x) => x.kind)).toEqual(['post', 'post', 'post']);
    expect(r.store.state.items['7']?.entries.every((x) => x.status === 'scheduled')).toBe(true);
    expect(r.audit.entries.filter((x) => x.kind === 'ntfy.published')).toHaveLength(3);
  });
});

// ── Cancel (R6) ──────────────────────────────────────────────────────────────

describe('cancel', () => {
  it('remove sends DELETE with every stored seq, then forgets them (the brief test)', async () => {
    const r = rig();
    await r.sink.upsert(desiredEvent(7, 2 * HOUR));
    await r.sink.remove(7);
    expect(r.requests.slice(3).map((x) => x.kind)).toEqual(['delete', 'delete', 'delete']);
    for (const lead of [60, 15, 5]) {
      expect(r.requests.some((x) => x.kind === 'delete' && x.url === `${NTFY_SERVER}/${TOPIC}/${sequenceId(7, lead, 0)}`)).toBe(
        true,
      );
    }
    expect(r.store.state.items['7']).toBeUndefined();
    expect(r.audit.entries.filter((x) => x.kind === 'ntfy.cancelled')).toHaveLength(3);
    const n = r.requests.length;
    await r.sink.remove(7);
    expect(r.requests.length).toBe(n); // idempotent
  });

  it('an end-time change cancels the stored seqs and republishes with the new delays', async () => {
    const r = rig();
    await r.sink.upsert(desiredEvent(7, 2 * HOUR));
    const e2 = desiredEvent(7, 4 * HOUR);
    await r.sink.upsert(e2);
    const after = r.requests.slice(3);
    expect(after.slice(0, 3).every((x) => x.kind === 'delete')).toBe(true);
    expect(after.slice(3).map((x) => x.kind)).toEqual(['post', 'post', 'post']);
    // Same seqs (deterministic), new X-Delay for the new end time.
    for (const [i, lead] of [60, 15, 5].entries()) {
      expect(after[3 + i]?.headers['x-sequence-id']).toBe(sequenceId(7, lead, 0));
      expect(after[3 + i]?.headers['x-delay']).toBe(String(Math.floor((new Date(e2.startUtc).getTime() - lead * MIN) / 1000)));
    }
    expect(r.store.state.items['7']?.fingerprint).toBe(fingerprintOf(e2));
  });

  it('remove keeps entries whose DELETE failed (retried by a later remove) and never throws', async () => {
    const r = rig();
    installNtfy(r.requests, r.clock, (kind, n) => (kind === 'delete' && n === 2 ? 'error' : { status: 200 }));
    await r.sink.upsert(desiredEvent(7, 2 * HOUR));
    await r.sink.remove(7);
    expect(r.requests.filter((x) => x.kind === 'delete')).toHaveLength(3);
    expect(r.store.state.items['7']?.entries).toHaveLength(1);
    expect(r.audit.entries.filter((x) => x.kind === 'ntfy.failed').at(-1)?.details).toMatchObject({ error: 'network' });
  });

  it('remove while disabled makes zero requests and forgets nothing', async () => {
    const r = rig();
    await r.sink.upsert(desiredEvent(7, 2 * HOUR));
    r.restart({ enabled: false });
    await r.sink.remove(7);
    expect(r.requests.filter((x) => x.kind === 'delete')).toHaveLength(0);
    expect(r.store.state.items['7']?.entries).toHaveLength(3);
  });
});

// ── Idempotency (R5, R7) ─────────────────────────────────────────────────────

describe('idempotency', () => {
  it('a restart upsert with the same event publishes nothing again', async () => {
    const r = rig();
    const e = desiredEvent(7, 2 * HOUR);
    await r.sink.upsert(e);
    const before = structuredClone(r.store.state);
    r.restart();
    await r.sink.upsert(e);
    expect(r.requests.filter((x) => x.kind === 'post')).toHaveLength(3);
    expect(r.store.state).toEqual(before);
  });

  it('an invalid sbw:ntfy record reads as empty through the Repo and cannot cause a resend storm', async () => {
    const areas = new FakeStorageAreas();
    const clock = new FakeClock(T0);
    const repo = new Repo(areas, clock);
    areas.local.seed({ [STORAGE_KEYS.ntfy]: { junk: 42 } });
    expect(await repo.find(STORAGE_KEYS.ntfy)).toBeUndefined();
    expect(areas.local.dump()['sbw:quarantine:sbw:ntfy']).toMatchObject({ value: { junk: 42 } });

    const requests: Captured[] = [];
    installNtfy(requests, clock);
    const sink = new NtfySink({
      http: new BrowserHttp({ now: () => clock.now() }),
      clock,
      permissions: new FakePermissions({ origins: ['https://ntfy.sh/*'] }),
      audit: new FakeAuditLog(clock),
      settings: () => Promise.resolve({ ntfy: { enabled: true, server: NTFY_SERVER, topic: TOPIC }, timeZone: TIME_ZONE }),
      store: {
        load: async () => (await repo.find(STORAGE_KEYS.ntfy)) ?? structuredClone(EMPTY_NTFY_STATE),
        update: (fn) =>
          repo.withLock(STORAGE_KEYS.ntfy, async () => {
            const cur = (await repo.find(STORAGE_KEYS.ntfy)) ?? structuredClone(EMPTY_NTFY_STATE);
            const next = fn(cur);
            await repo.set(STORAGE_KEYS.ntfy, next);
            return next;
          }),
      },
      minIntervalMs: 0,
    });
    await sink.upsert(desiredEvent(7, 2 * HOUR));
    // Same deterministic seqs as a clean run: ntfy overwrites, never duplicates.
    expect(requests.map((x) => x.headers['x-sequence-id'])).toEqual([
      sequenceId(7, 60, 0),
      sequenceId(7, 15, 0),
      sequenceId(7, 5, 0),
    ]);
  });
});

// ── Failures and pacing (R8) ─────────────────────────────────────────────────

describe('failures and pacing', () => {
  it('a 429 stops the sync: one request, a recorded backoff, later upserts wait, the next sync retries', async () => {
    const r = rig();
    installNtfy(r.requests, r.clock, (kind, n) => (kind === 'post' && n === 1 ? { status: 429 } : { status: 200 }));
    await r.sink.upsert(desiredEvent(7, 2 * HOUR));
    expect(r.requests.filter((x) => x.kind === 'post')).toHaveLength(1);
    expect(r.audit.kinds).toContain('ntfy.rate-limited');

    // Give up for this sync: other items make no request while the backoff holds.
    await r.sink.upsert(desiredEvent(8, 2 * HOUR));
    expect(r.requests.filter((x) => x.kind === 'post')).toHaveLength(1);

    // The next sync (after the backoff) retries the same event.
    r.clock.advance(61_000);
    await r.sink.upsert(desiredEvent(7, 2 * HOUR));
    expect(r.requests.filter((x) => x.kind === 'post')).toHaveLength(4);
  });

  it('a 5xx backs off the same way', async () => {
    const r = rig();
    installNtfy(r.requests, r.clock, (kind, n) => (kind === 'post' && n === 1 ? { status: 503 } : { status: 200 }));
    await r.sink.upsert(desiredEvent(7, 2 * HOUR));
    expect(r.requests.filter((x) => x.kind === 'post')).toHaveLength(1);
    expect(r.audit.kinds).toContain('ntfy.rate-limited');
    await r.sink.upsert(desiredEvent(8, 2 * HOUR));
    expect(r.requests.filter((x) => x.kind === 'post')).toHaveLength(1);
  });

  it('a network failure never throws, is audited without request details, and is retried by the next upsert', async () => {
    const r = rig();
    installNtfy(r.requests, r.clock, () => 'error');
    const e = desiredEvent(7, 2 * HOUR);
    await expect(r.sink.upsert(e)).resolves.toBeUndefined();
    const failed = r.audit.entries.filter((x) => x.kind === 'ntfy.failed');
    expect(failed).toHaveLength(3); // one per lead, no retry loop
    expect(failed[0]?.details).toEqual({ error: 'network', leadMin: 60 });
    expect(r.store.state.items['7']?.entries).toEqual([]);
    await r.sink.upsert(e); // retried by the next upsert, not retried in a loop
    expect(r.requests.filter((x) => x.kind === 'post')).toHaveLength(6); // 3 attempts + 3 retries
    expect(r.audit.entries.filter((x) => x.kind === 'ntfy.failed')).toHaveLength(6);
  });

  it('paces ntfy requests at least 1 s apart (monotonic clock)', async () => {
    const r = rig({ minIntervalMs: 1000 });
    const a = r.sink.upsert(desiredEvent(7, 2 * HOUR));
    await pump(r.clock);
    await a;
    const b = r.sink.upsert(desiredEvent(8, 2 * HOUR));
    await pump(r.clock);
    await b;
    expect(r.requests).toHaveLength(6);
    const starts = r.requests.map((x) => x.at);
    for (let i = 1; i < starts.length; i++) {
      expect((starts[i] ?? 0) - (starts[i - 1] ?? 0), `request ${String(i)}`).toBeGreaterThanOrEqual(1000);
    }
  });
});

// ── Privacy (R3, R4) ─────────────────────────────────────────────────────────

describe('privacy', () => {
  it('published messages carry only the title, end time, lead and item link — never the max bid or other data', async () => {
    const r = rig();
    await r.sink.upsert(desiredEvent(7, 2 * HOUR));
    for (const req of r.requests) {
      const everything = JSON.stringify([req.url, req.headers, req.body]);
      expect(everything).not.toMatch(/\$75\.00|\$25\.00|max bid|Current price/i);
      expect(everything).not.toContain('snipe');
      expect(everything).not.toContain('@');
    }
    for (const req of r.requests.filter((x) => x.kind === 'post')) {
      // The title travels in X-Title; the body holds only the lead and the end
      // time. The only header fetch adds is the content-type.
      const keys = Object.keys(req.headers)
        .filter((k) => k.startsWith('x-'))
        .sort();
      expect(keys).toEqual(['x-click', 'x-delay', 'x-sequence-id', 'x-tags', 'x-title']);
      expect(req.body).not.toContain('Pyrex bowl');
    }
  });

  it('the topic never appears in the audit log, console output or thrown errors (R3)', async () => {
    const spies = ['log', 'warn', 'error', 'info', 'debug'].map((m) =>
      vi.spyOn(console, m as 'log' | 'warn' | 'error' | 'info' | 'debug').mockImplementation(() => undefined),
    );
    const r = rig();
    // A permissions port that fails with the full URL in its error: the sink must swallow and sanitise it.
    r.permissions.contains = () => Promise.reject(new Error(`browser error at https://ntfy.sh/${TOPIC}/boom`));
    await expect(r.sink.upsert(desiredEvent(7, 2 * HOUR))).resolves.toBeUndefined();

    // Publish failures must not leak the URL (which contains the topic) either.
    r.permissions.contains = () => Promise.resolve(true);
    installNtfy(r.requests, r.clock, () => 'error');
    await expect(r.sink.upsert(desiredEvent(7, 2 * HOUR))).resolves.toBeUndefined();

    const auditText = JSON.stringify(r.audit.entries);
    expect(auditText).not.toContain(TOPIC);
    expect(auditText).not.toContain('ntfy.sh/');
    for (const s of spies) {
      expect(s.mock.calls.flat().map(String).join('\n')).not.toContain(TOPIC);
      expect(s.mock.calls.flat().map(String).join('\n')).not.toContain('ntfy.sh/');
    }
  });
});

// ── Registration (R1: register from ntfy-reminders.ts) ───────────────────────

describe('registration', () => {
  it('register(ctx) feeds the sink through calendar sync and re-offers deferred reminders after a job run', async () => {
    const areas = new FakeStorageAreas();
    const clock = new FakeClock(T0);
    const repo = new Repo(areas, clock);
    const audit = new FakeAuditLog(clock);
    const switches = new FakeSwitches();
    const requests: Captured[] = [];
    installNtfy(requests, clock);

    const s = structuredClone(await repo.get(STORAGE_KEYS.settings));
    s.calendar.enabled = true;
    s.dryRun.calendar = false;
    s.ntfy = { enabled: true, server: NTFY_SERVER, topic: TOPIC };
    await repo.set(STORAGE_KEYS.settings, s);
    await repo.update(STORAGE_KEYS.tracked, (cur) => ({
      ...cur,
      7: {
        itemId: 7,
        title: 'Pyrex bowl',
        endTime: new Date(T0 + 5 * DAY).toISOString(),
        sellerId: 3,
        reasons: [{ kind: 'manual' }],
        favoriteState: 'none',
        calendar: true,
        addedAt: T0,
        updatedAt: T0,
      },
    }));

    const ctx = {
      repo,
      audit,
      clock,
      storage: areas,
      http: new BrowserHttp({ now: () => clock.now() }),
      permissions: new FakePermissions({ origins: ['https://ntfy.sh/*'] }),
      switches,
      lifecycle: {
        onStartup: (): (() => void) => () => undefined,
        onInstalled: (): (() => void) => () => undefined,
      },
    };
    register(ctx as never);

    // Calendar sync feeds the registered sink: 5 days out → deferred, nothing sent.
    const sync = new CalendarSync({
      repo,
      audit,
      clock,
      storage: areas.local,
      api: stubCalendarApi(),
      switches,
      google: {
        status: () =>
          Promise.resolve({
            connected: false,
            provider: 'none',
            grantedScopes: [],
            needsInteraction: false,
            configured: false,
          }),
      },
      notifier: { notify: () => Promise.resolve('') },
      permissions: ctx.permissions,
      badge: { set: () => undefined },
      minIntervalMs: 0,
    });
    await sync.syncNow('test');
    expect(requests).toHaveLength(0);
    expect((await repo.find(STORAGE_KEYS.ntfy))?.items['7']?.entries.every((x) => x.status === 'deferred')).toBe(true);

    // The daily job finishes days later: the registration hook re-offers the
    // now-due deferred reminders (R1: the re-call schedules them).
    clock.advance(3 * DAY + 2 * HOUR);
    const run: JobRun = {
      id: 'run-1',
      trigger: 'manual',
      startedAt: clock.now(),
      finishedAt: clock.now(),
      status: 'done',
      steps: [],
      cursor: 0,
      results: { newMatches: [], favorited: [], calendarUpserts: [], errors: [] },
    };
    await repo.set(STORAGE_KEYS.jobRuns, [run]);
    await until(clock, () => (requests.length === 3 ? requests : undefined));
    expect(requests.map((x) => x.kind)).toEqual(['post', 'post', 'post']);
    expect((await repo.find(STORAGE_KEYS.ntfy))?.items['7']?.entries.every((x) => x.status === 'scheduled')).toBe(true);
  });
});

function stubCalendarApi(): CalendarApi {
  const never = (): Promise<never> => {
    throw new Error('the disconnected path must not call the calendar API');
  };
  return {
    calendarsInsert: never,
    calendarListGet: never,
    calendarListList: never,
    eventsInsert: never,
    eventsGet: never,
    eventsPatch: never,
    eventsDelete: never,
    eventsListByPrivateProp: never,
  };
}
