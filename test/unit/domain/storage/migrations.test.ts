import { beforeEach, describe, expect, it } from 'vitest';

import { StorageTooNewError, migrate, migrations, type Migration } from '../../../../src/domain/storage/migrations';
import { Repo } from '../../../../src/domain/storage/repo';
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
    expect(r).toEqual({ from: 0, to: 1, recovered: false, ran: [{ from: 0, to: 1 }] });
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

  it('treats corrupt meta as version 0', async () => {
    areas.local.seed({ [STORAGE_KEYS.meta]: 'junk' });
    const r = await migrate(repo);
    expect(r.ran).toHaveLength(1);
    expect((await repo.find(STORAGE_KEYS.meta))?.schemaVersion).toBe(1);
  });

  it('fails loudly when a step is missing', async () => {
    await expect(migrate(repo, [], 1)).rejects.toThrow(/no storage migration from schemaVersion 0/);
  });
});
