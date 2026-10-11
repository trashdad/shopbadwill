// T-67: the calendar sync job. Puts each tracked auction's end time on the
// user's dedicated Google Calendar (reminders at 60, 15 and 5 minutes before the
// end), keeps it in sync, and stamps WON / LOST once the outcome is known.
//
// When it runs (all through T-36 self-registration, I-01):
//   - after each job run (a `sbw:jobRuns` entry reaches done/failed);
//   - on `calendar.syncNow` (handlers/calendar.ts);
//   - on `sbw:tracked` changes, debounced 60 s (an alarm, so it survives a
//     worker restart; the first change in a quiet period starts the 60 s);
//   - on every scheduler tick (cheap: no Google call unless an op is due), which
//     is what retries errored links with the reconciler's backoff and resumes a
//     sync a restart cut short;
//   - at browser start.
//
// Nothing here calls Google unless the user has connected: disconnected, desired
// events become `pending` links (no call) and the badge is raised. Reminder
// sinks (ntfy, I-34) are fed from the same desired set, independent of Google.
import { GoogleCalendarSink, RequestLimiter, limitCalendarApi } from '../../adapters/google/calendar-sink';
import type { AuditLog } from '../../domain/audit/types';
import { buildDesiredEvent, hashDesired } from '../../domain/calendar/event-builder';
import { eventIdFor } from '../../domain/calendar/event-id';
import { reconcile, type RecreateStrategy } from '../../domain/calendar/reconciler';
import type { CalendarLink, DesiredEvent } from '../../domain/calendar/types';
import { isLateAdd } from '../../domain/notify/late-add';
import type { Settings } from '../../domain/settings/schema';
import type { Repo } from '../../domain/storage/repo';
import { STORAGE_KEYS } from '../../domain/storage/schema';
import type { EpochMs, ItemId, Listing, TrackedItem } from '../../domain/types';
import type { CalendarApi } from '../../ports/calendar';
import type { Clock } from '../../ports/clock';
import type { GlobalSwitches } from '../../ports/global-switches';
import type { GoogleAuthProvider } from '../../ports/google-auth';
import type { Notifier } from '../../ports/notifier';
import type { Permissions } from '../../ports/permissions';
import type { Alarms } from '../../ports/alarms';
import type { Storage } from '../../ports/storage';
import type { BackgroundContext } from '../context';
import { LATE_ID_PREFIX, itemUrl, truncateTitle } from './notify';

export const SYNC_ALARM = 'sbw:calendar-sync';
export const DEBOUNCE_MS = 60_000;

// ── Reminder sinks (I-34) ───────────────────────────────────────────────────

/**
 * A place that also wants the 60/15/5-minute reminders (T-69's ntfy). It must be
 * idempotent per item: `upsert` is called again with the same event after a
 * restart, and `remove` for an item that is gone or decided.
 */
export interface ReminderSink {
  readonly name: string;
  upsert(event: DesiredEvent): Promise<void>;
  remove(itemId: ItemId): Promise<void>;
}

const reminderSinks = new Map<string, ReminderSink>();

/** Registers a sink (a later one with the same name replaces it). Returns an unregister function. */
export function registerReminderSink(sink: ReminderSink): () => void {
  reminderSinks.set(sink.name, sink);
  return () => {
    if (reminderSinks.get(sink.name) === sink) reminderSinks.delete(sink.name);
  };
}

// ── Desired events ──────────────────────────────────────────────────────────

/** Tracked items do not keep a price; the builder needs one. It is dropped from the stable description. */
function asListing(t: TrackedItem, now: EpochMs): Listing {
  return {
    itemId: t.itemId,
    title: t.title,
    currentPrice: 0,
    startingMinimumBid: 0,
    numBids: 0,
    endTime: t.endTime,
    endTimeRaw: '1970-01-01T00:00:00',
    sellerId: t.sellerId,
    source: 'api',
    observedAt: now,
  };
}

/**
 * The price changes with every bid and is not what the calendar is for; keeping it
 * would patch the event on every bid. The stable description omits it, so the
 * change hash only moves when the end time, title or outcome does.
 */
function dropPrice(description: string): string {
  return description
    .split('\n')
    .filter((l) => !l.startsWith('Current price:'))
    .join('\n');
}

export interface BuildDesiredOptions {
  /** Keep the "Current price" line (the .ics download). Default: dropped (sync). */
  withPrice?: boolean;
  /** Only these items (the .ics download). */
  only?: readonly ItemId[];
}

