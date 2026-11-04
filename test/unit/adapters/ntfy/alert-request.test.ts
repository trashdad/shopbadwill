// R-3: the immediate alert publish (`ntfyRequest('alert', ...)`). Pure wire
// shape; no network. Placeholders only: never a real server, topic or token.
import { describe, expect, it } from 'vitest';

import { ntfyRequest } from '../../../../src/adapters/ntfy/ntfy-sink';

const SERVER = 'https://ntfy.example.com';
const TOPIC = 'sbw-abcdefghijklmnopqrstuvwxyz';
const TOKEN = 'tk_placeholdertokenplaceholder0';

/** Decodes RFC 2047 encoded-words the way ntfy's server does (whitespace between words dropped). */
function decodeRfc2047(value: string): string {
  const words = value.split(' ');
  if (!words.every((w) => /^=\?UTF-8\?B\?[A-Za-z0-9+/=]*\?=$/.test(w))) return value;
  const bytes = words.flatMap((w) => [...Buffer.from(w.slice('=?UTF-8?B?'.length, -2), 'base64')]);
  return new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(bytes));
}

describe("ntfyRequest('alert', ...)", () => {
  it('is one immediate POST to <server>/<topic>: priority 5, rotating_light, X-Click, no delay or sequence id', () => {
    const req = ntfyRequest('alert', { server: SERVER, topic: TOPIC }, { title: 'Won: Pyrex bowl', body: 'You won this auction.', clickUrl: 'https://shopgoodwill.com/item/7' });
    expect(req.method).toBe('POST');
    expect(req.url).toBe(`${SERVER}/${TOPIC}`);
    expect(req.credentials).toBe('omit');
    expect(req.body).toBe('You won this auction.');
    expect(req.headers).toEqual({
      'X-Title': 'Won: Pyrex bowl',
      'X-Click': 'https://shopgoodwill.com/item/7',
      'X-Priority': '5',
      'X-Tags': 'rotating_light',
    });
  });

  it('leaves X-Click out when there is no click URL', () => {
    const req = ntfyRequest('alert', { server: SERVER, topic: TOPIC }, { title: 'Snipe at risk', body: 'x' });
    expect(req.headers).not.toHaveProperty('X-Click');
    expect(req.headers).not.toHaveProperty('X-Delay');
    expect(req.headers).not.toHaveProperty('X-Sequence-ID');
  });

  it('sends Authorization: Bearer only when a token is set', () => {
    expect(ntfyRequest('alert', { server: SERVER, topic: TOPIC, token: TOKEN }, { title: 't', body: 'b' }).headers?.Authorization).toBe(
      `Bearer ${TOKEN}`,
    );
    expect(ntfyRequest('alert', { server: SERVER, topic: TOPIC }, { title: 't', body: 'b' }).headers).not.toHaveProperty('Authorization');
    expect(ntfyRequest('alert', { server: SERVER, topic: TOPIC, token: '' }, { title: 't', body: 'b' }).headers).not.toHaveProperty(
      'Authorization',
    );
  });

  it('encodes a non-ASCII title as RFC 2047 encoded-words', () => {
    const title = 'Won: Men’s “Butterprint” Pyrex — Café 🎉…';
    const value = ntfyRequest('alert', { server: SERVER, topic: TOPIC }, { title, body: 'b' }).headers?.['X-Title'] ?? '';
    expect(value).toMatch(/^[\x20-\x7e]+$/);
    expect(value.startsWith('=?UTF-8?B?')).toBe(true);
    expect(decodeRfc2047(value)).toBe(title);
  });

  it('refuses a server that is not a normalized https origin, without the topic or token in the error', () => {
    let error: unknown;
    try {
      ntfyRequest('alert', { server: 'http://ntfy.example.com', topic: TOPIC, token: TOKEN }, { title: 't', body: 'b' });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain(TOPIC);
    expect(String(error)).not.toContain(TOKEN);
  });
});
