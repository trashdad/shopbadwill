// T-52: the StepExecutor registry (I-07). Every other `./*.ts` file in this
// folder is one executor module whose default export is `{ kind, run }`
// (T-53's favorite.ts set the shape); T-56, T-57, T-67 and T-103 each add one
// file here and edit nothing else. The DailyJob runner asks `executorFor(kind)`
// for the step at the cursor.
//
// A kind with no module runs NO_OP: it audits the skip and answers a
// non-retryable `error` whose message starts with STEP_SKIP_PREFIX, so the run
// moves on and totals do not count it as a failure (see isPolicySkip in
// daily-job-runner.ts).
//
// Executors return a StepOutcome or throw. The runner maps a thrown
// SgwApiError to a retryable or final `error` outcome, and treats `paused` and
// `budget` (nothing was sent) as "not run": the step stays at the cursor and no
// retry is used.
import type { AuditLog } from '../../../domain/audit/types';
import type { Repo } from '../../../domain/storage/repo';
import type { Lane } from '../../../domain/types';
import type { JobRun, JobStep, StepOutcome } from '../../../domain/watches/schema';
import type { GlobalSwitches } from '../../../ports/global-switches';
import type { SgwApi } from '../../../ports/sgw-api';
import type { BackgroundContext } from '../../context';

type Kind = JobStep['kind'];

/** Every step kind (exhaustive: a new kind in the contract fails to compile here). */
const KINDS: Readonly<Record<Kind, true>> = {
  search: true,
  favoritesList: true,
  detail: true,
  favorite: true,
  quote: true,
  calendarUpsert: true,
  notifyDigest: true,
  postEnd: true,
};

/** What every executor gets. A superset of T-53's FavoriteStepDeps. */
export interface StepDeps {
  api: SgwApi;
  repo: Repo;
  audit: Pick<AuditLog, 'append'>;
  switches: GlobalSwitches;
  /** 'background' on a tick (120 s spacing); 'interactive' while job.runNow drains. */
  lane: Lane;
  /** The run as it was before this step (read only; the runner applies the outcome). */
  run: Readonly<JobRun>;
  /** The rest of the background (calendar, notifier, ...) for executors that need it. */
  ctx: BackgroundContext;
}

export interface StepExecutor {
  readonly kind: Kind;
  run(step: JobStep, deps: StepDeps): Promise<StepOutcome>;
}

/** As `import.meta.glob(..., { eager: true })` returns it: `./file.ts` → module. */
export type StepModuleMap = Readonly<Record<string, { default?: unknown }>>;

export const STEP_MODULES: StepModuleMap = import.meta.glob<{ default?: unknown }>(['./*.ts', '!./index.ts'], { eager: true });

/** Starts the message of a skip by the no-op executor (not a failure). */
export const STEP_SKIP_PREFIX = 'step skipped: ';

export interface StepRegistry {
  /** The module's executor, or the no-op one that audits the skip. */
  executorFor(kind: Kind): StepExecutor;
  /** Kinds that have a module. */
  readonly kinds: ReadonlySet<Kind>;
  /** Modules that were not loaded, and why. */
  readonly failed: ReadonlyArray<{ file: string; error: string }>;
}

function isExecutor(value: unknown): value is StepExecutor {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as { kind?: unknown; run?: unknown };
  return typeof v.kind === 'string' && Object.hasOwn(KINDS, v.kind) && typeof v.run === 'function';
}

function noOp(kind: Kind): StepExecutor {
  return {
    kind,
    async run(step, deps) {
      const itemId = 'itemId' in step ? step.itemId : undefined;
      await deps.audit.append({
        actor: 'daily-job',
        kind: 'job.step.skipped',
        ...(itemId === undefined ? {} : { itemId }),
        details: { step: kind, why: 'no executor' },
      });
      return { kind: 'error', message: `${STEP_SKIP_PREFIX}no executor for '${kind}' steps`, retryable: false };
    },
  };
}

/** Loads the executor modules in file-name order; the first module of a kind wins. */
export function createStepRegistry(modules: StepModuleMap = STEP_MODULES): StepRegistry {
  const byKind = new Map<Kind, StepExecutor>();
  const failed: Array<{ file: string; error: string }> = [];
  for (const [file, mod] of Object.entries(modules).sort(([a], [b]) => a.localeCompare(b))) {
    const exec = mod.default;
    if (!isExecutor(exec)) {
      failed.push({ file, error: 'the default export is not a step executor { kind, run }' });
      continue;
    }
    if (byKind.has(exec.kind)) {
      failed.push({ file, error: `another module already runs '${exec.kind}' steps` });
      continue;
    }
    byKind.set(exec.kind, exec);
  }
  return {
    executorFor: (kind) => byKind.get(kind) ?? noOp(kind),
    kinds: new Set(byKind.keys()),
    failed,
  };
}
