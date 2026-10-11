// `sbw:test:baseUrl` (T-39): the test-only override of the two remote origins
// the background can talk to. E2E runs set them to the fake servers on
// 127.0.0.1 (buyerapi on 8787, Google on 8788), so no background request can
// leave the machine. Test builds only; see ./index.ts for how hooks are loaded
// and called.
//
// Mechanism: a wrapper around the background's `globalThis.fetch`. The only
// network caller in the background is BrowserHttp (src/adapters/browser/http.ts),
// which reads the global `fetch` at send time, so rewriting the URLs there
// reaches every adapter without touching the frozen composition root
// (src/background/main.ts) or the adapter configs. The wrapper is installed
// once (a symbol marks it); with no override set it passes every input through
// untouched. A caller's `Request` input becomes a new Request, so its headers,
// method and body are preserved.
import { z } from 'zod';

import type { TestHookContext } from './index';

export const BASE_URL_HOOK = 'sbw:test:baseUrl';

/** The production origins this hook may rewrite. Keep them in sync with the adapter configs. */
export const PROD_ORIGINS = {
  /** src/adapters/sgw/config.ts: SGW_API_BASE. */
  sgw: 'https://buyerapi.shopgoodwill.com',
  /** src/adapters/google/calendar-api.ts: CALENDAR_BASE_URL. */
  google: 'https://www.googleapis.com',
} as const;

export type OverrideKey = keyof typeof PROD_ORIGINS;
export interface BaseUrlPatch {
  sgw: string | null;
  google: string | null;
}
/** What the hook endpoint accepts: origins to rewrite to, or null to clear. */
export type BaseUrlOverrides = Partial<Record<OverrideKey, string | null>>;

const OverridesSchema = z
  .strictObject({
    sgw: z.union([z.string().min(1), z.null()]).optional(),
    google: z.union([z.string().min(1), z.null()]).optional(),
  })
  .refine((v) => v.sgw !== undefined || v.google !== undefined, {
    message: 'send at least one of sgw / google',
  });

let patch: BaseUrlPatch = { sgw: null, google: null };

function parseOrigin(key: OverrideKey, raw: string | null): string | null {
  if (raw === null) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${key}: not a URL: ${JSON.stringify(raw)}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`${key}: not an http(s) origin: ${JSON.stringify(raw)}`);
  }
  return url.origin;
}

/** Applies `next` on top of the current patch and returns the result. Throws on a bad value (nothing changes). */
export function applyOverrides(next: BaseUrlOverrides): BaseUrlPatch {
  const candidate: BaseUrlPatch = { ...patch };
  for (const key of Object.keys(PROD_ORIGINS) as OverrideKey[]) {
    if (next[key] !== undefined) candidate[key] = parseOrigin(key, next[key] ?? null);
  }
  patch = candidate;
  return { ...patch };
}

/** The URL a request to `raw` is rewritten to under `p` (default: the current patch). Unmatched URLs are returned as is. */
export function rewriteUrl(raw: string, p: BaseUrlPatch = patch): string {
  for (const key of Object.keys(PROD_ORIGINS) as OverrideKey[]) {
    const to = p[key];
    const from = PROD_ORIGINS[key];
    if (to === null) continue;
    if (raw === from || raw.startsWith(`${from}/`)) return `${to}${raw.slice(from.length)}`;
  }
  return raw;
}

const WRAP_MARK = Symbol.for('sbw.testHooks.baseUrl.fetch');

/** Wraps `realFetch` so every URL the background requests is rewritten. Idempotent (a second call returns the wrapper). */
export function installFetchRewrite(realFetch: typeof fetch): typeof fetch {
  if ((realFetch as unknown as Record<symbol, unknown>)[WRAP_MARK] === true) return realFetch;
  const wrapped = function (this: unknown, input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    let next: RequestInfo | URL = input;
    if (typeof input === 'string') {
      next = rewriteUrl(input);
    } else if (input instanceof Request) {
      const rewritten = rewriteUrl(input.url);
      if (rewritten !== input.url) next = new Request(rewritten, input);
    } else if (input instanceof URL) {
      next = new URL(rewriteUrl(input.href));
    }
    // Keep the call shape: fetch(url) stays a one-argument call.
    return init === undefined ? realFetch.call(globalThis, next) : realFetch.call(globalThis, next, init);
  } as typeof fetch;
  Object.defineProperty(wrapped, WRAP_MARK, { value: true });
  return wrapped;
}

export function install(ctx: TestHookContext): void {
  const real = globalThis.fetch;
  if (typeof real === 'function') globalThis.fetch = installFetchRewrite(real);

  ctx.serve(BASE_URL_HOOK, (payload) => {
    const parsed = OverridesSchema.safeParse(payload);
    if (!parsed.success) {
      throw new Error(`expected { sgw?, google? } origins (http://127.0.0.1:8787) or null; got ${JSON.stringify(payload)}`);
    }
    return applyOverrides(parsed.data);
  });
}
