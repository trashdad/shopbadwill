// T-62: PKCE (RFC 7636) and OAuth `state` helpers. Pure apart from WebCrypto:
// randomness comes from crypto.getRandomValues, the challenge from SHA-256.

/** Fills `length` bytes from a cryptographically secure source. */
export type RandomBytes = (length: number) => Uint8Array;

export const cryptoRandomBytes: RandomBytes = (length) => crypto.getRandomValues(new Uint8Array(length));

/** RFC 7636 §4.1: 43 to 128 characters from the unreserved set. */
const VERIFIER_RE = /^[A-Za-z0-9\-._~]{43,128}$/;

/** 32 random bytes: a 43-character verifier (256 bits). */
const VERIFIER_BYTES = 32;
/** 32 random bytes of `state` (256 bits; RFC 6749 §10.10 asks for at least 128). */
const STATE_BYTES = 32;

/** Base64url without padding (RFC 4648 §5, as RFC 7636 Appendix A requires). */
export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function isValidVerifier(verifier: string): boolean {
  return VERIFIER_RE.test(verifier);
}

/** 32..96 bytes encode to a 43..128-character verifier. */
export function verifierFromBytes(bytes: Uint8Array): string {
  if (bytes.length < 32 || bytes.length > 96) {
    throw new RangeError(`PKCE verifier needs 32..96 random bytes, got ${String(bytes.length)}`);
  }
  return base64UrlEncode(bytes);
}

export function createVerifier(random: RandomBytes = cryptoRandomBytes): string {
  return verifierFromBytes(random(VERIFIER_BYTES));
}

/** code_challenge = BASE64URL(SHA256(ASCII(code_verifier))) (RFC 7636 §4.2, S256). */
export async function challengeS256(verifier: string): Promise<string> {
  if (!isValidVerifier(verifier)) throw new RangeError('invalid PKCE code_verifier');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64UrlEncode(new Uint8Array(digest));
}

/** Opaque, unguessable anti-CSRF `state`, bound to one authorization request. */
export function createState(random: RandomBytes = cryptoRandomBytes): string {
  return base64UrlEncode(random(STATE_BYTES));
}
