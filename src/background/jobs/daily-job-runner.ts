// T-52: the DailyJob runner. It feeds T-51's pure state machine
// (src/domain/jobs/daily-job.ts) one step at a time and persists the run, so a
// worker that dies between ticks resumes at `cursor`.
//
// - tick(): ONE step on lane `background` (one SGW request at most, 120 s
//   spacing by the RequestScheduler). Only the scheduler's `sbw:tick` alarm
//   calls it (scheduler.ts).
// - runNow(): starts a manual run, or JOINS the active run (R3), then drains it
//   step by step on lane `interactive` (1 req/s). While it drains, ticks are
//   refused ('busy'). The drain stops on a pause, backoff or spent budget; the
//   run then carries on, on ticks.
// - Never two runs at once and never two steps at once (R3): every read and
//   write of the active run runs under one in-memory lock, a tick while a step
//   is in flight is refused ('busy'), and each step is committed with a
//   compare-and-set on the stored run (same id, cursor, status and step count
//   as when it was loaded), so a second worker instance cannot apply a step
//   over this one.
// - Before every step: the SGW host permission (missing → the run fails,
//   notification + audit) and the RequestScheduler state. A pause, a backoff
//   on the lane or a spent budget executes nothing and uses no retry (T-51
//   carry); once it ends, a run T-51 paused is resume()d. An executor that
//   throws SgwApiError `paused`/`budget`, or a retryable error with no HTTP
//   status while the lane is now blocked (a queued request refused locally
//   once the lane entered backoff), sent nothing: the step stays.
// - Planning happens only under reconcile() or runNow() and sends nothing
//   (R2): the first SGW request comes from a tick or the runNow drain.
// - Side effects of a step (on commit): newly matched items become
//   TrackedItems (reasons = the watches whose strict match planned the write,
//   or the local watches that matched; calendar = a calendarUpsert was
//   planned). When the run ends: seenUpdates(run) into each watch's seen ring
//   (recordSeen), lastRunAt and lastError, the candidates compacted to ids,
//   statuses and notes, at most STORAGE_LIMITS.jobRunsKept runs kept, and a
//   `job.run.done` audit.
// - New matches (T-56 carry): right after a step commits new strict matches
//   (their TrackedItems already written), every onNewMatches(cb) subscriber
//   gets the run and the new item ids, so T-56's late-add alert (sendLateAdds,
//   which applies isLateAdd, the only late-add rule) fires at once instead of
//   with the end-of-run digest. register(ctx) subscribes sendLateAdds; a
//   runner built without register has no subscriber. step() awaits them
//   (allSettled) after the run lock is released and before it resolves, so a
//   Run now drain cannot start the next step (notifyDigest's own sendLateAdds)
//   until the hook has written its audit row. A subscriber's failure is
//   logged, never thrown.
// - Favorites: at most one favorite step per item per run (a later one is a
//   policy skip). desired() (T-53) adds a favorite step for every tracked item
//   it says 'add' to (failed or not yet favorited, sgw-late window open) to
//   each new run, capped. An sgw-late window that opens between daily runs
//   gets a small favorites-only run (planFavoriteSweep).
import { SGW_SEARCH_BODY_DEFAULTS } from '../../adapters/sgw/config';
import { invalidSearchParams } from '../../adapters/sgw/query-url';
import { desired } from '../../domain/favorites/reconcile';
import { createDailyJob, resume, seenUpdates } from '../../domain/jobs/daily-job';
import { evaluateBatch } from '../../domain/rules/matcher';
import type { Rule } from '../../domain/rules/schema';
import { DEFAULT_FAVORITE_WITHIN_HOURS } from '../../domain/settings/defaults';
import type { Settings } from '../../domain/settings/schema';
import { STORAGE_KEYS, STORAGE_LIMITS } from '../../domain/storage/schema';
import type { EpochMs, ItemId, Lane, Listing, TrackedItem } from '../../domain/types';
import { nextRunAtFor, recordSeen } from '../../domain/watches/helpers';
import type { DailyJob, JobCandidate, JobRun, JobStep, StepOutcome, Watch } from '../../domain/watches/schema';
import { PORT_NAMES } from '../../messaging/protocol';
import { SgwApiError, type SgwApiErrorKind } from '../../ports/errors';
import { errorText, type BackgroundContext, type RuntimePort } from '../context';
import { FAVORITE_SKIP_PREFIX } from './steps/favorite';
import { sendLateAdds } from './notify';
import { createStepRegistry, STEP_SKIP_PREFIX, type StepDeps, type StepRegistry } from './steps/index';

