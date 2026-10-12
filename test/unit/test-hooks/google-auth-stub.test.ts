// T-72: `sbw:test:googleAuth` (src/test-hooks/google-auth-stub.ts), the
// test-only stand-in for the one part of the GoogleAuthProvider that cannot
// run headless: Google's consent window (`identity.launchWebAuthFlow`). The
// real PkceRefreshProvider runs unchanged on top of it; the harness plays the
// user (it loads the consent page on the fake Google server and hands the
// redirect back through the hook).
import { afterEach, describe, expect, it, vi } from 'vitest';

import { BrowserClock } from '../../../src/adapters/browser/clock';
import { BrowserHttp } from '../../../src/adapters/browser/http';
import { CALENDAR_SCOPE, PkceRefreshProvider, type WebAuthFlow } from '../../../src/adapters/google/auth-pkce';
import { installHooks } from '../../../src/test-hooks';
import * as baseUrlHook from '../../../src/test-hooks/base-url';
import * as stubHook from '../../../src/test-hooks/google-auth-stub';
import { startFakeGoogle, type FakeGoogle } from '../../fakes/fake-google-server/server';
import { FakeStorageAreas } from '../../fakes/ports/fake-storage';
import { EXTENSION_ID, fakeHookBrowser, type FakeHookBrowser, type Reply } from './fake-hook-browser';

const AUTHORIZE = 'https://accounts.google.com/o/oauth2/v2/auth?client_id=1&state=s1';
/** A Chrome redirect URL: 32 letters a-p (what redirectUriFor accepts). */
const CHROME_REDIRECT = `https://${'abcdefghijklmnop'.repeat(2)}.chromiumapp.org/`;

type WithIdentity = FakeHookBrowser & { identity?: WebAuthFlow };

function rig(): { browser: WithIdentity; call: (payload: unknown) => Promise<Reply> } {
  const browser: WithIdentity = fakeHookBrowser();
  installHooks({ './base-url.ts': baseUrlHook, './google-auth-stub.ts': stubHook }, browser);
  const call = (payload: unknown): Promise<Reply> => {
    const port = browser.connect(stubHook.GOOGLE_AUTH_HOOK);
    port.post({ payload });
    return port.nextReply();
  };
  return { browser, call };
}

function identityOf(browser: WithIdentity): WebAuthFlow {
  const identity = browser.identity;
  if (identity === undefined) throw new Error('no identity on the browser');
  return identity;
}

let fake: FakeGoogle | undefined;

afterEach(async () => {
  baseUrlHook.applyOverrides({ sgw: null, google: null });
  await fake?.close();
  fake = undefined;
});

