import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  BUFFER_GIVE_UP_MS,
  installApiTap,
  MAX_BODY_CHARS,
  MAX_BUFFER_MESSAGES,
  TAP_SOURCE,
  type TapTarget,
} from '../../src/content/api-tap.main';
import { parseTapMessage } from '../../src/content/tap-message';

const NONCE = 'n-123';
const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJCdXllcklkIjoxfQ.c2ln';
const LISTING = 'https://buyerapi.shopgoodwill.com/api/Search/ItemListing';

class FakeXhr {
  status = 200;
  responseType = '';
  responseText = '';
  response: unknown = null;
  responseURL = '';
  headers: [string, string][] = [];
  listeners: (() => void)[] = [];
  openArgs: unknown[] = [];
  open(...a: unknown[]) {
    this.openArgs = a;
    return 'open-ret';
  }
  setRequestHeader(n: string, v: string) {
    this.headers.push([n, v]);
  }
  send() {
    return 'send-ret';
  }
  addEventListener(_t: 'load', cb: () => void) {
    this.listeners.push(cb);
  }
  finish() {
    this.listeners.forEach((l) => {
      l();
    });
  }
}

class FakeObserver {
  static instances: FakeObserver[] = [];
  disconnected = false;
  constructor(public cb: () => void) {
    FakeObserver.instances.push(this);
  }
  observe() {}
  disconnect() {
    this.disconnected = true;
  }
}

function makeWin(fetchImpl?: (...a: unknown[]) => unknown) {
  const posted: { msg: Record<string, unknown>; origin: string }[] = [];
  const attrs: Record<string, string> = { 'data-sbw-nonce': NONCE };
  const win = {
    XMLHttpRequest: class extends FakeXhr {} as unknown as { prototype: object },
    fetch: fetchImpl,
    MutationObserver: FakeObserver,
    postMessage: (msg: unknown, origin: string) => posted.push({ msg: msg as Record<string, unknown>, origin }),
    location: { href: 'https://shopgoodwill.com/home', origin: 'https://shopgoodwill.com' },
    document: { documentElement: { getAttribute: (n: string) => attrs[n] ?? null } },
  } satisfies TapTarget;
  return { win, posted, attrs };
}

function freshXhr(win: TapTarget, url: string, auth?: string) {
  const x = new (win.XMLHttpRequest as unknown as typeof FakeXhr)();
  x.open('GET', url);
  if (auth !== undefined) x.setRequestHeader('Authorization', auth);
  return x;
}

describe('api-tap XHR', () => {
  it('relays a buyerapi ItemListing response with the nonce', () => {
    const { win, posted } = makeWin();
    installApiTap(win);
    const x = freshXhr(win, LISTING);
    x.send();
    x.responseText = '{"searchResults":{"items":[]}}';
    x.finish();
    expect(posted).toHaveLength(1);
    expect(posted[0]?.origin).toBe('https://shopgoodwill.com');
    expect(posted[0]?.msg).toMatchObject({
      source: TAP_SOURCE,
      nonce: NONCE,
      kind: 'response',
      url: expect.stringContaining('ItemListing') as string,
      status: 200,
      body: { searchResults: { items: [] } },
    });
    expect(parseTapMessage(posted[0]?.msg, NONCE)).not.toBeNull();
  });

  it('ignores non-buyerapi traffic', () => {
    const { win, posted } = makeWin();
    installApiTap(win);
    const x = freshXhr(win, 'https://shopgoodwill.com/api/other', `Bearer ${JWT}`);
    x.send();
    x.finish();
    const y = freshXhr(win, 'https://evil.example/buyerapi.shopgoodwill.com/', `Bearer ${JWT}`);
    y.send();
    y.finish();
    expect(x.listeners).toHaveLength(0);
    expect(posted).toHaveLength(0);
  });

  it('relays the bearer once per change, bare, and only if JWT-shaped', () => {
    const { win, posted } = makeWin();
    installApiTap(win);
    freshXhr(win, LISTING, `Bearer ${JWT}`);
    freshXhr(win, LISTING, `Bearer ${JWT}`);
    freshXhr(win, LISTING, 'Bearer not-a-jwt');
    freshXhr(win, LISTING, `Basic ${JWT}`);
    expect(posted.map((p) => p.msg)).toEqual([{ source: TAP_SOURCE, nonce: NONCE, kind: 'token', bearer: JWT }]);
    const JWT2 = `${JWT}x`;
    freshXhr(win, LISTING, `Bearer ${JWT2}`);
    expect(posted).toHaveLength(2);
  });

  it('does not relay bodies for binary response types; sends tooLarge over 2 MB', () => {
    const { win, posted } = makeWin();
    installApiTap(win);
    const b = freshXhr(win, LISTING);
    b.responseType = 'blob';
    b.send();
    b.finish();
    expect(posted).toHaveLength(0);
    const big = freshXhr(win, LISTING);
    big.send();
    big.responseText = 'x'.repeat(MAX_BODY_CHARS + 1);
    big.finish();
    expect(posted[0]?.msg.body).toEqual({ tooLarge: true });
  });

  it('drops messages when no nonce has been set', () => {
    const { win, posted, attrs } = makeWin();
    delete attrs['data-sbw-nonce'];
    installApiTap(win);
    const x = freshXhr(win, LISTING, `Bearer ${JWT}`);
    x.send();
    x.finish();
    expect(posted).toHaveLength(0);
  });

  it('preserves return values, arguments and thrown exceptions', () => {
    const { win } = makeWin();
    const proto = win.XMLHttpRequest.prototype as FakeXhr;
    const boom = new Error('boom');
    proto.send = function () {
      throw boom;
    };
    installApiTap(win);
    const x = new (win.XMLHttpRequest as unknown as typeof FakeXhr)();
    expect(x.open('GET', LISTING, true)).toBe('open-ret');
    expect(x.openArgs).toEqual(['GET', LISTING, true]);
    expect(() => {
      x.send();
    }).toThrow(boom);
  });

  it('wrapping twice is a no-op', () => {
    const { win, posted } = makeWin(() => Promise.resolve(new Response('{}')));
    installApiTap(win);
    const open: unknown = (win.XMLHttpRequest.prototype as Record<string, unknown>).open;
    const fetchFn = win.fetch;
    installApiTap(win);
    expect((win.XMLHttpRequest.prototype as Record<string, unknown>).open).toBe(open);
    expect(win.fetch).toBe(fetchFn);
    const x = freshXhr(win, LISTING);
    x.send();
    x.responseText = '{}';
    x.finish();
    expect(posted).toHaveLength(1);
  });
});

