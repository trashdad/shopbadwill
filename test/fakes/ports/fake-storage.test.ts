import { describe, expect, it } from 'vitest';

import { FakeStorage, FakeStorageAreas } from './fake-storage';

describe('FakeStorage', () => {
  it('round-trips values by clone, so callers cannot alias stored state', async () => {
    const s = new FakeStorage();
    const value = { a: [1, 2] };
    await s.set({ k: value });
    value.a.push(3);
    const read = await s.get<{ a: number[] }>('k');
    expect(read).toEqual({ a: [1, 2] });
    read?.a.push(9);
    expect(await s.get('k')).toEqual({ a: [1, 2] });
    expect(await s.get('missing')).toBeUndefined();
  });

  it('reports old and new values, and nothing for unchanged keys', async () => {
    const s = new FakeStorage();
    const seen: unknown[] = [];
    s.onChanged((c) => seen.push(c));
    await s.set({ a: 1 });
    await s.set({ a: 1, b: { x: 1 } });
    await s.set({ a: 2 });
    await s.set({ a: 2 });
    expect(seen).toEqual([{ a: { newValue: 1 } }, { b: { newValue: { x: 1 } } }, { a: { oldValue: 1, newValue: 2 } }]);
  });

  it('remove reports old values, ignores absent keys, and unsubscribe works', async () => {
    const s = new FakeStorage();
    await s.set({ a: 1 });
    const seen: unknown[] = [];
    const off = s.onChanged((c) => seen.push(c));
    await s.remove(['a', 'nope']);
    expect(seen).toEqual([{ a: { oldValue: 1 } }]);
    expect(await s.get('a')).toBeUndefined();
    off();
    await s.set({ z: 1 });
    expect(seen).toHaveLength(1);
  });

  it('seed and dump bypass events', () => {
    const s = new FakeStorage();
    let n = 0;
    s.onChanged(() => {
      n += 1;
    });
    s.seed({ a: 1 });
    expect(n).toBe(0);
    expect(s.dump()).toEqual({ a: 1 });
  });

  it('areas are independent', async () => {
    const areas = new FakeStorageAreas();
    await areas.local.set({ k: 1 });
    expect(await areas.session.get('k')).toBeUndefined();
  });
});
