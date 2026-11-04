import { beforeEach, describe, expect, it } from 'vitest';

import { defaultSettings } from '../../../../src/domain/settings/defaults';
import { CACHE_MAX_ENTRIES, Repo, auditChunkKey, quarantineKey } from '../../../../src/domain/storage/repo';
import { STORAGE_KEYS, STORAGE_LIMITS } from '../../../../src/domain/storage/schema';
import { FakeClock } from '../../../fakes/ports/fake-clock';
import { FakeStorageAreas } from '../../../fakes/ports/fake-storage';

let areas: FakeStorageAreas;
let clock: FakeClock;
let repo: Repo;

beforeEach(() => {
  areas = new FakeStorageAreas();
  clock = new FakeClock();
  repo = new Repo(areas, clock);
});

const entry = (n: number) => ({ actor: 'system' as const, kind: 'k' + String(n), details: { n } });

describe('Repo records', () => {
  it('returns defaults for missing records; settings default is a mutable clone', async () => {
    expect(await repo.get(STORAGE_KEYS.rules)).toEqual([]);
    expect(await repo.get(STORAGE_KEYS.snipes)).toEqual({});
    expect(await repo.find(STORAGE_KEYS.sgwSession)).toBeUndefined();
    const s = await repo.get(STORAGE_KEYS.settings);
    expect(s).toEqual(defaultSettings());
    s.killSwitch = true;
    expect((await repo.get(STORAGE_KEYS.settings)).killSwitch).toBe(false);
  });

  it('quarantines an invalid record and returns the default', async () => {
    areas.local.seed({ [STORAGE_KEYS.awake]: ['not', 'numbers'] });
    expect(await repo.get(STORAGE_KEYS.awake)).toEqual([]);
    const dump = areas.local.dump();
    expect(dump[STORAGE_KEYS.awake]).toBeUndefined();
    expect(dump[quarantineKey(STORAGE_KEYS.awake)]).toMatchObject({ at: clock.now(), value: ['not', 'numbers'] });
    const listed = await repo.listQuarantined();
    expect(listed.map((q) => q.key)).toEqual([STORAGE_KEYS.awake]);
    expect(listed[0]?.generation).toBe(0);
    await repo.clearQuarantine(STORAGE_KEYS.awake);
    expect(await repo.listQuarantined()).toEqual([]);
  });

  it('quarantines an invalid session record in the session area', async () => {
    areas.session.seed({ [STORAGE_KEYS.googleAccess]: { token: '' } });
    expect(await repo.find(STORAGE_KEYS.googleAccess)).toBeUndefined();
    expect(areas.session.dump()[quarantineKey(STORAGE_KEYS.googleAccess)]).toBeDefined();
    expect(areas.local.dump()).toEqual({});
  });

  it('keeps a huge corrupt record intact (rules)', async () => {
    const big = Array.from({ length: 20_000 }, (_, n) => ({ id: 'rule-' + String(n), junk: 'xxxxxxxxxx' }));
    areas.local.seed({ [STORAGE_KEYS.rules]: big });
    expect(await repo.get(STORAGE_KEYS.rules)).toEqual([]);
    const q = areas.local.dump()[quarantineKey(STORAGE_KEYS.rules)] as { value: unknown };
    expect(q.value).toEqual(big);
    expect(areas.local.dump()[STORAGE_KEYS.rules]).toBeUndefined();
  });

  it('keeps the last 3 quarantine generations and never overwrites an earlier one', async () => {
    for (let n = 1; n <= 4; n++) {
      areas.local.seed({ [STORAGE_KEYS.awake]: ['bad' + String(n)] });
      clock.advance(1000);
      await repo.get(STORAGE_KEYS.awake);
    }
    const items = await repo.listQuarantined();
    expect(items.map((q) => [q.generation, q.record.value])).toEqual([
      [0, ['bad4']],
      [1, ['bad3']],
      [2, ['bad2']],
    ]);
    expect((items[0]?.record.at ?? 0) > (items[1]?.record.at ?? 0)).toBe(true);
    await repo.clearQuarantine(STORAGE_KEYS.awake);
    expect(await repo.listQuarantined()).toEqual([]);
  });

  it('drops a corrupt cache instead of quarantining it', async () => {
    areas.local.seed({ [STORAGE_KEYS.shippingCache]: 'garbage' });
    expect(await repo.get(STORAGE_KEYS.shippingCache)).toEqual({});
    expect(areas.local.dump()).toEqual({});
  });

  it('set validates and refuses to write an invalid value', async () => {
    await expect(repo.set(STORAGE_KEYS.awake, ['x'] as unknown as number[])).rejects.toThrow();
    expect(areas.local.dump()).toEqual({});
    await repo.set(STORAGE_KEYS.awake, [1, 2]);
    expect(await repo.get(STORAGE_KEYS.awake)).toEqual([1, 2]);
  });

  it('puts session keys in session storage and others in local', async () => {
    await repo.set(STORAGE_KEYS.clock, []);
    await repo.set(STORAGE_KEYS.awake, [5]);
    expect(Object.keys(areas.session.dump())).toEqual([STORAGE_KEYS.clock]);
    expect(Object.keys(areas.local.dump())).toEqual([STORAGE_KEYS.awake]);
  });

  it('serialises concurrent updates', async () => {
    await Promise.all(Array.from({ length: 20 }, (_, i) => repo.update(STORAGE_KEYS.awake, (a) => [...a, i])));
    expect((await repo.get(STORAGE_KEYS.awake)).length).toBe(20);
  });
});