describe('api-tap fetch', () => {
  it('relays a buyerapi response from a clone and leaves the original readable', async () => {
    const original = new Response('{"a":1}', { status: 200 });
    const { win, posted } = makeWin(() => Promise.resolve(original));
    installApiTap(win);
    const f = win.fetch as (u: string, i?: unknown) => Promise<Response>;
    const res = await f(LISTING, { headers: { Authorization: `Bearer ${JWT}` } });
    expect(res).toBe(original);
    await vi.waitFor(() => {
      expect(posted).toHaveLength(2);
    });
    expect(posted[0]?.msg).toMatchObject({ kind: 'token', bearer: JWT });
    expect(posted[1]?.msg).toMatchObject({ kind: 'response', status: 200, body: { a: 1 } });
    expect(await res.json()).toEqual({ a: 1 });
  });

  it('ignores non-buyerapi fetches', async () => {
    const { win, posted } = makeWin(() => Promise.resolve(new Response('{}')));
    installApiTap(win);
    await (win.fetch as (u: string) => Promise<Response>)('https://example.com/x');
    await Promise.resolve();
    expect(posted).toHaveLength(0);
  });

  it('passes rejections and synchronous throws through unchanged', async () => {
    const err = new Error('net');
    const a = makeWin(() => Promise.reject(err));
    installApiTap(a.win);
    await expect((a.win.fetch as (u: string) => Promise<unknown>)(LISTING)).rejects.toBe(err);
    const sync = new TypeError('sync');
    const b = makeWin(() => {
      throw sync;
    });
    installApiTap(b.win);
    expect(() => (b.win.fetch as (u: string) => unknown)(LISTING)).toThrow(sync);
  });

  it('preserves this and arguments', async () => {
    const calls: { self: unknown; args: unknown[] }[] = [];
    const { win } = makeWin(function (this: unknown, ...args: unknown[]) {
      calls.push({ self: this, args });
      return Promise.resolve(new Response('{}'));
    });
    installApiTap(win);
    const init = { method: 'POST' };
    await (win.fetch as (...a: unknown[]) => Promise<unknown>).call(win, LISTING, init);
    expect(calls[0]?.self).toBe(win);
    expect(calls[0]?.args[1]).toBe(init);
  });
});

describe('parseTapMessage (untrusted receiver)', () => {
  const ok = { source: TAP_SOURCE, nonce: NONCE, kind: 'response', url: LISTING, status: 200, body: {} };
  it('accepts a well-formed message', () => {
    expect(parseTapMessage(ok, NONCE)).toEqual(ok);
  });
  it('drops malformed messages, wrong nonce and wrong source', () => {
    for (const bad of [null, 'x', 42, {}, { ...ok, nonce: 'other' }, { ...ok, source: 'x' }, { ...ok, status: 'a' }, { ...ok, kind: 'zzz' }]) {
      expect(parseTapMessage(bad, NONCE)).toBeNull();
    }
  });
  it('drops non-buyerapi response URLs', () => {
    expect(parseTapMessage({ ...ok, url: 'https://evil.example/api' }, NONCE)).toBeNull();
  });
  it('drops tokens that are not JWT-shaped', () => {
    const tok = { source: TAP_SOURCE, nonce: NONCE, kind: 'token' };
    expect(parseTapMessage({ ...tok, bearer: JWT }, NONCE)).not.toBeNull();
    for (const bearer of ['abc', 'Bearer ' + JWT, 'a.b', '', 'a b.c.d', 5]) {
      expect(parseTapMessage({ ...tok, bearer }, NONCE)).toBeNull();
    }
  });
});

