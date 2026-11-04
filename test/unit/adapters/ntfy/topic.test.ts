// T-69: the ntfy topic (R3). It is a secret: 128 bits of entropy, lowercase
// base32, prefixed `sbw-`. Tests pin the shape and the masking rule.
import { describe, expect, it, vi } from 'vitest';

import { TOPIC_PREFIX, generateTopic, isValidTopic, maskTopic } from '../../../../src/adapters/ntfy/topic';

describe('generateTopic', () => {
  it('draws 128 bits from crypto.getRandomValues and encodes them as sbw- plus 26 base32 chars', () => {
    const spy = vi.spyOn(crypto, 'getRandomValues');
    const topic = generateTopic();
    expect(spy).toHaveBeenCalledTimes(1);
    const bytes = spy.mock.calls[0]?.[0];
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes).toHaveLength(16);
    expect(topic.startsWith(TOPIC_PREFIX)).toBe(true);
    expect(topic).toMatch(/^sbw-[a-z2-7]{26}$/);
    spy.mockRestore();
  });

  it('uses exactly the 128 random bits given (deterministic for tests)', () => {
    const topic = generateTopic(() => new Uint8Array(16).fill(0));
    expect(topic).toBe(`${TOPIC_PREFIX}${'a'.repeat(26)}`);
    // 0xff bytes encode to the highest base32 digit (index 31 → '7'); the
    // trailing 3 bits pad to 28 → '4'.
    expect(generateTopic(() => new Uint8Array(16).fill(0xff))).toBe(`${TOPIC_PREFIX}${'7'.repeat(25)}4`);
  });

  it('draws a different topic for different randomness', () => {
    expect(generateTopic(() => new Uint8Array(16).fill(1))).not.toBe(generateTopic(() => new Uint8Array(16).fill(2)));
  });

  it('reads only the first 16 bytes and refuses fewer than 128 bits', () => {
    const long = generateTopic(() => new Uint8Array(32).fill(7));
    expect(long).toMatch(/^sbw-[a-z2-7]{26}$/);
    expect(() => generateTopic(() => new Uint8Array(15))).toThrow(/128 bits/);
  });
});

describe('isValidTopic', () => {
  it('accepts generated topics and the ntfy topic alphabet', () => {
    expect(isValidTopic(generateTopic())).toBe(true);
    expect(isValidTopic('sbw-my-topic_1')).toBe(true);
    expect(isValidTopic('a')).toBe(true);
  });

  it('rejects empty, whitespace, leading hyphens, long and non-url-safe topics', () => {
    for (const bad of ['', ' ', ' topic', 'sbw topic!', '-starts-with-hyphen', 'UPPER', `sbw-${'a'.repeat(65)}`]) {
      expect(isValidTopic(bad), JSON.stringify(bad)).toBe(false);
    }
  });
});

describe('maskTopic', () => {
  it('shows at most the last 4 characters outside the options field', () => {
    expect(maskTopic('sbw-abcdefghijklmnopqrstuvwxyz')).toBe('…wxyz');
    expect(maskTopic('sbw-ab')).toBe('…w-ab');
    expect(maskTopic('x')).toBe('x');
    expect(maskTopic('')).toBe('');
  });
});