/** The host permissions every run needs (wxt.config.ts host_permissions). */
export const SGW_HOST_ORIGINS: readonly string[] = ['https://shopgoodwill.com/*', 'https://buyerapi.shopgoodwill.com/*'];
/** One id, so a repeated warning replaces the last one instead of stacking. */
export const PERMISSION_NOTIFICATION_ID = 'sbw:job-permission';
export const NO_PERMISSION_MESSAGE =
  'ShopBadwill has no access to shopgoodwill.com. Allow it in the browser’s extension settings, then try again.';
/** Favorite steps desired() may add to one run (soonest-ending first), like T-51's detail cap. */
export const MAX_FAVORITE_RETRIES_PER_RUN = 20;
/** Safety bound on one runNow drain. */
export const MAX_DRAIN_STEPS = 500;
/** Why a due watch with no enabled `watch` rule is not searched (it could never match). */
export const NO_WATCH_RULE = 'no enabled watch rule, so nothing could match; not searched';
const PERMISSION_LAST_ERROR = 'skipped: no host permission for shopgoodwill.com';
/** Prefix of run-level errors (not tied to one step), e.g. a revoked permission. */
const RUN_ERROR_PREFIX = 'run: ';

const SEARCH_PAGE_SIZE = Number(SGW_SEARCH_BODY_DEFAULTS.pageSize);
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
/** Failures worth retrying (T-51 pauses the run; MAX_STEP_ATTEMPTS bounds it). */
const RETRYABLE: ReadonlySet<SgwApiErrorKind> = new Set<SgwApiErrorKind>(['rate-limited', 'server', 'network', 'timeout']);

/**
 * - 'stepped': one step was executed and committed;
 * - 'idle': no active run;
 * - 'busy': a step or a runNow drain is in progress (tick only);
 * - 'paused': the RequestScheduler is paused, or the lane is backing off or out of budget;
 * - 'not-run': the executor was refused before sending (SgwApiError paused/budget, or a local backoff refusal);
 * - 'no-permission': the host permission is missing (the run failed);
 * - 'conflict': another runner advanced the run first (compare-and-set lost).
 */
export type StepResult = 'stepped' | 'idle' | 'busy' | 'paused' | 'not-run' | 'no-permission' | 'conflict';
export type PlanResult = 'started' | 'active' | 'none' | 'skipped';

/** What scheduler.ts decides for the due watches (it owns due detection and catch-up). */
export interface DuePlan {
  /** Watches to run now. */
  run: Watch[];
  /** Overdue watches skipped because dailyRun.catchUp is off. */
  skipLate: Watch[];
  trigger: 'scheduled' | 'catch-up';
}
export type ClassifyDue = (watches: readonly Watch[], settings: Settings, now: EpochMs) => DuePlan;

interface JobInputs {
  watches: Watch[];
  rules: Rule[];
  settings: Settings;
}

/** Called with the run and the item ids a step just matched (strictly). */
export type NewMatchesHook = (run: JobRun, itemIds: ItemId[]) => void | Promise<void>;

export interface RunnerOptions {
  steps?: StepRegistry;
  log?: (message: string, error?: unknown) => void;
}

// ── Helpers (exported for the UI, the digest and tests) ─────────────────────

/** A results.errors message that is a policy skip (T-53's FAVORITE_SKIP_PREFIX, or a no-op executor's), not a failure. */
export function isPolicySkip(message: string): boolean {
  const body = message.replace(/^[A-Za-z]+: /, '');
  return body.startsWith(FAVORITE_SKIP_PREFIX) || body.startsWith(STEP_SKIP_PREFIX);
}

/** The run's real failures: errors that are not policy skips (progress and digest totals). */
export function runFailures(run: Pick<JobRun, 'results'>): JobRun['results']['errors'] {
  return run.results.errors.filter((e) => !isPolicySkip(e.message));
}

/** The run being worked on: the newest run that is running or paused. */
export function activeRun(runs: readonly JobRun[]): JobRun | undefined {
  const last = runs.at(-1);
  return last !== undefined && (last.status === 'running' || last.status === 'paused') ? last : undefined;
}

const finished = (run: JobRun): boolean => run.status === 'done' || run.status === 'failed';

/** The next daily run slot after `now` (settings.dailyRun.localTime in the user's zone); a day later if the zone is unusable. */
export function nextDailySlot(settings: Settings, now: EpochMs): EpochMs {
  try {
    return nextRunAtFor(settings, now, settings.locale.timeZone);
  } catch {
    return now + DAY_MS;
  }
}

/** Whether a watch has an enabled `watch` rule (without one it can never match, so it is not searched). */
export function hasWatchRule(watch: Watch, rules: readonly Rule[]): boolean {
  return watch.ruleIds.some((id) => rules.some((r) => r.id === id && r.enabled && r.action === 'watch'));
}