describe('Repo audit ring', () => {
  it('stamps seq and at, and lists newest first', async () => {
    const a = await repo.appendAudit(entry(1));
    const b = await repo.appendAudit(entry(2));
    expect([a.seq, b.seq]).toEqual([1, 2]);
    expect(a.at).toBe(clock.now());
    expect((await repo.listAudit({ limit: 10 })).map((e) => e.seq)).toEqual([2, 1]);
    expect((await repo.listAudit({ limit: 10, before: 2 })).map((e) => e.seq)).toEqual([1]);
    expect((await repo.listAudit({ limit: 10, kinds: ['k1'] })).map((e) => e.seq)).toEqual([1]);
    expect((JSON.parse(await repo.exportAuditJson()) as Array<{ seq: number }>).map((e) => e.seq)).toEqual([1, 2]);
  });

  it('rolls to a new chunk every 500 entries', async () => {
    for (let i = 0; i < 501; i++) await repo.appendAudit(entry(i));
    const meta = await repo.get(STORAGE_KEYS.auditMeta);
    expect(meta).toEqual({ nextSeq: 502, head: 1, tail: 0 });
    const d = areas.local.dump();
    expect((d[auditChunkKey(0)] as unknown[]).length).toBe(500);
    expect((d[auditChunkKey(1)] as unknown[]).length).toBe(1);
  });

  it('wraps at 20 chunks, dropping the oldest', async () => {
    const { auditChunkSize: size, auditChunkCount: count } = STORAGE_LIMITS;
    // Fill 20 chunks directly, then append through the repo to cross the wrap.
    for (let c = 0; c < count; c++) {
      areas.local.seed({
        [auditChunkKey(c)]: Array.from({ length: size }, (_, i) => ({ seq: c * size + i + 1, at: 1, actor: 'system', kind: 'x', details: {} })),
      });
    }
    areas.local.seed({ [STORAGE_KEYS.auditMeta]: { nextSeq: count * size + 1, head: count - 1, tail: 0 } });

    const e = await repo.appendAudit(entry(0));
    expect(e.seq).toBe(count * size + 1);
    expect(await repo.get(STORAGE_KEYS.auditMeta)).toEqual({ nextSeq: count * size + 2, head: count, tail: 1 });
    const keys = Object.keys(areas.local.dump()).filter((k) => k.startsWith('sbw:audit:'));
    expect(keys).toHaveLength(count);
    const all = JSON.parse(await repo.exportAuditJson()) as Array<{ seq: number }>;
    expect(all).toHaveLength((count - 1) * size + 1);
    expect(all[0]?.seq).toBe(size + 1);
    expect(all[all.length - 1]?.seq).toBe(count * size + 1);
    expect((await repo.listAudit({ limit: 1 }))[0]?.seq).toBe(count * size + 1);
  });

  it('wraps via plain appends too (small run of the real path)', async () => {
    for (let i = 0; i < STORAGE_LIMITS.auditChunkSize * STORAGE_LIMITS.auditChunkCount + 1; i++) await repo.appendAudit(entry(i));
    expect(await repo.get(STORAGE_KEYS.auditMeta)).toMatchObject({ head: 20, tail: 1 });
    expect(Object.keys(areas.local.dump()).filter((k) => k.startsWith('sbw:audit:'))).toHaveLength(20);
  }, 60_000);

  it('rebuilds a corrupt auditMeta from the chunks instead of overwriting live ones', async () => {
    const mk = (from: number, n: number) =>
      Array.from({ length: n }, (_, i) => ({ seq: from + i, at: 1, actor: 'system', kind: 'x', details: {} }));
    const slot0 = mk(1, 500);
    areas.local.seed({
      [auditChunkKey(0)]: slot0,
      [auditChunkKey(1)]: mk(501, 3),
      [STORAGE_KEYS.auditMeta]: { nextSeq: 'oops' },
    });
    const e = await repo.appendAudit(entry(1));
    expect(e.seq).toBe(504);
    const d = areas.local.dump();
    expect(d[auditChunkKey(0)]).toEqual(slot0);
    expect((d[auditChunkKey(1)] as unknown[]).length).toBe(4);
    expect(d[STORAGE_KEYS.auditMeta]).toEqual({ nextSeq: 505, head: 1, tail: 0 });
    expect(d[quarantineKey(STORAGE_KEYS.auditMeta)]).toBeDefined();
  });

  it('rebuilds a missing auditMeta and rolls to the next slot when the head chunk is full', async () => {
    const full = Array.from({ length: 500 }, (_, i) => ({ seq: 501 + i, at: 1, actor: 'system', kind: 'x', details: {} }));
    areas.local.seed({ [auditChunkKey(1)]: full });
    expect((await repo.appendAudit(entry(1))).seq).toBe(1001);
    expect(await repo.get(STORAGE_KEYS.auditMeta)).toEqual({ nextSeq: 1002, head: 2, tail: 1 });
    expect(areas.local.dump()[auditChunkKey(1)]).toEqual(full);
  });

  it('quarantines a corrupt chunk and carries on', async () => {
    await repo.appendAudit(entry(1));
    areas.local.seed({ [auditChunkKey(0)]: 'garbage' });
    const e = await repo.appendAudit(entry(2));
    expect(e.seq).toBe(2);
    expect(areas.local.dump()[quarantineKey(auditChunkKey(0))]).toBeDefined();
    expect((await repo.listAudit({ limit: 10 })).map((x) => x.seq)).toEqual([2]);
  });

  it('never reuses a seq after a crash between chunk and meta writes', async () => {
    await repo.appendAudit(entry(1));
    areas.local.seed({ [STORAGE_KEYS.auditMeta]: { nextSeq: 1, head: 0, tail: 0 } });
    expect((await repo.appendAudit(entry(2))).seq).toBe(2);
  });
});

