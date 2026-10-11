// T-69 review: cancelling stored ntfy messages (options disable / topic rotation).
// MSW only — never the real ntfy.sh. A wrong implementation that skips a seq,
// keeps going after a 429, or sends faster than 1/s fails here.
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';

import { BrowserHttp } from '../../../../src/adapters/browser/http';
import { NTFY_SERVER, cancelScheduledMessages } from '../../../../src/adapters/ntfy/ntfy-sink';
import { createNtfyScheduledStore } from '../../../../src/entrypoints/options/sections/ntfy/scheduled-store';
import { STORAGE_KEYS, parseNtfyState, type NtfyState } from '../../../../src/domain/storage/schema';
import { mswServer } from '../../../setup/vitest.setup';
import { FakeClock } from '../../../fakes/ports/fake-clock';

const T0 = 1_750_000_000_000;
const TOPIC = 'sbw-abcdefghijklmnopqrstuvwxyz';

interface Captured {
  url: string;
  method: string;
  at: number;
}

function state(): NtfyState {
  return {
    items: {
      7: {
        fingerprint: 'fp',
        entries: [
          { seq: 'sbw-7-60-0', leadMin: 60, fireAt: T0, status: 'scheduled' },
          { seq: 'sbw-7-15-0', leadMin: 15, fireAt: T0, status: 'deferred' },
          { seq: 'sbw-7-5-0', leadMin: 5, fireAt: T0, status: 'scheduled' },
        ],
      },
      8: {
        fingerprint: 'fp',
        entries: [{ seq: 'sbw-8-60-0', leadMin: 60, fireAt: T0, status: 'scheduled' }],
      },
    },
  };
}

function install(requests: Captured[], clock: FakeClock, statusFor: (n: number) => number | 'error' = () => 200): void {
  let n = 0;
  mswServer.use(
    http.delete(`${NTFY_SERVER}/:topic/:seq`, ({ request }) => {
      n += 1;
      requests.push({ url: request.url, method: request.method, at: clock.monotonic() });
      const status = statusFor(n);
      if (status === 'error') return HttpResponse.error();
      return new HttpResponse(null, { status });
    }),
    http.post(`${NTFY_SERVER}/:topic`, () => {
      throw new Error('cancel must not publish');
    }),
  );
}

async function pump(clock: FakeClock, rounds = 30): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (clock.pendingTimers > 0) clock.advance(1000);
  }
}

describe('cancelScheduledMessages', () => {
  it('DELETEs every stored scheduled seq on https://ntfy.sh and skips deferred ones', async () => {
    const clock = new FakeClock(T0);
    const requests: Captured[] = [];
    install(requests, clock);
    const result = await cancelScheduledMessages({
      topic: TOPIC,
      state: state(),
      http: new BrowserHttp({ now: () => clock.now() }),
      clock,
      minIntervalMs: 0,
    });
    expect(result).toEqual({ ok: true });
    expect(requests.map((r) => r.method)).toEqual(['DELETE', 'DELETE', 'DELETE']);
    expect(requests.map((r) => r.url)).toEqual([
      `${NTFY_SERVER}/${TOPIC}/sbw-7-60-0`,
      `${NTFY_SERVER}/${TOPIC}/sbw-7-5-0`,
      `${NTFY_SERVER}/${TOPIC}/sbw-8-60-0`,
    ]);
  });

  it('makes no request when nothing is scheduled, or the topic is not valid', async () => {
    const clock = new FakeClock(T0);
    const requests: Captured[] = [];
    install(requests, clock);
    const http = new BrowserHttp({ now: () => clock.now() });
    const empty = await cancelScheduledMessages({
      topic: TOPIC,
      state: { items: { 7: { fingerprint: 'fp', entries: [{ seq: 'sbw-7-60-0', leadMin: 60, fireAt: T0, status: 'deferred' }] } } },
      http,
      clock,
      minIntervalMs: 0,
    });
    const invalid = await cancelScheduledMessages({
      topic: 'not a topic',
      state: state(),
      http,
      clock,
      minIntervalMs: 0,
    });
    expect(empty).toEqual({ ok: true });
    expect(invalid).toEqual({ ok: false });
    expect(requests).toHaveLength(0);
  });

  it('stops on 429 and on 5xx and reports that the cancel did not finish', async () => {
    const clock = new FakeClock(T0);
    const requests: Captured[] = [];
    install(requests, clock, () => 429);
    const result = await cancelScheduledMessages({
      topic: TOPIC,
      state: state(),
      http: new BrowserHttp({ now: () => clock.now() }),
      clock,
      minIntervalMs: 0,
    });
    expect(result).toEqual({ ok: false });
    expect(requests).toHaveLength(1);

    const again: Captured[] = [];
    install(again, clock, () => 503);
    const second = await cancelScheduledMessages({
      topic: TOPIC,
      state: state(),
      http: new BrowserHttp({ now: () => clock.now() }),
      clock,
      minIntervalMs: 0,
    });
    expect(second).toEqual({ ok: false });
    expect(again).toHaveLength(1);
  });

  it('treats 404 as already gone and still cancels the rest', async () => {
    const clock = new FakeClock(T0);
    const requests: Captured[] = [];
    install(requests, clock, (n) => (n === 1 ? 404 : 200));
    const result = await cancelScheduledMessages({
      topic: TOPIC,
      state: state(),
      http: new BrowserHttp({ now: () => clock.now() }),
      clock,
      minIntervalMs: 0,
    });
    expect(result).toEqual({ ok: true });
    expect(requests).toHaveLength(3);
  });

  it('paces DELETEs at least 1 s apart and never throws the topic', async () => {
    const clock = new FakeClock(T0);
    const requests: Captured[] = [];
    install(requests, clock, () => 'error');
    const pending = cancelScheduledMessages({
      topic: TOPIC,
      state: state(),
      http: new BrowserHttp({ now: () => clock.now() }),
      clock,
      minIntervalMs: 1000,
    });
    const rejection = pending.then(
      () => undefined,
      (e: unknown) => e,
    );
    await pump(clock);
    const failed = await rejection;
    expect(failed).toBeUndefined();
    const result = await pending;
    expect(result).toEqual({ ok: false });
    expect(requests).toHaveLength(3);
    const starts = requests.map((r) => r.at);
    for (let i = 1; i < starts.length; i++) {
      expect((starts[i] ?? 0) - (starts[i - 1] ?? 0)).toBeGreaterThanOrEqual(1000);
    }
    expect(JSON.stringify(result)).not.toContain(TOPIC);
  });
});

describe('parseNtfyState', () => {
  it('reads missing or invalid sbw:ntfy as empty, and clear writes that empty record', async () => {
    expect(parseNtfyState(undefined)).toEqual({ items: {} });
    expect(parseNtfyState({ junk: 1 })).toEqual({ items: {} });
    expect(parseNtfyState(null)).toEqual({ items: {} });
    const mem: Record<string, unknown> = { [STORAGE_KEYS.ntfy]: { junk: 1 } };
    const store = createNtfyScheduledStore(() => ({
      get: (key) => Promise.resolve({ [key]: mem[key] }),
      set: (items) => {
        Object.assign(mem, items);
        return Promise.resolve();
      },
    }));
    expect(await store.load()).toEqual({ items: {} });
    await store.clear();
    expect(mem[STORAGE_KEYS.ntfy]).toEqual({ items: {} });
  });
});
