// T-67: `calendar.*` handlers (connect, disconnect, status, syncNow, ics) and the
// `deleteEvent` undo executor. Registered through register(ctx) (T-36, I-01).
//
// calendar.connect is a user gesture: it runs the Google consent (T-62) and then
// starts a sync in the background (not awaited: the reply is the new status).
// calendar.ics is the zero-auth fallback (I-10): it builds the .ics from tracked
// items with T-68's buildIcs, and needs no Google at all.
//
// Undo ref format (documented in docs/CONTRACT-DECISIONS.md): an audit entry
// `calendar.insert` carries `undo: { kind: 'deleteEvent', ref: 'deleteEvent:<itemId>:<eventId>' }`.
// Undo turns `tracked[itemId].calendar` off FIRST (so a sync that runs meanwhile
// cannot put the event back), then deletes the event through the sink (the
// ownership guard and the dry-run / kill / cooldown gates apply). A refusal
// restores the flag and is "not now: ...". Google not connected is refused
// before any call. Running it again is a no-op.
import { parseDeleteEventRef } from '../../adapters/google/calendar-sink';
import { buildIcs } from '../../domain/calendar/ics';
import { STORAGE_KEYS } from '../../domain/storage/schema';
import type { BackgroundContext } from '../context';
import { buildDesired, syncFor } from '../jobs/calendar-sync';
import type { Handler } from '../router';
import type { UndoExecutor } from './audit';

type CalendarHandlers = {
  'calendar.connect': Handler<'calendar.connect'>;
  'calendar.disconnect': Handler<'calendar.disconnect'>;
  'calendar.status': Handler<'calendar.status'>;
  'calendar.syncNow': Handler<'calendar.syncNow'>;
  'calendar.ics': Handler<'calendar.ics'>;
};

export function createCalendarHandlers(ctx: BackgroundContext): CalendarHandlers {
  return {
    'calendar.connect': async () => {
      const status = await ctx.google.connect();
      void syncFor(ctx)
        .syncNow('connect')
        .catch(() => undefined);
      return status;
    },
    'calendar.disconnect': async () => {
      await ctx.google.disconnect();
      return undefined;
    },
    'calendar.status': () => ctx.google.status(),
    'calendar.syncNow': async () => {
      await syncFor(ctx).syncNow('user');
      return undefined;
    },
    'calendar.ics': async (p) => {
      const [settings, tracked, calendar] = await Promise.all([
        ctx.repo.get(STORAGE_KEYS.settings),
        ctx.repo.get(STORAGE_KEYS.tracked),
        ctx.repo.get(STORAGE_KEYS.calendar),
      ]);
      const now = ctx.repo.now();
      const events = buildDesired(tracked, calendar.links, settings, now, { withPrice: true, only: p.itemIds });
      return { ics: buildIcs(events, { nowUtc: new Date(now).toISOString() }) };
    },
  };
}

/** T-58's audit undo map entry for `deleteEvent`. */
export function createCalendarUndoExecutors(ctx: BackgroundContext): { deleteEvent: UndoExecutor } {
  return {
    deleteEvent: async (ref) => {
      const parsed = parseDeleteEventRef(ref);
      if (parsed === undefined) throw new Error('This entry has no valid calendar event to undo.');
      const link = (await ctx.repo.get(STORAGE_KEYS.calendar)).links[parsed.itemId];
      if (link === undefined || link.status === 'deleted') {
        await setCalendarFlag(ctx, parsed.itemId, false);
        return; // already gone
      }
      if (link.eventId !== parsed.eventId) throw new Error('That calendar event has changed since; nothing was undone.');
      const auth = await ctx.google.status();
      if (!auth.connected || auth.needsInteraction) throw new Error('not now: Google Calendar is not connected. Connect it, then undo again.');
      const wasOn = await setCalendarFlag(ctx, parsed.itemId, false);
      try {
        await syncFor(ctx).sink.remove(parsed.itemId);
      } catch (e) {
        if (wasOn) await setCalendarFlag(ctx, parsed.itemId, true);
        throw new Error(`not now: ${e instanceof Error ? e.message : String(e)}`, { cause: e });
      }
    },
  };
}

/** Sets `tracked[itemId].calendar`. Returns whether it was on before. */
async function setCalendarFlag(ctx: BackgroundContext, itemId: number, on: boolean): Promise<boolean> {
  let was = false;
  await ctx.repo.update(STORAGE_KEYS.tracked, (cur) => {
    const t = cur[itemId];
    was = t?.calendar === true;
    return t === undefined || t.calendar === on ? cur : { ...cur, [itemId]: { ...t, calendar: on, updatedAt: ctx.repo.now() } };
  });
  return was;
}

/** T-36 self-registration (I-01). */
export function register(ctx: BackgroundContext): void {
  const h = createCalendarHandlers(ctx);
  ctx.router.register('calendar.connect', h['calendar.connect']);
  ctx.router.register('calendar.disconnect', h['calendar.disconnect']);
  ctx.router.register('calendar.status', h['calendar.status']);
  ctx.router.register('calendar.syncNow', h['calendar.syncNow']);
  ctx.router.register('calendar.ics', h['calendar.ics']);
}