/** Drops what only the run in progress needs: the candidates keep ids, statuses and notes. */
function compact(run: JobRun): JobRun {
  if (run.candidates === undefined) return run;
  return {
    ...run,
    candidates: run.candidates.map((c): JobCandidate => {
      const out: JobCandidate = { itemId: c.itemId, watchIds: c.watchIds, endTime: c.endTime, status: c.status };
      if (c.note !== undefined) out.note = c.note;
      return out;
    }),
  };
}

/** At most jobRunsKept runs, oldest dropped. */
function bounded(runs: JobRun[]): JobRun[] {
  return runs.length > STORAGE_LIMITS.jobRunsKept ? runs.slice(runs.length - STORAGE_LIMITS.jobRunsKept) : runs;
}

const endMs = (iso: string): number => new Date(iso).getTime();

/** The message of the run's last real failure for `watchId`, or undefined. */
function lastErrorFor(run: JobRun, watchId: string): string | undefined {
  let out: string | undefined;
  for (const e of run.results.errors) {
    if (isPolicySkip(e.message)) continue;
    const step = run.steps[e.step];
    if (e.message.startsWith(`watch ${watchId}: `) || e.message.startsWith(RUN_ERROR_PREFIX)) out = e.message;
    else if (e.message.startsWith('search: ') && step?.kind === 'search' && step.watchId === watchId) out = e.message;
  }
  return out;
}

/** The watches a run covered: those it searched, and those its plan refused (invalid params). */
function watchesOf(run: JobRun, watches: readonly Watch[]): Set<string> {
  const ids = new Set(run.steps.flatMap((s) => (s.kind === 'search' ? [s.watchId] : [])));
  for (const w of watches) if (run.results.errors.some((e) => e.message.startsWith(`watch ${w.id}: `))) ids.add(w.id);
  return ids;
}

/** T-51 closes a note as "<watchId>: why; ..." for every watch that did not strictly match. */
function noteNames(note: string | undefined, watchId: string): boolean {
  return (note ?? '').split('; ').some((seg) => seg.startsWith(`${watchId}: `));
}

/** Enabled non-local watches named on a tracked item, in reason order. These may favorite it on SGW. */
function sgwFavoriteWatches(item: TrackedItem, byId: ReadonlyMap<string, Watch>): Watch[] {
  const out: Watch[] = [];
  for (const reason of item.reasons) {
    if (reason.kind !== 'watch' || reason.id === undefined) continue;
    const watch = byId.get(reason.id);
    if (watch !== undefined && watch.enabled && watch.favoriteMode !== 'local') out.push(watch);
  }
  return out;
}

/** What one step did, and the subscriber work step() settles after releasing the run lock. */
interface SettledStep {
  result: StepResult;
  pending: readonly Promise<unknown>[];
}

const settled = (result: StepResult, pending: readonly Promise<unknown>[] = []): SettledStep => ({ result, pending });

function auditDetails(run: JobRun): Record<string, string | number | boolean | null> {
  return {
    runId: run.id,
    trigger: run.trigger,
    status: run.status,
    steps: run.steps.length,
    newMatches: run.results.newMatches.length,
    favorited: run.results.favorited.length,
    calendarUpserts: run.results.calendarUpserts.length,
    failures: runFailures(run).length,
    skips: run.results.errors.filter((e) => isPolicySkip(e.message)).length,
  };
}

// ── The runner ──────────────────────────────────────────────────────────────

export class DailyJobRunner {
  private readonly steps: StepRegistry;
  private readonly log: (message: string, error?: unknown) => void;
  private chain: Promise<unknown> = Promise.resolve();
  /** Steps started and not settled (a tick in flight, or the drain's next step queued behind it). */
  private stepping = 0;
  private draining: Promise<void> | undefined;
  private readonly ports = new Set<RuntimePort>();
  private readonly newMatchHooks = new Set<NewMatchesHook>();

  constructor(
    private readonly ctx: BackgroundContext,
    opts: RunnerOptions = {},
  ) {
    this.steps = opts.steps ?? createStepRegistry();
    this.log =
      opts.log ??
      ((message, error) => {
        console.error(`[ShopBadwill] ${message}`, error);
      });
    for (const f of this.steps.failed) this.log(`daily job: step module ${f.file} was not loaded: ${f.error}`);
  }

  // ── Public API ──────────────────────────────────────────────────────────

  /** One step on lane `background` (the scheduler's tick). */
  tick(): Promise<StepResult> {
    if (this.stepping > 0 || this.draining !== undefined) return Promise.resolve('busy');
    return this.step('background');
  }

