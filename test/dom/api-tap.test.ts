import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  BUFFER_GIVE_UP_MS,
  installApiTap,
  MAX_BODY_CHARS,
  MAX_BUFFER_MESSAGES,
  TAP_SOURCE,
  type TapTarget,
} from '../../src/content/api-tap.main';
import { MAX_BEARER_CHARS, MAX_NONCE_CHARS, MAX_URL_CHARS, parseTapMessage } from '../../src/content/tap-message';

const NONCE = 'n-123';
const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJCdXllcklkIjoxfQ.c2ln';
const JWT2 = `${JWT}x`;
const LISTING = 'https://buyerapi.shopgoodwill.com/api/Search/ItemListing';
const MARK = Symbol.for('sbw.apiTap.installed');

class FakeXhr {
  status = 200;
  responseType = '';
  responseText = '';
  response: unknown = null;
  responseURL = '';
  contentLength: string | null = null;
  headers: [string, string][] = [];
  listeners: (() => void)[] = [];
  openArgs: unknown[] = [];
  sendArgs: unknown[] = [];
  open(method: string, url: string, ...rest: unknown[]) {
    this.openArgs = [method, url, ...rest];
    return 'open-ret';
  }
  setRequestHeader(n: string, v: string) {
    this.headers.push([n, v]);
    return 'set-ret';
  }
  send(...a: unknown[]) {
    this.sendArgs = a;
    return 'send-ret';
  }
  getResponseHeader(n: string) {
    return n.toLowerCase() === 'content-length' ? this.contentLength : null;
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

type Posted = { msg: Record<string, unknown>; origin: string };

function makeWin(fetchImpl?: (...a: unknown[]) => unknown) {
  const posted: Posted[] = [];
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

const Xhr = (win: TapTarget) => win.XMLHttpRequest as unknown as typeof FakeXhr;

function freshXhr(win: TapTarget, url: string, auth?: string) {
  const x = new (Xhr(win))();
  x.open('GET', url);
  if (auth !== undefined) x.setRequestHeader('Authorization', auth);
  return x;
}

function run(win: TapTarget, url: string, text: string, configure?: (x: FakeXhr) => void) {
  const x = freshXhr(win, url);
  configure?.(x);
  x.send();
  x.responseText = text;
  x.finish();
  return x;
}

const bodies = (posted: Posted[]) => posted.map((p) => (p.msg.body as { n: number }).n);

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  FakeObserver.instances = [];
});

describe('api-tap XHR', () => {
  it('relays a buyerapi ItemListing response with the nonce', () => {
    const { win, posted } = makeWin();
    installApiTap(win);
    run(win, LISTING, '{"searchResults":{"items":[]}}');
    expect(posted).toHaveLength(1);
    expect(posted[0]?.origin).toBe('https://shopgoodwill.com');
    expect(posted[0]?.msg).toEqual({
      source: TAP_SOURCE,
      nonce: NONCE,
      kind: 'response',
      url: LISTING,
      status: 200,
      body: { searchResults: { items: [] } },
    });
    expect(parseTapMessage(posted[0]?.msg, NONCE)).not.toBeNull();
  });

  it('uses responseURL when present, else the opened URL', () => {
    const { win, posted } = makeWin();
    installApiTap(win);
    run(win, LISTING, '{}', (x) => {
      x.responseURL = 'https://buyerapi.shopgoodwill.com/api/Final';
    });
    run(win, LISTING, '{}');
    expect(posted.map((p) => p.msg.url)).toEqual(['https://buyerapi.shopgoodwill.com/api/Final', LISTING]);
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
    freshXhr(win, LISTING, `Bearer ${JWT2}`);
    expect(posted).toHaveLength(2);
  });

  it('matches the Authorization header name exactly (case-insensitive only)', () => {
    const { win, posted } = makeWin();
    installApiTap(win);
    for (const name of ['X-Authorization', 'Authorization-Extra', 'Proxy-Authorization', '']) {
      const x = new (Xhr(win))();
      x.open('GET', LISTING);
      x.setRequestHeader(name, `Bearer ${JWT}`);
    }
    expect(posted).toHaveLength(0);
    const x = new (Xhr(win))();
    x.open('GET', LISTING);
    x.setRequestHeader('aUtHoRiZaTiOn', `Bearer ${JWT}`);
    expect(posted).toHaveLength(1);
  });

  it('does not relay a token for non-buyerapi XHRs', () => {
    const { win, posted } = makeWin();
    installApiTap(win);
    freshXhr(win, 'https://example.com/x', `Bearer ${JWT}`);
    expect(posted).toHaveLength(0);
  });

  it('does not relay bodies for binary response types', () => {
    const { win, posted } = makeWin();
    installApiTap(win);
    for (const t of ['blob', 'arraybuffer', 'document']) {
      run(win, LISTING, '{}', (x) => {
        x.responseType = t;
      });
    }
    expect(posted).toHaveLength(0);
  });

  it('relays text and json response types', () => {
    const { win, posted } = makeWin();
    installApiTap(win);
    run(win, LISTING, '{"n":1}', (x) => {
      x.responseType = 'text';
    });
    const x = freshXhr(win, LISTING);
    x.responseType = 'json';
    x.response = { n: 2 };
    x.send();
    x.finish();
    expect(bodies(posted)).toEqual([1, 2]);
  });

  it('sends tooLarge over 2 MB (text, json by size, json by content-length)', () => {
    const { win, posted } = makeWin();
    installApiTap(win);
    run(win, LISTING, 'x'.repeat(MAX_BODY_CHARS + 1));
    const j = freshXhr(win, LISTING);
    j.responseType = 'json';
    j.response = { blob: 'z'.repeat(3 * 1024 * 1024) };
    j.send();
    j.finish();
    const k = freshXhr(win, LISTING);
    k.responseType = 'json';
    k.response = { small: true };
    k.contentLength = String(MAX_BODY_CHARS + 1);
    k.send();
    k.finish();
    const ok = freshXhr(win, LISTING);
    ok.responseType = 'json';
    ok.response = { small: true };
    ok.contentLength = String(MAX_BODY_CHARS);
    ok.send();
    ok.finish();
    expect(posted.map((p) => p.msg.body)).toEqual([
      { tooLarge: true },
      { tooLarge: true },
      { tooLarge: true },
      { small: true },
    ]);
  });

  it('drops messages when the nonce attribute is empty or missing', () => {
    const { win, posted, attrs } = makeWin();
    attrs['data-sbw-nonce'] = '';
    installApiTap(win);
    freshXhr(win, LISTING, `Bearer ${JWT}`);
    run(win, LISTING, '{"n":1}');
    expect(posted).toHaveLength(0);
  });

  it('preserves return values, arguments, send(body) and exceptions', () => {
    const { win } = makeWin();
    const boom = new Error('boom');
    (win.XMLHttpRequest.prototype as FakeXhr).send = function (this: FakeXhr, ...a: unknown[]) {
      this.sendArgs = a;
      if (a[0] === 'throw') throw boom;
      return 'send-ret';
    };
    installApiTap(win);
    const x = new (Xhr(win))();
    expect(x.open('GET', LISTING, true)).toBe('open-ret');
    expect(x.openArgs).toEqual(['GET', LISTING, true]);
    expect(x.setRequestHeader('Accept', 'x')).toBe('set-ret');
    expect(x.headers).toEqual([['Accept', 'x']]);
    const payload = { a: 1 };
    expect(x.send(payload as unknown as string)).toBe('send-ret');
    expect(x.sendArgs[0]).toBe(payload);
    expect(() => x.send('throw')).toThrow(boom);
  });

  it('forwards send(body) to the native send exactly', () => {
    const { win } = makeWin();
    installApiTap(win);
    const x = freshXhr(win, LISTING);
    x.send('body-1', 'extra');
    expect(x.sendArgs).toEqual(['body-1', 'extra']);
  });

  it('wrapping twice is a no-op', () => {
    const { win, posted } = makeWin(() => Promise.resolve(new Response('{}')));
    installApiTap(win);
    const open: unknown = (win.XMLHttpRequest.prototype as Record<string, unknown>).open;
    const fetchFn = win.fetch;
    installApiTap(win);
    expect((win.XMLHttpRequest.prototype as Record<string, unknown>).open).toBe(open);
    expect(win.fetch).toBe(fetchFn);
    run(win, LISTING, '{}');
    expect(posted).toHaveLength(1);
  });

  it('mimics native name/length and hides its marker', () => {
    const nativeFetch = Object.defineProperties(() => Promise.resolve(new Response('{}')), {
      name: { value: 'fetch' },
      length: { value: 2 },
    });
    const { win } = makeWin(nativeFetch);
    const proto = win.XMLHttpRequest.prototype as Record<string, unknown>;
    installApiTap(win);
    const f = (n: string) => proto[n] as { name: string; length: number };
    expect([f('open').name, f('open').length]).toEqual(['open', 2]);
    expect([f('setRequestHeader').name, f('setRequestHeader').length]).toEqual(['setRequestHeader', 2]);
    expect([f('send').name, f('send').length]).toEqual(['send', 0]);
    const fetchFn = win.fetch as unknown as { name: string; length: number };
    expect([fetchFn.name, fetchFn.length]).toEqual(['fetch', 2]);
    expect(Object.prototype.propertyIsEnumerable.call(proto, MARK)).toBe(false);
    expect(Object.getOwnPropertyDescriptor(proto, MARK)?.value).toBe(true);
    expect(Object.prototype.propertyIsEnumerable.call(fetchFn, MARK)).toBe(false);
    expect((fetchFn as unknown as Record<symbol, unknown>)[MARK]).toBe(true);
  });

  it('re-used XHR: one relay per load, not one per send', () => {
    const { win, posted } = makeWin();
    installApiTap(win);
    const x = new (Xhr(win))();
    for (let i = 0; i < 3; i++) {
      x.open('GET', LISTING);
      x.send();
      x.responseText = `{"n":${String(i)}}`;
      x.finish();
    }
    expect(x.listeners).toHaveLength(1);
    expect(bodies(posted)).toEqual([0, 1, 2]);
  });

  it('re-used XHR re-opened to a non-buyerapi URL is not relayed', () => {
    const { win, posted } = makeWin();
    installApiTap(win);
    const x = new (Xhr(win))();
    x.open('GET', LISTING);
    x.send();
    x.responseText = '{"n":1}';
    x.finish();
    x.open('GET', 'https://shopgoodwill.com/private');
    x.send();
    x.responseText = '{"secret":true}';
    x.finish();
    expect(posted).toHaveLength(1);
    // And back to buyerapi still works.
    x.open('GET', LISTING);
    x.send();
    x.responseText = '{"n":3}';
    x.finish();
    expect(bodies(posted)).toEqual([1, 3]);
  });

  it('adds a listener when a non-buyerapi XHR is later re-opened to buyerapi', () => {
    const { win, posted } = makeWin();
    installApiTap(win);
    const x = new (Xhr(win))();
    x.open('GET', 'https://example.com/');
    x.send();
    expect(x.listeners).toHaveLength(0);
    x.open('GET', LISTING);
    x.send();
    x.responseText = '{"n":1}';
    x.finish();
    expect(bodies(posted)).toEqual([1]);
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
    expect(posted[1]?.msg).toMatchObject({ kind: 'response', url: LISTING, status: 200, body: { a: 1 } });
    expect(await res.json()).toEqual({ a: 1 });
  });

  it('ignores non-buyerapi fetches', async () => {
    const { win, posted } = makeWin(() => Promise.resolve(new Response('{}')));
    installApiTap(win);
    await (win.fetch as (u: string, i?: unknown) => Promise<Response>)('https://example.com/x', {
      headers: { Authorization: `Bearer ${JWT}` },
    });
    await Promise.resolve();
    expect(posted).toHaveLength(0);
  });

  it('matches the Authorization header name exactly', async () => {
    const { win, posted } = makeWin(() => Promise.resolve(new Response('{}')));
    installApiTap(win);
    const f = win.fetch as (u: string, i?: unknown) => Promise<Response>;
    await f(LISTING, { headers: { 'X-Authorization': `Bearer ${JWT}` } });
    await f(LISTING, { headers: [['X-Authorization', `Bearer ${JWT}`]] });
    await f(LISTING, { headers: new Headers({ 'X-Authorization': `Bearer ${JWT}` }) });
    await vi.waitFor(() => {
      expect(posted.filter((p) => p.msg.kind === 'response')).toHaveLength(3);
    });
    expect(posted.filter((p) => p.msg.kind === 'token')).toHaveLength(0);
  });

  it('reads the bearer from Headers, array and plain-object init', async () => {
    const { win, posted } = makeWin(() => Promise.resolve(new Response('{}')));
    installApiTap(win);
    const f = win.fetch as (u: string, i?: unknown) => Promise<Response>;
    await f(LISTING, { headers: new Headers({ authorization: `Bearer ${JWT}` }) });
    await f(LISTING, { headers: [['AUTHORIZATION', `Bearer ${JWT2}`]] });
    await f(LISTING, { headers: { Authorization: `Bearer ${JWT}` } });
    expect(posted.filter((p) => p.msg.kind === 'token').map((p) => p.msg.bearer)).toEqual([JWT, JWT2, JWT]);
  });

  it('never consumes a one-shot iterable passed as headers', async () => {
    const { win, posted } = makeWin(() => Promise.resolve(new Response('{}')));
    installApiTap(win);
    function* gen() {
      yield ['Authorization', `Bearer ${JWT}`];
    }
    const it = gen();
    await (win.fetch as (u: string, i?: unknown) => Promise<Response>)(LISTING, { headers: it });
    expect(it.next().done).toBe(false);
    expect(posted.filter((p) => p.msg.kind === 'token')).toHaveLength(0);
  });

  it('handles a Request input (URL and headers)', async () => {
    const { win, posted } = makeWin(() => Promise.resolve(new Response('{"n":7}')));
    installApiTap(win);
    const req = new Request(LISTING, { headers: { Authorization: `Bearer ${JWT}` } });
    await (win.fetch as (r: Request) => Promise<Response>)(req);
    await vi.waitFor(() => {
      expect(posted).toHaveLength(2);
    });
    expect(posted[0]?.msg).toMatchObject({ kind: 'token', bearer: JWT });
    expect(posted[1]?.msg).toMatchObject({ kind: 'response', url: LISTING, body: { n: 7 } });
  });

  it('handles a URL input', async () => {
    const { win, posted } = makeWin(() => Promise.resolve(new Response('{"n":1}')));
    installApiTap(win);
    await (win.fetch as (u: URL) => Promise<Response>)(new URL(LISTING));
    await vi.waitFor(() => {
      expect(posted).toHaveLength(1);
    });
    expect(posted[0]?.msg.url).toBe(LISTING);
  });

  it('sends tooLarge for a big content-length and for a big text body', async () => {
    const fake = (len: string | null, text: string) => ({
      status: 200,
      headers: { get: (n: string) => (n.toLowerCase() === 'content-length' ? len : null) },
      clone: () => ({ text: () => Promise.resolve(text) }),
    });
    const queue = [fake(String(MAX_BODY_CHARS + 1), '{"n":1}'), fake(null, 'x'.repeat(MAX_BODY_CHARS + 1)), fake(String(MAX_BODY_CHARS), '{"n":4}')];
    const { win, posted } = makeWin(() => Promise.resolve(queue.shift()));
    installApiTap(win);
    const f = win.fetch as (u: string) => Promise<unknown>;
    await f(LISTING);
    await f(LISTING);
    await f(LISTING);
    await vi.waitFor(() => {
      expect(posted).toHaveLength(3);
    });
    expect(posted.map((p) => p.msg.body)).toEqual([{ tooLarge: true }, { tooLarge: true }, { n: 4 }]);
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

  it('preserves this, arguments and the returned promise', async () => {
    const calls: { self: unknown; args: unknown[] }[] = [];
    const ret = Promise.resolve(new Response('{}'));
    const { win } = makeWin(function (this: unknown, ...args: unknown[]) {
      calls.push({ self: this, args });
      return ret;
    });
    installApiTap(win);
    const init = { method: 'POST' };
    const self = { distinct: true };
    const out = (win.fetch as (...a: unknown[]) => Promise<unknown>).call(self, LISTING, init);
    expect(out).toBe(ret);
    await out;
    expect(calls[0]?.self).toBe(self);
    expect(calls[0]?.args).toEqual([LISTING, init]);
    expect(calls[0]?.args[1]).toBe(init);
  });
});

describe('api-tap early-request buffering', () => {
  it('nonce set before the first request: relayed immediately', () => {
    const { win, posted } = makeWin();
    installApiTap(win);
    run(win, LISTING, '{"n":1}');
    expect(posted).toHaveLength(1);
    expect(FakeObserver.instances).toHaveLength(0);
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
    expect(bodies(posted)).toEqual([1, 2]);
    expect(posted.every((p) => p.msg.nonce === NONCE)).toBe(true);
    expect(FakeObserver.instances[0]?.disconnected).toBe(true);
    run(win, LISTING, '{"n":3}');
    expect(posted).toHaveLength(3);
  });

  it('observer callback without a nonce does not flush', () => {
    const { win, posted, attrs } = makeWin();
    delete attrs['data-sbw-nonce'];
    installApiTap(win);
    run(win, LISTING, '{"n":1}');
    FakeObserver.instances[0]?.cb();
    expect(posted).toHaveLength(0);
    expect(FakeObserver.instances[0]?.disconnected).toBe(false);
  });

  it('flushes lazily, in order, before the next message when no observer fires', () => {
    const { win, posted, attrs } = makeWin();
    delete attrs['data-sbw-nonce'];
    installApiTap(win);
    run(win, LISTING, '{"n":1}');
    attrs['data-sbw-nonce'] = NONCE;
    run(win, LISTING, '{"n":2}');
    expect(bodies(posted)).toEqual([1, 2]);
  });

  it('keeps at most 50 messages, dropping the oldest', () => {
    const { win, posted, attrs } = makeWin();
    delete attrs['data-sbw-nonce'];
    installApiTap(win);
    for (let i = 0; i < MAX_BUFFER_MESSAGES + 5; i++) run(win, LISTING, `{"n":${String(i)}}`);
    attrs['data-sbw-nonce'] = NONCE;
    FakeObserver.instances[0]?.cb();
    expect(posted).toHaveLength(MAX_BUFFER_MESSAGES);
    expect(bodies(posted)[0]).toBe(5);
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

  it('a 1-2 MB body arriving while buffering is replaced by tooLarge, not dropped', () => {
    const { win, posted, attrs } = makeWin();
    delete attrs['data-sbw-nonce'];
    installApiTap(win);
    run(win, LISTING, 'y'.repeat(1_500_000));
    run(win, LISTING, '{"n":2}');
    attrs['data-sbw-nonce'] = NONCE;
    FakeObserver.instances[0]?.cb();
    expect(posted).toHaveLength(2);
    expect(posted[0]?.msg).toMatchObject({ kind: 'response', url: LISTING, status: 200, body: { tooLarge: true } });
    expect(posted[1]?.msg.body).toEqual({ n: 2 });
  });

  it('gives up after 15 s: buffer discarded, nothing more buffered', () => {
    vi.useFakeTimers();
    const { win, posted, attrs } = makeWin();
    delete attrs['data-sbw-nonce'];
    installApiTap(win);
    run(win, LISTING, '{"n":1}');
    vi.advanceTimersByTime(BUFFER_GIVE_UP_MS - 1);
    expect(FakeObserver.instances[0]?.disconnected).toBe(false);
    vi.advanceTimersByTime(2);
    expect(FakeObserver.instances[0]?.disconnected).toBe(true);
    run(win, LISTING, '{"n":2}'); // gaveUp: dropped, no new observer
    freshXhr(win, LISTING, `Bearer ${JWT2}`); // gaveUp: token dropped too, no new observer
    expect(FakeObserver.instances).toHaveLength(1);
    attrs['data-sbw-nonce'] = NONCE;
    FakeObserver.instances[0]?.cb();
    expect(posted).toHaveLength(0);
    run(win, LISTING, '{"n":3}'); // nonce now present: relayed
    expect(bodies(posted)).toEqual([3]);
  });

  it('token survives eviction by large bodies and is relayed once when the nonce arrives', () => {
    const { win, posted, attrs } = makeWin();
    delete attrs['data-sbw-nonce'];
    installApiTap(win);
    freshXhr(win, LISTING, `Bearer ${JWT}`);
    const chunk = 'y'.repeat(400_000);
    for (let i = 0; i < 5; i++) run(win, LISTING, chunk + String(i));
    for (let i = 0; i < MAX_BUFFER_MESSAGES + 3; i++) run(win, LISTING, `{"n":${String(i)}}`);
    freshXhr(win, LISTING, `Bearer ${JWT}`); // same token again while pending: still one
    attrs['data-sbw-nonce'] = NONCE;
    FakeObserver.instances[0]?.cb();
    const tokens = posted.filter((p) => p.msg.kind === 'token');
    expect(tokens).toHaveLength(1);
    expect(tokens[0]?.msg.bearer).toBe(JWT);
    freshXhr(win, LISTING, `Bearer ${JWT}`);
    expect(posted.filter((p) => p.msg.kind === 'token')).toHaveLength(1);
  });

  it('a newer pending token replaces an older one', () => {
    const { win, posted, attrs } = makeWin();
    delete attrs['data-sbw-nonce'];
    installApiTap(win);
    freshXhr(win, LISTING, `Bearer ${JWT}`);
    freshXhr(win, LISTING, `Bearer ${JWT2}`);
    attrs['data-sbw-nonce'] = NONCE;
    FakeObserver.instances[0]?.cb();
    expect(posted.map((p) => p.msg.bearer)).toEqual([JWT2]);
  });

  it('after a give-up, the next request relays the token again', () => {
    vi.useFakeTimers();
    const { win, posted, attrs } = makeWin();
    delete attrs['data-sbw-nonce'];
    installApiTap(win);
    freshXhr(win, LISTING, `Bearer ${JWT}`);
    vi.advanceTimersByTime(BUFFER_GIVE_UP_MS + 1);
    attrs['data-sbw-nonce'] = NONCE;
    expect(posted).toHaveLength(0);
    freshXhr(win, LISTING, `Bearer ${JWT}`);
    expect(posted.map((p) => p.msg.bearer)).toEqual([JWT]);
  });

  it('give-up resets the posted-token memory', () => {
    vi.useFakeTimers();
    const { win, posted, attrs } = makeWin();
    installApiTap(win);
    freshXhr(win, LISTING, `Bearer ${JWT}`); // posted, remembered
    delete attrs['data-sbw-nonce'];
    freshXhr(win, LISTING, `Bearer ${JWT2}`); // pending
    vi.advanceTimersByTime(BUFFER_GIVE_UP_MS + 1);
    attrs['data-sbw-nonce'] = NONCE;
    freshXhr(win, LISTING, `Bearer ${JWT}`);
    expect(posted.map((p) => p.msg.bearer)).toEqual([JWT, JWT]);
  });
});

describe('api-tap natives', () => {
  it('uses natives captured at install, not later page patches', async () => {
    vi.useFakeTimers();
    const response = Promise.resolve(new Response('{"n":9}'));
    const { win, posted, attrs } = makeWin(() => response);
    delete attrs['data-sbw-nonce'];
    const proto = win.XMLHttpRequest.prototype as FakeXhr;
    installApiTap(win);

    const boom = () => {
      throw new Error('patched global used');
    };
    vi.stubGlobal('URL', function () {
      boom();
    });
    vi.stubGlobal('Headers', function () {
      boom();
    });
    vi.stubGlobal('setTimeout', boom);
    vi.stubGlobal('clearTimeout', boom);
    vi.spyOn(Promise, 'resolve').mockImplementation(boom);
    proto.addEventListener = boom;

    const x = new (Xhr(win))();
    x.open('GET', LISTING);
    x.setRequestHeader('Authorization', `Bearer ${JWT}`);
    x.send();
    expect(x.listeners).toHaveLength(1); // registered via the captured addEventListener
    x.responseText = '{"n":1}';
    x.finish(); // buffered: the 15 s timer must come from the captured setTimeout
    vi.advanceTimersByTime(BUFFER_GIVE_UP_MS + 1);
    expect(FakeObserver.instances[0]?.disconnected).toBe(true);

    attrs['data-sbw-nonce'] = NONCE;
    run(win, LISTING, '{"n":2}');
    expect(bodies(posted)).toEqual([2]);

    // fetch: Promise.resolve is patched, the tap must still relay.
    await (win.fetch as (u: string, i?: unknown) => Promise<unknown>)(LISTING, { headers: { Authorization: `Bearer ${JWT2}` } });
    await vi.waitFor(() => {
      expect(posted.some((p) => p.msg.kind === 'response' && (p.msg.body as { n: number }).n === 9)).toBe(true);
    });
    expect(posted.some((p) => p.msg.bearer === JWT2)).toBe(true);
  });

  it('clears its timer through the captured clearTimeout', () => {
    const { win, posted, attrs } = makeWin();
    delete attrs['data-sbw-nonce'];
    installApiTap(win);
    vi.stubGlobal('clearTimeout', () => {
      throw new Error('patched clearTimeout used');
    });
    run(win, LISTING, '{"n":1}');
    attrs['data-sbw-nonce'] = NONCE;
    run(win, LISTING, '{"n":2}');
    expect(bodies(posted)).toEqual([1, 2]);
  });
});

describe('parseTapMessage (untrusted receiver)', () => {
  const ok = { source: TAP_SOURCE, nonce: NONCE, kind: 'response', url: LISTING, status: 200, body: {} };
  const tok = { source: TAP_SOURCE, nonce: NONCE, kind: 'token', bearer: JWT };
  it('accepts well-formed messages', () => {
    expect(parseTapMessage(ok, NONCE)).toEqual(ok);
    expect(parseTapMessage(tok, NONCE)).toEqual(tok);
  });
  it('drops malformed messages, wrong nonce and wrong or missing source', () => {
    for (const bad of [null, undefined, 'x', 42, {}, { ...ok, nonce: 'other' }, { ...ok, status: 'a' }, { ...ok, kind: 'zzz' }, { ...ok, status: 1.5 }]) {
      expect(parseTapMessage(bad, NONCE)).toBeNull();
    }
    expect(parseTapMessage({ ...ok, source: 'x' }, NONCE)).toBeNull();
    expect(parseTapMessage({ ...tok, source: 'x' }, NONCE)).toBeNull();
    const noSource: Record<string, unknown> = { ...ok };
    delete noSource.source;
    expect(parseTapMessage(noSource, NONCE)).toBeNull();
  });
  it('rejects an empty nonce even when the expected nonce is empty', () => {
    expect(parseTapMessage({ ...ok, nonce: '' }, '')).toBeNull();
    expect(parseTapMessage({ ...tok, nonce: '' }, '')).toBeNull();
  });
  it('drops non-buyerapi response URLs', () => {
    expect(parseTapMessage({ ...ok, url: 'https://evil.example/api' }, NONCE)).toBeNull();
    expect(parseTapMessage({ ...ok, url: 'http://buyerapi.shopgoodwill.com/api/x' }, NONCE)).toBeNull();
  });
  it('drops tokens that are not JWT-shaped', () => {
    for (const bearer of ['abc', 'Bearer ' + JWT, 'a.b', '', 'a b.c.d', 5]) {
      expect(parseTapMessage({ ...tok, bearer }, NONCE)).toBeNull();
    }
  });
  it('enforces length limits', () => {
    const url = (n: number) => `https://buyerapi.shopgoodwill.com/${'a'.repeat(n - 'https://buyerapi.shopgoodwill.com/'.length)}`;
    expect(parseTapMessage({ ...ok, url: url(MAX_URL_CHARS) }, NONCE)).not.toBeNull();
    expect(parseTapMessage({ ...ok, url: url(MAX_URL_CHARS + 1) }, NONCE)).toBeNull();
    const n128 = 'n'.repeat(MAX_NONCE_CHARS);
    expect(parseTapMessage({ ...ok, nonce: n128 }, n128)).not.toBeNull();
    const n129 = 'n'.repeat(MAX_NONCE_CHARS + 1);
    expect(parseTapMessage({ ...ok, nonce: n129 }, n129)).toBeNull();
    const jwtOf = (n: number) => `a.b.${'c'.repeat(n - 4)}`;
    expect(parseTapMessage({ ...tok, bearer: jwtOf(MAX_BEARER_CHARS) }, NONCE)).not.toBeNull();
    expect(parseTapMessage({ ...tok, bearer: jwtOf(MAX_BEARER_CHARS + 1) }, NONCE)).toBeNull();
  });
  it('returns null instead of throwing on hostile input', () => {
    const hostile = {
      get source(): string {
        throw new Error('getter');
      },
    };
    expect(parseTapMessage(hostile, NONCE)).toBeNull();
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
