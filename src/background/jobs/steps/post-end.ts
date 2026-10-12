// T-103: the `postEnd` step executor (I-07). One ItemDetail read on lane
// `background`, at least 2 minutes after the auction end (the scan in
// outcomes.ts enforces the timing), decides the outcome of a tracked item the
// T-84 snipe path did not settle:
//
//   won / lost      from the read's high-bidder flag (null on the anonymous
//                   background read, C6) or, for a loss only, the over-max rule
//                   (final price above the user's snipe max, see overMaxLimit),
//                   whose notification says just that ("Over your max"),
//                   stamped on the calendar through T-67's CalendarSink (R3,
//                   R7: it obeys writesAllowed('calendar') and is not gated by
//                   the SGW session), recorded on the TrackedItem, notified once;
//   ended-early     the auction closed while a snipe was still pre-fire: each
//                   such snipe is moved to its ended terminal state with an
//                   EXISTING reducer event (R4, no domain edit): `preflight-failed
//                   {reason:'ended'}` from `armed`, `verify-failed {reason:'ended'}`
//                   from `waking` or `verified`. Its effects stamp and notify.
//   still running   the end moved: the tracked end time is refreshed, no
//                   outcome, and the scan waits for the new end;
//   mid-flight      a snipe with a possible send out (`firing`, `sent`,
//                   `fallback-applied`) owns the outcome: nothing is recorded,
//                   the scan retries on a later tick.
//
// Shared with outcomes.ts: the outcome notification gate (`notifyOutcome`),
// the alarm re-send (`onOutcomeAlarm`), the notification copy and the tracked
// outcome write. Everything is idempotent or persisted, so a restart never
// reads an item twice (R2), never stamps twice (the sink is read-before-write)
// and never notifies twice (the `notify.outcome` marker row is written before
// the send, R6).
import type { AuditLog } from '../../../domain/audit/types';
import { formatMoney } from '../../../domain/money';
import type { Snipe, SnipeEvent } from '../../../domain/snipe/types';
import type { Repo } from '../../../domain/storage/repo';
import { STORAGE_KEYS } from '../../../domain/storage/schema';
import type { Cents, EpochMs, ItemId, Lane, TrackedItem } from '../../../domain/types';
import type { JobStep, StepOutcome } from '../../../domain/watches/schema';
import { SgwApiError } from '../../../ports/errors';
import type { Notification } from '../../../ports/notifier';
import type { SgwApi } from '../../../ports/sgw-api';
import type { BackgroundContext } from '../../context';
import { syncFor } from '../calendar-sync';
import { deferAlarm } from '../deferred-alarms';
import { itemUrl, plainText, quietHoursEnd, truncateTitle } from '../notify';
import { getSnipeRunner } from '../snipe-runner';

/** A decided tracked/calendar outcome (TrackedItem.outcome minus 'unknown'). */
export type OutcomeKind = 'won' | 'lost' | 'ended-early';

/** The outcome notification: OS notification id and deferral alarm name share this prefix. */
export const OUTCOME_NOTIFY_PREFIX = 'sbw:notify:outcome:';

/** The audit kind whose presence means the outcome notification was handled (never send twice, R6). */
const NOTIFY_OUTCOME_KIND = 'notify.outcome';
const AUDIT_PAGE = 200;

/** A tracked item whose outcome is decided (R2: never read such an item again). */
export function decidedOutcome(t: Pick<TrackedItem, 'outcome'>): t is TrackedItem & { outcome: OutcomeKind } {
  return t.outcome === 'won' || t.outcome === 'lost' || t.outcome === 'ended-early';
}

const STAMPED_OUTCOMES: ReadonlySet<string> = new Set<OutcomeKind>(['won', 'lost', 'ended-early']);

