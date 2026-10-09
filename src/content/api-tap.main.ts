// MAIN-world api-tap (T-31). Runs in the page's own JS world at document_start
// and OBSERVES SGW's buyerapi traffic. It must never alter page behaviour:
// wrappers forward `this`, arguments, return values, exceptions and rejections
// untouched, and bodies are read from clones / after load only.
//
// Threat model: `window.postMessage` is visible to every script on the page.
// Any third-party script already running there can read the page's own token
// (it is in the page's XHR calls and cookie), so relaying it adds little
// exposure. Mitigations: the bearer is relayed only for buyerapi URLs, only if
// `Bearer <JWT-shaped>`, once per change, with our own origin as the target
// origin, and is never logged; the receiver treats every message as untrusted
// (`parseTapMessage`); the per-page nonce only avoids collisions, it is NOT
// authentication.
import { z } from 'zod';

export const TAP_SOURCE = 'sbw-api-tap';
/** Attribute the isolated script sets on <html> before the tap runs. */
export const NONCE_ATTR = 'data-sbw-nonce';
export const MAX_BODY_CHARS = 2 * 1024 * 1024;
const BUYERAPI_HOST = 'buyerapi.shopgoodwill.com';
const MARK = Symbol.for('sbw.apiTap.installed');
const JWT_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/;

/** Response body: parsed JSON, raw text, or `{ tooLarge: true }` over 2 MB. */
export const TapMessageSchema = z.discriminatedUnion('kind', [
  z.object({
    source: z.literal(TAP_SOURCE),
    nonce: z.string().min(1),
    kind: z.literal('response'),
    url: z.string(),
    status: z.number().int(),
    body: z.unknown(),
  }),
  z.object({
    source: z.literal(TAP_SOURCE),
    nonce: z.string().min(1),
    kind: z.literal('token'),
    /** Bare JWT, no "Bearer " prefix. */
    bearer: z.string().regex(JWT_RE),
  }),
]);
export type TapMessage = z.infer<typeof TapMessageSchema>;

export function isBuyerApiUrl(url: string, base = 'https://shopgoodwill.com/'): boolean {
  try {
    const u = new URL(url, base);
    return u.protocol === 'https:' && u.hostname === BUYERAPI_HOST;
  } catch {
    return false;
  }
}

/**
 * Receiver-side validation (for the isolated script, T-32). Returns null for
 * anything malformed, carrying the wrong nonce, a non-buyerapi response URL or
 * a token that is not JWT-shaped.
 */
export function parseTapMessage(data: unknown, nonce: string): TapMessage | null {
  const r = TapMessageSchema.safeParse(data);
  if (!r.success || r.data.nonce !== nonce) return null;
  if (r.data.kind === 'response' && !isBuyerApiUrl(r.data.url)) return null;
  return r.data;
}

/** `Bearer <jwt>` -> bare jwt, else null. */
export function extractBearer(header: string): string | null {
  const m = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return m?.[1] !== undefined && JWT_RE.test(m[1]) ? m[1] : null;
}

