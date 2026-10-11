// T-90: the dry-run counter (R1, I-12). It subscribes to T-84's dry-run
// completion event through the runner's seam (`snipeSeams(ctx).onDryRunComplete`)
// and increments `settings.snipe.completedDryRuns` exactly once per completed
// dry run, keyed by snipe id, so a replayed event never double-counts — live
// sniping is gated on this number, so an over-count is the dangerous direction.
//
// Storage. The counted snipe ids live at the module-private key
// `sbw:dryRunCounted` (storage.local), written through the raw Storage port —
// not a Repo key, like T-67's `sbw:calendarSync` ("bookkeeping the frozen
// schema has no room for"). The record is validated with a module-private
// schema (fail closed) and capped. The settings increment itself goes through
// the Repo.
//
// Crash order. The id is recorded BEFORE the settings increment: a crash in
// between loses the count (under-count), never adds it twice (over-count).
// An unreadable record refuses to count at all, for the same reason.
import { z } from 'zod';

import type { Settings } from '../../domain/settings/schema';
import type { Repo } from '../../domain/storage/repo';
import { STORAGE_KEYS } from '../../domain/storage/schema';
import type { Clock } from '../../ports/clock';
import type { Storage } from '../../ports/storage';
import type { BackgroundContext } from '../context';
import { snipeSeams } from './snipe-runner';

/** Module-private: not in STORAGE_KEYS, so the Repo neither validates nor quarantines it. */
export const DRY_RUN_COUNTED_KEY = 'sbw:dryRunCounted';
/** How many counted ids the record keeps (oldest go first); the record stays tiny. */
export const DRY_RUN_COUNTED_CAP = 4000;

/** Module-private on purpose: an exported `*Schema` would join the locked example list. */
const CountedRecordSchema = z.object({
  version: z.literal(1),
  /** snipe id -> when it was counted (local epoch ms, for the cap's oldest-first pruning). */
  counted: z.record(z.string().min(1), z.number()),
});
type CountedRecord = z.infer<typeof CountedRecordSchema>;

export type CountResult = 'counted' | 'already' | 'refused';

export interface DryRunCounterDeps {
  repo: Pick<Repo, 'update' | 'withLock'>;
  /** The local storage area (the counter owns `DRY_RUN_COUNTED_KEY` there). */
  storage: Storage;
  clock: Pick<Clock, 'now'>;
  /** `switches.noteSettings`, so the increment reaches the switches at once (not only via onChanged). */
  noteSettings?: (settings: Settings) => void;
  log?: (message: string, error?: unknown) => void;
}

const emptyRecord = (): CountedRecord => ({ version: 1, counted: {} });

async function readRecord(deps: DryRunCounterDeps): Promise<CountedRecord | 'unreadable'> {
  const raw = await deps.storage.get<unknown>(DRY_RUN_COUNTED_KEY);
  if (raw === undefined) return emptyRecord();
  const parsed = CountedRecordSchema.safeParse(raw);
  return parsed.success ? parsed.data : 'unreadable';
}

/** Appends `id` and prunes the oldest entries beyond the cap. */
async function writeRecord(deps: DryRunCounterDeps, record: CountedRecord, id: string): Promise<void> {
  const counted = { ...record.counted, [id]: deps.clock.now() };
  const entries = Object.entries(counted).sort((a, b) => a[1] - b[1]);
  const kept: CountedRecord['counted'] = {};
  for (const [k, at] of entries.slice(-DRY_RUN_COUNTED_CAP)) kept[k] = at;
  await deps.storage.set({ [DRY_RUN_COUNTED_KEY]: CountedRecordSchema.parse({ version: 1, counted: kept }) });
}

/**
 * Counts one completed dry run, keyed by its snipe id. `counted` increments
 * `settings.snipe.completedDryRuns` by exactly one; `already` means this id
 * was counted before (a replayed event) and nothing changes; `refused` means
 * the counted record was unreadable and nothing was counted (fail closed).
 * Throws when storage fails.
 */
export function countDryRun(deps: DryRunCounterDeps, id: string): Promise<CountResult> {
  return deps.repo.withLock('dry-run-counter', async (): Promise<CountResult> => {
    const record = await readRecord(deps);
    if (record === 'unreadable') {
      deps.log?.('dry-run counter: the counted record is unreadable; the dry run was not counted (fail closed)');
      return 'refused';
    }
    if (record.counted[id] !== undefined) return 'already';
    await writeRecord(deps, record, id);
    const next = await deps.repo.update(STORAGE_KEYS.settings, (s) => ({
      ...s,
      snipe: { ...s.snipe, completedDryRuns: s.snipe.completedDryRuns + 1 },
    }));
    deps.noteSettings?.(next);
    return 'counted';
  });
}

/** T-36 self-registration (I-01): subscribes to the runner's dry-run completion event. */
export function register(ctx: BackgroundContext): void {
  const deps: DryRunCounterDeps = {
    repo: ctx.repo,
    storage: ctx.storage.local,
    clock: ctx.clock,
    noteSettings: (settings) => {
      ctx.switches.noteSettings(settings);
    },
    log: (message, error) => {
      console.warn(`[ShopBadwill] ${message}`, error);
    },
  };
  snipeSeams(ctx).onDryRunComplete((snipe) => {
    void countDryRun(deps, snipe.id).catch((e: unknown) => {
      deps.log?.(`dry-run counter: counting the completed dry run ${snipe.id} failed`, e);
    });
  });
}
