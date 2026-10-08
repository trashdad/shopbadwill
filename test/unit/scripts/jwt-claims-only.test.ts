import { describe, expect, it } from 'vitest';
import { JwtRefusal, analyzeJwt, formatReport } from '../../../scripts/jwt-claims-only';

const b64u = (v: unknown) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url');
const mk = (payload: unknown, header: unknown = { alg: 'HS256', typ: 'JWT' }) =>
  `${b64u(header)}.${b64u(payload)}.${b64u('not-a-real-signature')}`;

// Synthetic, obviously fake values. Each must never appear in output.
const SECRETS = ['SECRET-BUYER-4242', '203.0.113.77', 'Mozilla/5.0 SECRETUA', 'nested-secret-xyz', 'deep-secret-qrs', 'leaky@example.test'];
const IAT = 1_790_000_000;
const EXP = IAT + 30 * 86400;
const payload = {
  BuyerId: 'SECRET-BUYER-4242',
  IpAddress: '203.0.113.77',
  Browser: 'Mozilla/5.0 SECRETUA',
  profile: { note: 'nested-secret-xyz', inner: { deep: 'deep-secret-qrs' } },
  list: ['leaky@example.test'],
  iat: IAT,
  exp: EXP,
};

describe('analyzeJwt', () => {
  it('reports names, iat/exp and lifetime', () => {
    const r = analyzeJwt(mk(payload));
    expect(r.claimNames).toEqual(['BuyerId', 'IpAddress', 'Browser', 'profile', 'list', 'iat', 'exp']);
    expect(r.iat).toBe(new Date(IAT * 1000).toISOString());
    expect(r.exp).toBe(new Date(EXP * 1000).toISOString());
    expect(r.lifetimeHours).toBe(720);
    expect(r.lifetimeDays).toBe(30);
    expect(r.hasIpClaim).toBe(true);
    expect(r.hasBrowserClaim).toBe(true);
  });

  it('never leaks a claim value (flat or nested) or the token', () => {
    const token = mk(payload);
    const out = formatReport(analyzeJwt(token));
    for (const s of SECRETS) expect(out).not.toContain(s);
    expect(out).not.toContain(token);
    expect(out).not.toContain('eyJ');
    expect(out).not.toContain(token.split('.').at(-1) ?? 'x');
  });

  it('reports absent IP/UA claims as no', () => {
    const r = analyzeJwt(mk({ sub: 'x', recipient: 'y', iat: IAT, exp: EXP }));
    expect(r.hasIpClaim).toBe(false);
    expect(r.hasBrowserClaim).toBe(false);
  });

  it('detects UA-like and ip-like names case-insensitively', () => {
    expect(analyzeJwt(mk({ userAgent: 'a' })).hasBrowserClaim).toBe(true);
    expect(analyzeJwt(mk({ clientIp: 'a' })).hasIpClaim).toBe(true);
  });

  it('handles missing or non-numeric iat/exp without echoing them', () => {
    const r = analyzeJwt(mk({ iat: 'SECRET-BUYER-4242', exp: IAT }));
    expect(r.iat).toBeNull();
    expect(r.lifetimeHours).toBeNull();
    const out = formatReport(r);
    expect(out).not.toContain('SECRET-BUYER-4242');
    expect(formatReport(analyzeJwt(mk({ a: 1 })))).toContain('iat: absent');
  });

  it('accepts a leading "Bearer " and surrounding whitespace', () => {
    expect(analyzeJwt(`  Bearer ${mk(payload)}\n`).claimNames).toContain('exp');
  });

  it.each([
    ['empty', ''],
    ['plain text', 'hello world SECRET-BUYER-4242'],
    ['two parts', 'abc.def'],
    ['four parts', 'a.b.c.d'],
    ['non-base64 junk', '!!!.@@@.###'],
    ['payload not JSON', `${b64u({ alg: 'HS256' })}.${b64u('not json')}.sig`],
    ['payload is an array', mk([1, 2])],
    ['payload is a string', mk('"str"')],
    ['header not JSON', `${b64u('nope')}.${b64u({ a: 1 })}.sig`],
    ['header without alg', mk({ a: 1 }, { typ: 'JWT' })],
  ])('refuses %s without echoing the input', (_n, input) => {
    let err: unknown;
    try {
      analyzeJwt(input);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(JwtRefusal);
    const msg = (err as Error).message;
    expect(msg).not.toContain('SECRET-BUYER-4242');
    if (input.length > 8) expect(msg).not.toContain(input);
  });
});

describe('claim name hygiene', () => {
  const longKey = 'k'.repeat(42);
  const keys = ['jane.doe@example.test', longKey, 'a\r\nb', 'x\u202Ey', 'ok_Name'];
  it('omits email-like, long, CR/LF and bidi names', () => {
    const r = analyzeJwt(mk(Object.fromEntries(keys.map((k) => [k, 1]))));
    expect(r.claimNames).toEqual([
      '<name omitted, 21 chars>',
      '<name omitted, 42 chars>',
      '<name omitted, 4 chars>',
      '<name omitted, 3 chars>',
      'ok_Name',
    ]);
    const out = formatReport(r);
    for (const k of keys.slice(0, 4)) expect(out).not.toContain(k);
    expect(out).not.toMatch(/[\u202E\r]/);
    expect(out.split('\n')).toHaveLength(7);
  });
  it('detects IP-like names by the raw name even when it is not printed', () => {
    const r = analyzeJwt(mk({ 'client ip': 1 }));
    expect(r.hasIpClaim).toBe(true);
    expect(r.claimNames[0]).toBe('<name omitted, 9 chars>');
  });
  it('accepts a 41-char name and omits 42', () => {
    expect(analyzeJwt(mk({ ['a'.repeat(41)]: 1 })).claimNames[0]).toBe('a'.repeat(41));
    expect(analyzeJwt(mk({ ['a'.repeat(42)]: 1 })).claimNames[0]).toBe('<name omitted, 42 chars>');
  });
});

describe('formatReport shape', () => {
  it('prints a fixed, pasteable block', () => {
    const lines = formatReport(analyzeJwt(mk(payload))).trimEnd().split('\n');
    expect(lines).toEqual([
      'claims: BuyerId, IpAddress, Browser, profile, list, iat, exp',
      `iat: ${new Date(IAT * 1000).toISOString()}`,
      `exp: ${new Date(EXP * 1000).toISOString()}`,
      'exp - iat: 720.0 hours = 30.00 days',
      'IpAddress-like claim present: yes',
      'Browser/UA-like claim present: yes',
    ]);
  });
});
