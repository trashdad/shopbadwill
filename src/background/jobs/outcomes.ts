// T-103: after-auction outcome detection (PLAN §6 T-103). On every scheduler
// tick (T-52's onTick hook) it scans the persisted state and enqueues at most
// ONE `postEnd` step per tick, executed by steps/post-end.ts on lane
// `background` (R1, R2). The scan itself never reads SGW.
//
// Per tracked item (R2: only ones with a snipe or a calendar event; never again
// once its outcome is recorded):
//   - a T-84 snipe whose outcome already decided the result (won or outbid
//     settled by its outcome read; below-minimum, late, ended) is recorded
//     from the snipe's persisted outcome: no read, no stamp, no notification
//     (the snipe path did them);
//   - a calendar link carrying a `stamped:<outcome>` record (CalendarSink.stamp)
//     recovers a postEnd run that crashed before recording its outcome;
//   - a snipe with a send in flight (`firing`, `sent`, `fallback-applied`)
//     defers to the runner, which owns that outcome;
//   - otherwise, at least 2 minutes after the end, the item gets its one
//     postEnd read. A read that settles nothing (still open, or failed) is
//     retried with a delay, at most MAX_POST_END_READS in all; then the item
//     is recorded `unknown`.
//
// The tick obeys the lane budget: a `budget` or `paused` refusal stops the tick
// quietly and the item is retried on a later tick, never in a loop (R2). The
// kill switch stops the read (R7); the calendar stamp goes through T-67's
// CalendarSink, which obeys writesAllowed('calendar') and is not gated by the
// SGW session (R7). Spent-today stays T-82's accumulation: nothing here adds
// spending (R5).
import type { AuditLog } from '../../domain/audit/types';
import type { CalendarLink } from '../../domain/calendar/types';
import type { Snipe } from '../../domain/snipe/types';
import { STORAGE_KEYS } from '../../domain/storage/schema';
import type { EpochMs, ItemId, TrackedItem } from '../../domain/types';
import { SgwApiError } from '../../ports/errors';
import { errorText, type BackgroundContext } from '../context';
import { syncFor } from './calendar-sync';
import { snipeSeams } from './snipe-runner';
import postEnd from './steps/post-end';
import { OUTCOME_NOTIFY_PREFIX, onOutcomeAlarm, notifyOutcome, recordOutcome, stampedOutcome, type OutcomeKind } from './steps/post-end';

/** The outcome notification alarm / id prefix and the alarm handler (wired in register). */
export { OUTCOME_NOTIFY_PREFIX as OUTCOME_NOTIFY_ALARM_PREFIX, onOutcomeAlarm, stampedOutcome };

/** The one postEnd read happens at least this long after the auction end (R2). */
export const POST_END_MIN_DELAY_MS = 2 * 60_000;

/**
 * Reads that settle nothing (the auction was still open, or the read failed)
 * are capped per item. At the cap the item is recorded `unknown` and never
 * read again (R2), so an end that keeps moving later, or a read that keeps
 * failing, costs at most this many reads.
 */
export const MAX_POST_END_READS = 4;

/** After a failed read, the next attempt waits this long (the last delay repeats). */
export const READ_RETRY_DELAYS_MS: readonly number[] = [15 * 60_000, 60 * 60_000, 4 * 60 * 60_000];

const MID_FLIGHT: ReadonlySet<Snipe['state']> = new Set(['firing', 'sent', 'fallback-applied']);
const PRE_FIRE: ReadonlySet<Snipe['state']> = new Set(['armed', 'waking', 'verified']);
const DECIDED: ReadonlySet<TrackedItem['outcome']> = new Set(['won', 'lost', 'ended-early', 'unknown']);

/**
 * T-87 calls a win (or an outbid) final, and T-84 stamps it, only when the
 * outcome read saw the item. Settled any other way (`post-read failed` after
 * about 7 days, or a reply alone) it is "Leading" / "Outbid when the bid went
 * in": nothing proves it, so it decides nothing here and the item gets its own read.
 */
function settledByOutcomeRead(s: Pick<Snipe, 'history'>): boolean {
  return s.history.at(-1)?.why === 'post-read';
}

/** The T-84 snipe outcomes whose stamp and notification already decided the calendar result. */
export function decisiveOutcome(s: Pick<Snipe, 'outcome' | 'history'>): OutcomeKind | undefined {
  switch (s.outcome) {
    case 'won':
      return settledByOutcomeRead(s) ? 'won' : undefined;
    case 'outbid':
      return settledByOutcomeRead(s) ? 'lost' : undefined;
    case 'below-minimum':
    case 'late':
      // T-84's own "Lost" results (its copy says so whether or not it knew the price).
      return 'lost';
    case 'ended':
      return 'ended-early';
    default:
      return undefined;
  }
}

/** What the tick must do for one item, decided from persisted state only (never memory, R3). */
export type OutcomePlan =
  | { kind: 'record'; itemId: ItemId; outcome: OutcomeKind; via: 'snipe' | 'stamp' }
  | { kind: 'give-up'; itemId: ItemId; reads: number }
  | { kind: 'read'; itemId: ItemId };

