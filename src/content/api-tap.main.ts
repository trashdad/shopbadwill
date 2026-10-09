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
//
// The `() => undefined` rejection handler on our derived fetch promise marks
// that derived promise as handled. The page's own promise is returned
// untouched, but because any reaction handler marks a promise as handled, the
// page's `unhandledrejection` event will not fire for a rejected fetch the page
// itself never handles. Accepted trade-off.
//
// Natives (setTimeout, URL, Headers, Promise.resolve, XHR addEventListener) are
// captured inside installApiTap at document_start, before zone.js / Angular
// patch them, so the tap's timer and listeners do not touch Angular's zone.
//
// This module is bundled into the page at document_start on every SGW page:
// keep it tiny and never import zod here (receiver schema: ./tap-message.ts).
import { JWT_RE } from './jwt';

export const TAP_SOURCE = 'sbw-api-tap';
/** Attribute the isolated script sets on <html> before the tap runs. */
export const NONCE_ATTR = 'data-sbw-nonce';
export const MAX_BODY_CHARS = 2 * 1024 * 1024;
export const MAX_BUFFER_MESSAGES = 50;
export const MAX_BUFFER_CHARS = 1024 * 1024;
export const BUFFER_GIVE_UP_MS = 15_000;
const BUYERAPI_HOST = 'buyerapi.shopgoodwill.com';
const MARK = Symbol.for('sbw.apiTap.installed');
const TOO_LARGE = { tooLarge: true } as const;

