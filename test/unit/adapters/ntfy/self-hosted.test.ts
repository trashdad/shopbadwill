// T-123: phone push through a self-hosted ntfy server with an access token.
// MSW only (test/setup/vitest.setup.ts refuses any real host); placeholder
// hosts only. Covered: every request goes to the configured origin, the Bearer
// header is present only with a token, the host permission is checked for that
// exact host, the token never reaches the audit log, the store, the console or
// an error, and the topic tag covers the server as well as the topic.
import { HttpResponse, http } from 'msw';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { BrowserHttp } from '../../../../src/adapters/browser/http';
import {
  EMPTY_NTFY_STATE,
  NTFY_SERVER,
  NtfySink,
  cancelScheduledMessages,
  ntfyRequest,
  testPushRequest,
  topicTag,
  type NtfySettingsView,
  type NtfyStore,
} from '../../../../src/adapters/ntfy/ntfy-sink';
import type { DesiredEvent } from '../../../../src/domain/calendar/types';
import type { NtfyState } from '../../../../src/domain/storage/schema';
import { mswServer } from '../../../setup/vitest.setup';
import { FakeAuditLog } from '../../../fakes/ports/fake-audit-log';
import { FakeClock } from '../../../fakes/ports/fake-clock';
import { FakePermissions } from '../../../fakes/ports/fake-permissions';

const T0 = 1_750_000_000_000;
const HOUR = 3_600_000;
const SERVER = 'https://ntfy.example.com';
const SERVER_PATTERN = 'https://ntfy.example.com/*';
const TOPIC = 'sbw-abcdefghijklmnopqrstuvwxyz';
const TOKEN = 'tk_placeholdertokenplaceholder0';
const MESSAGE = { seq: 'sbw-1-15-0', title: 'Pyrex bowl', body: 'Ends in 15 min', clickUrl: 'https://shopgoodwill.com/item/1', fireAt: T0 + HOUR };

interface Captured {
  method: string;
  url: string;
  authorization: string | null;
}

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

function desiredEvent(itemId: number, endInMs: number): DesiredEvent {
  return {
    itemId,
    generation: 0,
    title: 'Pyrex bowl',
    description: 'Ends: soon',
    startUtc: new Date(T0 + endInMs).toISOString(),
    durationMin: 15,
    sourceUrl: `https://shopgoodwill.com/item/${String(itemId)}`,
    reminders: [
      { method: 'popup', minutes: 60 },
      { method: 'popup', minutes: 15 },
    ],
    privateProps: { sbwItemId: String(itemId), sbwGen: '0', sbwState: 'open' },
  };
}

/** Records every request to either server; `answer` picks the status (or a network error). */
function install(requests: Captured[], answer: (c: Captured) => number | 'error' = () => 200): void {
  const record = ({ request }: { request: Request }) => {
    const c = { method: request.method, url: request.url, authorization: request.headers.get('authorization') };
    requests.push(c);
    const status = answer(c);
    if (status === 'error') return HttpResponse.error();
    return new HttpResponse(null, { status });
  };
  for (const origin of [SERVER, NTFY_SERVER]) {
    mswServer.use(http.post(`${origin}/:topic`, record), http.delete(`${origin}/:topic/:seq`, record));
  }
}

