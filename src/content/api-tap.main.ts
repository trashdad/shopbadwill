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
// This module is bundled into the page at document_start on every SGW page:
// keep it tiny and never import zod here (receiver schema: ./tap-message.ts).

export const TAP_SOURCE = 'sbw-api-tap';
/** Attribute the isolated script sets on <html> before the tap runs. */
export const NONCE_ATTR = 'data-sbw-nonce';
export const MAX_BODY_CHARS = 2 * 1024 * 1024;
const BUYERAPI_HOST = 'buyerapi.shopgoodwill.com';
const MARK = Symbol.for('sbw.apiTap.installed');
export const MAX_BUFFER_MESSAGES = 50;
export const MAX_BUFFER_CHARS = 1024 * 1024;
export const BUFFER_GIVE_UP_MS = 15_000;
const JWT_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/;

export function isBuyerApiUrl(url: string, base = 'https://shopgoodwill.com/'): boolean {
  try {
    const u = new URL(url, base);
    return u.protocol === 'https:' && u.hostname === BUYERAPI_HOST;
  } catch {
    return false;
  }
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
  MutationObserver?: new (cb: () => void) => { observe(n: never, o: never): void; disconnect(): void };
  location: { href: string; origin: string };
  document: { documentElement: { getAttribute(n: string): string | null } };
}

export function installApiTap(win: TapTarget): void {
  // Messages produced before the isolated script has set the nonce are held
  // (bounded: 50 msgs / 1 MB, oldest dropped, abandoned after 15 s) and
  // flushed in order once the attribute appears.
  let buffer: { msg: Record<string, unknown>; size: number }[] = [];
  let bufferChars = 0;
  let gaveUp = false;
  let observer: { disconnect(): void } | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const readNonce = (): string | null => {
    try {
      const n = win.document.documentElement.getAttribute(NONCE_ATTR);
      return n === null || n === '' ? null : n;
    } catch {
      return null;
    }
  };
  const send = (nonce: string, msg: Record<string, unknown>): void => {
    try {
      win.postMessage({ source: TAP_SOURCE, nonce, ...msg }, win.location.origin);
    } catch {
      /* observation must never break the page */
    }
  };
  const stopWaiting = (): void => {
    observer?.disconnect();
    observer = undefined;
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
  const flush = (nonce: string): void => {
    const pending = buffer;
    buffer = [];
    bufferChars = 0;
    stopWaiting();
    for (const p of pending) send(nonce, p.msg);
  };
  const startWaiting = (): void => {
    if (observer !== undefined || timer !== undefined) return;
    try {
      if (win.MutationObserver) {
        const o = new win.MutationObserver(() => {
          const n = readNonce();
          if (n !== null) flush(n);
        });
        o.observe(win.document.documentElement as never, { attributes: true, attributeFilter: [NONCE_ATTR] } as never);
        observer = o;
      }
    } catch {
      /* lazy flush on the next message still works */
    }
    timer = setTimeout(() => {
      gaveUp = true;
      buffer = [];
      bufferChars = 0;
      stopWaiting();
    }, BUFFER_GIVE_UP_MS);
  };
  const sizeOf = (msg: Record<string, unknown>): number => {
    const b = msg.body;
    if (typeof b === 'string') return b.length + 200;
    if (b === undefined || b === null) return 200;
    try {
      return JSON.stringify(b).length + 200;
    } catch {
      return MAX_BUFFER_CHARS;
    }
  };
  const post = (msg: Record<string, unknown>): void => {
    try {
      const nonce = readNonce();
      if (nonce !== null) {
        flush(nonce);
        send(nonce, msg);
        return;
      }
      if (gaveUp) return;
      const size = sizeOf(msg);
      if (size > MAX_BUFFER_CHARS) return;
      buffer.push({ msg, size });
      bufferChars += size;
      while (buffer.length > MAX_BUFFER_MESSAGES || bufferChars > MAX_BUFFER_CHARS) {
        const dropped = buffer.shift();
        bufferChars -= dropped?.size ?? 0;
      }
      startWaiting();
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
