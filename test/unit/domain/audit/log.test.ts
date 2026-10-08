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
    expect(d.message).toBe('Hi xthere');
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
