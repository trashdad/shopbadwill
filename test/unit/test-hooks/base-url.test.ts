// T-39: `sbw:test:baseUrl` (src/test-hooks/base-url.ts). The hook rewrites the
// two remote origins the background can talk to (buyerapi.shopgoodwill.com,
// www.googleapis.com) so E2E runs against the fake servers on 127.0.0.1, and
// answers the endpoint that sets/clears the overrides.
//
// The rewrite happens inside a wrapper around `globalThis.fetch` installed by
// `install()`, so the test stubs fetch BEFORE installing and then asserts what
// the wrapper passes through.
import { afterEach, describe, expect, it, vi } from 'vitest';

import { installHooks } from '../../../src/test-hooks';
import * as baseUrlHook from '../../../src/test-hooks/base-url';
import { fakeHookBrowser } from './fake-hook-browser';

const API = 'https://buyerapi.shopgoodwill.com/api/Search/ItemListing';
const fetchSpy = (): ReturnType<typeof vi.fn<typeof fetch>> =>
  vi.fn<typeof fetch>(() => Promise.resolve(new Response('ok')));
const CAL = 'https://www.googleapis.com/calendar/v3/calendars/x/events';
const UNTOUCHED = 'https://shopgoodwill.com/categories/listing?st=pyrex';

describe('sbw:test:baseUrl', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    baseUrlHook.applyOverrides({ sgw: null, google: null });
  });

  it('answers the hook with the normalized origins it applied', async () => {
    const browserStub = fakeHookBrowser();
    installHooks({ './base-url.ts': baseUrlHook }, browserStub);

    const port = browserStub.connect(baseUrlHook.BASE_URL_HOOK);
    port.post({ payload: { sgw: 'http://127.0.0.1:8787/', google: 'http://127.0.0.1:8788' } });
    const reply = await port.nextReply();

    expect(reply.ok).toBe(true);
    expect(reply.value).toEqual({ sgw: 'http://127.0.0.1:8787', google: 'http://127.0.0.1:8788' });
  });

  it('rejects a payload that is not {sgw?, google?}', async () => {
    const browserStub = fakeHookBrowser();
    installHooks({ './base-url.ts': baseUrlHook }, browserStub);

    const port = browserStub.connect(baseUrlHook.BASE_URL_HOOK);
    port.post({ payload: { sgw: 'not a url' } });
    const reply = await port.nextReply();

    expect(reply.ok).toBe(false);
    expect(reply.error).toContain('sgw');
  });

  it('clears an override on null, and unknown hosts pass through untouched', async () => {
    const browserStub = fakeHookBrowser();
    installHooks({ './base-url.ts': baseUrlHook }, browserStub);

    const port = browserStub.connect(baseUrlHook.BASE_URL_HOOK);
    port.post({ payload: { sgw: 'http://127.0.0.1:8787' } });
    expect((await port.nextReply()).ok).toBe(true);

    const clear = browserStub.connect(baseUrlHook.BASE_URL_HOOK);
    clear.post({ payload: { sgw: null } });
    expect((await clear.nextReply()).value).toEqual({ sgw: null, google: null });

    expect(baseUrlHook.rewriteUrl(API)).toBe(API);
    expect(baseUrlHook.rewriteUrl(UNTOUCHED)).toBe(UNTOUCHED);
  });

  it('rewrites fetch string, Request and URL inputs, and leaves other hosts alone', async () => {
    const spy = fetchSpy();
    vi.stubGlobal('fetch', spy);
    const browserStub = fakeHookBrowser();
    installHooks({ './base-url.ts': baseUrlHook }, browserStub);

    const port = browserStub.connect(baseUrlHook.BASE_URL_HOOK);
    port.post({ payload: { sgw: 'http://127.0.0.1:8787', google: 'http://127.0.0.1:8788' } });
    expect((await port.nextReply()).ok).toBe(true);

    const wrapped = globalThis.fetch;

    await wrapped(API, { method: 'POST', body: '{}' });
    await wrapped(new Request(API, { method: 'POST' }));
    await wrapped(new URL(API));
    await wrapped(CAL, { method: 'GET' });
    await wrapped(UNTOUCHED);

    const urls = spy.mock.calls.map((c) => String(c[0] instanceof Request ? c[0].url : c[0]));
    expect(urls).toEqual([
      'http://127.0.0.1:8787/api/Search/ItemListing',
      'http://127.0.0.1:8787/api/Search/ItemListing',
      'http://127.0.0.1:8787/api/Search/ItemListing',
      'http://127.0.0.1:8788/calendar/v3/calendars/x/events',
      UNTOUCHED,
    ]);
  });

  it('installing twice never double-wraps fetch', async () => {
    const spy = fetchSpy();
    vi.stubGlobal('fetch', spy);
    const browserStub = fakeHookBrowser();
    installHooks({ './base-url.ts': baseUrlHook }, browserStub);
    installHooks({ './base-url.ts': baseUrlHook }, browserStub);

    const port = browserStub.connect(baseUrlHook.BASE_URL_HOOK);
    port.post({ payload: { sgw: 'http://127.0.0.1:8787' } });
    expect((await port.nextReply()).ok).toBe(true);

    await globalThis.fetch(API);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith('http://127.0.0.1:8787/api/Search/ItemListing');
  });
});