/**
 * Desired events: every tracked item with `calendar` on. An auction that already
 * ended with no outcome and no live event is left off (nothing useful to put on a
 * calendar); one with a live event stays, so it can be stamped.
 */
export function buildDesired(
  tracked: Readonly<Record<number, TrackedItem>>,
  links: Readonly<Record<number, CalendarLink>>,
  settings: Settings,
  now: EpochMs,
  opts: BuildDesiredOptions = {},
): DesiredEvent[] {
  const out: DesiredEvent[] = [];
  const only = opts.only === undefined ? undefined : new Set(opts.only);
  for (const t of Object.values(tracked)) {
    if (only !== undefined && !only.has(t.itemId)) continue;
    if (only === undefined && !t.calendar) continue;
    const link = links[t.itemId];
    const live = link !== undefined && link.status !== 'deleted';
    const ended = new Date(t.endTime).getTime() <= now;
    const decided = t.outcome === 'won' || t.outcome === 'lost' || t.outcome === 'ended-early';
    if (ended && !decided && !live && only === undefined) continue;
    const e = buildDesiredEvent(t, asListing(t, now), settings, { generation: link?.generation ?? 0 });
    out.push(opts.withPrice === true ? e : { ...e, description: dropPrice(e.description) });
  }
  return out.sort((a, b) => a.itemId - b.itemId);
}

// ── The sync ────────────────────────────────────────────────────────────────

export type SyncStatus = 'disabled' | 'synced' | 'pending' | 'blocked' | 'cooling-down' | 'needs-reconnect' | 'offline' | 'error';

export interface SyncReport {
  status: SyncStatus;
  /** Ops that changed Google (insert, patch, ...) or, in dry run, would have. */
  changed: number;
  pending: number;
  errors: number;
  detail?: string;
}

export interface CalendarSyncDeps {
  repo: Repo;
  audit: Pick<AuditLog, 'append' | 'list'>;
  clock: Clock;
  storage: Storage;
  api: CalendarApi;
  switches: GlobalSwitches;
  google: Pick<GoogleAuthProvider, 'status'>;
  notifier: Pick<Notifier, 'notify'>;
  permissions: Pick<Permissions, 'contains'>;
  /** The badge owner (T-86 subscribes to the flag). */
  badge: { set(on: boolean): void };
  strategy?: RecreateStrategy;
  /** 0 in tests; production uses the 1 s default. */
  minIntervalMs?: number;
}

/** The local calendar day, `YYYY-MM-DD` (UTC when the zone is unusable). */
export function localDay(now: EpochMs, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(now));
  } catch {
    return new Date(now).toISOString().slice(0, 10);
  }
}

export class CalendarSync {
  readonly sink: GoogleCalendarSink;
  private inFlight: Promise<SyncReport> | undefined;
  private rerun = false;

  constructor(private readonly deps: CalendarSyncDeps) {
    const limiter = new RequestLimiter(deps.clock, deps.minIntervalMs);
    this.sink = new GoogleCalendarSink({
      api: limitCalendarApi(deps.api, limiter),
      store: {
        load: () => deps.repo.get(STORAGE_KEYS.calendar),
        update: async (fn) => {
          await deps.repo.update(STORAGE_KEYS.calendar, fn);
        },
        dryRun: async () => {
          const settings = await deps.repo.get(STORAGE_KEYS.settings);
          return settings.dryRun.calendar && !settings.killSwitch;
        },
      },
      kit: { eventIdFor, hashDesired, reconcile },
      storage: deps.storage,
      audit: deps.audit,
      switches: deps.switches,
      clock: deps.clock,
      isLateAdd,
      ...(deps.strategy === undefined ? {} : { strategy: deps.strategy }),
      onLateAdd: (e) => this.lateAddNotice(e),
    });
  }

  /** Runs a sync. Calls that arrive during one share it and cause exactly one more pass. */
  syncNow(reason = 'manual'): Promise<SyncReport> {
    if (this.inFlight !== undefined) {
      this.rerun = true;
      return this.inFlight;
    }
    const run = (async () => {
      let report: SyncReport;
      do {
        report = await this.once(reason);
      } while (this.takeRerun());
      return report;
    })().finally(() => {
      this.inFlight = undefined;
    });
    this.inFlight = run;
    return run;
  }

  private takeRerun(): boolean {
    const again = this.rerun;
    this.rerun = false;
    return again;
  }

