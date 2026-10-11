// T-52: the Scheduler (PLAN §1.2, §3.6). One repeating alarm `sbw:tick`
// (every 2 minutes) drives the daily job.
//
// reconcile(now) runs when this module registers (the background's first
// turn after startup), on runtime.onStartup and onInstalled, and on every tick:
//   1. re-creates the tick alarm if it is missing (Firefox drops alarms on
//      restart; Chrome before 150 may too);
//   2. due-watch detection with catch-up (classifyDue): enabled watches whose
//      nextRunAt has passed. However overdue (hours or days), a watch runs ONCE:
//      its nextRunAt moves to the next daily slot when the run is planned. A
//      run more than CATCH_UP_GRACE_MS late is a 'catch-up' run; with
//      dailyRun.catchUp off it is skipped to its next slot instead (audited).
//      dailyRun.enabled off plans nothing (Run now still works);
//   3. otherwise, an sgw-late favorite window that opened since the last run
//      gets a favorites-only run (the runner's planFavoriteSweep).
// reconcile() only plans: it never executes a step, so startup, install and
// reconcile send no SGW request (R2). On a tick, after reconcile, the runner
// executes one step; ctx.ticks (the onTick hook: T-83's heartbeat, T-103's
// post-end work) runs alongside, so a slow subscriber never holds up the job.
import type { Settings } from '../../domain/settings/schema';
import { STORAGE_KEYS } from '../../domain/storage/schema';
import type { EpochMs } from '../../domain/types';
import type { Scheduler, Watch } from '../../domain/watches/schema';
import type { BackgroundContext } from '../context';
import { runnerFor, type DailyJobRunner, type DuePlan } from './daily-job-runner';

export const TICK_ALARM = 'sbw:tick';
export const TICK_PERIOD_MINUTES = 2;
/** A run planned later than this after its slot is a catch-up run (the browser was not running then). */
export const CATCH_UP_GRACE_MS = 15 * 60_000;

export const isDue = (w: Watch, now: EpochMs): boolean => w.enabled && w.nextRunAt <= now;

/** Due-watch detection with catch-up. Pure. */
export function classifyDue(watches: readonly Watch[], settings: Pick<Settings, 'dailyRun'>, now: EpochMs): DuePlan {
  if (!settings.dailyRun.enabled) return { run: [], skipLate: [], trigger: 'scheduled' };
  const due = watches.filter((w) => isDue(w, now));
  const late = due.filter((w) => now - w.nextRunAt > CATCH_UP_GRACE_MS);
  if (!settings.dailyRun.catchUp) return { run: due.filter((w) => !late.includes(w)), skipLate: late, trigger: 'scheduled' };
  return { run: due, skipLate: [], trigger: late.length > 0 ? 'catch-up' : 'scheduled' };
}

export class JobScheduler implements Scheduler {
  constructor(
    private readonly ctx: BackgroundContext,
    private readonly runner: DailyJobRunner,
    private readonly log: (message: string, error?: unknown) => void = (message, error) => {
      console.error(`[ShopBadwill] ${message}`, error);
    },
  ) {}

  async reconcile(now: EpochMs): Promise<void> {
    await this.ensureAlarm();
    const planned = await this.runner.planDue(now, classifyDue);
    if (planned === 'none') await this.runner.planFavoriteSweep(now);
  }

  async dueWatches(now: EpochMs): Promise<Watch[]> {
    return (await this.ctx.repo.get(STORAGE_KEYS.watches)).filter((w) => isDue(w, now));
  }

  /** One `sbw:tick`: reconcile, then one runner step; the ctx.ticks subscribers alongside. Never rejects. */
  async onTick(): Promise<void> {
    const own = (async () => {
      await this.reconcile(this.ctx.clock.now());
      await this.runner.tick();
    })().catch((e: unknown) => {
      this.log('scheduler: a tick failed', e);
    });
    await Promise.all([this.ctx.ticks.tick(), own]);
  }

  private async ensureAlarm(): Promise<void> {
    try {
      const alarms = await this.ctx.alarms.getAll();
      if (alarms.some((a) => a.name === TICK_ALARM && a.periodInMinutes === TICK_PERIOD_MINUTES)) return;
      await this.ctx.alarms.create(TICK_ALARM, { periodInMinutes: TICK_PERIOD_MINUTES });
    } catch (e) {
      this.log('scheduler: creating the tick alarm failed', e);
    }
  }
}

const SCHEDULERS = new WeakMap<BackgroundContext, JobScheduler>();

/** The one scheduler of this background. */
export function schedulerFor(ctx: BackgroundContext): JobScheduler {
  let s = SCHEDULERS.get(ctx);
  if (s === undefined) {
    s = new JobScheduler(ctx, runnerFor(ctx));
    SCHEDULERS.set(ctx, s);
  }
  return s;
}

/** T-36 self-registration (I-01): the tick alarm, the lifecycle events, and a reconcile now. */
export function register(ctx: BackgroundContext): void {
  const s = schedulerFor(ctx);
  const reconcile = (why: string): void => {
    s.reconcile(ctx.clock.now()).catch((e: unknown) => {
      console.error(`[ShopBadwill] scheduler: reconcile (${why}) failed`, e);
    });
  };
  ctx.alarms.onAlarm((alarm) => {
    if (alarm.name === TICK_ALARM) void s.onTick();
  });
  ctx.lifecycle.onStartup(() => {
    reconcile('startup');
  });
  ctx.lifecycle.onInstalled(() => {
    reconcile('installed');
  });
  reconcile('background start');
}
