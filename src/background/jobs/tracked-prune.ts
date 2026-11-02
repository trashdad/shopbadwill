// T-129: ended auctions fall off the extension. A tracked item is deleted
// from `sbw:tracked` once its outcome is recorded, or PRUNE_AFTER_END_MS after
// its end, whichever comes first, with these holds (planPrune):
//   - a snipe of the item that is not finished (any state but resolved or
//     killed) keeps it, whatever else holds;
//   - an item the outcome scan still owes a read (outcomes.ts: one with a
//     snipe or a calendar event and no recorded outcome) keeps it past the 6
//     hours: the read ends in a recorded outcome, at the latest the read cap's
//     `unknown`, and then the item goes;
//   - a snipe of the item whose effects the runner has not run yet (its
//     `sbw:snipeRunner` outbox: the calendar stamp, the notification) keeps it;
//   - a deferred outcome notification (quiet hours) keeps it: its alarm
//     rebuilds the copy from the tracked item;
//   - an ntfy reminder still scheduled to fire keeps it (dropping it locally
//     would leave the push on the server).
//
// A prune is local only: no SGW, Google or ntfy request. The item's Google
// Calendar event is NOT deleted (a past event is harmless history): the
// calendar sink forgets its link and bookkeeping first (CalendarSink.forget),
// so no sync can delete, patch or re-create that event, and only then is the
// item deleted. The item's ntfy record is dropped without a cancel request
// (its reminders have all fired). One `tracked.prune` audit row per pass, with
// the count, never one per item.
//
// It runs where the outcome work already wakes: at the end of every outcomes
// tick (so right after an outcome is recorded) and at browser start. Every
// run, the outcomes tick and the deferred outcome notification share one
// per-context queue (withOutcomeLock), so a prune never lands between an
// outcome being recorded and its notification reading the item.
import type { CalendarLink } from '../../domain/calendar/types';
import type { Snipe, SnipeState } from '../../domain/snipe/types';
import { STORAGE_KEYS, type NtfyState, type SnipeRunnerRecord } from '../../domain/storage/schema';
import type { EpochMs, ItemId, TrackedItem } from '../../domain/types';
import type { BackgroundContext } from '../context';
import { syncFor } from './calendar-sync';
import { OUTCOME_NOTIFY_PREFIX } from './steps/post-end';

/** Without a recorded outcome, an item goes this long after its end. */
export const PRUNE_AFTER_END_MS = 6 * 60 * 60_000;

/** The audit kind of a prune pass (one row per pass). */
export const PRUNE_AUDIT_KIND = 'tracked.prune';

const FINISHED: ReadonlySet<SnipeState> = new Set(['resolved', 'killed']);

/**
 * outcomes.ts's scope: the outcome scan reads an item after its end only when
 * it has a (non-draft) snipe or a calendar event. Shared, so the prune never
 * runs ahead of a read the scan still owes.
 */
export function inOutcomeScope(t: Pick<TrackedItem, 'calendar'>, itemSnipes: readonly Snipe[], link: CalendarLink | undefined): boolean {
  return itemSnipes.some((s) => s.state !== 'draft') || t.calendar || (link !== undefined && link.status !== 'deleted');
}

export interface PruneInput {
  tracked: Readonly<Record<number, TrackedItem>>;
  snipes: Readonly<Record<string, Snipe>>;
  links: Readonly<Record<number, CalendarLink>>;
  /** `sbw:deferredAlarms`: alarm name -> when. */
  deferredAlarms: Readonly<Record<string, number>>;
  /** `sbw:ntfy` items (absent: nothing scheduled). */
  ntfy?: NtfyState['items'];
  /** `sbw:snipeRunner` entries (absent: no effect pending). */
  runner?: SnipeRunnerRecord['entries'];
  now: EpochMs;
}

