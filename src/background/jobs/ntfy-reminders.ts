// T-69: registers the ntfy ReminderSink (T-67's I-34 seam) and re-offers
// deferred reminders after every daily job run. Self-registering through the
// jobs glob (I-01): main.ts, calendar-sync.ts and wxt.config.ts stay untouched.
//
// The sink is fed by calendar sync's feedSinks (changed events, removals, dry
// run and kill switch gated). One gap: feedSinks skips events whose hash did
// not change, so a reminder deferred because it was more than 3 days out would
// never be re-offered once it enters the window. R1's "calendar sync calls
// upsert again after every daily job run" is therefore implemented here: when a
// job run finishes, every open desired event with a deferred entry is re-offered
// to the sink (idempotent — unchanged events publish nothing again). No alarm
// of its own.
import { EMPTY_NTFY_STATE, NtfySink, type NtfyStore } from '../../adapters/ntfy/ntfy-sink';
import { STORAGE_KEYS } from '../../domain/storage/schema';
import type { BackgroundContext } from '../context';
import { buildDesired, registerReminderSink } from './calendar-sync';

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

  const promoteDeferred = (): void => {
    void (async () => {
      try {
        const settings = await ctx.repo.get(STORAGE_KEYS.settings);
        if (!settings.calendar.enabled) return;
        const ntfyState = await ctx.repo.find(STORAGE_KEYS.ntfy);
        const hasDeferred = Object.values(ntfyState?.items ?? {}).some((i) =>
          i.entries.some((x) => x.status === 'deferred'),
        );
        if (!hasDeferred) return;
        // The same outbound-write gates calendar sync's feedSinks applies.
        if (settings.killSwitch || settings.dryRun.calendar) return;
        const verdict = await ctx.switches.writesAllowed('calendar');
        if (!verdict.ok) return;
        const [tracked, calendar] = await Promise.all([
          ctx.repo.get(STORAGE_KEYS.tracked),
          ctx.repo.get(STORAGE_KEYS.calendar),
        ]);
        const desired = buildDesired(tracked, calendar.links, settings, ctx.repo.now());
        for (const e of desired) {
          if (e.privateProps.sbwState !== 'open') continue;
          await sink.upsert(e); // never throws (R8)
        }
      } catch {
        // Never audit the error text: it could embed the topic (R3).
        await ctx.audit
          .append({ actor: 'calendar', kind: 'ntfy.promote.failed', details: { reason: 're-offer failed' } })
          .catch(() => undefined);
      }
    })();
  };

  // A job run reached done/failed: re-offer deferred reminders (mirrors
  // calendar-sync.register's own job-run trigger).
  let lastRunSynced: string | undefined;
  ctx.storage.local.onChanged((changes) => {
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
    promoteDeferred();
  });

  // A restart can land days later; re-offer at startup too (still no alarm).
  ctx.lifecycle.onStartup(promoteDeferred);
}
