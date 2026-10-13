// T-33: storage migrations (PLAN §2.3). `migrate()` runs in background/main.ts
// before any listener is registered. It sets `sbw:meta.migrating` while it
// works, so a crash mid-migration leaves the flag set and the next start
// re-runs from the stored version. Every migration must therefore be
// idempotent. Adding a defaulted field is not a migration; renaming or
// re-keying is.
import type { Repo } from './repo';
import { STORAGE_KEYS, STORAGE_SCHEMA_VERSION } from './schema';

export interface Migration {
  from: number;
  to: number;
  run(repo: Repo): Promise<void>;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export const migrations: Migration[] = [
  {
    // Empty storage to v1: nothing to move; migrate() writes the meta record itself.
    from: 0,
    to: 1,
    run: () => Promise.resolve(),
  },
];

export interface MigrateResult {
  from: number;
  to: number;
  /** True when a previous run crashed (the migrating flag was set). */
  recovered: boolean;
  ran: Array<{ from: number; to: number }>;
  /**
   * 'meta-corrupt': `sbw:meta` was unusable while other data exists, so nothing
   * was migrated or stamped and the data is left alone (the quarantined meta
   * and the invalid keys show on the health panel). Otherwise 'ok'.
   */
  health: 'ok' | 'meta-corrupt';
  /** True when a corrupt or missing meta was re-stamped at the current version because all data validated. */
  metaRestamped: boolean;
}

export class StorageTooNewError extends Error {
  constructor(readonly found: number) {
    super(`storage schemaVersion ${String(found)} is newer than this build (${String(STORAGE_SCHEMA_VERSION)})`);
    this.name = 'StorageTooNewError';
  }
}

export async function migrate(
  repo: Repo,
  list: readonly Migration[] = migrations,
  target: number = STORAGE_SCHEMA_VERSION,
): Promise<MigrateResult> {
  const rawMeta = await repo.getRaw(STORAGE_KEYS.meta);
  const wellFormed =
    isRecord(rawMeta) &&
    typeof rawMeta.schemaVersion === 'number' &&
    typeof rawMeta.installedAt === 'number' &&
    typeof rawMeta.lastMigrationAt === 'number' &&
    (rawMeta.migrating === undefined || typeof rawMeta.migrating === 'boolean');
  if (!wellFormed) {
    if (rawMeta !== undefined) await repo.quarantineStored(STORAGE_KEYS.meta, 'sbw:meta is not a valid meta record');
    // Existing data with no usable meta is not a fresh install: never assume version 0 and re-run from there.
    const { present, invalid } = await repo.inspectStored();
    if (present.length > 0) {
      if (invalid.length > 0) return { from: 0, to: 0, recovered: false, ran: [], health: 'meta-corrupt', metaRestamped: false };
      const now = repo.now();
      await repo.setRaw(STORAGE_KEYS.meta, { schemaVersion: target, installedAt: now, lastMigrationAt: now });
      return { from: target, to: target, recovered: false, ran: [], health: 'ok', metaRestamped: true };
    }
  }
  const meta = wellFormed ? rawMeta : {};
  const stored = typeof meta.schemaVersion === 'number' ? meta.schemaVersion : 0;
  const recovered = meta.migrating === true;
  const installedAt = typeof meta.installedAt === 'number' ? meta.installedAt : repo.now();

  if (stored > target) throw new StorageTooNewError(stored);
  // Up to date and healthy (find() quarantines a record that fails StorageMetaSchema).
  if (stored === target && !recovered && (await repo.find(STORAGE_KEYS.meta))) {
    return { from: stored, to: target, recovered: false, ran: [], health: 'ok', metaRestamped: false };
  }

  const writeMeta = (version: number, migrating: boolean, lastMigrationAt: number) =>
    repo.setRaw(STORAGE_KEYS.meta, { schemaVersion: version, installedAt, lastMigrationAt, ...(migrating ? { migrating: true } : {}) });

  const lastBefore = typeof meta.lastMigrationAt === 'number' ? meta.lastMigrationAt : repo.now();
  await writeMeta(stored, true, lastBefore);
  const ran: MigrateResult['ran'] = [];
  let version = stored;
  while (version < target) {
    const step = list.find((m) => m.from === version);
    if (!step) throw new Error(`no storage migration from schemaVersion ${String(version)}`);
    await step.run(repo);
    version = step.to;
    ran.push({ from: step.from, to: step.to });
    await writeMeta(version, true, lastBefore);
  }
  await writeMeta(version, false, repo.now());
  return { from: stored, to: version, recovered, ran, health: 'ok', metaRestamped: false };
}