  /**
   * job.runNow: joins the active run, or starts a manual run of `watchIds`
   * (default: every enabled watch), then drains it on lane `interactive`.
   * Resolves once the run is planned or joined; the drain carries on.
   * Throws (a clear reply) without the host permission or with nothing to run.
   */
  async runNow(watchIds?: readonly string[]): Promise<void> {
    await this.exclusive(async () => {
      if (activeRun(await this.ctx.repo.get(STORAGE_KEYS.jobRuns)) !== undefined) return; // join (R3)
      if (!(await this.hostPermitted())) {
        await this.reportNoPermission({ trigger: 'manual' });
        throw new Error(NO_PERMISSION_MESSAGE);
      }
      const inputs = await this.inputs();
      const now = this.ctx.clock.now();
      const chosen = inputs.watches.filter((w) => w.enabled && (watchIds === undefined || watchIds.includes(w.id)));
      if (chosen.length === 0) throw new Error(watchIds === undefined ? 'There is no enabled watch to run.' : 'None of those watches is enabled.');
      const runnable = chosen.filter((w) => hasWatchRule(w, inputs.rules));
      // A due watch run by hand takes its daily slot now, else the next tick would run it again.
      const next = nextDailySlot(inputs.settings, now);
      await this.updateWatches(new Set(chosen.filter((w) => w.nextRunAt <= now).map((w) => w.id)), next, chosen.filter((w) => !runnable.includes(w)), undefined);
      if (runnable.length === 0) throw new Error(`Nothing to search: ${NO_WATCH_RULE}.`);
      await this.planRun('manual', runnable, inputs, now);
    });
    void this.drain();
  }

  /** job.status: the active run, else the latest one, else null. */
  async status(): Promise<JobRun | null> {
    const runs = await this.ctx.repo.get(STORAGE_KEYS.jobRuns);
    return activeRun(runs) ?? runs.at(-1) ?? null;
  }

  /**
   * reconcile()'s planning step (scheduler.ts): advances the due watches'
   * nextRunAt, pulls back any nextRunAt beyond the next slot, and plans a run
   * of `classify`'s watches unless one is active. Sends no request (R2).
   */
  planDue(now: EpochMs, classify: ClassifyDue): Promise<PlanResult> {
    return this.exclusive(async () => {
      const active = activeRun(await this.ctx.repo.get(STORAGE_KEYS.jobRuns)) !== undefined;
      const inputs = await this.inputs();
      const plan: DuePlan = active ? { run: [], skipLate: [], trigger: 'scheduled' } : classify(inputs.watches, inputs.settings, now);
      const next = nextDailySlot(inputs.settings, now);
      const permitted = plan.run.length === 0 || (await this.hostPermitted());
      const noRule = plan.run.filter((w) => !hasWatchRule(w, inputs.rules));
      const due = new Set([...plan.run, ...plan.skipLate].map((w) => w.id));
      await this.updateWatches(due, next, noRule, permitted ? undefined : plan.run);
      for (const w of plan.skipLate) {
        await this.audit({ actor: 'daily-job', kind: 'job.skipped', details: { reason: 'catch-up-off', watchId: w.id, dueAt: w.nextRunAt } });
      }
      if (!permitted) {
        await this.reportNoPermission({ trigger: plan.trigger, watches: plan.run.length });
        return 'skipped';
      }
      const runnable = plan.run.filter((w) => !noRule.includes(w));
      if (runnable.length === 0) return active ? 'active' : 'none';
      await this.planRun(plan.trigger, runnable, inputs, now);
      return 'started';
    });
  }

  /**
   * sgw-late items whose favorite window opened since the last run started
   * (and before now) get a favorites-only run, so a window that opens between
   * daily runs is not missed. Once per window: the new run's start is after it.
   */
  planFavoriteSweep(now: EpochMs): Promise<boolean> {
    return this.exclusive(async () => {
      const runs = await this.ctx.repo.get(STORAGE_KEYS.jobRuns);
      if (activeRun(runs) !== undefined) return false;
      const inputs = await this.inputs();
      if (!inputs.settings.dailyRun.enabled) return false;
      const since = runs.at(-1)?.startedAt ?? 0;
      const byId = new Map(inputs.watches.map((w) => [w.id, w]));
      const candidates = (await this.favoriteAdds(inputs, now)).filter(({ item }) => {
        const usable = sgwFavoriteWatches(item, byId);
        if (usable.length === 0 || usable.some((w) => w.favoriteMode === 'sgw')) return false;
        const opensAt = Math.max(...usable.map((w) => endMs(item.endTime) - (w.favoriteWithinHours ?? DEFAULT_FAVORITE_WITHIN_HOURS) * HOUR_MS));
        return opensAt > since && opensAt <= now;
      });
      if (candidates.length === 0 || !(await this.hostPermitted())) return false;
      const run: JobRun = {
        id: this.runId(runs, now),
        trigger: 'scheduled',
        startedAt: now,
        status: 'running',
        steps: candidates.map(({ step }) => step),
        cursor: 0,
        results: { newMatches: [], favorited: [], calendarUpserts: [], errors: [] },
        candidates: [],
      };
      await this.append(run);
      return true;
    });
  }