  private async once(reason: string): Promise<SyncReport> {
    const { repo, audit } = this.deps;
    try {
      const settings = await repo.get(STORAGE_KEYS.settings);
      if (!settings.calendar.enabled) return { status: 'disabled', changed: 0, pending: 0, errors: 0 };
      this.sink.setTimeZone(settings.locale.timeZone);
      const [tracked, calendar] = await Promise.all([repo.get(STORAGE_KEYS.tracked), repo.get(STORAGE_KEYS.calendar)]);
      const now = repo.now();
      const desired = buildDesired(tracked, calendar.links, settings, now);
      await this.feedSinks(desired, settings);

      const auth = await this.deps.google.status();
      if (!auth.connected || auth.needsInteraction) {
        const pending = await this.sink.queuePending(desired);
        if (desired.length > 0) this.deps.badge.set(true);
        if (auth.connected && auth.needsInteraction) await this.reconnectNotice(settings, now);
        return {
          status: auth.connected ? 'needs-reconnect' : 'pending',
          changed: 0,
          pending,
          errors: 0,
          detail: auth.connected ? 'Google needs you to reconnect' : 'Google is not connected',
        };
      }

      const links = Object.values(calendar.links);
      const run = await this.sink.run(desired, links);
      const errors = run.results.filter((r) => r.error !== undefined).length;
      const changed = run.results.filter((r) => r.op !== 'noop' && r.error === undefined).length;
      const after = await repo.get(STORAGE_KEYS.calendar);
      const pending = Object.values(after.links).filter((l) => l.status === 'pending').length;
      if (run.halted === undefined) return { status: errors > 0 ? 'error' : 'synced', changed, pending, errors };
      const detail = `${reason}: ${run.halted.message}`;
      switch (run.halted.reason) {
        case 'auth':
          this.deps.badge.set(true);
          await this.reconnectNotice(settings, now);
          return { status: 'needs-reconnect', changed, pending, errors, detail };
        case 'rate-limited':
          return { status: 'cooling-down', changed, pending, errors, detail };
        case 'offline':
          return { status: 'offline', changed, pending, errors, detail };
        case 'blocked':
          return { status: 'blocked', changed, pending, errors, detail };
        case 'error':
          return { status: 'error', changed, pending, errors, detail };
      }
    } catch (e) {
      const detail = (e instanceof Error ? e.message : String(e)).slice(0, 200);
      await audit.append({ actor: 'calendar', kind: 'calendar.sync.failed', details: { error: detail } }).catch(() => undefined);
      return { status: 'error', changed: 0, pending: 0, errors: 1, detail };
    }
  }

  // ── notifications ─────────────────────────────────────────────────────────

  private async canNotify(settings: Settings): Promise<boolean> {
    if (!settings.notifications.enabled) return false;
    try {
      return await this.deps.permissions.contains({ permissions: ['notifications'] });
    } catch {
      return false;
    }
  }

  /** One notice per local day, not per item (invalid_grant, a lapsed Testing-mode token, a lost scope). */
  private async reconnectNotice(settings: Settings, now: EpochMs): Promise<void> {
    const day = localDay(now, settings.locale.timeZone);
    if ((await this.sink.state.read()).noticeDay === day) return;
    await this.sink.state.update((s) => ({ ...s, noticeDay: day }));
    await this.deps.audit.append({ actor: 'calendar', kind: 'calendar.needs-reconnect', details: { day } });
    if (!(await this.canNotify(settings))) return;
    try {
      await this.deps.notifier.notify({
        id: 'sbw:calendar:reconnect',
        title: 'Reconnect Google Calendar',
        message: 'ShopBadwill cannot update your auction calendar until you reconnect Google in the options page.',
        priority: 1,
      });
    } catch {
      // Audited above; a failed notification must not fail the sync.
    }
  }

  /** I-18: an event inserted for an auction ending in under an hour gets an immediate local notice (once per item). */
  private async lateAddNotice(e: DesiredEvent): Promise<void> {
    const { repo, audit } = this.deps;
    const settings = await repo.get(STORAGE_KEYS.settings);
    if (!(await this.canNotify(settings))) return;
    const done = await audit.list({ limit: 200, kinds: ['notify.late-add'] });
    if (done.some((x) => x.itemId === e.itemId)) return; // T-56 already alerted for this item
    const minutes = Math.max(1, Math.ceil((new Date(e.startUtc).getTime() - repo.now()) / 60_000));
    await this.deps.notifier.notify({
      id: LATE_ID_PREFIX + String(e.itemId),
      title: `Ends in ${String(minutes)} min: ${truncateTitle(e.title, 50)}`,
      message: `Added to your calendar. ${itemUrl(e.itemId)}`,
      priority: 1,
      openUrlOnClick: itemUrl(e.itemId),
    });
    await audit.append({ actor: 'calendar', kind: 'notify.late-add', itemId: e.itemId, details: { minutes } });
  }

