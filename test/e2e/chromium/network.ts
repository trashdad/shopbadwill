// What the Chromium E2E route does with a request. The browser is launched
// with a dead proxy and a resolver that fails every name, so `continue` only
// works for schemes that never leave the machine (extension pages, about:).
// Every other allowed request is fetched by Playwright from 127.0.0.1 and
// fulfilled. Anything else is aborted. An unexpected host fails the spec.
export const FAKE_SITE = 'http://127.0.0.1:8789';
export const FAKE_BUYERAPI = 'http://127.0.0.1:8787';
export const FAKE_GOOGLE = 'http://127.0.0.1:8788';

const LOCAL_PORTS = new Set(['8787', '8788', '8789']);

export type RouteDecision =
  | { action: 'fetch'; url: string; bucket: 'site' | 'buyerapi' | 'local' }
  | { action: 'abort'; unexpected: boolean }
  | { action: 'continue' };

/** The upstream URL is always a local fake. The original host is never fetched. */
export function decideRequest(rawUrl: string): RouteDecision {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { action: 'abort', unexpected: true };
  }
  if (url.protocol === 'chrome-extension:' || url.protocol === 'about:') return { action: 'continue' };
  if (url.hostname === 'shopgoodwill.com') {
    return { action: 'fetch', url: `${FAKE_SITE}${url.pathname}${url.search}`, bucket: 'site' };
  }
  if (url.hostname === 'buyerapi.shopgoodwill.com') {
    return { action: 'fetch', url: `${FAKE_BUYERAPI}${url.pathname}${url.search}`, bucket: 'buyerapi' };
  }
  // The test build's own calls, after sbw:test:baseUrl rewrites them. Fetch
  // them here: continue() would send the browser at the dead proxy.
  if (url.hostname === '127.0.0.1' && LOCAL_PORTS.has(url.port)) {
    return { action: 'fetch', url: rawUrl, bucket: 'local' };
  }
  if (url.hostname === 'img.test') return { action: 'abort', unexpected: false };
  return { action: 'abort', unexpected: true };
}
