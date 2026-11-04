import { beforeEach, describe, expect, it } from 'vitest';

import { StorageTooNewError, migrate, migrations, type Migration } from '../../../../src/domain/storage/migrations';
import { Repo, quarantineKey } from '../../../../src/domain/storage/repo';
import { STORAGE_KEYS } from '../../../../src/domain/storage/schema';
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

describe('migrate', () => {
  it('runs 0 -> 1 on empty storage and writes a valid meta', async () => {
    const installed = clock.now();
    const r = await migrate(repo);
    expect(r).toEqual({ from: 0, to: 1, recovered: false, ran: [{ from: 0, to: 1 }], health: 'ok', metaRestamped: false });
    expect(await repo.find(STORAGE_KEYS.meta)).toEqual({ schemaVersion: 1, installedAt: installed, lastMigrationAt: installed });
  });

  it('is idempotent: a second run does nothing and keeps installedAt', async () => {
    const installed = clock.now();
    await migrate(repo);
    clock.advance(60_000);
    const r = await migrate(repo);
    expect(r.ran).toEqual([]);
    const meta = await repo.find(STORAGE_KEYS.meta);
    expect(meta?.installedAt).toBe(installed);
    expect(meta?.lastMigrationAt).toBe(installed);
  });

  it('re-runs when the migrating flag shows a crash', async () => {
    areas.local.seed({ [STORAGE_KEYS.meta]: { schemaVersion: 1, installedAt: 42, lastMigrationAt: 43, migrating: true } });
    const r = await migrate(repo);
    expect(r.recovered).toBe(true);
    expect(r.ran).toEqual([]);
    expect(await repo.find(STORAGE_KEYS.meta)).toEqual({ schemaVersion: 1, installedAt: 42, lastMigrationAt: clock.now() });
  });

  it('retries from the stored version after a crash mid-migration, with the flag set meanwhile', async () => {
    const seen: unknown[] = [];
    let crash = true;
    const list: Migration[] = [
      ...migrations,
      {
        from: 1,
        to: 2,
        run: async (r) => {
          seen.push(await r.getRaw(STORAGE_KEYS.meta));
          if (crash) throw new Error('boom');
        },
      },
    ];
    await expect(migrate(repo, list, 2)).rejects.toThrow('boom');
    // Crashed: version 1 recorded, flag still set.
    expect(areas.local.dump()[STORAGE_KEYS.meta]).toMatchObject({ schemaVersion: 1, migrating: true });
    crash = false;
    const r = await migrate(repo, list, 2);
    expect(r).toMatchObject({ from: 1, to: 2, recovered: true, ran: [{ from: 1, to: 2 }] });
    expect(seen[1]).toMatchObject({ migrating: true });
    expect(areas.local.dump()[STORAGE_KEYS.meta]).toMatchObject({ schemaVersion: 2 });
    expect(areas.local.dump()[STORAGE_KEYS.meta]).not.toHaveProperty('migrating');
  });

  it('refuses storage written by a newer build', async () => {
    areas.local.seed({ [STORAGE_KEYS.meta]: { schemaVersion: 9, installedAt: 1, lastMigrationAt: 1 } });
    await expect(migrate(repo)).rejects.toBeInstanceOf(StorageTooNewError);
    expect(areas.local.dump()[STORAGE_KEYS.meta]).toMatchObject({ schemaVersion: 9 });
  });

  it('quarantines a corrupt meta, then migrates from 0 when the store is otherwise empty', async () => {
    areas.local.seed({ [STORAGE_KEYS.meta]: 'junk' });
    const r = await migrate(repo);
    expect(r).toMatchObject({ health: 'ok', ran: [{ from: 0, to: 1 }] });
    expect(areas.local.dump()[quarantineKey(STORAGE_KEYS.meta)]).toMatchObject({ value: 'junk' });
    expect((await repo.find(STORAGE_KEYS.meta))?.schemaVersion).toBe(1);
  });

  it('does not re-run migrations from 0 when meta is corrupt but data exists; re-stamps if the data validates', async () => {
    areas.local.seed({ [STORAGE_KEYS.meta]: { schemaVersion: 'x' }, [STORAGE_KEYS.awake]: [1, 2] });
    let ran = 0;
    const list: Migration[] = [{ from: 0, to: 1, run: () => ((ran += 1), Promise.resolve()) }];
    const r = await migrate(repo, list);
    expect(ran).toBe(0);
    expect(r).toMatchObject({ health: 'ok', metaRestamped: true, ran: [] });
    expect(areas.local.dump()[quarantineKey(STORAGE_KEYS.meta)]).toBeDefined();
    expect((await repo.find(STORAGE_KEYS.meta))?.schemaVersion).toBe(1);
    expect(await repo.get(STORAGE_KEYS.awake)).toEqual([1, 2]);
  });

  it('flags meta-corrupt and leaves everything alone when existing data does not validate', async () => {
    areas.local.seed({ [STORAGE_KEYS.meta]: 'junk', [STORAGE_KEYS.awake]: ['bad'] });
    let ran = 0;
    const list: Migration[] = [{ from: 0, to: 1, run: () => ((ran += 1), Promise.resolve()) }];
    const r = await migrate(repo, list);
    expect(ran).toBe(0);
    expect(r).toMatchObject({ health: 'meta-corrupt', metaRestamped: false, ran: [] });
    const d = areas.local.dump();
    expect(d[STORAGE_KEYS.meta]).toBeUndefined();
    expect(d[STORAGE_KEYS.awake]).toEqual(['bad']);
    expect(d[quarantineKey(STORAGE_KEYS.meta)]).toBeDefined();
    // Still flagged on the next start (meta is now missing, data still present).
    expect(await migrate(repo, list)).toMatchObject({ health: 'meta-corrupt' });
    expect(ran).toBe(0);
  });

  it('fails loudly when a step is missing', async () => {
    await expect(migrate(repo, [], 1)).rejects.toThrow(/no storage migration from schemaVersion 0/);
  });
});