function rig(opts: { server?: string; token?: string; granted?: string[] } = {}) {
  const clock = new FakeClock(T0);
  const audit = new FakeAuditLog(clock);
  const permissions = new FakePermissions({ origins: opts.granted ?? [SERVER_PATTERN] });
  const store = new MemStore();
  const requests: Captured[] = [];
  install(requests);
  const view: NtfySettingsView = {
    ntfy: { enabled: true, server: opts.server ?? SERVER, topic: TOPIC },
    ...(opts.token === undefined ? {} : { token: opts.token }),
    timeZone: 'America/New_York',
  };
  const sink = new NtfySink({
    http: new BrowserHttp({ now: () => clock.now() }),
    clock,
    permissions,
    audit,
    settings: () => Promise.resolve(structuredClone(view)),
    store,
    minIntervalMs: 0,
  });
  return { clock, audit, permissions, store, requests, view, sink };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the wire shape on a configured server', () => {
  it('publish and cancel go to the configured origin', () => {
    expect(ntfyRequest('publish', { server: SERVER, topic: TOPIC }, MESSAGE).url).toBe(`${SERVER}/${TOPIC}`);
    expect(ntfyRequest('cancel', { server: SERVER, topic: TOPIC }, { seq: 'sbw-1-15-0' }).url).toBe(`${SERVER}/${TOPIC}/sbw-1-15-0`);
    expect(ntfyRequest('publish', { server: 'https://ntfy.example.com:8443', topic: TOPIC }, MESSAGE).url).toBe(
      `https://ntfy.example.com:8443/${TOPIC}`,
    );
  });

  it('sends Authorization: Bearer only when a token is set', () => {
    const withToken = { server: SERVER, topic: TOPIC, token: TOKEN };
    expect(ntfyRequest('publish', withToken, MESSAGE).headers?.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(ntfyRequest('cancel', withToken, { seq: 'sbw-1-15-0' }).headers).toEqual({ Authorization: `Bearer ${TOKEN}` });
    expect(testPushRequest(withToken).headers?.Authorization).toBe(`Bearer ${TOKEN}`);

    const without = { server: SERVER, topic: TOPIC };
    expect(ntfyRequest('publish', without, MESSAGE).headers).not.toHaveProperty('Authorization');
    expect(ntfyRequest('cancel', without, { seq: 'sbw-1-15-0' }).headers).toBeUndefined();
    expect(testPushRequest(without).headers).not.toHaveProperty('Authorization');
    expect(ntfyRequest('publish', { ...without, token: '' }, MESSAGE).headers).not.toHaveProperty('Authorization');
  });

  it('the test push is one immediate message: no delay, no sequence id', () => {
    const req = testPushRequest({ server: SERVER, topic: TOPIC });
    expect(req.method).toBe('POST');
    expect(req.url).toBe(`${SERVER}/${TOPIC}`);
    expect(req.credentials).toBe('omit');
    expect(req.headers).not.toHaveProperty('X-Delay');
    expect(req.headers).not.toHaveProperty('X-Sequence-ID');
    expect(req.body).toMatch(/ShopBadwill/);
  });

  it('refuses a server that is not a normalized https origin, without the topic or token in the error', () => {
    for (const server of ['http://ntfy.example.com', 'https://ntfy.example.com/path', 'https://user:pw@ntfy.example.com', '']) {
      let error: unknown;
      try {
        ntfyRequest('publish', { server, topic: TOPIC, token: TOKEN }, MESSAGE);
      } catch (e) {
        error = e;
      }
      expect(error, server).toBeInstanceOf(Error);
      expect(String(error)).not.toContain(TOPIC);
      expect(String(error)).not.toContain(TOKEN);
      expect(() => testPushRequest({ server, topic: TOPIC })).toThrow();
    }
  });
});

describe('the sink on a self-hosted server', () => {
  it('publishes to the configured origin with the Bearer token, and checks permission for that host', async () => {
    const r = rig({ token: TOKEN });
    const contains = vi.spyOn(r.permissions, 'contains');
    await r.sink.upsert(desiredEvent(7, 2 * HOUR));
    expect(r.requests.map((x) => [x.method, x.url])).toEqual([
      ['POST', `${SERVER}/${TOPIC}`],
      ['POST', `${SERVER}/${TOPIC}`],
    ]);
    expect(r.requests.every((x) => x.authorization === `Bearer ${TOKEN}`)).toBe(true);
    expect(contains).toHaveBeenCalledWith({ origins: [SERVER_PATTERN] });
    await r.sink.remove(7);
    expect(r.requests.filter((x) => x.method === 'DELETE').map((x) => [x.url, x.authorization])).toEqual([
      [`${SERVER}/${TOPIC}/sbw-7-60-0`, `Bearer ${TOKEN}`],
      [`${SERVER}/${TOPIC}/sbw-7-15-0`, `Bearer ${TOKEN}`],
    ]);
  });

  it('sends no Authorization header without a token', async () => {
    const r = rig();
    await r.sink.upsert(desiredEvent(7, 2 * HOUR));
    expect(r.requests).toHaveLength(2);
    expect(r.requests.every((x) => x.authorization === null)).toBe(true);
  });

  it('needs the permission for the configured host: ntfy.sh access does not count', async () => {
    const r = rig({ granted: ['https://ntfy.sh/*'] });
    await r.sink.upsert(desiredEvent(7, 2 * HOUR));
    expect(r.requests).toHaveLength(0);
    expect(r.store.state.status).toBe('needs-permission');
  });

  it('refuses a stored server that is not a normalized https origin (status disabled, no request)', async () => {
    for (const server of ['http://ntfy.example.com', 'https://ntfy.example.com/x', 'https://NTFY.example.com']) {
      const r = rig({ server, granted: [SERVER_PATTERN, 'https://NTFY.example.com/*'] });
      await r.sink.upsert(desiredEvent(7, 2 * HOUR));
      expect(r.requests, server).toHaveLength(0);
      expect(r.store.state.status, server).toBe('disabled');
    }
  });

  it('the token never reaches the audit log, sbw:ntfy, the console or a rejection (401, 5xx, network)', async () => {
    const spies = (['log', 'warn', 'error', 'info', 'debug'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => undefined));
    const r = rig({ token: TOKEN });
    await expect(r.sink.upsert(desiredEvent(7, 2 * HOUR))).resolves.toBeUndefined(); // published
    install(r.requests, () => 401);
    await expect(r.sink.upsert(desiredEvent(8, 2 * HOUR))).resolves.toBeUndefined();
    install(r.requests, () => 'error');
    await expect(r.sink.upsert(desiredEvent(9, 2 * HOUR))).resolves.toBeUndefined();
    await expect(r.sink.remove(7)).resolves.toBeUndefined();
    install(r.requests, () => 503);
    await expect(r.sink.upsert(desiredEvent(10, 2 * HOUR))).resolves.toBeUndefined();
    r.permissions.contains = () => Promise.reject(new Error(`boom Bearer ${TOKEN}`));
    await expect(r.sink.reconcile(() => Promise.resolve([desiredEvent(11, 2 * HOUR)]))).resolves.toBeUndefined();

    expect(r.audit.kinds).toContain('ntfy.failed');
    const stored = JSON.stringify([r.audit.entries, r.store.state]);
    expect(stored).not.toContain(TOKEN);
    expect(stored).not.toContain(TOKEN.slice(3));
    for (const s of spies) expect(s.mock.calls.flat().map(String).join('\n')).not.toContain(TOKEN);
  });
});