/** The outcome recorded on a calendar link by CalendarSink.stamp (`stamped:<outcome>`). */
export function stampedOutcome(hash: string): OutcomeKind | undefined {
  const m = /^stamped:([a-z-]+)$/.exec(hash);
  const outcome = m?.[1];
  return outcome !== undefined && STAMPED_OUTCOMES.has(outcome) ? (outcome as OutcomeKind) : undefined;
}

/** A loss inferred from the price alone: what the copy may say about it. */
export interface OverMax {
  maxBid: Cents;
  /** Absent when the price was never recorded (a crash-recovered stamp). */
  finalPrice?: Cents;
}

/** The reducer's `why` for a snipe skipped because the user already led (T-80's verify-failed). */
const ALREADY_HIGH_WHY = 'verify-failed: already-high';

/**
 * The max the over-max rule may compare the final price with, or undefined
 * when the rule does not apply. The rule ("final price above every max →
 * lost") is sound only when the user's bids were our snipes: a dry run is not
 * a bid, and a snipe skipped because the user already led proves a bid
 * ShopBadwill never saw.
 */
export function overMaxLimit(snipes: readonly Snipe[]): Cents | undefined {
  if (snipes.some((s) => s.history.some((h) => h.why === ALREADY_HIGH_WHY))) return undefined;
  let max = 0;
  for (const s of snipes) if (!s.dryRun && s.maxBid > max) max = s.maxBid;
  return max > 0 ? max : undefined;
}

/**
 * The OS notification for one outcome. Plain text. A loss inferred from the
 * price says only that (ShopBadwill cannot see bids placed on SGW directly),
 * never "you did not win".
 */
export function outcomeNotification(t: TrackedItem, outcome: OutcomeKind, overMax?: OverMax): Notification {
  const title = truncateTitle(t.title, 50);
  const url = itemUrl(t.itemId);
  if (outcome === 'lost' && overMax !== undefined) {
    const price = overMax.finalPrice === undefined ? 'The final price was' : `The final price, ${formatMoney(overMax.finalPrice)}, was`;
    return {
      id: OUTCOME_NOTIFY_PREFIX + String(t.itemId),
      title: `Over your max: ${title}`,
      message: `${price} above your max of ${formatMoney(overMax.maxBid)}. ${url}`,
      priority: 1,
      openUrlOnClick: url,
    };
  }
  const heading = outcome === 'won' ? 'WON' : outcome === 'lost' ? 'LOST' : 'ENDED EARLY';
  const message =
    outcome === 'won'
      ? `You won this auction. ${url}`
      : outcome === 'lost'
        ? `You did not win this auction. ${url}`
        : `The auction ended before any bid could be placed. ${url}`;
  return {
    id: OUTCOME_NOTIFY_PREFIX + String(t.itemId),
    title: `${heading}: ${title}`,
    message,
    priority: 1,
    openUrlOnClick: url,
  };
}

/** Sets `tracked.outcome` and audits it. Idempotent: an already decided item is left alone. */
export async function recordOutcome(
  repo: Repo,
  audit: Pick<AuditLog, 'append'>,
  itemId: ItemId,
  outcome: TrackedItem['outcome'],
  details: Record<string, string | number | boolean | null>,
): Promise<void> {
  await repo.update(STORAGE_KEYS.tracked, (cur) => {
    const t = cur[itemId];
    if (t === undefined || decidedOutcome(t)) return cur;
    return { ...cur, [itemId]: { ...t, outcome, updatedAt: repo.now() } };
  });
  await audit.append({ actor: 'daily-job', kind: 'outcome.recorded', itemId, details: { outcome: outcome ?? 'unknown', ...details } });
}

/**
 * Why a recorded loss is a loss, for its copy. The newest `outcome.recorded`
 * row says so (`basis`). A row without one is a crash-recovered stamp: with a
 * usable snipe max, a post-end loss can only have come from the over-max rule
 * (the background read is anonymous, C6), so the copy says that, without a price.
 */