const STILL_OPEN_KIND = 'outcome.still-open';
const READ_FAILED_KIND = 'outcome.read-failed';
const AUDIT_PAGE = 200;

/** The persisted record of an item's post-end reads that settled nothing (audit rows, newest first). */
export interface ReadHistory {
  /** Reads that found the auction still open, plus reads that failed. */
  unsettled: number;
  failures: number;
  /** When the newest failed read was audited. */
  lastFailAt?: EpochMs;
  /** The end the newest `final` still-open row was read at: that end needs no second read. */
  finalEnd?: string;
}

/** One paged pass over the `outcome.still-open` and `outcome.read-failed` rows, per item. */
export async function readHistory(audit: Pick<AuditLog, 'list'>): Promise<ReadonlyMap<ItemId, ReadHistory>> {
  const out = new Map<ItemId, ReadHistory>();
  let before: number | undefined;
  for (;;) {
    const page = await audit.list({
      limit: AUDIT_PAGE,
      kinds: [STILL_OPEN_KIND, READ_FAILED_KIND],
      ...(before === undefined ? {} : { before }),
    });
    for (const e of page) {
      if (e.itemId === undefined) continue;
      const h = out.get(e.itemId) ?? { unsettled: 0, failures: 0 };
      h.unsettled += 1;
      if (e.kind === READ_FAILED_KIND) {
        h.failures += 1;
        h.lastFailAt ??= e.at;
      } else if (e.details.final === true && h.finalEnd === undefined && typeof e.details.endTime === 'string') {
        h.finalEnd = e.details.endTime;
      }
      out.set(e.itemId, h);
    }
    const last = page.at(-1);
    if (page.length < AUDIT_PAGE || last === undefined) return out;
    before = last.seq;
  }
}

function sameInstant(a: string, b: string): boolean {
  return new Date(a).getTime() === new Date(b).getTime();
}

/**
 * The read is due: at least 2 minutes after the end (R2), this end has not
 * already been read while still open, and a failed read has waited out its
 * retry delay (never a read per tick, never a loop).
 */
function dueForRead(t: TrackedItem, now: EpochMs, h: ReadHistory | undefined): boolean {
  const endMs = new Date(t.endTime).getTime();
  if (now < endMs + POST_END_MIN_DELAY_MS) return false;
  if (h === undefined) return true;
  if (h.finalEnd !== undefined && sameInstant(h.finalEnd, t.endTime)) return false;
  if (h.lastFailAt === undefined) return true;
  const delay = READ_RETRY_DELAYS_MS[Math.min(h.failures, READ_RETRY_DELAYS_MS.length) - 1] ?? 0;
  return now >= h.lastFailAt + delay;
}

/** The per-item scan. Pure over the persisted records: snipe outcomes, the calendar links' stamp records, the read history. */
export function planOutcomeWork(
  tracked: Readonly<Record<number, TrackedItem>>,
  snipes: Readonly<Record<string, Snipe>>,
  links: Readonly<Record<number, CalendarLink>>,
  now: EpochMs,
  history: ReadonlyMap<ItemId, ReadHistory> = new Map(),
): OutcomePlan[] {
  const byItem = new Map<ItemId, Snipe[]>();
  for (const s of Object.values(snipes)) {
    if (s.state === 'draft') continue;
    const list = byItem.get(s.itemId);
    if (list === undefined) byItem.set(s.itemId, [s]);
    else list.push(s);
  }
  const plans: OutcomePlan[] = [];
  for (const t of Object.values(tracked)) {
    if (t.outcome !== undefined && DECIDED.has(t.outcome)) continue; // R2: recorded, never again
    const itemSnipes = byItem.get(t.itemId) ?? [];
    const link = links[t.itemId];
    // R2: only tracked items with a snipe or a calendar event.
    if (itemSnipes.length === 0 && !t.calendar && (link === undefined || link.status === 'deleted')) continue;
    // A send may be out: the T-84 runner owns the outcome.
    if (itemSnipes.some((s) => MID_FLIGHT.has(s.state))) continue;
    const h = history.get(t.itemId);
    const readOrGiveUp = (): void => {
      if (h !== undefined && h.unsettled >= MAX_POST_END_READS) plans.push({ kind: 'give-up', itemId: t.itemId, reads: h.unsettled });
      else if (dueForRead(t, now, h)) plans.push({ kind: 'read', itemId: t.itemId });
    };
    // R4: pre-fire snipes need the read to confirm the auction closed; the step
    // then moves them to their ended terminal state.
    if (itemSnipes.some((s) => PRE_FIRE.has(s.state))) {
      readOrGiveUp();
      continue;
    }
    // R3: the T-84 path already decided (its stamp and notification went out).
    const decisive = itemSnipes.map((s) => decisiveOutcome(s)).find((o): o is OutcomeKind => o !== undefined);
    if (decisive !== undefined) {
      plans.push({ kind: 'record', itemId: t.itemId, outcome: decisive, via: 'snipe' });
      continue;
    }
    // R3: the calendar link's stamp record (a postEnd run that crashed before recording).
    const stamped = link === undefined ? undefined : stampedOutcome(link.lastSyncedHash);
    if (stamped !== undefined) {
      plans.push({ kind: 'record', itemId: t.itemId, outcome: stamped, via: 'stamp' });
      continue;
    }
    readOrGiveUp();
  }
  return plans;
}

