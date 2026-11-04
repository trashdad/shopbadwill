// T-123: the ntfy server origin and the optional access token. The server is
// any https origin with no path, query or credentials; the host permission is
// requested for exactly that host. Placeholder hosts only (the repo is public).
import { describe, expect, it } from 'vitest';

import {
  isAllowedServer,
  normalizeToken,
  parseServer,
  serverHost,
  serverPermissionPattern,
} from '../../../../src/adapters/ntfy/server';

describe('parseServer', () => {
  it.each([
    ['https://ntfy.sh', 'https://ntfy.sh'],
    ['https://ntfy.example.com', 'https://ntfy.example.com'],
    ['  https://ntfy.example.com/  ', 'https://ntfy.example.com'],
    ['HTTPS://NTFY.Example.COM', 'https://ntfy.example.com'],
    ['https://ntfy.example.com:8443', 'https://ntfy.example.com:8443'],
    ['https://ntfy.example.com:443', 'https://ntfy.example.com'],
    ['https://192.0.2.10', 'https://192.0.2.10'],
  ])('accepts %s as the origin %s', (input, origin) => {
    expect(parseServer(input)).toEqual({ ok: true, origin });
  });

  it.each([
    ['', /enter the server address/i],
    ['ntfy.example.com', /https:\/\//i],
    ['not a url at all', /https:\/\//i],
    ['http://ntfy.example.com', /https/i],
    ['http://localhost', /https/i],
    ['http://127.0.0.1:8080', /https/i],
    ['ftp://ntfy.example.com', /https/i],
    ['https://user:pass@ntfy.example.com', /user name and password/i],
    ['https://user@ntfy.example.com', /user name and password/i],
    ['https://ntfy.example.com/sbw-topic', /no path/i],
    ['https://ntfy.example.com/?x=1', /no path/i],
    ['https://ntfy.example.com/#frag', /no path/i],
    ['https://*.example.com', /host name/i],
    ['https://ntfy_example.com', /host name/i],
  ])('refuses %j with a plain explanation', (input, message) => {
    const result = parseServer(input);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toMatch(message);
  });

  it('never repeats what was typed in its message (it could hold a password)', () => {
    const result = parseServer('https://alice:hunter2-secret@ntfy.example.com');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).not.toContain('hunter2');
      expect(result.message).not.toContain('alice');
    }
  });
});

describe('isAllowedServer', () => {
  it('is true only for an already-normalized https origin', () => {
    expect(isAllowedServer('https://ntfy.sh')).toBe(true);
    expect(isAllowedServer('https://ntfy.example.com:8443')).toBe(true);
    expect(isAllowedServer('https://ntfy.example.com/')).toBe(false);
    expect(isAllowedServer('https://NTFY.example.com')).toBe(false);
    expect(isAllowedServer('http://ntfy.example.com')).toBe(false);
    expect(isAllowedServer('https://ntfy.example.com/x')).toBe(false);
    expect(isAllowedServer('')).toBe(false);
  });
});

describe('serverPermissionPattern and serverHost', () => {
  it('asks for exactly the configured host (match patterns carry no port)', () => {
    expect(serverPermissionPattern('https://ntfy.sh')).toBe('https://ntfy.sh/*');
    expect(serverPermissionPattern('https://ntfy.example.com')).toBe('https://ntfy.example.com/*');
    expect(serverPermissionPattern('https://ntfy.example.com:8443')).toBe('https://ntfy.example.com/*');
  });

  it('names the host for messages', () => {
    expect(serverHost('https://ntfy.sh')).toBe('ntfy.sh');
    expect(serverHost('https://ntfy.example.com:8443')).toBe('ntfy.example.com:8443');
  });
});

describe('normalizeToken', () => {
  it('trims a pasted token and accepts header-safe characters', () => {
    expect(normalizeToken('  tk_abcdefghijklmnopqrstuvwxyz123  ')).toEqual({ ok: true, token: 'tk_abcdefghijklmnopqrstuvwxyz123' });
  });

  it.each(['', '   ', 'tk_abc def', 'tk_abc\nxyz', 'tk_ü', 'x'.repeat(257)])('refuses %j without echoing it', (input) => {
    const result = normalizeToken(input);
    expect(result.ok).toBe(false);
    if (!result.ok && input.trim() !== '') expect(result.message).not.toContain(input.trim());
  });
});
