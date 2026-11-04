// T-69 (R3): the ntfy topic. It is a secret that grants publish rights on the
// topic, so it is 128 bits of `crypto.getRandomValues` entropy, encoded as
// lowercase base32 (26 characters) and prefixed `sbw-`. It is never logged,
// audited or put into an error message; outside the options field only the last
// 4 characters may be shown (`maskTopic`).
export const TOPIC_PREFIX = 'sbw-';

const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';

/** A topic ntfy.sh accepts: 1-64 of [a-z0-9_-], not starting with a hyphen. */
const TOPIC_SHAPE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/**
 * A fresh 128-bit topic, `sbw-` + 26 base32 characters (lowercase, url-safe).
 * `random` is injectable for tests and must return at least 16 bytes.
 */
export function generateTopic(random: () => Uint8Array = () => crypto.getRandomValues(new Uint8Array(16))): string {
  const bytes = random();
  if (bytes.length < 16) throw new RangeError(`the topic needs 128 bits of entropy, got ${String(bytes.length * 8)}`);
  const digit = (index: number): string => BASE32[index] ?? '';
  let acc = 0;
  let bits = 0;
  let out = '';
  for (let i = 0; i < 16; i++) {
    const b = bytes[i] ?? 0;
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += digit((acc >> bits) & 31);
    }
  }
  if (bits > 0) out += digit((acc << (5 - bits)) & 31);
  return `${TOPIC_PREFIX}${out}`;
}

/** Whether the topic could be a real ntfy topic (url-safe, 1-64 chars, no leading hyphen). */
export function isValidTopic(topic: string): boolean {
  return TOPIC_SHAPE.test(topic);
}

/** At most the last 4 characters (R3): what may be shown outside the options field. */
export function maskTopic(topic: string): string {
  return topic.length <= 4 ? topic : `…${topic.slice(-4)}`;
}