async function lossBasis(ctx: BackgroundContext, itemId: ItemId): Promise<OverMax | undefined> {
  let before: number | undefined;
  let row: Record<string, unknown> | undefined;
  while (row === undefined) {
    const page = await ctx.audit.list({ limit: AUDIT_PAGE, kinds: ['outcome.recorded'], ...(before === undefined ? {} : { before }) });
    row = page.find((e) => e.itemId === itemId)?.details;
    const last = page.at(-1);
    if (page.length < AUDIT_PAGE || last === undefined) break;
    before = last.seq;
  }
  if (row?.basis === 'over-max' && typeof row.maxBid === 'number') {
    return { maxBid: row.maxBid, ...(typeof row.finalPrice === 'number' ? { finalPrice: row.finalPrice } : {}) };
  }
  if (row?.basis !== undefined) return undefined;
  const snipes = Object.values(await ctx.repo.get(STORAGE_KEYS.snipes)).filter((s) => s.itemId === itemId && s.state !== 'draft');
  const maxBid = overMaxLimit(snipes);
  return maxBid === undefined ? undefined : { maxBid };
}

/** Whether a `notify.outcome` row for the item exists (the never-twice marker, R6). */
async function alreadyNotified(audit: Pick<AuditLog, 'list'>, itemId: ItemId): Promise<boolean> {
  let before: number | undefined;
  for (;;) {
    const page = await audit.list({ limit: AUDIT_PAGE, kinds: [NOTIFY_OUTCOME_KIND], ...(before === undefined ? {} : { before }) });
    if (page.some((e) => e.itemId === itemId)) return true;
    const last = page.at(-1);
    if (page.length < AUDIT_PAGE || last === undefined) return false;
    before = last.seq;
  }
}

/**
 * Sends (or defers) the one outcome notification, through T-56's gates: the
 * notifications setting, the optional `notifications` permission, and quiet
 * hours (deferred by an alarm that carries the item id; the handler rebuilds
 * the copy from the persisted tracked outcome). The `notify.outcome` marker
 * row is written BEFORE the send, so a restart can never send it twice (R6).
 */
export async function notifyOutcome(
  ctx: BackgroundContext,
  itemId: ItemId,
  outcome: OutcomeKind,
): Promise<'sent' | 'deferred' | 'skipped' | 'failed'> {
  const { repo, audit, notifier, permissions, alarms, clock } = ctx;
  const settings = await repo.get(STORAGE_KEYS.settings);
  if (!settings.notifications.enabled) return 'skipped';
  if (await alreadyNotified(audit, itemId)) return 'skipped';
  let ok: boolean;
  try {
    ok = await permissions.contains({ permissions: ['notifications'] });
  } catch {
    ok = false;
  }
  if (!ok) {
    await audit.append({ actor: 'daily-job', kind: 'notify.skipped', itemId, details: { why: 'notifications permission not granted' } });
    return 'skipped';
  }
  const tracked = await repo.get(STORAGE_KEYS.tracked);
  const t = tracked[itemId];
  if (t === undefined) return 'skipped';
  const until = quietHoursEnd(clock.now(), settings.notifications.quietHours, settings.locale.timeZone);
  if (until !== null) {
    await deferAlarm({ repo, alarms }, OUTCOME_NOTIFY_PREFIX + String(itemId), until); // T-118 (L6): survives a dropped alarm
    return 'deferred';
  }
  const overMax = outcome === 'lost' ? await lossBasis(ctx, itemId) : undefined;
  await audit.append({ actor: 'daily-job', kind: NOTIFY_OUTCOME_KIND, itemId, details: { outcome } });
  try {
    await notifier.notify(outcomeNotification(t, outcome, overMax));
    return 'sent';
  } catch (e) {
    await audit.append({
      actor: 'daily-job',
      kind: 'notify.failed',
      itemId,
      details: { error: plainText(e instanceof Error ? e.message : String(e)).slice(0, 200) },
    });
    return 'failed';
  }
}

