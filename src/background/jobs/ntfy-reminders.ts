// T-69: registers the ntfy ReminderSink (T-67's I-34 seam) and reconciles it.
// Self-registering through the jobs glob (I-01): main.ts, calendar-sync.ts and
// wxt.config.ts stay untouched. No alarm of its own.
//
// The sink is fed by calendar sync's feedSinks (changed events, removals, dry
// run and kill switch gated). feedSinks records an item's hash as soon as
// upsert resolves, and the sink never rejects (R8), so an unchanged item is
// offered once. What the sink could not finish then is picked up here by one
// idempotent pass (NtfySink.reconcile) that re-offers every open event and
// removes stored items that are no longer open:
//   - after every job run (R1's daily re-call: deferred reminders that came
//     inside the 3-day window, and anything a 429/5xx cut short);
//   - at browser start;
//   - when the ntfy settings change (turned on, or a new topic after the
//     options page cancelled and cleared the old one);
//   - on a scheduler tick, only while the sink last stopped for a missing host
//     permission and the permission is now granted (there is no onAdded port).
// A pass makes no request when nothing is owed, and none at all while the gate
// (R2) is closed.
import { EMPTY_NTFY_STATE, NTFY_ORIGIN, NtfySink, type NtfyStore } from '../../adapters/ntfy/ntfy-sink';
import { STORAGE_KEYS } from '../../domain/storage/schema';
import type { BackgroundContext } from '../context';
import { buildDesired, registerReminderSink } from './calendar-sync';

/** The ntfy group of a stored settings value, for change detection only (never logged). */
function ntfyGroup(settings: unknown): string {
  if (typeof settings !== 'object' || settings === null || !('ntfy' in settings)) return '';
  return JSON.stringify(settings.ntfy);
}

export function register(ctx: BackgroundContext): void {
  const store: NtfyStore = {
    load: async () => (await ctx.repo.find(STORAGE_KEYS.ntfy)) ?? structuredClone(EMPTY_NTFY_STATE),
    update: (fn) =>
      ctx.repo.withLock(STORAGE_KEYS.ntfy, async () => {
        const cur = (await ctx.repo.find(STORAGE_KEYS.ntfy)) ?? structuredClone(EMPTY_NTFY_STATE);
        const next = fn(cur);
        await ctx.repo.set(STORAGE_KEYS.ntfy, next);
        return next;
      }),
  };
  const sink = new NtfySink({
    http: ctx.http,
    clock: ctx.clock,
    permissions: ctx.permissions,
    audit: ctx.audit,
    settings: async () => {
      const s = await ctx.repo.get(STORAGE_KEYS.settings);
      return { ntfy: s.ntfy, timeZone: s.locale.timeZone };
    },
    store,
  });
  registerReminderSink(sink);

  const reconcileOnce = async (): Promise<void> => {
    try {
      const settings = await ctx.repo.get(STORAGE_KEYS.settings);
      // The same gates as calendar sync's feedSinks: the sink is fed only while
      // calendar sync runs, and it is an outbound write.
      if (!settings.calendar.enabled) return;
      if (settings.killSwitch || settings.dryRun.calendar) return;
      const verdict = await ctx.switches.writesAllowed('calendar');
      if (!verdict.ok) return;
      await sink.reconcile(async () => {
        const [tracked, calendar] = await Promise.all([
          ctx.repo.get(STORAGE_KEYS.tracked),
          ctx.repo.get(STORAGE_KEYS.calendar),
        ]);
        return buildDesired(tracked, calendar.links, settings, ctx.repo.now()).filter(
          (e) => e.privateProps.sbwState === 'open',
        );
      }); // never throws (R8)
    } catch {
      // Never audit the error text: it could embed the topic (R3).
      await ctx.audit
        .append({ actor: 'calendar', kind: 'ntfy.reconcile.failed', details: { reason: 're-offer failed' } })
        .catch(() => undefined);
    }
  };

  // One pass at a time; triggers during a pass cause exactly one more.
  let running = false;
  let again = false;
  const takeAgain = (): boolean => {
    const was = again;
    again = false;
    return was;
  };
  const reconcile = (): void => {
    if (running) {
      again = true;
      return;
    }
    running = true;
    void (async () => {
      do {
        await reconcileOnce();
      } while (takeAgain());
      running = false;
    })();
  };

  let lastRunSynced: string | undefined;
  ctx.storage.local.onChanged((changes) => {
    const settings = changes[STORAGE_KEYS.settings];
    if (settings !== undefined && ntfyGroup(settings.oldValue) !== ntfyGroup(settings.newValue)) reconcile();

    // A job run reached done/failed (mirrors calendar-sync.register's own trigger).
    const runs = changes[STORAGE_KEYS.jobRuns]?.newValue;
    if (!Array.isArray(runs)) return;
    let newest: { id: string; at: number } | undefined;
    for (const r of runs as Array<{ id?: unknown; status?: unknown; finishedAt?: unknown }>) {
      if ((r.status !== 'done' && r.status !== 'failed') || typeof r.id !== 'string') continue;
      const at = typeof r.finishedAt === 'number' ? r.finishedAt : 0;
      if (newest === undefined || at >= newest.at) newest = { id: r.id, at };
    }
    const id = newest?.id;
    if (id === undefined || id === lastRunSynced) return;
    lastRunSynced = id;
    reconcile();
  });

  // A restart can land days later.
  ctx.lifecycle.onStartup(reconcile);

  // The permission is granted from the options page, and no port reports that.
  // A tick looks only while the sink last stopped for it, so failed publishes
  // are never retried every tick (they wait for the next job run).
  ctx.ticks.onTick(async () => {
    try {
      if ((await ctx.repo.find(STORAGE_KEYS.ntfy))?.status !== 'needs-permission') return;
      if (!(await ctx.permissions.contains({ origins: [NTFY_ORIGIN] }))) return;
      reconcile();
    } catch {
      // Nothing for the tick hub to log.
    }
  });
}