  /** The late-add hook (T-56): `cb(run, itemIds)` after each step that matched new items. Returns an unsubscribe function. */
  onNewMatches(cb: NewMatchesHook): () => void {
    this.newMatchHooks.add(cb);
    return () => {
      this.newMatchHooks.delete(cb);
    };
  }

  /** Streams the run to a `sbw:job-progress` port: now, and after every change. Web pages and content scripts are refused. */
  serveProgress(port: RuntimePort): void {
    const url = port.sender?.url ?? '';
    if (!/^(chrome|moz)-extension:\/\//.test(url)) {
      port.disconnect();
      return;
    }
    this.ports.add(port);
    port.onDisconnect.addListener(() => {
      this.ports.delete(port);
    });
    void this.status().then(
      (run) => {
        if (run !== null && this.ports.has(port)) this.post(port, run);
      },
      (e: unknown) => {
        this.log('daily job: reading the run for a progress port failed', e);
      },
    );
  }

  // ── Steps ───────────────────────────────────────────────────────────────

  private async step(lane: Lane): Promise<StepResult> {
    this.stepping++;
    try {
      const done = await this.exclusive(() => this.stepOnce(lane));
      // After the run lock, before step() resolves: a drain must not start the
      // next step (often notifyDigest) until these subscribers have settled.
      await Promise.allSettled(done.pending);
      return done.result;
    } catch (e) {
      this.log('daily job: a step failed', e);
      return 'idle';
    } finally {
      this.stepping--;
    }
  }

  private drain(): Promise<void> {
    this.draining ??= (async () => {
      try {
        for (let i = 0; i < MAX_DRAIN_STEPS; i++) if ((await this.step('interactive')) !== 'stepped') break;
      } finally {
        this.draining = undefined;
      }
    })();
    return this.draining;
  }

  private async stepOnce(lane: Lane): Promise<SettledStep> {
    const stored = activeRun(await this.ctx.repo.get(STORAGE_KEYS.jobRuns));
    if (stored === undefined) return settled('idle');
    if (!(await this.hostPermitted())) {
      await this.failRun(stored, 'host permission for shopgoodwill.com was revoked');
      await this.reportNoPermission({ runId: stored.id });
      return settled('no-permission');
    }
    if (this.laneBlocked(lane)) return settled('paused');
    // The scheduler is not paused (any more): a run T-51 paused carries on.
    const before = resume(stored);
    const inputs = await this.inputs();
    const job = this.dailyJob(inputs);
    const step = job.next(before);
    if (step === null) return settled('idle');

    let outcome: StepOutcome;
    if (step.kind === 'favorite' && before.steps.slice(0, before.cursor).some((s) => s.kind === 'favorite' && s.itemId === step.itemId)) {
      outcome = { kind: 'error', message: `${FAVORITE_SKIP_PREFIX}already handled in this run`, retryable: false };
    } else {
      const executed = await this.execute(step, before, lane);
      if (executed === 'not-run') return settled('not-run');
      outcome = executed;
    }
    const after = job.apply(before, step, outcome);
    const ok = await this.commit(stored, after, async () => {
      await this.trackMatches(before, after, outcome, inputs);
      if (finished(after)) await this.finishWatches(after);
    });
    if (!ok) {
      this.log(`daily job: run ${stored.id} changed while step ${String(stored.cursor)} ran; this result was dropped`);
      return settled('conflict');
    }
    const matched = after.results.newMatches.filter((id) => !before.results.newMatches.includes(id));
    const pending = matched.length > 0 ? this.emitNewMatches(after, matched) : [];
    if (finished(after)) await this.audit({ actor: 'daily-job', kind: 'job.run.done', details: auditDetails(after) });
    return settled('stepped', pending);
  }

  /** RequestScheduler gate: a pause, a backoff on the lane or a spent budget executes nothing (and uses no retry). */
  private laneBlocked(lane: Lane): boolean {
    const stats = this.ctx.scheduler.stats();
    if (stats.paused !== undefined) return true;
    const l = stats.lanes[lane];
    const now = this.ctx.clock.now();
    return (l.backoffUntil !== undefined && l.backoffUntil > now) || l.usedToday >= l.budget;
  }