describe('topicTag covers the server and the topic', () => {
  it('differs between servers for the same topic, and between topics', () => {
    expect(topicTag(SERVER, TOPIC)).not.toBe(topicTag(NTFY_SERVER, TOPIC));
    expect(topicTag(SERVER, TOPIC)).not.toBe(topicTag(SERVER, 'sbw-zyxwvutsrqponmlkjihgfedcba'));
    expect(topicTag(SERVER, TOPIC)).toMatch(/^[0-9a-f]{8}$/);
  });

  it('keeps the T-118 tag for https://ntfy.sh, so records written before T-123 still count', () => {
    // 32-bit FNV-1a of the topic alone (T-118's formula).
    let h = 0x811c9dc5;
    for (let i = 0; i < TOPIC.length; i++) {
      h ^= TOPIC.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    expect(topicTag(NTFY_SERVER, TOPIC)).toBe(h.toString(16).padStart(8, '0'));
  });

  it('entries published on another server are never taken as scheduled here', async () => {
    const r = rig({ granted: [SERVER_PATTERN, 'https://ntfy.sh/*'], server: NTFY_SERVER });
    const e = desiredEvent(7, 2 * HOUR);
    await r.sink.upsert(e);
    expect(r.requests.filter((x) => x.url.startsWith(NTFY_SERVER))).toHaveLength(2);
    r.view.ntfy = { enabled: true, server: SERVER, topic: TOPIC }; // same topic, new server
    await r.sink.upsert(e);
    expect(r.requests.filter((x) => x.method === 'POST' && x.url.startsWith(SERVER))).toHaveLength(2);
    // nothing is DELETEd on the new server for seqs that were never there
    expect(r.requests.filter((x) => x.method === 'DELETE')).toHaveLength(0);
    expect(r.store.state.items['7']?.topicTag).toBe(topicTag(SERVER, TOPIC));
  });

  it('a server change mid-publish takes this pass pushes back off the old server', async () => {
    const r = rig({ granted: [SERVER_PATTERN, 'https://ntfy.sh/*'], server: NTFY_SERVER, token: TOKEN });
    let fired = false;
    mswServer.use(
      http.post(`${NTFY_SERVER}/:topic`, () => {
        if (!fired) {
          fired = true;
          r.store.state = structuredClone(EMPTY_NTFY_STATE);
          r.view.ntfy = { enabled: true, server: SERVER, topic: TOPIC };
        }
        return undefined;
      }),
    );
    await r.sink.upsert(desiredEvent(7, 2 * HOUR));
    const old = r.requests.filter((x) => x.url.startsWith(NTFY_SERVER));
    expect(old.filter((x) => x.method === 'POST')).toHaveLength(2);
    expect(old.filter((x) => x.method === 'DELETE')).toHaveLength(2);
    expect(r.store.state.items['7']).toBeUndefined();
  });
});

describe('cancelScheduledMessages on a configured server', () => {
  const seeded: NtfyState = {
    items: {
      7: {
        fingerprint: 'fp',
        entries: [
          { seq: 'sbw-7-60-0', leadMin: 60, fireAt: T0, status: 'scheduled' },
          { seq: 'sbw-7-15-0', leadMin: 15, fireAt: T0, status: 'deferred' },
        ],
      },
    },
  };

  it('DELETEs on the given server with the given token', async () => {
    const requests: Captured[] = [];
    install(requests);
    const clock = new FakeClock(T0);
    const result = await cancelScheduledMessages({
      server: SERVER,
      topic: TOPIC,
      token: TOKEN,
      state: seeded,
      http: new BrowserHttp({ now: () => clock.now() }),
      clock,
      minIntervalMs: 0,
    });
    expect(result.ok).toBe(true);
    expect(requests).toEqual([{ method: 'DELETE', url: `${SERVER}/${TOPIC}/sbw-7-60-0`, authorization: `Bearer ${TOKEN}` }]);
  });

  it('makes no request and reports failure for a server that is not allowed', async () => {
    const requests: Captured[] = [];
    install(requests);
    const clock = new FakeClock(T0);
    const result = await cancelScheduledMessages({
      server: 'http://ntfy.example.com',
      topic: TOPIC,
      state: seeded,
      http: new BrowserHttp({ now: () => clock.now() }),
      clock,
      minIntervalMs: 0,
    });
    expect(result.ok).toBe(false);
    expect(requests).toHaveLength(0);
  });
});