  // ── reminder sinks ────────────────────────────────────────────────────────

  /**
   * Sends changed events to every ReminderSink, and removes ones that are gone or
   * decided. Hashes are kept in `sbw:calendarSync`, so an unchanged set sends
   * nothing. Dry run and the kill switch stop it (it is an outbound write too).
   */
  private async feedSinks(desired: readonly DesiredEvent[], settings: Settings): Promise<void> {
    if (reminderSinks.size === 0) return;
    if (settings.killSwitch || settings.dryRun.calendar) return;
    const verdict = await this.deps.switches.writesAllowed('calendar');
    if (!verdict.ok) return;
    const open = desired.filter((d) => d.privateProps.sbwState === 'open');
    const state = await this.sink.state.read();
    const next = new Map<string, string>();
    for (const e of open) {
      const key = String(e.itemId);
      const hash = hashDesired(e);
      if (state.sinkHashes[key] === hash) {
        next.set(key, hash);
        continue;
      }
      const failed: string[] = [];
      for (const s of [...reminderSinks.values()]) {
        await s.upsert(e).catch(() => {
          failed.push(s.name); // retried on the next sync
        });
      }
      if (failed.length === 0) next.set(key, hash);
    }
    for (const [key, old] of Object.entries(state.sinkHashes)) {
      if (next.has(key)) continue;
      const failed: string[] = [];
      for (const s of [...reminderSinks.values()]) {
        await s.remove(Number(key)).catch(() => {
          failed.push(s.name);
        });
      }
      if (failed.length > 0) next.set(key, old);
    }
    await this.sink.state.update((s) => ({ ...s, sinkHashes: Object.fromEntries(next) }));
  }
}

// ── Per-context instance (handlers, the step executor and register share it) ─

const instances = new WeakMap<BackgroundContext, CalendarSync>();

export function syncFor(ctx: BackgroundContext): CalendarSync {
  let sync = instances.get(ctx);
  if (sync === undefined) {
    sync = new CalendarSync({
      repo: ctx.repo,
      audit: ctx.audit,
      clock: ctx.clock,
      storage: ctx.storage.local,
      api: ctx.calendarApi,
      switches: ctx.switches,
      google: ctx.google,
      notifier: ctx.notifier,
      permissions: ctx.permissions,
      badge: ctx.googleNeedsInteraction,
    });
    instances.set(ctx, sync);
  }
  return sync;
}

// ── Triggers ────────────────────────────────────────────────────────────────

/** Schedules the 60 s debounce alarm unless one is already pending. */
export async function scheduleDebounced(alarms: Pick<Alarms, 'create' | 'getAll'>, now: EpochMs): Promise<void> {
  const pending = (await alarms.getAll()).some((a) => a.name === SYNC_ALARM);
  if (!pending) await alarms.create(SYNC_ALARM, { when: now + DEBOUNCE_MS });
}

export function register(ctx: BackgroundContext): void {
  const sync = syncFor(ctx);
  const fire = (reason: string): void => {
    void sync.syncNow(reason).catch(() => undefined);
  };

  ctx.alarms.onAlarm((alarm) => {
    if (alarm.name === SYNC_ALARM) fire('debounce');
  });

  let lastRunSynced: string | undefined;
  ctx.storage.local.onChanged((changes) => {
    if (STORAGE_KEYS.tracked in changes) {
      void scheduleDebounced(ctx.alarms, ctx.clock.now()).catch(() => undefined);
    }
    const runs = changes[STORAGE_KEYS.jobRuns]?.newValue;
    if (Array.isArray(runs)) {
      let newest: { id: string; at: number } | undefined;
      for (const r of runs as Array<{ id?: unknown; status?: unknown; finishedAt?: unknown }>) {
        if ((r.status !== 'done' && r.status !== 'failed') || typeof r.id !== 'string') continue;
        const at = typeof r.finishedAt === 'number' ? r.finishedAt : 0;
        if (newest === undefined || at >= newest.at) newest = { id: r.id, at };
      }
      const id = newest?.id;
      if (id !== undefined && id !== lastRunSynced) {
        lastRunSynced = id;
        fire('job-run');
      }
    }
  });

  // Retry backoff, recovery after a restart, and the badge. A tick with nothing due makes no Google call.
  ctx.ticks.onTick(() => {
    fire('tick'); // not awaited: a sync paced at 1 request/second must not hold the tick hub
  });
  ctx.lifecycle.onStartup(() => {
    fire('startup');
  });
}