  private async execute(step: JobStep, run: JobRun, lane: Lane): Promise<StepOutcome | 'not-run'> {
    const { ctx } = this;
    const deps: StepDeps = { api: ctx.api, repo: ctx.repo, audit: ctx.audit, switches: ctx.switches, lane, run, ctx };
    try {
      return await this.steps.executorFor(step.kind).run(step, deps);
    } catch (e) {
      if (e instanceof SgwApiError) {
        if (e.kind === 'paused' || e.kind === 'budget') return 'not-run';
        // Queued, then refused locally: the lane entered backoff and nothing was sent
        // (no HTTP status). A real 429/5xx carries a status and still counts as a retry.
        if (e.status === undefined && RETRYABLE.has(e.kind) && this.laneBlocked(lane)) return 'not-run';
        return { kind: 'error', message: e.message, retryable: RETRYABLE.has(e.kind) };
      }
      this.log(`daily job: the ${step.kind} executor threw`, e);
      return { kind: 'error', message: errorText(e), retryable: false };
    }
  }

  // ── Persistence ─────────────────────────────────────────────────────────

  /** Serialises everything that reads and writes the active run (one step at a time, R3). */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }

  /**
   * Compare-and-set (R3): writes `next` only if the stored run still is
   * `expected` (same id, cursor, status and step count); `effects` run first,
   * under the same lock. A finished run is stored compacted.
   */
  private async commit(expected: JobRun, next: JobRun, effects: () => Promise<void>): Promise<boolean> {
    const { repo } = this.ctx;
    const ok = await repo.withLock(STORAGE_KEYS.jobRuns, async () => {
      const runs = await repo.get(STORAGE_KEYS.jobRuns);
      const at = runs.findIndex((r) => r.id === expected.id);
      const cur = runs[at];
      if (cur === undefined || cur.cursor !== expected.cursor || cur.status !== expected.status || cur.steps.length !== expected.steps.length) {
        return false;
      }
      await effects();
      runs[at] = finished(next) ? compact(next) : next;
      await repo.set(STORAGE_KEYS.jobRuns, bounded(runs));
      return true;
    });
    if (ok) this.publish(finished(next) ? compact(next) : next);
    return ok;
  }

  private async append(run: JobRun): Promise<void> {
    const stored = finished(run) ? compact(run) : run;
    await this.ctx.repo.update(STORAGE_KEYS.jobRuns, (runs) => bounded([...runs, stored]));
    this.publish(stored);
  }

  /** Ends the active run as failed (e.g. the permission was revoked), with the usual end-of-run effects. */
  private async failRun(stored: JobRun, why: string): Promise<void> {
    const failed: JobRun = structuredClone(stored);
    failed.status = 'failed';
    failed.finishedAt = this.ctx.clock.now();
    failed.results.errors.push({ step: stored.cursor, message: `${RUN_ERROR_PREFIX}${why}` });
    if (await this.commit(stored, failed, () => this.finishWatches(failed))) {
      await this.audit({ actor: 'daily-job', kind: 'job.run.done', details: auditDetails(failed) });
    }
  }

  /** A run id no stored run has. */
  private runId(runs: readonly JobRun[], now: EpochMs): string {
    const base = `run-${String(now)}`;
    let id = base;
    for (let n = 2; runs.some((r) => r.id === id); n++) id = `${base}-${String(n)}`;
    return id;
  }

  // ── Planning ────────────────────────────────────────────────────────────

  private async inputs(): Promise<JobInputs> {
    const { repo } = this.ctx;
    const [watches, rules, settings] = await Promise.all([
      repo.get(STORAGE_KEYS.watches),
      repo.get(STORAGE_KEYS.rules),
      repo.get(STORAGE_KEYS.settings),
    ]);
    return { watches, rules, settings };
  }

  /** T-51's DailyJob with this tick's watches, rules and settings (carry: factory deps). */
  private dailyJob(inputs: JobInputs): DailyJob {
    return createDailyJob({
      evaluateBatch,
      validateQuery: invalidSearchParams,
      searchPageSize: () => SEARCH_PAGE_SIZE,
      watches: inputs.watches,
      rules: inputs.rules,
      settings: inputs.settings,
      now: () => this.ctx.clock.now(),
    });
  }

  /** Plans and stores a run (lock held). Favorite retries from desired() follow the planned steps. */
  private async planRun(trigger: JobRun['trigger'], watches: Watch[], inputs: JobInputs, now: EpochMs): Promise<JobRun> {
    const runs = await this.ctx.repo.get(STORAGE_KEYS.jobRuns);
    const run = this.dailyJob(inputs).plan(watches, now);
    run.trigger = trigger;
    run.id = this.runId(runs, now);
    if (run.status === 'running') {
      for (const { step } of (await this.favoriteAdds(inputs, now)).slice(0, MAX_FAVORITE_RETRIES_PER_RUN)) run.steps.push(step);
    }
    await this.append(run);
    if (finished(run)) {
      // Every watch was refused at plan time (invalid params): record why on them now.
      await this.finishWatches(run);
      await this.audit({ actor: 'daily-job', kind: 'job.run.done', details: auditDetails(run) });
    }
    return run;
  }

  /** desired()'s 'add' items (T-53), soonest-ending first, each with the favorite step to plan. */
  private async favoriteAdds(inputs: JobInputs, now: EpochMs): Promise<Array<{ item: TrackedItem; step: JobStep }>> {
    const { repo } = this.ctx;
    const [tracked, cache] = await Promise.all([repo.get(STORAGE_KEYS.tracked), repo.get(STORAGE_KEYS.favoritesCache)]);
    const byId = new Map(inputs.watches.map((w) => [w.id, w]));
    const out: Array<{ item: TrackedItem; step: JobStep }> = [];
    for (const d of desired(Object.values(tracked), inputs.watches, now, cache.items)) {
      const item = tracked[d.itemId];
      if (d.action !== 'add' || item === undefined) continue;
      const usable = sgwFavoriteWatches(item, byId);
      const pick = usable.find((w) => w.favoriteMode === 'sgw') ?? usable[0];
      if (pick !== undefined) out.push({ item, step: { kind: 'favorite', itemId: item.itemId, watchId: pick.id } });
    }
    return out.sort((a, b) => endMs(a.item.endTime) - endMs(b.item.endTime));
  }

  /**
   * Moves the `due` watches to `next`, pulls any nextRunAt beyond `next` back
   * to it (the run time moved earlier), and records why `noRule` and
   * `noPermission` watches did not run.
   */
  private async updateWatches(due: ReadonlySet<string>, next: EpochMs, noRule: readonly Watch[], noPermission: readonly Watch[] | undefined): Promise<void> {
    const lastError = new Map<string, string>();
    for (const w of noPermission ?? []) lastError.set(w.id, PERMISSION_LAST_ERROR);
    for (const w of noRule) lastError.set(w.id, NO_WATCH_RULE);
    if (due.size === 0 && lastError.size === 0 && !(await this.ctx.repo.get(STORAGE_KEYS.watches)).some((w) => w.nextRunAt > next)) return;
    await this.ctx.repo.update(STORAGE_KEYS.watches, (watches) =>
      watches.map((w) => {
        const nextRunAt = due.has(w.id) || w.nextRunAt > next ? next : w.nextRunAt;
        const err = lastError.get(w.id);
        if (nextRunAt === w.nextRunAt && (err === undefined || err === w.lastError)) return w;
        return err === undefined ? { ...w, nextRunAt } : { ...w, nextRunAt, lastError: err };
      }),
    );
  }

  // ── Side effects ────────────────────────────────────────────────────────

  /** Newly matched candidates become (or join) TrackedItems. */
  private async trackMatches(before: JobRun, after: JobRun, outcome: StepOutcome, inputs: JobInputs): Promise<void> {
    const prior = new Map((before.candidates ?? []).map((c) => [c.itemId, c]));
    const planned = after.steps.slice(before.steps.length);
    const byId = new Map(inputs.watches.map((w) => [w.id, w]));
    const found: Array<{ listing: Listing; watchIds: string[]; calendar: boolean }> = [];
    for (const c of after.candidates ?? []) {
      const was = prior.get(c.itemId);
      if (c.status !== 'matched' || was?.status === 'matched') continue;
      const listing =
        (outcome.kind === 'detail' && outcome.detail.itemId === c.itemId ? outcome.detail : undefined) ??
        was?.detail ??
        was?.row ??
        (outcome.kind === 'search' ? outcome.items.find((l) => l.itemId === c.itemId) : undefined);
      if (listing === undefined) continue;
      const writer = planned.find((s) => s.kind === 'favorite' && s.itemId === c.itemId);
      const local = c.watchIds.filter((id) => byId.get(id)?.favoriteMode === 'local' && !noteNames(c.note, id));
      let watchIds = [...new Set([...(writer?.kind === 'favorite' ? [writer.watchId] : []), ...local])];
      if (watchIds.length === 0) watchIds = c.watchIds;
      const calendar = planned.some((s) => s.kind === 'calendarUpsert' && s.itemId === c.itemId);
      found.push({ listing, watchIds, calendar });
    }
    if (found.length === 0) return;
    const now = this.ctx.clock.now();
    await this.ctx.repo.update(STORAGE_KEYS.tracked, (cur) => {
      const next = { ...cur };
      for (const { listing, watchIds, calendar } of found) {
        const old = cur[listing.itemId];
        const reasons = [...(old?.reasons ?? [])];
        for (const id of watchIds) if (!reasons.some((r) => r.kind === 'watch' && r.id === id)) reasons.push({ kind: 'watch', id });
        next[listing.itemId] = {
          ...old,
          itemId: listing.itemId,
          title: listing.title,
          endTime: listing.endTime,
          sellerId: listing.sellerId,
          reasons,
          favoriteState: old?.favoriteState ?? 'none',
          calendar: (old?.calendar ?? false) || calendar,
          addedAt: old?.addedAt ?? now,
          updatedAt: now,
        };
      }
      return next;
    });
  }

  /** End of run: seenUpdates via recordSeen, lastRunAt and lastError for every watch the run covered. */
  private async finishWatches(run: JobRun): Promise<void> {
    const seen = seenUpdates(run);
    const at = run.finishedAt ?? this.ctx.clock.now();
    await this.ctx.repo.update(STORAGE_KEYS.watches, (watches) => {
      const covered = watchesOf(run, watches);
      return watches.map((w) => {
        const ids = seen[w.id];
        if (ids === undefined && !covered.has(w.id)) return w;
        const next: Watch = { ...w };
        if (ids !== undefined) next.seenItemIds = recordSeen(w.seenItemIds, ids);
        if (covered.has(w.id)) {
          next.lastRunAt = at;
          const err = lastErrorFor(run, w.id);
          if (err === undefined) delete next.lastError;
          else next.lastError = err;
        }
        return next;
      });
    });
  }

  // ── Permission, audit, progress ─────────────────────────────────────────

  private async hostPermitted(): Promise<boolean> {
    try {
      return await this.ctx.permissions.contains({ origins: [...SGW_HOST_ORIGINS] });
    } catch (e) {
      this.log('daily job: permissions.contains failed', e);
      return false;
    }
  }

  /** The run is skipped: a notification and an audit entry. */
  private async reportNoPermission(details: Record<string, string | number | boolean | null>): Promise<void> {
    try {
      await this.ctx.notifier.notify({
        id: PERMISSION_NOTIFICATION_ID,
        title: 'ShopBadwill skipped its daily check',
        message: NO_PERMISSION_MESSAGE,
        priority: 1,
      });
    } catch (e) {
      // Chrome hides notifications until their optional permission is granted; the audit entry still records it.
      this.log('daily job: the permission notification failed', e);
    }
    await this.audit({ actor: 'daily-job', kind: 'job.skipped', details: { reason: 'host-permission', ...details } });
  }

  private async audit(entry: Parameters<BackgroundContext['audit']['append']>[0]): Promise<void> {
    try {
      await this.ctx.audit.append(entry);
    } catch (e) {
      this.log(`daily job: writing the ${entry.kind} audit entry failed`, e);
    }
  }

  /** Starts each subscriber. The caller awaits these after the run lock is released. Failures are logged, never thrown. */
  private emitNewMatches(run: JobRun, itemIds: ItemId[]): Promise<void>[] {
    return [...this.newMatchHooks].map((cb) =>
      Promise.resolve()
        .then(() => cb(structuredClone(run), [...itemIds]))
        .then(() => undefined)
        .catch((e: unknown) => {
          this.log('daily job: a new-matches subscriber failed', e);
        }),
    );
  }

  private publish(run: JobRun): void {
    for (const port of [...this.ports]) this.post(port, run);
  }

  private post(port: RuntimePort, run: JobRun): void {
    try {
      port.postMessage(run);
    } catch {
      this.ports.delete(port); // disconnected
    }
  }
}

const RUNNERS = new WeakMap<BackgroundContext, DailyJobRunner>();

/** The one runner of this background (shared by scheduler.ts and the job.* handlers). */
export function runnerFor(ctx: BackgroundContext): DailyJobRunner {
  let runner = RUNNERS.get(ctx);
  if (runner === undefined) {
    runner = new DailyJobRunner(ctx);
    RUNNERS.set(ctx, runner);
  }
  return runner;
}

/**
 * T-36 self-registration (I-01): serves the `sbw:job-progress` port and sends
 * T-56's late-add alerts as soon as a step matches (sendLateAdds keeps only
 * items ending in under 60 min, once each). The tick comes from scheduler.ts.
 */
export function register(ctx: BackgroundContext): void {
  const runner = runnerFor(ctx);
  const notify = { repo: ctx.repo, audit: ctx.audit, notifier: ctx.notifier, permissions: ctx.permissions, alarms: ctx.alarms };
  runner.onNewMatches(async (run, itemIds) => {
    await sendLateAdds(notify, { id: run.id, results: { ...run.results, newMatches: itemIds } });
  });
  ctx.ports.serve(PORT_NAMES.jobProgress, (port) => {
    runner.serveProgress(port);
  });
}