function toBody(text: string): unknown {
  if (text.length > MAX_BODY_CHARS) return { tooLarge: true };
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

// Minimal structural types so tests can inject fakes.
interface XhrLike {
  status: number;
  responseType: string;
  responseText: string;
  response: unknown;
  responseURL?: string;
  addEventListener(type: 'load', cb: () => void): void;
}
type XhrMethod = (this: XhrLike, ...a: unknown[]) => unknown;
interface XhrProto {
  open: XhrMethod;
  setRequestHeader: XhrMethod;
  send: XhrMethod;
  [k: symbol]: unknown;
}
export interface TapTarget {
  XMLHttpRequest?: { prototype: object };
  fetch?: unknown;
  postMessage(msg: unknown, targetOrigin: string): void;
  location: { href: string; origin: string };
  document: { documentElement: { getAttribute(n: string): string | null } };
}

export function installApiTap(win: TapTarget): void {
  const post = (msg: Record<string, unknown>): void => {
    try {
      const nonce = win.document.documentElement.getAttribute(NONCE_ATTR);
      if (nonce === null || nonce === '') return; // no receiver yet: drop
      win.postMessage({ source: TAP_SOURCE, nonce, ...msg }, win.location.origin);
    } catch {
      /* observation must never break the page */
    }
  };
  let lastBearer: string | null = null;
  const relayBearer = (url: string, header: string): void => {
    if (!isBuyerApiUrl(url, win.location.href)) return;
    const bearer = extractBearer(header);
    if (bearer === null || bearer === lastBearer) return;
    lastBearer = bearer;
    post({ kind: 'token', bearer });
  };
  const relayResponse = (url: string, status: number, body: unknown): void => {
    post({ kind: 'response', url, status, body });
  };

  // ── XHR ──
  const proto = win.XMLHttpRequest?.prototype as XhrProto | undefined;
  if (proto && proto[MARK] !== true) {
    proto[MARK] = true;
    const urls = new WeakMap<object, string>();
    const origOpen = proto.open;
    const origSet = proto.setRequestHeader;
    const origSend = proto.send;
    proto.open = function (this: XhrLike, ...args: unknown[]) {
      try {
        const u = args[1];
        urls.set(this, u instanceof URL ? u.href : String(u));
      } catch {
        /* ignore */
      }
      return origOpen.apply(this, args);
    };
    proto.setRequestHeader = function (this: XhrLike, ...args: unknown[]) {
      try {
        const [name, value] = args;
        const url = urls.get(this);
        if (url !== undefined && typeof name === 'string' && name.toLowerCase() === 'authorization') {
          relayBearer(url, String(value));
        }
      } catch {
        /* ignore */
      }
      return origSet.apply(this, args);
    };
    proto.send = function (this: XhrLike, ...args: unknown[]) {
      try {
        const url = urls.get(this);
        if (url !== undefined && isBuyerApiUrl(url, win.location.href)) {
          this.addEventListener('load', () => {
            try {
              const t = this.responseType;
              if (t !== '' && t !== 'text' && t !== 'json') return;
              const body = t === 'json' ? this.response : toBody(this.responseText);
              relayResponse(this.responseURL || url, this.status, body);
            } catch {
              /* ignore */
            }
          });
        }
      } catch {
        /* ignore */
      }
      return origSend.apply(this, args);
    };
  }

  // ── fetch ──
  const origFetch = win.fetch as ((...a: unknown[]) => unknown) | undefined;
  if (typeof origFetch === 'function' && (origFetch as unknown as Record<symbol, unknown>)[MARK] !== true) {
    const wrapped = function (this: unknown, ...args: unknown[]) {
      let url: string | null = null;
      try {
        const input = args[0] as { url?: string; headers?: HeadersInit } | string | URL;
        const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (raw !== undefined && isBuyerApiUrl(raw, win.location.href)) {
          url = raw;
          const init = args[1] as { headers?: HeadersInit } | undefined;
          const hdrs = init?.headers ?? (typeof input === 'object' && 'headers' in input ? input.headers : undefined);
          const auth = new Headers(hdrs).get('authorization');
          if (auth !== null) relayBearer(raw, auth);
        }
      } catch {
        /* ignore */
      }
      const result = origFetch.apply(this, args);
      if (url !== null) {
        const u = url;
        try {
          // Derived chain only; `result` itself is returned untouched.
          void Promise.resolve(result).then(
            (res) => {
              try {
                const r = res as Response;
                if (Number(r.headers.get('content-length')) > MAX_BODY_CHARS) {
                  relayResponse(u, r.status, { tooLarge: true });
                  return;
                }
                void r
                  .clone()
                  .text()
                  .then((t) => {
                    relayResponse(u, r.status, toBody(t));
                  })
                  .catch(() => undefined);
              } catch {
                /* ignore */
              }
            },
            () => undefined,
          );
        } catch {
          /* ignore */
        }
      }
      return result;
    };
    (wrapped as unknown as Record<symbol, unknown>)[MARK] = true;
    win.fetch = wrapped;
  }
}