describe('sbw:test:googleAuth', () => {
  it('is dormant until the harness installs it: loading the hook module leaves identity alone', () => {
    const { browser } = rig();
    expect(browser.identity).toBeUndefined();
  });

  it('install puts a consent-window stand-in on the browser, with the Chrome redirect URL', async () => {
    const { browser, call } = rig();
    const reply = await call({ op: 'install' });
    expect(reply).toEqual({ ok: true, value: { redirectUrl: `https://${EXTENSION_ID}.chromiumapp.org/` } });
    expect(identityOf(browser).getRedirectURL()).toBe(`https://${EXTENSION_ID}.chromiumapp.org/`);
    // A Firefox harness passes the browser's own redirect URL.
    const ff = await call({ op: 'install', redirectUrl: 'https://abcdef0123456789.extensions.allizom.org/' });
    expect(ff.value).toEqual({ redirectUrl: 'https://abcdef0123456789.extensions.allizom.org/' });
    expect(identityOf(browser).getRedirectURL()).toBe('https://abcdef0123456789.extensions.allizom.org/');
  });

  it('an interactive launch waits for the harness; pending reports the URL as asked and where the window loads it', async () => {
    const { browser, call } = rig();
    await call({ op: 'install' });
    expect((await call({ op: 'pending' })).value).toBeNull();

    const flow = identityOf(browser).launchWebAuthFlow({ url: AUTHORIZE, interactive: true });
    // No base-URL override: the window would load Google itself (the harness refuses that).
    expect((await call({ op: 'pending' })).value).toEqual({ url: AUTHORIZE, fakeUrl: AUTHORIZE });
    baseUrlHook.applyOverrides({ google: 'http://127.0.0.1:8788' });
    expect((await call({ op: 'pending' })).value).toEqual({
      url: AUTHORIZE,
      fakeUrl: 'http://127.0.0.1:8788/o/oauth2/v2/auth?client_id=1&state=s1',
    });

    const back = `https://${EXTENSION_ID}.chromiumapp.org/?state=s1&code=4%2F0Afake`;
    expect(await call({ op: 'complete', responseUrl: back })).toEqual({ ok: true, value: { completed: true } });
    await expect(flow).resolves.toBe(back);
    expect((await call({ op: 'pending' })).value).toBeNull();
  });

  it('cancel rejects the open flow with Chrome\'s "did not approve" text', async () => {
    const { browser, call } = rig();
    await call({ op: 'install' });
    const flow = identityOf(browser).launchWebAuthFlow({ url: AUTHORIZE, interactive: true });
    expect(await call({ op: 'cancel' })).toEqual({ ok: true, value: { cancelled: true } });
    await expect(flow).rejects.toThrow('The user did not approve access.');
  });

  it('a non-interactive launch fails at once, as Chrome does without a window', async () => {
    const { browser, call } = rig();
    await call({ op: 'install' });
    await expect(identityOf(browser).launchWebAuthFlow({ url: AUTHORIZE, interactive: false })).rejects.toThrow(
      'User interaction required.',
    );
    expect((await call({ op: 'pending' })).value).toBeNull();
  });

  it('a second launch while one is open is refused; the first stays open', async () => {
    const { browser, call } = rig();
    await call({ op: 'install' });
    const first = identityOf(browser).launchWebAuthFlow({ url: AUTHORIZE, interactive: true });
    await expect(identityOf(browser).launchWebAuthFlow({ url: `${AUTHORIZE}&again=1`, interactive: true })).rejects.toThrow(
      /already open/,
    );
    expect(((await call({ op: 'pending' })).value as { url: string }).url).toBe(AUTHORIZE);
    await call({ op: 'complete', responseUrl: 'https://x.chromiumapp.org/?code=c' });
    await expect(first).resolves.toBe('https://x.chromiumapp.org/?code=c');
  });

  it('refuses complete/cancel with nothing open, a bad responseUrl and unknown payloads', async () => {
    const { browser, call } = rig();
    await call({ op: 'install' });
    expect(await call({ op: 'complete', responseUrl: 'https://x.chromiumapp.org/' })).toMatchObject({ ok: false });
    expect(await call({ op: 'cancel' })).toMatchObject({ ok: false });
    const flow = identityOf(browser).launchWebAuthFlow({ url: AUTHORIZE, interactive: true });
    expect(await call({ op: 'complete', responseUrl: 'not a url' })).toMatchObject({ ok: false });
    expect(await call({ op: 'nope' })).toMatchObject({ ok: false });
    expect(await call(undefined)).toMatchObject({ ok: false });
    // Still open after the refused calls.
    await call({ op: 'cancel' });
    await expect(flow).rejects.toThrow();
  });

  it('uninstall restores what was there before (and cancels an open flow)', async () => {
    const { browser, call } = rig();
    const real: WebAuthFlow = { getRedirectURL: () => 'real', launchWebAuthFlow: () => Promise.resolve('real') };
    browser.identity = real;
    await call({ op: 'install' });
    expect(browser.identity).not.toBe(real);
    const flow = identityOf(browser).launchWebAuthFlow({ url: AUTHORIZE, interactive: true });
    expect(await call({ op: 'uninstall' })).toEqual({ ok: true, value: { uninstalled: true } });
    expect(browser.identity).toBe(real);
    await expect(flow).rejects.toThrow();
  });

  it('drives the real PkceRefreshProvider through consent against the fake Google server', async () => {
    fake = await startFakeGoogle({ port: 0, scenario: { clientId: '1-e2e.apps.googleusercontent.com', clientSecret: 'fake-secret' } });
    const { browser, call } = rig();
    // The fake hook browser's id is not Chrome's 32 a-p letters, so the harness passes the redirect URL.
    await call({ op: 'install', redirectUrl: CHROME_REDIRECT });
    baseUrlHook.applyOverrides({ google: fake.url });
    // In the extension the fetch wrapper does the rewrite; here the provider is pointed at it directly.
    const rewrite = (u: string): string => baseUrlHook.rewriteUrl(u);
    const badge = vi.fn();
    const provider = new PkceRefreshProvider({
      storage: new FakeStorageAreas(),
      http: new BrowserHttp({ isOnline: () => true }),
      clock: new BrowserClock(),
      identity: identityOf(browser),
      clientConfig: () => ({ clientId: '1-e2e.apps.googleusercontent.com', clientSecret: 'fake-secret' }),
      badge: { set: badge },
      endpoints: { token: rewrite('https://oauth2.googleapis.com/token'), revoke: rewrite('https://oauth2.googleapis.com/revoke') },
    });

    const connecting = provider.connect();
    // The harness: wait for the window, load it on the fake, hand the redirect back.
    let pending: { url: string; fakeUrl: string } | null = null;
    await vi.waitFor(async () => {
      pending = (await call({ op: 'pending' })).value as { url: string; fakeUrl: string } | null;
      expect(pending).not.toBeNull();
    });
    const asked = pending as unknown as { url: string; fakeUrl: string };
    expect(new URL(asked.url).origin).toBe('https://accounts.google.com');
    expect(asked.fakeUrl.startsWith(`${fake.url}/o/oauth2/v2/auth?`)).toBe(true);
    const res = await fetch(asked.fakeUrl, { redirect: 'manual' });
    expect(res.status).toBe(302);
    const location = res.headers.get('location') ?? '';
    expect(location.startsWith(`${CHROME_REDIRECT}?`)).toBe(true);
    await call({ op: 'complete', responseUrl: location });

    const status = await connecting;
    expect(status).toMatchObject({ connected: true, provider: 'pkce', grantedScopes: [CALENDAR_SCOPE] });
    expect(badge).toHaveBeenLastCalledWith(false);
    // The real code exchange reached the fake (PKCE verified there), once.
    const tokenPosts = fake.state.requests.filter((r) => r.method === 'POST' && r.path === '/token');
    expect(tokenPosts.map((r) => r.status)).toEqual([200]);
  });

  it('the provider still refuses a redirect that is not a browser redirect URL (the stub weakens no check)', async () => {
    const { browser, call } = rig();
    await call({ op: 'install', redirectUrl: 'https://evil.example/' });
    const provider = new PkceRefreshProvider({
      storage: new FakeStorageAreas(),
      http: new BrowserHttp({ isOnline: () => true }),
      clock: new BrowserClock(),
      identity: identityOf(browser),
      clientConfig: () => ({ clientId: '1-e2e.apps.googleusercontent.com' }),
      badge: { set: () => undefined },
    });
    await expect(provider.connect()).rejects.toMatchObject({ code: 'not_configured' });
    expect((await call({ op: 'pending' })).value).toBeNull();
  });
});
