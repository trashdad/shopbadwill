import { afterEach, describe, expect, it, vi } from 'vitest';
import type { browser } from 'wxt/browser';

import {
  installHooks,
  installTestHooks,
  type TestHookBrowser,
  type TestHookContext,
  type TestHookModule,
} from '../../../src/test-hooks';
import { fakeHookBrowser } from './fake-hook-browser';

// Compile-time contract: the background passes WXT's `browser` as-is (T-36:
// `if (import.meta.env.SBW_TEST) installTestHooks({ browser })`).
type AcceptsWxtBrowser = typeof browser extends TestHookBrowser ? true : false;
const acceptsWxtBrowser: AcceptsWxtBrowser = true;

function echoHook(): TestHookModule {
  return {
    install(ctx) {
      ctx.serve('sbw:test:echo', (payload) => ({ echoed: payload, hooks: ctx.hooks }));
    },
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('installTestHooks (the SBW_TEST guard)', () => {
  it('accepts the WXT browser object', () => {
    expect(acceptsWxtBrowser).toBe(true);
  });

  it('installs nothing and registers no listener outside a test build', () => {
    vi.stubEnv('SBW_TEST', '');
    const browserStub = fakeHookBrowser();
    expect(installTestHooks({ browser: browserStub })).toEqual([]);
    expect(browserStub.connectListenerCount).toBe(0);
  });

  it('in a test build, loads every src/test-hooks module by glob (state among them)', () => {
    vi.stubEnv('SBW_TEST', '1');
    const browserStub = fakeHookBrowser();
    const hooks = installTestHooks({ browser: browserStub });
    expect(hooks).toContain('state');
    expect(hooks).not.toContain('index');
    expect(browserStub.connectListenerCount).toBe(1);
  });
});

describe('installHooks', () => {
  it('names hooks after their module file, in path order', () => {
    const order: string[] = [];
    const record = (name: string): TestHookModule => ({ install: () => order.push(name) });
    const hooks = installHooks({ './zeta.ts': record('zeta'), './alpha.ts': record('alpha') }, fakeHookBrowser());
    expect(hooks).toEqual(['alpha', 'zeta']);
    expect(order).toEqual(['alpha', 'zeta']);
  });

  it('fails loudly on a module without install()', () => {
    expect(() => installHooks({ './broken.ts': {} }, fakeHookBrowser())).toThrow(/broken\.ts.*install/);
  });

  it('rejects two hooks serving the same name', () => {
    expect(() => installHooks({ './a.ts': echoHook(), './b.ts': echoHook() }, fakeHookBrowser())).toThrow(
      /sbw:test:echo.*twice/,
    );
  });

  it('passes the hook list to every hook', () => {
    let seen: TestHookContext | undefined;
    installHooks({ './one.ts': { install: (ctx) => (seen = ctx) }, './two.ts': { install: () => undefined } }, fakeHookBrowser());
    expect(seen?.hooks).toEqual(['one', 'two']);
  });
});

describe('sbw:test:* ports', () => {
  it('answers a request from an extension page with { ok: true, value }', async () => {
    const browserStub = fakeHookBrowser();
    installHooks({ './echo.ts': echoHook() }, browserStub);
    const port = browserStub.connect('sbw:test:echo');
    port.post({ payload: { n: 1 } });
    expect(await port.nextReply()).toEqual({ ok: true, value: { echoed: { n: 1 }, hooks: ['echo'] } });
  });

  it('reports a throwing or rejecting handler as { ok: false, error }', async () => {
    const browserStub = fakeHookBrowser();
    const throwing: TestHookModule = {
      install(ctx) {
        ctx.serve('sbw:test:sync', () => {
          throw new Error('boom');
        });
      },
    };
    const rejecting: TestHookModule = {
      install(ctx) {
        ctx.serve('sbw:test:async', () => Promise.reject(new Error('later')));
      },
    };
    installHooks({ './sync.ts': throwing, './async.ts': rejecting }, browserStub);
    const sync = browserStub.connect('sbw:test:sync');
    sync.post({});
    expect(await sync.nextReply()).toEqual({ ok: false, error: 'boom' });
    const later = browserStub.connect('sbw:test:async');
    later.post({});
    expect(await later.nextReply()).toEqual({ ok: false, error: 'later' });
  });

  it('answers an unknown sbw:test: name with an error', async () => {
    const browserStub = fakeHookBrowser();
    installHooks({ './echo.ts': echoHook() }, browserStub);
    const port = browserStub.connect('sbw:test:nope');
    expect(await port.nextReply()).toEqual({ ok: false, error: 'no test hook serves sbw:test:nope' });
    expect(port.disconnected).toBe(true);
  });

  it('ignores ports that are not sbw:test:* (other listeners own them)', () => {
    const browserStub = fakeHookBrowser();
    installHooks({ './echo.ts': echoHook() }, browserStub);
    const port = browserStub.connect('sbw:job-progress');
    port.post({ payload: 1 });
    expect(port.replies).toEqual([]);
    expect(port.disconnected).toBe(false);
  });

  it.each([
    ['a content script on a web page', { id: 'test-extension-id', url: 'https://shopgoodwill.com/' }],
    ['another extension', { id: 'someone-else', url: 'moz-extension://someone-else/page.html' }],
    ['an unknown sender', {}],
  ])('refuses %s', async (_label, sender) => {
    const browserStub = fakeHookBrowser();
    installHooks({ './echo.ts': echoHook() }, browserStub);
    const port = browserStub.connect('sbw:test:echo', sender);
    port.post({ payload: 1 });
    expect(await port.nextReply()).toEqual({ ok: false, error: 'sbw:test:echo: only extension pages may call test hooks' });
    expect(port.disconnected).toBe(true);
    expect(port.replies).toHaveLength(1);
  });
});