describe('api-tap early-request buffering', () => {
  afterEach(() => {
    vi.useRealTimers();
    FakeObserver.instances = [];
  });
  const run = (win: TapTarget, url: string, text: string) => {
    const x = freshXhr(win, url);
    x.send();
    x.responseText = text;
    x.finish();
  };
  const ns = (posted: { msg: Record<string, unknown> }[]) => posted.map((p) => (p.msg.body as { n: number }).n);

  it('nonce set before the first request: relayed immediately', () => {
    const { win, posted } = makeWin();
    installApiTap(win);
    run(win, LISTING, '{"n":1}');
    expect(posted).toHaveLength(1);
  });

  it('nonce set after two requests: both flushed in order via the observer', () => {
    const { win, posted, attrs } = makeWin();
    delete attrs['data-sbw-nonce'];
    installApiTap(win);
    run(win, LISTING, '{"n":1}');
    run(win, LISTING, '{"n":2}');
    expect(posted).toHaveLength(0);
    attrs['data-sbw-nonce'] = NONCE;
    FakeObserver.instances[0]?.cb();
    expect(ns(posted)).toEqual([1, 2]);
    expect(posted.every((p) => p.msg.nonce === NONCE)).toBe(true);
    expect(FakeObserver.instances[0]?.disconnected).toBe(true);
    run(win, LISTING, '{"n":3}');
    expect(posted).toHaveLength(3);
  });

  it('flushes lazily, in order, before the next message when no observer fires', () => {
    const { win, posted, attrs } = makeWin();
    delete attrs['data-sbw-nonce'];
    installApiTap(win);
    run(win, LISTING, '{"n":1}');
    attrs['data-sbw-nonce'] = NONCE;
    run(win, LISTING, '{"n":2}');
    expect(ns(posted)).toEqual([1, 2]);
  });

  it('keeps at most 50 messages, dropping the oldest', () => {
    const { win, posted, attrs } = makeWin();
    delete attrs['data-sbw-nonce'];
    installApiTap(win);
    for (let i = 0; i < MAX_BUFFER_MESSAGES + 5; i++) run(win, LISTING, `{"n":${String(i)}}`);
    attrs['data-sbw-nonce'] = NONCE;
    FakeObserver.instances[0]?.cb();
    expect(posted).toHaveLength(MAX_BUFFER_MESSAGES);
    expect(ns(posted)[0]).toBe(5);
  });

  it('caps the buffer at 1 MB total, dropping the oldest', () => {
    const { win, posted, attrs } = makeWin();
    delete attrs['data-sbw-nonce'];
    installApiTap(win);
    const chunk = 'y'.repeat(400_000);
    for (let i = 0; i < 4; i++) run(win, LISTING, chunk + String(i));
    attrs['data-sbw-nonce'] = NONCE;
    FakeObserver.instances[0]?.cb();
    expect(posted).toHaveLength(2);
    expect((posted[1]?.msg.body as string).endsWith('3')).toBe(true);
  });

  it('gives up after 15 s: buffer discarded, later messages dropped', () => {
    vi.useFakeTimers();
    const { win, posted, attrs } = makeWin();
    delete attrs['data-sbw-nonce'];
    installApiTap(win);
    run(win, LISTING, '{"n":1}');
    vi.advanceTimersByTime(BUFFER_GIVE_UP_MS + 1);
    attrs['data-sbw-nonce'] = NONCE;
    FakeObserver.instances[0]?.cb();
    expect(posted).toHaveLength(0);
  });
});

describe('api-tap bundle', () => {
  it('stays tiny and contains no zod', async () => {
    const { build } = await import('vite');
    const out = (await build({
      logLevel: 'silent',
      configFile: false,
      build: {
        write: false,
        minify: true,
        lib: { entry: 'src/entrypoints/api-tap.content.ts', formats: ['iife'], name: 'tap' },
        rollupOptions: { external: ['wxt/utils/define-content-script'], output: { globals: { 'wxt/utils/define-content-script': 'wxt' } } },
      },
    })) as unknown as { output: { type: string; code?: string }[] }[];
    const code = out.flatMap((o) => o.output).map((c) => c.code ?? '').join('');
    expect(code.length).toBeGreaterThan(500);
    expect(code.length).toBeLessThan(10 * 1024);
    expect(code).not.toMatch(/zod/i);
  }, 30_000);
});