export function isBuyerApiUrl(url: string, base = 'https://shopgoodwill.com/', URLCtor: typeof URL = URL): boolean {
  try {
    const u = new URLCtor(url, base);
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
  if (text.length > MAX_BODY_CHARS) return TOO_LARGE;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/** Authorization value from Headers, array pairs or a plain object; never iterates anything else. */
function authFrom(h: unknown, HeadersCtor: typeof Headers): string | null {
  if (h instanceof HeadersCtor) return h.get('authorization');
  if (Array.isArray(h)) {
    for (const e of h as unknown[]) {
      if (Array.isArray(e) && typeof e[0] === 'string' && e[0].toLowerCase() === 'authorization') {
        return typeof e[1] === 'string' ? e[1] : null;
      }
    }
    return null;
  }
  if (Object.prototype.toString.call(h) === '[object Object]') {
    for (const k of Object.keys(h as object)) {
      if (k.toLowerCase() === 'authorization') {
        const v = (h as Record<string, unknown>)[k];
        return typeof v === 'string' ? v : null;
      }
    }
  }
  return null;
}

type AnyFn = (...a: never[]) => unknown;
function hide(target: object, key: symbol): void {
  Object.defineProperty(target, key, { value: true, enumerable: false, configurable: true });
}
function mimic(wrapper: AnyFn, native: AnyFn): void {
  try {
    Object.defineProperty(wrapper, 'name', { value: native.name, configurable: true });
    Object.defineProperty(wrapper, 'length', { value: native.length, configurable: true });
  } catch {
    /* cosmetic only */
  }
}

// Minimal structural types so tests can inject fakes.
interface XhrLike {
  status: number;
  responseType: string;
  responseText: string;
  response: unknown;
  responseURL?: string;
  getResponseHeader?(name: string): string | null;
}
type XhrMethod = (this: XhrLike, ...a: unknown[]) => unknown;
interface XhrProto {
  open: XhrMethod;
  setRequestHeader: XhrMethod;
  send: XhrMethod;
  addEventListener: (this: XhrLike, type: 'load', cb: () => void) => void;
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
  // Natives captured now (document_start), before the page's libraries patch them.
  const NativeURL = URL;
  const NativeHeaders = Headers;
  const nativeResolve = Promise.resolve.bind(Promise);
  const nativeSetTimeout = globalThis.setTimeout.bind(globalThis);
  const nativeClearTimeout = globalThis.clearTimeout.bind(globalThis);
  const isBuyer = (u: string): boolean => isBuyerApiUrl(u, win.location.href, NativeURL);

  // Messages produced before the isolated script has set the nonce are held
  // (bounded: 50 msgs / 1 MB, oldest dropped, abandoned after 15 s) and
  // flushed in order once the attribute appears. The bearer has its own slot
  // so eviction can never lose it.
  let buffer: { msg: Record<string, unknown>; size: number }[] = [];
  let bufferChars = 0;
  let pendingToken: string | null = null;
  let lastBearer: string | null = null; // last token actually posted
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
  const sendToken = (nonce: string, bearer: string): void => {
    lastBearer = bearer;
    send(nonce, { kind: 'token', bearer });
  };
  const stopWaiting = (): void => {
    observer?.disconnect();
    observer = undefined;
    if (timer !== undefined) nativeClearTimeout(timer);
    timer = undefined;
  };
  const flush = (nonce: string): void => {
    const pending = buffer;
    const token = pendingToken;
    buffer = [];
    bufferChars = 0;
    pendingToken = null;
    stopWaiting();
    if (token !== null) sendToken(nonce, token);
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
    timer = nativeSetTimeout(() => {
      gaveUp = true;
      buffer = [];
      bufferChars = 0;
      pendingToken = null;
      lastBearer = null;
      stopWaiting();
    }, BUFFER_GIVE_UP_MS);
  };
  const sizeOf = (body: unknown): number => {
    if (typeof body === 'string') return body.length + 200;
    if (body === undefined || body === null) return 200;
    try {
      return JSON.stringify(body).length + 200;
    } catch {
      return MAX_BUFFER_CHARS + 1;
    }
  };
  const relayBearer = (url: string, header: string): void => {
    if (!isBuyer(url)) return;
    const bearer = extractBearer(header);
    if (bearer === null || bearer === lastBearer || bearer === pendingToken) return;
    try {
      const nonce = readNonce();
      if (nonce !== null) {
        flush(nonce);
        sendToken(nonce, bearer);
        return;
      }
      if (gaveUp) return;
      pendingToken = bearer;
      startWaiting();
    } catch {
      /* observation must never break the page */
    }
  };
  const relayResponse = (url: string, status: number, body: unknown): void => {
    try {
      const nonce = readNonce();
      if (nonce !== null) {
        flush(nonce);
        send(nonce, { kind: 'response', url, status, body });
        return;
      }
      if (gaveUp) return;
      let size = sizeOf(body);
      let held = body;
      if (size > MAX_BUFFER_CHARS) {
        held = TOO_LARGE;
        size = 200;
      }
      buffer.push({ msg: { kind: 'response', url, status, body: held }, size });
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

  // ── XHR ──
  const proto = win.XMLHttpRequest?.prototype as XhrProto | undefined;
  if (proto && proto[MARK] !== true) {
    hide(proto, MARK);
    const urls = new WeakMap<object, string>();
    const listening = new WeakSet<object>();
    const origOpen = proto.open;
    const origSet = proto.setRequestHeader;
    const origSend = proto.send;
    const nativeAdd = proto.addEventListener;

    const onLoad = (x: XhrLike): void => {
      try {
        const url = urls.get(x); // re-checked at load: the XHR may have been re-opened elsewhere
        if (url === undefined || !isBuyer(url)) return;
        const t = x.responseType;
        if (t !== '' && t !== 'text' && t !== 'json') return;
        const len = Number(x.getResponseHeader?.('content-length'));
        let body: unknown;
        if (len > MAX_BODY_CHARS) {
          body = TOO_LARGE;
        } else if (t === 'json') {
          try {
            body = JSON.stringify(x.response).length > MAX_BODY_CHARS ? TOO_LARGE : x.response;
          } catch {
            body = TOO_LARGE;
          }
        } else {
          body = toBody(x.responseText);
        }
        relayResponse(x.responseURL || url, x.status, body);
      } catch {
        /* ignore */
      }
    };

    proto.open = function (this: XhrLike, ...args: unknown[]) {
      try {
        const u = args[1];
        urls.set(this, u instanceof NativeURL ? u.href : String(u));
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
        if (url !== undefined && !listening.has(this) && isBuyer(url)) {
          listening.add(this);
          nativeAdd.call(this, 'load', () => {
            onLoad(this);
          });
        }
      } catch {
        /* ignore */
      }
      return origSend.apply(this, args);
    };
    mimic(proto.open, origOpen);
    mimic(proto.setRequestHeader, origSet);
    mimic(proto.send, origSend);
  }

  // ── fetch ──
  const origFetch = win.fetch as ((...a: unknown[]) => unknown) | undefined;
  if (typeof origFetch === 'function' && (origFetch as unknown as Record<symbol, unknown>)[MARK] !== true) {
    const wrapped = function (this: unknown, ...args: unknown[]) {
      let url: string | null = null;
      try {
        const input = args[0];
        const init = args[1];
        let raw: string | undefined;
        let inputHeaders: unknown;
        if (typeof input === 'string') raw = input;
        else if (input instanceof NativeURL) raw = input.href;
        else if (input !== null && typeof input === 'object') {
          const r = input as { url?: unknown; headers?: unknown };
          if (typeof r.url === 'string') raw = r.url;
          inputHeaders = r.headers;
        }
        if (raw !== undefined && isBuyer(raw)) {
          url = raw;
          const initHeaders = init !== null && typeof init === 'object' ? (init as { headers?: unknown }).headers : undefined;
          const auth = authFrom(initHeaders ?? inputHeaders, NativeHeaders);
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
          void nativeResolve(result).then(
            (res) => {
              try {
                const r = res as Response;
                if (Number(r.headers.get('content-length')) > MAX_BODY_CHARS) {
                  relayResponse(u, r.status, TOO_LARGE);
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
    mimic(wrapped, origFetch);
    hide(wrapped, MARK);
    win.fetch = wrapped;
  }
}