/** Records a decided outcome without a read (the T-84 path, or a stamped link). */
async function applyRecord(ctx: BackgroundContext, plan: Extract<OutcomePlan, { kind: 'record' }>): Promise<void> {
  const { repo, audit } = ctx;
  await repo.update(STORAGE_KEYS.tracked, (cur) => {
    const t = cur[plan.itemId];
    if (t === undefined) return cur;
    return { ...cur, [plan.itemId]: { ...t, outcome: plan.outcome, updatedAt: repo.now() } };
  });
  await audit.append({ actor: 'daily-job', kind: 'outcome.recorded', itemId: plan.itemId, details: { outcome: plan.outcome, from: plan.via } });
  if (plan.via === 'snipe') {
    // The snipe path already notified: mark the notification obligation handled (R6).
    await audit.append({ actor: 'daily-job', kind: 'notify.outcome', itemId: plan.itemId, details: { outcome: plan.outcome, via: 'snipe' } });
  } else {
    await notifyOutcome(ctx, plan.itemId, plan.outcome);
  }
}

/** Contexts whose outcomes tick is still running (an in-worker overlap guard, not a decision). */
const RUNNING = new WeakSet<BackgroundContext>();

/**
 * One scheduler tick: record what is already decided, then ONE postEnd step at
 * most (R2). The `sbw:tick` alarm does not wait for the previous tick, so a
 * tick that finds the last one still working (a queued read, a slow stamp)
 * does nothing: two ticks must never read, or notify, the same item twice.
 */
export async function outcomesTick(ctx: BackgroundContext): Promise<void> {
  if (RUNNING.has(ctx)) return;
  RUNNING.add(ctx);
  try {
    await runOutcomesTick(ctx);
  } finally {
    RUNNING.delete(ctx);
  }
}

async function runOutcomesTick(ctx: BackgroundContext): Promise<void> {
  const { repo } = ctx;
  const now = ctx.clock.now();
  const [tracked, snipes, calendar] = await Promise.all([
    repo.get(STORAGE_KEYS.tracked),
    repo.get(STORAGE_KEYS.snipes),
    repo.get(STORAGE_KEYS.calendar),
  ]);
  const plans = planOutcomeWork(tracked, snipes, calendar.links, now, await readHistory(ctx.audit));
  for (const plan of plans) {
    if (plan.kind === 'record') await applyRecord(ctx, plan);
    // R2: the read cap is spent. `unknown` is final: no stamp, no notification, no further read.
    if (plan.kind === 'give-up') await recordOutcome(repo, ctx.audit, plan.itemId, 'unknown', { from: 'read-cap', reads: plan.reads });
  }
  const read = plans.find((p): p is Extract<OutcomePlan, { kind: 'read' }> => p.kind === 'read');
  if (read === undefined) return;
  try {
    const outcome = await postEnd.run(
      { kind: 'postEnd', itemId: read.itemId },
      { api: ctx.api, repo, audit: ctx.audit, lane: 'background', ctx },
    );
    // The no-op executor (module failed to load) audited its skip already.
    if (outcome.kind === 'error') return;
  } catch (e) {
    // R2: a budget or pause refusal sent nothing; retry on a later tick, never in a loop.
    if (e instanceof SgwApiError && (e.kind === 'paused' || e.kind === 'budget')) return;
    await ctx.audit.append({ actor: 'daily-job', kind: 'outcome.read-failed', itemId: read.itemId, details: { error: errorText(e).slice(0, 200) } });
  }
}

/** T-36 self-registration (I-01): the stamper, the notification alarm, and the tick hook. */
export function register(ctx: BackgroundContext): void {
  // R3: T-84's snipe path ships without a stamper; wire its stampCalendar effects
  // to T-67's sink (read-before-write, our events only), so a snipe outcome is
  // stamped even when the post-end step never runs.
  snipeSeams(ctx).setCalendarStamper({
    stamp: (snipe, outcome, finalPrice) => syncFor(ctx).sink.stamp(snipe.itemId, outcome, finalPrice),
  });
  ctx.alarms.onAlarm((alarm) => {
    if (!alarm.name.startsWith(OUTCOME_NOTIFY_PREFIX)) return;
    const itemId = Number(alarm.name.slice(OUTCOME_NOTIFY_PREFIX.length));
    if (Number.isSafeInteger(itemId) && itemId > 0) {
      void onOutcomeAlarm(ctx, itemId).catch(() => undefined);
    }
  });
  ctx.ticks.onTick(() =>
    outcomesTick(ctx).catch((e: unknown) => {
      console.error('[ShopBadwill] outcomes: a tick failed', e);
    }),
  );
}
