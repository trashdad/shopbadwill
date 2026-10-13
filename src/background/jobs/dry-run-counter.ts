// T-90: the dry-run counter (R1, I-12). It subscribes to T-84's dry-run
// completion event through the runner's seam (`snipeSeams(ctx).onDryRunComplete`)
// and increments `settings.snipe.completedDryRuns` exactly once per completed
// dry run, keyed by snipe id, so a replayed event never double-counts — live
// sniping is gated on this number, so an over-count is the dangerous direction.
//
// What counts. The seam fires when a dry run goes firing → resolved. That is
// outcome `dry-run`, including a measure read that failed. A live snipe, a
// kill, and an abort never have that outcome, and `noteDryRunComplete` ignores
// them even if the seam were to deliver one.
//
// Storage. The counted snipe ids live at `sbw:dryRunCounted` (storage.local),
// an optional record (T-90). The counter reads it raw: a typed `repo.find`
// would quarantine an invalid record, and the next read would look empty.
// Invalid data parses to empty (`parseDryRunCounted`), but a present invalid
// record is refused instead of adopted, so the idempotency set cannot reset
// and a replay cannot count again. The record is capped. The settings
// increment goes through the Repo.
//
// Crash order. The id is recorded BEFORE the settings increment: a crash in
// between loses the count (under-count), never adds it twice (over-count).
// An unreadable record refuses to count at all, for the same reason.
import type { Settings } from '../../domain/settings/schema';
import type { Snipe } from '../../domain/snipe/types';
import type { Repo } from '../../domain/storage/repo';
import {
  checkedDryRunCounted,
  readDryRunCounted,
  STORAGE_KEYS,
  type DryRunCountedRecord,
} from '../../domain/storage/schema';
import type { Clock } from '../../ports/clock';
import type { Storage } from '../../ports/storage';
import type { BackgroundContext } from '../context';
import { snipeSeams } from './snipe-runner';

/** `sbw:dryRunCounted`. The counter reads it raw so a bad record is not quarantined. */
export const DRY_RUN_COUNTED_KEY = STORAGE_KEYS.dryRunCounted;
/** How many counted ids the record keeps (oldest go first); the record stays tiny. */
export const DRY_RUN_COUNTED_CAP = 4000;

export type CountResult = 'counted' | 'already' | 'refused';
/** `ignored`: not a completed dry run (live, killed, or aborted). Nothing is stored. */
export type NoteResult = CountResult | 'ignored';

/**
 * The runner's completion event is a dry run that went `firing` → `resolved`
 * with outcome `dry-run`. That includes a measure read that never arrived
 * (`post-read-failed` still settles as dry-run). A live snipe, a kill
 * (`killed`), and an abort (skipped, ended, cap-blocked, …) do not.
 */
export function countsAsCompletedDryRun(snipe: Snipe): boolean {
  return snipe.dryRun && snipe.state === 'resolved' && snipe.outcome === 'dry-run';
}

export interface DryRunCounterDeps {
  repo: Pick<Repo, 'update' | 'withLock'>;
  /** The local storage area (the counter owns `DRY_RUN_COUNTED_KEY` there). */
  storage: Storage;
  clock: Pick<Clock, 'now'>;
  /** `switches.noteSettings`, so the increment reaches the switches at once (not only via onChanged). */
  noteSettings?: (settings: Settings) => void;
  log?: (message: string, error?: unknown) => void;
}

async function readRecord(deps: DryRunCounterDeps): Promise<DryRunCountedRecord | 'unreadable'> {
  const raw = await deps.storage.get<unknown>(DRY_RUN_COUNTED_KEY);
  const read = readDryRunCounted(raw);
  return read === 'invalid' ? 'unreadable' : read;
}

/** Appends `id` and prunes the oldest entries beyond the cap. */
async function writeRecord(deps: DryRunCounterDeps, record: DryRunCountedRecord, id: string): Promise<void> {
  const counted = { ...record.counted, [id]: deps.clock.now() };
  const entries = Object.entries(counted).sort((a, b) => a[1] - b[1]);
  const kept: DryRunCountedRecord['counted'] = {};
  for (const [k, at] of entries.slice(-DRY_RUN_COUNTED_CAP)) kept[k] = at;
  await deps.storage.set({ [DRY_RUN_COUNTED_KEY]: checkedDryRunCounted({ version: 1, counted: kept }) });
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

/**
 * Counts one completion event. Live, killed and aborted snipes are ignored
 * and do not touch storage. A completed dry run goes through `countDryRun`.
 */
export function noteDryRunComplete(deps: DryRunCounterDeps, snipe: Snipe): Promise<NoteResult> {
  if (!countsAsCompletedDryRun(snipe)) return Promise.resolve('ignored');
  return countDryRun(deps, snipe.id);
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
    // The seam's callback type is void, so the promise is not returned into it.
    void noteDryRunComplete(deps, snipe).catch((e: unknown) => {
      deps.log?.(`dry-run counter: counting the completed dry run ${snipe.id} failed`, e);
    });
  });
}