describe('Repo caches', () => {
  const k = STORAGE_KEYS.shippingCache;

  it('returns live entries and ignores expired ones', async () => {
    await repo.putCached(k, '1:12345', { cents: 500, expiresAt: clock.now() + 1000 });
    expect(await repo.getCached(k, '1:12345')).toEqual({ cents: 500, expiresAt: clock.now() + 1000 });
    clock.advance(1000);
    expect(await repo.getCached(k, '1:12345')).toBeUndefined();
  });

  it('drops expired entries on put and caps the entry count', async () => {
    await repo.putCached(k, 'old', { cents: 1, expiresAt: clock.now() + 1 });
    clock.advance(10);
    const cap = CACHE_MAX_ENTRIES[k];
    const all: Record<string, { cents: number; expiresAt: number }> = {};
    for (let i = 0; i < cap; i++) all['i' + String(i)] = { cents: 1, expiresAt: clock.now() + 1000 + i };
    areas.local.seed({ [k]: all });
    await repo.putCached(k, 'new', { cents: 2, expiresAt: clock.now() + 5000 });
    const stored = await repo.get(k);
    expect(Object.keys(stored)).toHaveLength(cap);
    expect(stored.new).toBeDefined();
    expect(stored.i0).toBeUndefined();
  });

  it('evicts the least recently written entry, never the one just written (even with the shortest TTL)', async () => {
    const cap = CACHE_MAX_ENTRIES[k];
    // Integer-like ids, as real item ids are: object key order would be numeric, not insertion order.
    for (let i = 0; i < cap; i++) await repo.putCached(k, String(1000 + i), { cents: i, expiresAt: clock.now() + 100_000 });
    await repo.putCached(k, '5', { cents: 9, expiresAt: clock.now() + 1 });
    const stored = await repo.get(k);
    expect(Object.keys(stored)).toHaveLength(cap);
    expect(stored['5']).toEqual({ cents: 9, expiresAt: clock.now() + 1 });
    expect(stored['1000']).toBeUndefined();
    expect(stored['1001']).toBeDefined();
  }, 60_000);

  it('pruneCaches removes expired entries', async () => {
    await repo.putCached(k, 'a', { cents: 1, expiresAt: clock.now() + 5 });
    clock.advance(5);
    expect(await repo.pruneCaches()).toBe(1);
    expect(await repo.get(k)).toEqual({});
  });
});
