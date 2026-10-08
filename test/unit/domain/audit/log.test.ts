import { beforeEach, describe, expect, it } from 'vitest';

import { createAuditLog, redactDetails } from '../../../../src/domain/audit/log';
import type { AuditLog } from '../../../../src/domain/audit/types';
import { Repo } from '../../../../src/domain/storage/repo';
import { FakeClock } from '../../../fakes/ports/fake-clock';
import { FakeStorageAreas } from '../../../fakes/ports/fake-storage';

let areas: FakeStorageAreas;
let log: AuditLog;
const base = { actor: 'system' as const, kind: 'x' };

beforeEach(() => {
  areas = new FakeStorageAreas();
  log = createAuditLog(new Repo(areas, new FakeClock()));
});

describe('AuditLog', () => {
  it('assigns monotonically increasing seq', async () => {
    const a = await log.append({ ...base, details: {} });
    const b = await log.append({ ...base, details: {} });
    const c = await log.append({ ...base, details: {} });
    expect([a.seq, b.seq, c.seq]).toEqual([a.seq, a.seq + 1, a.seq + 2]);
    expect((await log.list({ limit: 10 })).map((e) => e.seq)).toEqual([c.seq, b.seq, a.seq]);
  });

  it('redacts a bearer key before it reaches storage', async () => {
    const e = await log.append({ ...base, details: { bearer: 'SECRET-ABC', ok: 1 } });
    expect(e.details).toEqual({ ok: 1 });
    expect(JSON.stringify(areas.local.dump())).not.toContain('SECRET-ABC');
  });

  it('export is valid JSON', async () => {
    await log.append({ ...base, details: { a: 'b' } });
    const parsed: unknown = JSON.parse(await log.exportJson());
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(1);
  });

  it('redacts ref and undo.ref strings', async () => {
    const e = await log.append({ ...base, ref: '<b>r</b>', details: {}, undo: { kind: 'disarm', ref: '<i>u</i>' } });
    expect(e.ref).toBe('r');
    expect(e.undo?.ref).toBe('u');
  });
});

describe('redactDetails', () => {
  it('drops secret keys case-insensitively, incl. variants and nested', () => {
    const d = redactDetails({
      Bearer: 1,
      accessToken: 'a',
      refresh_token: 'b',
      PASSWORD: 'c',
      Authorization: 'd',
      keep: 'k',
      nested: { token: 'x', deep: [{ password: 'y', fine: 2 }] },
    });
    expect(d.keep).toBe('k');
    expect(d.nested).toBe('{"deep":[{"fine":2}]}');
    expect(Object.keys(d).sort()).toEqual(['keep', 'nested']);
  });

  it('strips HTML and truncates to 2 kB', () => {
    const d = redactDetails({ message: '<p>Hi <script>x</script>there</p>', big: 'a'.repeat(5000) });
    expect(d.message).toBe('Hi there');
    expect(String(d.big).length).toBeLessThanOrEqual(2048);
    expect(String(d.big)).toContain('truncated');
  });

  it('masks JWT-like and Bearer strings under innocent keys', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.abc_DEF-123';
    const d = redactDetails({ note: `got ${jwt} ok`, h: 'Bearer abcdefghijkl' });
    expect(JSON.stringify(d)).not.toContain('eyJhbGci');
    expect(JSON.stringify(d)).not.toContain('abcdefghijkl');
  });

  it('survives cycles, deep nesting, throwing getters, odd values', () => {
    const cyc: Record<string, unknown> = { a: 1 };
    cyc.self = cyc;
    let deep: Record<string, unknown> = { leaf: 1 };
    for (let i = 0; i < 10000; i++) deep = { n: deep };
    const weird = {
      get boom(): never {
        throw new Error('x');
      },
      f: () => 1,
      u: undefined,
      big: 10n,
      nan: NaN,
      d: new Date(NaN),
    };
    const d = redactDetails({ cyc, deep, weird });
    expect(d.cyc).toContain('[circular]');
    expect(d.deep).toContain('[max depth]');
    expect(redactDetails(null)).toEqual({});
    expect(redactDetails('str')).toEqual({});
  });
});