/** The items a prune pass deletes, ascending. Pure over the persisted records. */
export function planPrune(input: PruneInput): ItemId[] {
  const { now } = input;
  const byItem = new Map<ItemId, Snipe[]>();
  for (const s of Object.values(input.snipes)) {
    const list = byItem.get(s.itemId);
    if (list === undefined) byItem.set(s.itemId, [s]);
    else list.push(s);
  }
  const out: ItemId[] = [];
  for (const t of Object.values(input.tracked)) {
    const itemSnipes = byItem.get(t.itemId) ?? [];
    if (itemSnipes.some((s) => !FINISHED.has(s.state))) continue;
    // The runner still owes this snipe effects (its stamp, its notification).
    if (itemSnipes.some((s) => (input.runner?.[s.id]?.outbox.length ?? 0) > 0)) continue;
    if (t.outcome === undefined) {
      const endMs = new Date(t.endTime).getTime();
      if (Number.isNaN(endMs) || now < endMs + PRUNE_AFTER_END_MS) continue;
      // An outcome read is still owed: it records an outcome, then the item goes.
      if (inOutcomeScope(t, itemSnipes, input.links[t.itemId])) continue;
    }
    if (input.deferredAlarms[OUTCOME_NOTIFY_PREFIX + String(t.itemId)] !== undefined) continue;
    if ((input.ntfy?.[t.itemId]?.entries ?? []).some((e) => e.status === 'scheduled' && e.fireAt > now)) continue;
    out.push(t.itemId);
  }
  return out.sort((a, b) => a - b);
}

/** One prune pass. Returns how many items it deleted. Call it inside withOutcomeLock. */
export async function pruneTracked(ctx: BackgroundContext): Promise<number> {
  const { repo } = ctx;
  const [tracked, snipes, calendar, deferredAlarms, ntfy, runner] = await Promise.all([
    repo.get(STORAGE_KEYS.tracked),
    repo.get(STORAGE_KEYS.snipes),
    repo.get(STORAGE_KEYS.calendar),
    repo.get(STORAGE_KEYS.deferredAlarms),
    repo.find(STORAGE_KEYS.ntfy),
    repo.find(STORAGE_KEYS.snipeRunner),
  ]);
  const ids = planPrune({
    tracked,
    snipes,
    links: calendar.links,
    deferredAlarms,
    ...(ntfy === undefined ? {} : { ntfy: ntfy.items }),
    ...(runner === undefined ? {} : { runner: runner.entries }),
    now: ctx.clock.now(),
  });
  if (ids.length === 0) return 0;
  const keys = new Set(ids.map(String));

  // The calendar first: once its link is forgotten no sync can delete the event
  // when the item disappears, nor touch it with what it read before.
  await syncFor(ctx).sink.forget(ids);

  let count = 0;
  await repo.update(STORAGE_KEYS.tracked, (cur) => {
    count = Object.keys(cur).filter((k) => keys.has(k)).length;
    return count === 0 ? cur : Object.fromEntries(Object.entries(cur).filter(([k]) => !keys.has(k)));
  });

  // The ntfy record, dropped locally (the same lock the ntfy sink's store takes).
  if (ntfy !== undefined && Object.keys(ntfy.items).some((k) => keys.has(k))) {
    await repo.withLock(STORAGE_KEYS.ntfy, async () => {
      const cur = await repo.find(STORAGE_KEYS.ntfy);
      if (cur === undefined || !Object.keys(cur.items).some((k) => keys.has(k))) return;
      await repo.set(STORAGE_KEYS.ntfy, { ...cur, items: Object.fromEntries(Object.entries(cur.items).filter(([k]) => !keys.has(k))) });
    });
  }

  if (count > 0) await ctx.audit.append({ actor: 'system', kind: PRUNE_AUDIT_KIND, details: { count } });
  return count;
}

const QUEUES = new WeakMap<BackgroundContext, Promise<unknown>>();

/** Runs `fn` after every earlier one queued for this context (the outcomes tick, a prune, a deferred outcome notice). */
export function withOutcomeLock<T>(ctx: BackgroundContext, fn: () => Promise<T>): Promise<T> {
  const run = (QUEUES.get(ctx) ?? Promise.resolve()).then(fn);
  QUEUES.set(
    ctx,
    run.catch(() => undefined),
  );
  return run;
}

/** T-36 self-registration (I-01): a prune at browser start. The tick's prune runs in outcomes.ts. */
export function register(ctx: BackgroundContext): void {
  ctx.lifecycle.onStartup(() => {
    void withOutcomeLock(ctx, () => pruneTracked(ctx)).catch((e: unknown) => {
      console.error('[ShopBadwill] tracked prune: the startup pass failed', e);
    });
  });
}
