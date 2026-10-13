// What the Chromium E2E route does with a request. The browser is launched
// with a dead proxy and a resolver that fails every name, so `continue` only
// works for schemes that never leave the machine (extension pages, about:).
// Every other allowed request is fetched by Playwright from 127.0.0.1 and
// fulfilled. Anything else is aborted. An unexpected host fails the spec.
//
// Playwright routes the extension service worker's requests as well. The test
// build's background reaches buyerapi only through sbw:test:baseUrl
// (FAKE_BUYERAPI on 127.0.0.1), so a service-worker request that still names the prod
// origin is unexpected: mapping it to the fake would hide a hook that does not
// rewrite (or an override lost when the worker restarted).
//
// Ports (T-39b): each run gets its own. scripts/run-playwright.ts picks three
// free loopback ports and passes them in the env vars below; the fake servers
// (playwright.config.ts starts them) read the same vars, and so does every
// worker. Without the vars (a bare `playwright test`) the defaults apply, and
// playwright.config.ts never reuses a server already on a port: it fails fast.

/** The env var each fake server reads its port from (the names the servers already used). */
export const FAKE_PORT_ENV = {
  sgw: 'SBW_FAKE_SGW_PORT',
  google: 'FAKE_GOOGLE_PORT',
  site: 'SBW_FAKE_SITE_PORT',
} as const;
export const DEFAULT_FAKE_PORTS = { sgw: 8787, google: 8788, site: 8789 } as const;
export type FakeName = keyof typeof FAKE_PORT_ENV;

/** The port of one fake for this run: its env var, else the default. Port 0 or junk throws. */
export function fakePort(name: FakeName, env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[FAKE_PORT_ENV[name]];
  if (raw === undefined || raw === '') return DEFAULT_FAKE_PORTS[name];
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${FAKE_PORT_ENV[name]}=${JSON.stringify(raw)}: the Chromium E2E needs a concrete port (1-65535)`);
  }
  return port;
}

export const FAKE_PORTS = { sgw: fakePort('sgw'), google: fakePort('google'), site: fakePort('site') } as const;
export const FAKE_SITE = `http://127.0.0.1:${String(FAKE_PORTS.site)}`;
export const FAKE_BUYERAPI = `http://127.0.0.1:${String(FAKE_PORTS.sgw)}`;
export const FAKE_GOOGLE = `http://127.0.0.1:${String(FAKE_PORTS.google)}`;

const LOCAL_PORTS = new Set(Object.values(FAKE_PORTS).map(String));

export type RouteDecision =
  | { action: 'fetch'; url: string; bucket: 'site' | 'buyerapi' | 'local' }
  | { action: 'abort'; unexpected: boolean }
  | { action: 'continue' };

/** Who issued the request: `serviceWorker` is true for the extension's background. */
export interface RequestSource {
  serviceWorker: boolean;
}

/** The upstream URL is always a local fake. The original host is never fetched. */
export function decideRequest(rawUrl: string, from: RequestSource = { serviceWorker: false }): RouteDecision {
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
    if (from.serviceWorker) return { action: 'abort', unexpected: true };
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