describe('AuditLog leak paths (raw storage dump)', () => {
  const dump = () => JSON.stringify(areas.local.dump());
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.sigSIG123';

  it('drops a secret key beyond the depth cap', async () => {
    let deep: Record<string, unknown> = { password: 'DEEPSECRET' };
    for (let i = 0; i < 20; i++) deep = { n: deep };
    await log.append({ ...base, details: { deep } as never });
    expect(dump()).not.toContain('DEEPSECRET');
  });

  it('redacts a secret inside an array element', async () => {
    await log.append({ ...base, details: { list: [{ token: 'ARRSECRET' }, 'Bearer ARRSECRET2xx', 'ok'] } as never });
    expect(dump()).not.toContain('ARRSECRET');
  });

  it('redacts JSON-string, key=value and key: value secrets', async () => {
    await log.append({
      ...base,
      details: {
        a: '{"access_token":"JSONSECRET1","x":1}',
        b: 'https://x/y?token=QSSECRET2&z=1',
        c: 'password: COLONSECRET3 done',
        d: "refresh_token='QUOTESECRET4'",
      },
    });
    const d = dump();
    for (const s of ['JSONSECRET1', 'QSSECRET2', 'COLONSECRET3', 'QUOTESECRET4']) expect(d).not.toContain(s);
  });

  it('redacts Bearer in ref and undo.ref', async () => {
    await log.append({ ...base, ref: 'Bearer REFSECRET123', details: {}, undo: { kind: 'disarm', ref: 'Bearer UNDOSECRET123' } });
    const d = dump();
    expect(d).not.toContain('REFSECRET123');
    expect(d).not.toContain('UNDOSECRET123');
  });

  it('drops unknown top-level and undo fields', async () => {
    const e = { ...base, details: {}, extra: 'UNKNOWNSECRET', undo: { kind: 'disarm', ref: 'r', evil: 'UNDOEVIL' } };
    await log.append(e as never);
    expect(dump()).not.toMatch(/UNKNOWNSECRET|UNDOEVIL/);
  });

  it('redacts tag-split Bearer and JWT', async () => {
    const split = jwt.slice(0, 12) + '<b>' + jwt.slice(12);
    await log.append({ ...base, details: { m: 'Bearer <b>TAGSPLITSECRET</b>', j: split, k: 'Bearer&nbsp;x' } });
    const d = dump();
    expect(d).not.toContain('TAGSPLITSECRET');
    expect(d).not.toContain('sigSIG123');
  });

  it('handles unclosed script and entity-encoded markup', async () => {
    await log.append({
      ...base,
      details: { s: 'hi <script>token=SCRIPTSECRET', e: 'Bearer &lt;b&gt;ENTSECRET123&lt;/b&gt;', n: '&#60;i&#62;x&#60;/i&#62;' },
    });
    const d = dump();
    expect(d).not.toMatch(/SCRIPTSECRET|ENTSECRET123|<i>|&lt;/);
  });

  it('truncation does not leave a lone high surrogate', () => {
    const d = redactDetails({ s: 'a'.repeat(2048 - '...[truncated]'.length - 1) + '\u{1F600}'.repeat(10) });
    const s = String(d.s);
    const before = s.charCodeAt(s.indexOf('...[truncated]') - 1);
    expect(before >= 0xd800 && before <= 0xdbff).toBe(false);
  });
});

describe('AuditLog header-like and key-family leaks (raw storage dump)', () => {
  const dump = () => JSON.stringify(areas.local.dump());
  const cases: Array<[string, string, string]> = [
    ['Authorization Basic', 'Authorization: Basic dXNlcjpwYXNzd29yZA==', 'dXNlcjpwYXNzd29yZA'],
    ['Proxy-Authorization', 'Proxy-Authorization: Basic PROXYSECRET99 extra', 'PROXYSECRET99'],
    ['multi-pair cookie', 'cookie: a=1; sid=COOKIE2; theme=dark', 'COOKIE2'],
    ['Set-Cookie attrs', 'Set-Cookie: sid=SETCOOKIE3; Path=/; HttpOnly', 'SETCOOKIE3'],
    ['x-api-key', 'x-api-key: APIKEYSECRET4', 'APIKEYSECRET4'],
    ['api_key=', 'GET /x?api_key=APIKEYSECRET5&a=1', 'APIKEYSECRET5'],
    ['percent-encoded', 'q=token%3DPCTSECRET6&z=1', 'PCTSECRET6'],
    ['JSON authorization', '{"authorization":"Basic abc def JSONAUTH7"}', 'JSONAUTH7'],
    ['auth key', 'auth=AUTHSECRET8', 'AUTHSECRET8'],
    ['passphrase/pwd', 'pwd: PWDSECRET9 passphrase=PHRASE10', 'PWDSECRET9'],
  ];
  for (const [name, text, secret] of cases) {
    it('redacts ' + name, async () => {
      await log.append({ ...base, details: { t: text }, ref: text });
      expect(dump()).not.toContain(secret);
      expect(dump()).not.toContain('PHRASE10');
    });
  }

  it('drops api_key/pwd/credentials keys and keeps author', async () => {
    const e = await log.append({ ...base, details: { 'x-api-key': 'K1', apiKey: 'K2', pwd: 'K3', credentials: 'K4', author: 'bob' } });
    expect(e.details).toEqual({ author: 'bob' });
  });
});

describe('AuditLog escaped quotes (raw storage dump)', () => {
  const dump = () => JSON.stringify(areas.local.dump());
  const cases: Array<[string, string, string]> = [
    ['escaped dq in header', String.raw`{"authorization":"Basic a\"b ESCSEC1"}`, 'ESCSEC1'],
    ['escaped sq in header', String.raw`{'authorization':'Basic a\'b ESCSEC2'}`, 'ESCSEC2'],
    ['escaped dq in key value', String.raw`{"password":"a\"b ESCSEC3"}`, 'ESCSEC3'],
    ['escaped sq in key value', String.raw`password='a\'b ESCSEC4'`, 'ESCSEC4'],
  ];
  for (const [name, text, secret] of cases) {
    it('redacts ' + name, async () => {
      await log.append({ ...base, details: { t: text }, ref: text });
      expect(dump()).not.toContain(secret);
    });
  }
});
