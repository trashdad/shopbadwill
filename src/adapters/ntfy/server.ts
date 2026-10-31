// T-123: which ntfy server phone push talks to, and the optional access token.
//
// The server is any https origin (default https://ntfy.sh), stored normalized
// as `URL.origin`: no path, query, fragment or credentials. Every ntfy request
// (publish, cancel, test push) goes to that origin and nowhere else, and the
// host permission is requested for exactly that host (`https://<host>/*`; a
// match pattern carries no port). The manifest declares `https://*/*` as an
// optional host so any server can be asked for; it is never requested whole.
//
// The token (`tk_...` from `ntfy token add`) is a secret like the topic: it is
// never logged, audited, put into an error message or exported. Messages here
// never repeat the input, which could hold a password or a token.

export const DEFAULT_NTFY_SERVER = 'https://ntfy.sh';

/** A DNS name or IPv4 address (lowercase, as URL leaves it), or a bracketed IPv6 address. */
const HOST_SHAPE = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*|\[[0-9a-f:.]+\])$/;

/** Bytes a header value may carry without fetch throwing or garbling: printable ASCII, no space. */
const TOKEN_SHAPE = /^[\x21-\x7e]{1,256}$/;

export type ServerResult = { ok: true; origin: string } | { ok: false; message: string };
export type TokenResult = { ok: true; token: string } | { ok: false; message: string };

const NEED_HTTPS = 'Enter the server as an https:// address, like https://ntfy.example.com. Plain http is not allowed.';

/** Validates what the user typed and returns the origin to store. */
export function parseServer(input: string): ServerResult {
  const text = input.trim();
  if (text === '') return { ok: false, message: 'Enter the server address, for example https://ntfy.example.com.' };
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return { ok: false, message: NEED_HTTPS };
  }
  if (url.protocol !== 'https:') return { ok: false, message: NEED_HTTPS };
  if (url.username !== '' || url.password !== '') {
    return {
      ok: false,
      message: 'Leave the user name and password out of the address. Paste an access token below instead.',
    };
  }
  if ((url.pathname !== '/' && url.pathname !== '') || url.search !== '' || url.hash !== '' || text.endsWith('?') || text.endsWith('#')) {
    return {
      ok: false,
      message: 'Enter only the server address, with no path after it: https://ntfy.example.com, not https://ntfy.example.com/topic.',
    };
  }
  if (!HOST_SHAPE.test(url.hostname)) return { ok: false, message: 'That host name is not valid.' };
  return { ok: true, origin: url.origin };
}

/** A stored server value the sink may use: a valid https origin, already normalized. */
export function isAllowedServer(server: string): boolean {
  const parsed = parseServer(server);
  return parsed.ok && parsed.origin === server;
}

/** The optional host permission for this server: exactly its host, any port. */
export function serverPermissionPattern(origin: string): string {
  return `https://${new URL(origin).hostname}/*`;
}

/** The host (and port, if any) to name in messages. */
export function serverHost(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return 'the server';
  }
}

/** Trims a pasted token and checks it can travel as a header value. Never echoes it. */
export function normalizeToken(input: string): TokenResult {
  const token = input.trim();
  if (token === '') return { ok: false, message: 'Paste the access token first.' };
  if (!TOKEN_SHAPE.test(token)) {
    return {
      ok: false,
      message: 'That does not look like an access token: it has spaces or characters a token cannot have. Copy it again.',
    };
  }
  return { ok: true, token };
}

/** `Bearer <token>` header when a token is set; no header at all otherwise. */
export function authHeaders(token: string | undefined): Record<string, string> {
  return token === undefined || token === '' ? {} : { Authorization: `Bearer ${token}` };
}
