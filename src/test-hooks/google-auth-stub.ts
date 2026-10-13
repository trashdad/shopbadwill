// `sbw:test:googleAuth` (T-72, PLAN §7.5 "GoogleAuthProvider stub"): the
// test-only stand-in for Google's consent window. Test builds only; see
// ./index.ts for how hooks are loaded and called, and
// `pnpm check:prod-bundle`, which fails if any of this reaches production.
//
// What is stubbed, and why only this. The background's GoogleAuthProvider is
// the real PkceRefreshProvider (src/adapters/google/auth-pkce.ts), built by the
// frozen composition root (src/background/main.ts, I-01), so a test cannot
// swap the provider. Everything it does runs fine against the fake Google
// server once `sbw:test:baseUrl` points the Google hosts there (code exchange,
// refresh, invalid_grant, revoke, the Calendar API), except one step: the
// interactive consent window (`identity.launchWebAuthFlow`), which a headless
// E2E cannot drive, and which needs the `identity` permission Chrome only
// grants on a user prompt. So this hook replaces `browser.identity` (main.ts
// looks it up on every use) with a stand-in, and the HARNESS plays the user:
//
//   1. `{ op: 'install', redirectUrl? }` puts the stand-in on the browser.
//      `getRedirectURL()` answers `redirectUrl`, else the browser's own
//      (the real `identity.getRedirectURL()` when the browser has one, as
//      Firefox does), else Chrome's `https://<extension id>.chromiumapp.org/`
//      (Chrome hides `identity` until its optional permission is granted).
//      Nothing changes until the harness calls this: a test build left alone
//      behaves like production.
//   2. The provider opens consent; the stand-in keeps the flow open.
//   3. `{ op: 'pending' }` answers `{ url, fakeUrl }` (or null): the consent
//      URL exactly as the provider built it, and the same URL rewritten by
//      `sbw:test:baseUrl` (the fake Google server's consent page). The harness
//      loads `fakeUrl`; the fake answers 302 to the redirect URI with a code.
//   4. `{ op: 'complete', responseUrl }` hands that redirect back, as the
//      browser does when the window reaches the redirect URI. `{ op: 'cancel' }`
//      closes the window instead (Chrome's "did not approve" rejection).
//   5. `{ op: 'uninstall' }` restores whatever `identity` was there.
//
// A non-interactive launch fails at once ("User interaction required.", as on
// Chrome without a window); a second launch while one is open is refused.
// The state is in memory: a background restart drops it, and the harness
// installs it again, as it re-applies `sbw:test:baseUrl` (T-59 R2).
import { z } from 'zod';

import { rewriteUrl } from './base-url';
import type { TestHookContext } from './index';

export const GOOGLE_AUTH_HOOK = 'sbw:test:googleAuth';
/** Chrome's rejection text when the user closes or declines the consent window. */
export const CANCELLED_MESSAGE = 'The user did not approve access.';
/** Chrome's rejection text for a non-interactive flow that would need a window. */
export const NO_WINDOW_MESSAGE = 'User interaction required.';
/** Marks the stand-in (and, if it were ever bundled, trips check:prod-bundle's `sbw.test`). */
const STUB_MARK = Symbol.for('sbw.testHooks.googleAuthStub');

/** The `identity` slice PkceRefreshProvider uses (src/adapters/google/auth-pkce.ts: WebAuthFlow). */
interface WebAuthFlowLike {
  launchWebAuthFlow(details: { url: string; interactive: boolean }): Promise<string | undefined>;
  getRedirectURL(): string;
}

const HttpsUrl = z.string().refine((s) => URL.canParse(s) && new URL(s).protocol === 'https:', 'an https URL');

const RequestSchema = z.discriminatedUnion('op', [
  z.strictObject({ op: z.literal('install'), redirectUrl: HttpsUrl.optional() }),
  z.strictObject({ op: z.literal('pending') }),
  z.strictObject({ op: z.literal('complete'), responseUrl: z.string().refine((s) => URL.canParse(s), 'a URL') }),
  z.strictObject({ op: z.literal('cancel') }),
  z.strictObject({ op: z.literal('uninstall') }),
]);

/** The browser's own redirect URL, when it has a working `identity`. */
function realRedirectUrl(identity: unknown): string | undefined {
  try {
    const url = (identity as Partial<WebAuthFlowLike> | undefined)?.getRedirectURL?.();
    return typeof url === 'string' && url !== '' ? url : undefined;
  } catch {
    return undefined;
  }
}

interface OpenFlow {
  url: string;
  resolve(responseUrl: string): void;
  reject(error: Error): void;
}

export function install(ctx: TestHookContext): void {
  // The real `browser` object main.ts was given; `identity` is looked up on it at every use.
  const target = ctx.browser as unknown as Record<string, unknown>;
  let installed = false;
  /** What `identity` was before install (undefined: absent, as on Chrome without the permission). */
  let previous: PropertyDescriptor | undefined;
  let redirectUrl = '';
  /** The real identity's redirect URL, read before the stand-in replaced it (undefined on Chrome). */
  let browserRedirect: string | undefined;
  let flow: OpenFlow | undefined;

  const stub: WebAuthFlowLike & { readonly [STUB_MARK]: true } = {
    [STUB_MARK]: true,
    getRedirectURL: () => redirectUrl,
    launchWebAuthFlow: ({ url, interactive }) => {
      if (!interactive) return Promise.reject(new Error(NO_WINDOW_MESSAGE));
      if (flow !== undefined) return Promise.reject(new Error('a Google sign-in window is already open'));
      return new Promise<string>((resolve, reject) => {
        flow = { url, resolve, reject };
      });
    },
  };

  const take = (): OpenFlow => {
    const open = flow;
    if (open === undefined) throw new Error('no Google sign-in window is open');
    flow = undefined;
    return open;
  };

  ctx.serve(GOOGLE_AUTH_HOOK, (payload) => {
    const parsed = RequestSchema.safeParse(payload);
    if (!parsed.success) {
      throw new Error(
        `expected { op: 'install' (redirectUrl?) | 'pending' | 'complete' (responseUrl) | 'cancel' | 'uninstall' }; got ${JSON.stringify(payload)}`,
      );
    }
    const req = parsed.data;
    switch (req.op) {
      case 'install': {
        if (!installed) {
          previous = Object.getOwnPropertyDescriptor(target, 'identity');
          browserRedirect = realRedirectUrl(target['identity']);
        }
        redirectUrl = req.redirectUrl ?? browserRedirect ?? `https://${ctx.browser.runtime.id}.chromiumapp.org/`;
        Object.defineProperty(target, 'identity', { configurable: true, enumerable: true, writable: true, value: stub });
        installed = true;
        return { redirectUrl };
      }
      case 'pending':
        return flow === undefined ? null : { url: flow.url, fakeUrl: rewriteUrl(flow.url) };
      case 'complete':
        take().resolve(req.responseUrl);
        return { completed: true };
      case 'cancel':
        take().reject(new Error(CANCELLED_MESSAGE));
        return { cancelled: true };
      case 'uninstall': {
        if (flow !== undefined) take().reject(new Error(CANCELLED_MESSAGE));
        if (installed) {
          if (previous === undefined) Reflect.deleteProperty(target, 'identity');
          else Object.defineProperty(target, 'identity', previous);
          installed = false;
          previous = undefined;
        }
        return { uninstalled: true };
      }
    }
  });
}
