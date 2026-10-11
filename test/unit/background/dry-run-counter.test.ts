// T-90: the dry-run counter (src/background/jobs/dry-run-counter.ts). Fakes
// only. R1: increments settings.snipe.completedDryRuns exactly once per
// completed dry run, keyed by snipe id, idempotent across restarts — a
// replayed event must not double-count (R5).
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { countDryRun, DRY_RUN_COUNTED_CAP, DRY_RUN_COUNTED_KEY, type DryRunCounterDeps } from '../../../src/background/jobs/dry-run-counter';
import { defaultSettings } from '../../../src/domain/settings/defaults';
import type { Settings } from '../../../src/domain/settings/schema';
import { Repo } from '../../../src/domain/storage/repo';
import { STORAGE_KEYS } from '../../../src/domain/storage/schema';
import { FakeClock } from '../../fakes/ports/fake-clock';
import { FakeStorageAreas } from '../../fakes/ports/fake-storage';

const NOW = Date.UTC(2026, 9, 10, 15, 0, 0);

let clock: FakeClock;
let storage: FakeStorageAreas;
let repo: Repo;
let noted: Settings[];
let deps: DryRunCounterDeps;

/** A "worker restart": the same shared storage, but a fresh repo and clock state. */
function restart(): void {
  repo = new Repo(storage, clock);
  deps = { repo, storage: storage.local, clock, noteSettings: (s) => noted.push(s) };
}

beforeEach(async () => {
  clock = new FakeClock(NOW);
  storage = new FakeStorageAreas();
  repo = new Repo(storage, clock);
  noted = [];
  deps = { repo, storage: storage.local, clock, noteSettings: (s) => noted.push(s) };
  await repo.set(STORAGE_KEYS.settings, defaultSettings());
});

const completed = async (): Promise<number> => (await repo.get(STORAGE_KEYS.settings)).snipe.completedDryRuns;

describe('countDryRun (R1)', () => {
  it('increments completedDryRuns exactly once per completed dry run', async () => {
    expect(await completed()).toBe(0);
    expect(await countDryRun(deps, 's1')).toBe('counted');
    expect(await completed()).toBe(1);
    expect(await countDryRun(deps, 's2')).toBe('counted');
    expect(await completed()).toBe(2);
  });

  it('a replayed event for the same snipe id does not double-count (R5)', async () => {
    expect(await countDryRun(deps, 's1')).toBe('counted');
    expect(await countDryRun(deps, 's1')).toBe('already');
    expect(await countDryRun(deps, 's1')).toBe('already');
    expect(await completed()).toBe(1);
    // The keyed record survives: a second dry run counts once more.
    expect(await countDryRun(deps, 's2')).toBe('counted');
    expect(await completed()).toBe(2);
  });

  it('is idempotent across a worker restart (shared storage)', async () => {
    expect(await countDryRun(deps, 's1')).toBe('counted');
    expect(await completed()).toBe(1);

    restart(); // the worker died and came back; the counted ids live in storage
    expect(await countDryRun(deps, 's1')).toBe('already'); // the replayed event
    expect(await completed()).toBe(1);
    expect(await countDryRun(deps, 's3')).toBe('counted');
    expect(await completed()).toBe(2);
  });

  it('records the id BEFORE the increment (a crash in between under-counts, never over-counts)', async () => {
    const failingRepo = {
      withLock: repo.withLock.bind(repo),
      update: vi.fn(() => {
        throw new Error('storage went away');
      }),
    };
    const broken = { ...deps, repo: failingRepo as unknown as DryRunCounterDeps['repo'] };
    await expect(countDryRun(broken, 's1')).rejects.toThrow('storage went away');
    expect(await completed()).toBe(0); // never over-counted
    // The id was already recorded: a retry after the storage came back...
    const raw = await storage.local.get<unknown>(DRY_RUN_COUNTED_KEY);
    expect(raw).toMatchObject({ version: 1, counted: { s1: NOW } });
    // ...would see it and still not double-count, but the count was lost:
    // fail-safe direction for the live gate (under-count).
    expect(await countDryRun(deps, 's1')).toBe('already');
    expect(await completed()).toBe(0);
  });

  it('an unreadable counted record refuses to count (fail closed: never over-count)', async () => {
    await storage.local.set({ [DRY_RUN_COUNTED_KEY]: { version: 2, nope: true } });
    expect(await countDryRun(deps, 's1')).toBe('refused');
    expect(await completed()).toBe(0);
  });

  it('caps the counted record, dropping the oldest ids', async () => {
    const counted: Record<string, number> = {};
    for (let i = 0; i < DRY_RUN_COUNTED_CAP + 10; i += 1) counted[`s${String(i)}`] = NOW + i;
    await storage.local.set({ [DRY_RUN_COUNTED_KEY]: { version: 1, counted } });
    clock.set(NOW + DRY_RUN_COUNTED_CAP + 100); // the new id is the newest
    expect(await countDryRun(deps, 'fresh')).toBe('counted');
    expect(await completed()).toBe(1);
    const raw = await storage.local.get<{ counted: Record<string, number> }>(DRY_RUN_COUNTED_KEY);
    const keys = Object.keys(raw?.counted ?? {});
    expect(keys).toHaveLength(DRY_RUN_COUNTED_CAP);
    // The oldest ids were dropped; the newest survive.
    expect(raw?.counted['s0']).toBeUndefined();
    expect(raw?.counted['s1']).toBeUndefined();
    expect(raw?.counted['fresh']).toBeDefined();
    expect(raw?.counted[`s${String(DRY_RUN_COUNTED_CAP + 9)}`]).toBeDefined();
  });

  it('notifies the switches of the new settings', async () => {
    expect(await countDryRun(deps, 's1')).toBe('counted');
    expect(noted).toHaveLength(1);
    expect(noted[0]?.snipe.completedDryRuns).toBe(1);
  });
});