/** A deferred outcome notification alarm fired: re-send from the persisted tracked outcome. */
export async function onOutcomeAlarm(ctx: BackgroundContext, itemId: ItemId): Promise<void> {
  const tracked = await ctx.repo.get(STORAGE_KEYS.tracked);
  const t = tracked[itemId];
  if (t === undefined) return;
  if (!decidedOutcome(t)) return;
  await notifyOutcome(ctx, itemId, t.outcome);
}

/** The calendar stamp (R7): a blocked Google write is skipped and audited; the sync stamps later from the recorded outcome. */
async function stampOutcome(ctx: BackgroundContext, itemId: ItemId, outcome: OutcomeKind, finalPrice?: Cents): Promise<void> {
  try {
    await syncFor(ctx).sink.stamp(itemId, outcome, finalPrice);
  } catch (e) {
    await ctx.audit.append({
      actor: 'daily-job',
      kind: 'outcome.stamp-skipped',
      itemId,
      details: { why: plainText(e instanceof Error ? e.message : String(e)).slice(0, 200) },
    });
  }
}

/** What the executor needs: a structural subset of T-52's StepDeps (no run: postEnd steps are not part of a JobRun). */
export interface PostEndDeps {
  api: Pick<SgwApi, 'itemDetail'>;
  repo: Repo;
  audit: Pick<AuditLog, 'append'>;
  lane: Lane;
  ctx: BackgroundContext;
}

const MID_FLIGHT: ReadonlySet<Snipe['state']> = new Set(['firing', 'sent', 'fallback-applied']);
const PRE_FIRE: ReadonlySet<Snipe['state']> = new Set(['armed', 'waking', 'verified']);

/**
 * The existing reducer event that ends a pre-fire snipe because the auction
 * closed (R4). `preflight-failed` is accepted only from `armed`; `waking` and
 * `verified` reject it (`step-passed`). `verify-failed` is what ends those.
 */
function endedEvent(s: Snipe, now: EpochMs): SnipeEvent | undefined {
  if (s.state === 'armed') return { type: 'preflight-failed', now, reason: 'ended' };
  if (s.state === 'waking' || s.state === 'verified') return { type: 'verify-failed', now, reason: 'ended' };
  return undefined;
}

export async function executePostEnd(step: JobStep, deps: PostEndDeps): Promise<StepOutcome> {
  if (step.kind !== 'postEnd') {
    return { kind: 'error', message: `step skipped: postEnd executor got a '${step.kind}' step`, retryable: false };
  }
  const { itemId } = step;
  const { repo, audit, ctx } = deps;

  // R7: SGW reads obey the kill switch (the adapter gates only writes).
  const settings = await repo.get(STORAGE_KEYS.settings);
  if (settings.killSwitch) throw new SgwApiError('paused', 'the kill switch is on');

  // R2: exactly one read, on lane `background` (the caller scans the due items).
  const detail = await deps.api.itemDetail(itemId, deps.lane);

  const tracked = await repo.get(STORAGE_KEYS.tracked);
  const t = tracked[itemId];
  if (t === undefined || decidedOutcome(t)) return { kind: 'postEnd', detail };

  // Still running. An end that moved into the future is waited out (one read
  // after the new end). An end that is already due is not polled again: the
  // final `outcome.still-open` row is the "read done for this end" mark.
  // Exactly one row per read: outcomes.ts counts them against MAX_POST_END_READS.
  if (!detail.isClosed) {
    const newEndMs = new Date(detail.endTime).getTime();
    const moved = newEndMs !== new Date(t.endTime).getTime();
    if (moved) {
      await repo.update(STORAGE_KEYS.tracked, (cur) => {
        const curItem = cur[itemId];
        return curItem === undefined ? cur : { ...cur, [itemId]: { ...curItem, endTime: detail.endTime, updatedAt: repo.now() } };
      });
    }
    const endTime = moved ? detail.endTime : t.endTime;
    await audit.append({
      actor: 'daily-job',
      kind: 'outcome.still-open',
      itemId,
      details: newEndMs > repo.now() ? { endTime } : { endTime, final: true },
    });
    return { kind: 'postEnd', detail };
  }

  const snipes = Object.values(await repo.get(STORAGE_KEYS.snipes)).filter(
    (s) => s.itemId === itemId && s.state !== 'draft',
  );
  // A send may be out: the T-84 runner owns the outcome. Retried on a later tick.
  if (snipes.some((s) => MID_FLIGHT.has(s.state))) return { kind: 'postEnd', detail };

  const preFire = snipes.filter((s) => PRE_FIRE.has(s.state));
  if (preFire.length > 0) {
    // R4: the auction closed before the snipe could fire. Move each pre-fire snipe
    // with the existing event for its state (the reducer resolves it `ended`,
    // whose effects stamp ENDED EARLY and notify).
    const runner = getSnipeRunner(ctx);
    const now = repo.now();
    let moved = 0;
    for (const s of preFire) {
      const event = endedEvent(s, now);
      if (event === undefined) continue;
      const r = await runner?.endedEarly(s.id, event);
      if (r !== undefined && r.kind === 'accepted') moved += 1;
    }
    if (runner === undefined) {
      // No runner (never in production): leave the snipe alone (R4) and cover
      // the stamp and the notification ourselves.
      await stampOutcome(ctx, itemId, 'ended-early');
      await recordOutcome(repo, audit, itemId, 'ended-early', { from: 'read' });
      await notifyOutcome(ctx, itemId, 'ended-early');
      return { kind: 'postEnd', detail };
    }
    if (moved !== preFire.length) {
      // A dispatch was refused (the state moved): record nothing; the runner
      // settles the snipe and a later tick records its outcome.
      return { kind: 'postEnd', detail };
    }
    await recordOutcome(repo, audit, itemId, 'ended-early', { from: 'read' });
    // The snipe path stamps and notifies through its effects; mark the obligation handled (R6).
    await audit.append({ actor: 'daily-job', kind: NOTIFY_OUTCOME_KIND, itemId, details: { outcome: 'ended-early', via: 'snipe' } });
    return { kind: 'postEnd', detail };
  }

  // No live snipe: the read decides. The background read is anonymous (C6:
  // isHighBidder is null), so it can prove a win only with the high-bidder
  // flag, and a loss only by the over-max rule (final price above the user's
  // max; see overMaxLimit for when that rule holds). Anything else is unknown.
  // First, though: the calendar link's stamp record (R3) may already carry the
  // outcome of a postEnd run that crashed between its stamp and this recording —
  // trust the persisted record over the anonymous read (the stamp is the proof).
  const stamped = stampedOutcome((await repo.get(STORAGE_KEYS.calendar)).links[itemId]?.lastSyncedHash ?? '');
  const high = detail.isHighBidder;
  let outcome: TrackedItem['outcome'];
  let basis: Record<string, string | number> = {};
  if (stamped !== undefined) {
    outcome = stamped;
  } else if (high === true || high === false) {
    outcome = high ? 'won' : 'lost';
    basis = { basis: 'high-bidder' };
  } else {
    const maxBid = overMaxLimit(snipes);
    outcome = maxBid !== undefined && detail.currentPrice > maxBid ? 'lost' : 'unknown';
    if (outcome === 'lost' && maxBid !== undefined) basis = { basis: 'over-max', maxBid };
  }

  if (outcome === 'won' || outcome === 'lost') {
    if (stamped === undefined) await stampOutcome(ctx, itemId, outcome, detail.currentPrice);
    await recordOutcome(repo, audit, itemId, outcome, { from: 'read', finalPrice: detail.currentPrice, ...basis });
    await notifyOutcome(ctx, itemId, outcome);
  } else {
    await recordOutcome(repo, audit, itemId, 'unknown', { from: 'read' });
  }
  return { kind: 'postEnd', detail };
}

/** R1: the shape T-52's step registry loads. */
export default { kind: 'postEnd' as const, run: executePostEnd };
