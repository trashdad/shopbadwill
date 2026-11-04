// T-91: AuthHealth (T-84's port, I-12). The runner calls `check(snipe, '24h' |
// '1h')` 24 h and 1 h before the end (its `:health24` / `:health1` alarms).
//
// R1/R3: this module uses ONLY cached state — the session adapter, the last
// HealthReport, the Google auth status, the switch snapshot and the keep-awake
// port — and makes zero SGW requests (I-39). It never touches the API or the
// HTTP port; that is structural, not just discipline.
//
// R2: `ok: false` ONLY when the snipe would certainly fail:
//   - no SGW session ('logged-out', or a usable state with no token);
//   - the session is rejected (reportRejected history: state 'expired' while
//     the stored token has not time-expired);
//   - the session expires before the auction end plus 5 min
//     (SESSION_MARGIN_AFTER_END_MS, the preflight's rule).
// The runner marks the snipe at risk, audits and notifies with this `detail`,
// and never disarms: a false alarm here must not cost the user an auction.
//
// Everything else is `ok: true` plus a warning notification from THIS module
// (the runner acts only on `ok: false`): a session expiring soon but after the
// end, Google disconnected (or needing interaction) only when the calendar is
// on, a failing health report, keep-awake unavailable, and (R-1) a snipe lane
// running dry or SGW asking to slow down. Keep-awake readiness
// matches the runner: tier T1 and the `power` permission, not `background`.
// R4: one notification per snipe per check, deduped
// across restarts through the audit log (`snipe.auth-warn`, ref = snipe id,
// details.check), never a new storage key. Quiet hours hold a warning back only
// while the end stays more than 1 h away after the window ends; the deferred
// delivery is an alarm (`sbw:authhealth:<id>:<which>`) that re-checks, so a
// session that died during the night surfaces through the same copy the
// runner's at-risk notification uses.
//
// R-1: the snipe-lane figures come from `scheduler.stats()`, the scheduler's
// in-memory state (no request). Fewer than SNIPE_LANE_LOW_WATER requests left
// today, or an active pause or snipe-lane backoff, is a warning, never ok:false.
//
// R-6: on tier T0 nothing keeps the computer awake, so both checks warn when
// the awake history (`sbw:awake`, read from the Repo) shows the browser ran in
// the end's local hour on under half of at least 3 observed days, or when the
// end falls inside quiet hours. A warning, never ok:false.
import { browser } from 'wxt/browser';

import type { AuthStatus } from '../../domain/calendar/types';
import type { AuditLog } from '../../domain/audit/types';
import type { Repo } from '../../domain/storage/repo';
import { defaultSettings } from '../../domain/settings/defaults';
import type { Settings } from '../../domain/settings/schema';
import { awakeAdvice } from '../../domain/snipe/awake-history';
import { isoMs, SESSION_MARGIN_AFTER_END_MS } from '../../domain/snipe/preflight';
import type { Snipe } from '../../domain/snipe/types';
import { STORAGE_KEYS } from '../../domain/storage/schema';
import { formatDual } from '../../domain/time/pacific';
import type { EpochMs, HealthReport, RequestSchedulerStats, SgwSessionState } from '../../domain/types';
import type { Alarms } from '../../ports/alarms';
import type { Clock } from '../../ports/clock';
import type { GoogleAuthProvider } from '../../ports/google-auth';
import type { KeepAwake } from '../../ports/keep-awake';
import type { Notifier } from '../../ports/notifier';
import type { Permissions } from '../../ports/permissions';
import type { RequestScheduler } from '../../ports/request-scheduler';
import type { SgwHealth } from '../../ports/sgw-health';
import type { SgwSession } from '../../ports/sgw-session';
import type { BackgroundContext } from '../context';
import { HEALTH_WINDOW_MS } from '../switches';
import { deferAlarm } from './deferred-alarms';
import { itemUrl, quietHoursEnd, truncateTitle } from './notify';
import { snipeSeams, type AuthHealth, type AuthHealthCheck, type AuthHealthResult } from './snipe-runner';

/** The audit kind of a sent warning: the dedupe record across restarts (R4). */
export const AUTH_WARN_KIND = 'snipe.auth-warn';
/** Notification id and deferred-alarm name prefix. Never collides with the runner's `sbw:snipe:<id>:…` names. */
export const AUTH_WARN_ALARM_PREFIX = 'sbw:authhealth:';
export const AUTH_WARN_ID_PREFIX = 'sbw:snipe:';

/** The exact fix actions (R4). */
const SIGN_IN = 'Sign in to ShopGoodwill in this browser';
const RECONNECT_GOOGLE = 'Reconnect Google';
const TURN_ON_KEEP_AWAKE = 'Turn on Keep awake';

/** R-1: warn when the snipe lane has fewer requests than this left today (two snipes of about 8). */
export const SNIPE_LANE_LOW_WATER = 16;

/** R-6: the awake rule needs at least this many observed days, and warns below this likelihood. */
export const T0_AWAKE_MIN_DAYS = 3;
export const T0_AWAKE_MIN_LIKELIHOOD = 0.5;

export function authWarnAlarmName(id: string, which: AuthHealthCheck): string {
  return `${AUTH_WARN_ALARM_PREFIX}${id}:${which}`;
}

export function parseAuthHealthAlarm(name: string): { id: string; which: AuthHealthCheck } | null {
  if (!name.startsWith(AUTH_WARN_ALARM_PREFIX)) return null;
  const rest = name.slice(AUTH_WARN_ALARM_PREFIX.length);
  const at = rest.lastIndexOf(':');
  if (at <= 0) return null;
  const which = rest.slice(at + 1);
  if (which !== '24h' && which !== '1h') return null;
  return { id: rest.slice(0, at), which };
}

/**
 * R4: respect quiet hours only if the end is still more than 1 h away after
 * the quiet window. Returns the quiet-hours end to defer to, or null to send
 * now (not inside quiet hours, no quiet hours, or too little time left).
 */
export function authWarnDeferUntil(
  now: EpochMs,
  endMs: EpochMs,
  quiet: Settings['notifications']['quietHours'],
  timeZone: string,
): EpochMs | null {
  const until = quietHoursEnd(now, quiet, timeZone);
  if (until === null) return null;
  return until + HOUR < endMs ? until : null;
}

// ── The pure assessment ─────────────────────────────────────────────────────

export interface AuthHealthSnapshot {
  /** null when the session could not be read. */
  sessionState: SgwSessionState | null;
  /** `session.current()`'s expiresAt; null when there is no token. The bearer is never read. */
  tokenExpiresAt: EpochMs | null;
  /** The stored session record's expiresAt, to tell a rejected token from a time-expired one. */
  sessionRecordExpiresAt: EpochMs | null;
  /** null when the status could not be read. */
  google: AuthStatus | null;
  /** Google warnings exist only while the user has the calendar turned on. */
  calendarEnabled: boolean;
  healthReport: HealthReport | null;
  keepAwakeAvailable: boolean;
  /** The runner's keep-awake gate: the `power` permission. `background` is not part of it. */
  powerGranted: boolean;
  tier: Settings['snipe']['tier'];
  timeZone: string;
  /**
   * R-1: the snipe lane today, from the scheduler's cached stats; null when
   * they could not be read. `paused`: an all-lane pause is active;
   * `backingOff`: the snipe lane is backing off; `blocked`: that pause or
   * backoff would refuse the bid too (a 403, or a manual/health pause);
   * `until`: when the longest of them ends (null = until resumed).
   */
  snipeLane: { left: number; paused: boolean; backingOff: boolean; blocked: boolean; until: EpochMs | null } | null;
  /** R-6: the `sbw:awake` heartbeat history; null when it could not be read (no awake-history warning). */
  awakeHistory: readonly EpochMs[] | null;
  /** R-6: `sbw:meta.installedAt` (when recording began); null when unknown (`since` is omitted). */
  installedAt: EpochMs | null;
  /** The user's quiet hours (also used for the R4 deferral). */
  quiet: Settings['notifications']['quietHours'];
}

/** R-1: the snapshot's snipe-lane figures from the scheduler stats. */
export function snipeLaneOf(stats: RequestSchedulerStats): NonNullable<AuthHealthSnapshot['snipeLane']> {
  const snipe = stats.lanes.snipe;
  const pause = stats.paused;
  const backingOff = snipe.backoffUntil !== undefined;
  const paused = pause !== undefined;
  // A pause of unknown cause (an older scheduler) counts as one that refuses the bid.
  const blocked = (paused && pause.cause !== 'rate-limited') || (backingOff && snipe.backoffKind === 'blocked');
  let until: EpochMs | null = 0;
  if (paused) until = pause.until === null ? null : Math.max(until, pause.until);
  if (backingOff && until !== null) until = Math.max(until, snipe.backoffUntil ?? 0);
  return {
    left: Math.max(0, snipe.budget - snipe.usedToday),
    paused,
    backingOff,
    blocked,
    until: paused || backingOff ? until : null,
  };
}

const HEALTH_WARN_NAMES_LIMIT = 3;

/** R-6 R1/R2: the tier-T0 "usually asleep at the end" warning, or null. */
function t0AwakeWarning(now: EpochMs, endMs: EpochMs, snap: AuthHealthSnapshot): string | null {
  if (snap.tier !== 'T0') return null;
  const lead = 'Tier T0 does nothing to keep this computer awake, and';
  const fix = 'or set up tier T1 or T2 in the snipe settings.';
  const time = formatDual(endMs, snap.timeZone);
  let advice: ReturnType<typeof awakeAdvice> | null = null;
  if (snap.awakeHistory !== null) {
    try {
      advice = awakeAdvice(endMs, snap.awakeHistory, {
        now,
        timeZone: snap.timeZone,
        ...(snap.installedAt === null ? {} : { since: snap.installedAt }),
      });
    } catch {
      advice = null; // an unusable zone: no awake-history warning
    }
  }
  if (advice !== null && advice.observed >= T0_AWAKE_MIN_DAYS && advice.likelihood < T0_AWAKE_MIN_LIKELIHOOD) {
    return `${lead} ${advice.text}. Keep the computer awake and the browser open for the end at ${time}, ${fix}`;
  }
  if (quietHoursEnd(endMs, snap.quiet, snap.timeZone) !== null) {
    return `${lead} the auction ends inside your quiet hours (${time}). Keep the computer awake and the browser open, ${fix}`;
  }
  return null;
}

function sessionFailure(
  now: EpochMs,
  endMs: EpochMs,
  snap: AuthHealthSnapshot,
): AuthHealthResult | null {
  switch (snap.sessionState) {
    case 'logged-out':
      return {
        ok: false,
        reason: 'logged-out',
        detail: `You are not signed in to ShopGoodwill. ${SIGN_IN}.`,
      };
    case 'expired':
      return snap.sessionRecordExpiresAt !== null && snap.sessionRecordExpiresAt > now
        ? {
            ok: false,
            reason: 'rejected',
            detail: `ShopGoodwill no longer accepts your saved login. ${SIGN_IN}.`,
          }
        : {
            ok: false,
            reason: 'expired',
            detail: `Your ShopGoodwill login has expired. ${SIGN_IN}.`,
          };
    case 'ok':
    case 'expiring':
      if (snap.tokenExpiresAt === null) {
        return { ok: false, reason: 'logged-out', detail: `No ShopGoodwill login is saved. ${SIGN_IN}.` };
      }
      if (snap.tokenExpiresAt < endMs + SESSION_MARGIN_AFTER_END_MS) {
        return {
          ok: false,
          reason: 'expires-before-end',
          detail: `Your ShopGoodwill login expires ${formatDual(snap.tokenExpiresAt, snap.timeZone)}, too close to the auction end (it must outlast it by 5 minutes). ${SIGN_IN}.`,
        };
      }
      return null;
    case null:
      return null; // unreadable: a warning, not a failure (the snipe is not certainly lost)
  }
}

/**
 * R2, in one place: `ok: false` only for the session conditions; every other
 * finding is a warning next to `ok: true`.
 */
export function assessAuthHealth(
  snipe: Snipe,
  now: EpochMs,
  snap: AuthHealthSnapshot,
): { result: AuthHealthResult; warnings: string[] } {
  const warnings: string[] = [];
  const endMs = isoMs(snipe.endTime);

  const failure = sessionFailure(now, endMs, snap);
  if (failure !== null) return { result: failure, warnings: [] };

  if (snap.sessionState === null) {
    warnings.push(`Your ShopGoodwill login could not be checked; the 15-minute check will try again. To be safe: ${SIGN_IN}.`);
  } else if (snap.sessionState === 'expiring' && snap.tokenExpiresAt !== null) {
    warnings.push(
      `Your ShopGoodwill login expires ${formatDual(snap.tokenExpiresAt, snap.timeZone)} — after this auction, so this snipe is safe. ${SIGN_IN} for the next one.`,
    );
  }

  if (snap.calendarEnabled && snap.google !== null) {
    if (snap.google.connected && snap.google.needsInteraction) {
      warnings.push(`Google Calendar needs you to sign in again. ${RECONNECT_GOOGLE}.`);
    } else if (!snap.google.connected && snap.google.configured) {
      warnings.push(`Google Calendar is disconnected, so the outcome will not be saved to your calendar. ${RECONNECT_GOOGLE}.`);
    }
  }

  const report = snap.healthReport;
  if (report !== null && !report.ok && now - report.checkedAt < HEALTH_WINDOW_MS) {
    const names = report.checks
      .filter((c) => !c.ok)
      .slice(0, HEALTH_WARN_NAMES_LIMIT)
      .map((c) => c.name)
      .join(', ');
    warnings.push(
      `A health check is failing (${names === '' ? 'unknown' : names}). It may stop the snipe at the 15-minute check. See the health section in options.`,
    );
  }

  if (snap.tier === 'T1') {
    if (!snap.keepAwakeAvailable) {
      warnings.push(
        'Keep awake is not available in this browser, so the computer may sleep before the bid. Choose tier T0, or keep the computer awake yourself.',
      );
    } else if (!snap.powerGranted) {
      warnings.push(`Keep awake is not turned on, so the computer may sleep before the bid. ${TURN_ON_KEEP_AWAKE}.`);
    }
  }

  const asleep = t0AwakeWarning(now, endMs, snap);
  if (asleep !== null) warnings.push(asleep);

  const lane = snap.snipeLane;
  if (lane !== null) {
    if (lane.left < SNIPE_LANE_LOW_WATER) {
      warnings.push(
        `The snipe lane has only ${String(lane.left)} SGW requests left today (a snipe needs about 8). Fewer snipes today, or turn off considerate mode.`,
      );
    }
    if (lane.paused || lane.backingOff) {
      const until = lane.until === null ? 'resumed' : formatDual(lane.until, snap.timeZone);
      warnings.push(
        lane.blocked
          ? `ShopBadwill's SGW requests are paused (until ${until}), so the bid will not go unless the pause ends first. See the health section in options.`
          : `SGW asked ShopBadwill to slow down (until ${until}); the bid itself will still go, but the checks before it may not.`,
      );
    }
  }

  return { result: { ok: true }, warnings };
}

// ── The implementation ──────────────────────────────────────────────────────

export interface AuthHealthDeps {
  clock: Pick<Clock, 'now'>;
  session: Pick<SgwSession, 'state' | 'current'>;
  /** The stored `sbw:sgwSession` record, reduced to expiresAt: the bearer never leaves the repo. */
  sessionRecord(): Promise<{ expiresAt: EpochMs } | null>;
  google: Pick<GoogleAuthProvider, 'status'>;
  health: Pick<SgwHealth, 'last'>;
  keepAwake: Pick<KeepAwake, 'available'>;
  permissions: Pick<Permissions, 'contains'>;
  settings(): Settings;
  audit: Pick<AuditLog, 'append' | 'list'>;
  notifier: Notifier;
  alarms: Pick<Alarms, 'create' | 'onAlarm'>;
  /** The snipe settings page (options): the notification's click URL; `openOptions` opens it from the button. */
  optionsUrl(): string;
  openOptions(): void | Promise<void>;
  /** The stored snipe, for the deferred re-check. */
  getSnipe(id: string): Promise<Snipe | undefined>;
  /** T-118 (L6): records the deferral alarm in `sbw:deferredAlarms`. */
  repo?: Pick<Repo, 'update'>;
  /** R-1: the scheduler's cached stats only (no request is ever made through it here). */
  scheduler: Pick<RequestScheduler, 'stats'>;
  /** R-6: the stored `sbw:awake` heartbeat history (no request). */
  awakeHistory(): Promise<readonly EpochMs[]>;
  /** R-6: `sbw:meta.installedAt`, or null when there is no meta record. */
  installedAt(): Promise<EpochMs | null>;
  log?(message: string, error?: unknown): void;
}

const AUDIT_PAGE = 200;
const HOUR = 60 * 60_000;
const AT_RISK_ID = 'at-risk';

function fixedId(id: string, which: AuthHealthCheck): string {
  return `${AUTH_WARN_ID_PREFIX}${id}:auth-warn-${which}`;
}

async function safe<T>(p: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await p();
  } catch {
    return fallback;
  }
}

/**
 * R4: sends (or defers) the warnings. One notification per snipe per check;
 * a restart re-checks the audit log before re-sending. Inside quiet hours the
 * warning waits on an alarm only while the end stays more than 1 h away after
 * the quiet window ends (R4); the alarm re-runs the check, so the state at
 * delivery time decides.
 */
export function createAuthHealth(deps: AuthHealthDeps): AuthHealth {
  const log = (message: string, error?: unknown): void => {
    if (deps.log !== undefined) {
      deps.log(message, error);
    } else {
      console.warn(`[ShopBadwill] ${message}`, error);
    }
  };

  const gather = async (): Promise<AuthHealthSnapshot & { now: EpochMs }> => {
    const settings = deps.settings();
    const [state, tokenRead, record, google, healthReport, powerGranted, awakeHistory, installedAt] = await Promise.all([
      safe(() => deps.session.state(), null),
      // `{ token }` when read (token may be null: no login); null when the read failed.
      safe(async () => ({ token: await deps.session.current() }), null),
      safe(() => deps.sessionRecord(), null),
      safe(() => deps.google.status(), null),
      safe(() => deps.health.last(), null),
      safe(() => deps.permissions.contains({ permissions: ['power'] }), false),
      safe<readonly EpochMs[] | null>(() => deps.awakeHistory(), null),
      safe(() => deps.installedAt(), null),
    ]);
    // R2: a usable state whose token could not be read is unknown (a warning),
    // never "no login saved" (a failure). Logged-out/expired need no token.
    const sessionState = tokenRead === null && (state === 'ok' || state === 'expiring') ? null : state;
    let snipeLane: AuthHealthSnapshot['snipeLane'];
    try {
      snipeLane = snipeLaneOf(deps.scheduler.stats());
    } catch {
      snipeLane = null; // unreadable: no snipe-lane warning (a warning never disarms anyway)
    }
    return {
      now: deps.clock.now(),
      sessionState,
      tokenExpiresAt: tokenRead?.token?.expiresAt ?? null,
      sessionRecordExpiresAt: record?.expiresAt ?? null,
      google,
      calendarEnabled: settings.calendar.enabled,
      healthReport,
      keepAwakeAvailable: deps.keepAwake.available,
      powerGranted,
      tier: settings.snipe.tier,
      timeZone: settings.locale.timeZone,
      snipeLane,
      awakeHistory,
      installedAt,
      quiet: settings.notifications.quietHours,
    };
  };

  const alreadyWarned = async (snipeId: string, which: AuthHealthCheck): Promise<boolean> => {
    try {
      let before: number | undefined;
      for (;;) {
        const page = await deps.audit.list({ limit: AUDIT_PAGE, kinds: [AUTH_WARN_KIND], ...(before === undefined ? {} : { before }) });
        if (page.some((e) => e.ref === snipeId && e.details.check === which)) return true;
        const last = page.at(-1);
        if (page.length < AUDIT_PAGE || last === undefined) return false;
        before = last.seq;
      }
    } catch (e) {
      log('auth-health: reading the warning history failed; the warning is sent again', e);
      return false;
    }
  };

  const sendWarning = async (snipe: Snipe, which: AuthHealthCheck, warnings: string[]): Promise<void> => {
    try {
      await deps.notifier.notify({
        id: fixedId(snipe.id, which),
        title: `Snipe checklist: ${truncateTitle(snipe.title, 40)}`,
        message: `${warnings.join('\n')}\nFix what you can: the check 15 minutes before the end decides whether the snipe runs.`,
        priority: 2,
        openUrlOnClick: deps.optionsUrl(),
        ...(deps.notifier.supportsActions ? { actions: [{ id: 'options', title: 'Open snipe settings' }] } : {}),
      });
    } catch (e) {
      log(`auth-health: the warning for snipe ${snipe.id} failed to send; it will be retried`, e);
      return; // not audited: the next check retries
    }
    try {
      await deps.audit.append({
        actor: 'snipe',
        kind: AUTH_WARN_KIND,
        itemId: snipe.itemId,
        ref: snipe.id,
        details: { check: which, warnings: warnings.length },
        dryRun: snipe.dryRun,
      });
    } catch (e) {
      log(`auth-health: auditing the warning for snipe ${snipe.id} failed`, e);
    }
  };

  const check: AuthHealth['check'] = async (snipe, which) => {
    const snap = await gather();
    const { result, warnings } = assessAuthHealth(snipe, snap.now, snap);
    if (!result.ok) return result; // the runner marks the snipe at risk and notifies with `detail`
    if (warnings.length > 0 && !(await alreadyWarned(snipe.id, which))) {
      const until = authWarnDeferUntil(snap.now, isoMs(snipe.endTime), snap.quiet, snap.timeZone);
      if (until !== null) {
        // T-118 (L6): recorded (when the repo is wired) so a dropped alarm is re-created at startup.
        if (deps.repo === undefined) await deps.alarms.create(authWarnAlarmName(snipe.id, which), { when: until });
        else await deferAlarm({ repo: deps.repo, alarms: deps.alarms }, authWarnAlarmName(snipe.id, which), until);
      } else {
        await sendWarning(snipe, which, warnings);
      }
    }
    return result;
  };

  /** The deferred alarm fired: re-check against the state as it is now. */
  const recheck = async (id: string, which: AuthHealthCheck): Promise<void> => {
    const s = await deps.getSnipe(id);
    if (s === undefined || s.state === 'resolved' || s.state === 'killed') return;
    const r = await check(s, which);
    if (r.ok) return;
    // The runner is not involved here (its next check may be the 1 h one):
    // surface the now-certain failure with the runner's own copy and id.
    try {
      await deps.notifier.notify({
        id: `${AUTH_WARN_ID_PREFIX}${s.id}:${AT_RISK_ID}`,
        title: `Snipe at risk: ${s.title}`,
        message: `${r.detail} Fix it before the auction ends: the check 15 minutes before the end decides whether the snipe runs.`,
        priority: 2,
        openUrlOnClick: itemUrl(s.itemId),
      });
    } catch (e) {
      log(`auth-health: the deferred at-risk alert for snipe ${s.id} failed to send`, e);
    }
  };

  deps.alarms.onAlarm((alarm) => {
    const p = parseAuthHealthAlarm(alarm.name);
    if (p === null) return;
    recheck(p.id, p.which).catch((e: unknown) => {
      log(`auth-health: the deferred re-check for snipe ${p.id} failed`, e);
    });
  });

  // A body click needs nothing here: the notifier opens `openUrlOnClick` itself,
  // then reports 'click'. Opening again would give the user a second tab.
  deps.notifier.onAction((id, actionId) => {
    if (!id.includes(':auth-warn-') || actionId !== 'options') return;
    void Promise.resolve()
      .then(() => deps.openOptions())
      .catch(() => undefined);
  });

  return { check };
}

// ── Self-registration (I-01, main.ts is frozen) ─────────────────────────────

/** Registers the real implementation on T-84's seam. Returns it for tests and diagnostics. */
export function register(ctx: BackgroundContext): AuthHealth {
  const optionsUrl = (): string => browser.runtime.getURL('/options.html#section-snipe');
  const impl = createAuthHealth({
    clock: ctx.clock,
    session: ctx.session,
    sessionRecord: async () => {
      const rec = await ctx.repo.find(STORAGE_KEYS.sgwSession);
      return rec === undefined ? null : { expiresAt: rec.expiresAt };
    },
    google: ctx.google,
    health: ctx.health,
    keepAwake: ctx.keepAwake,
    permissions: ctx.permissions,
    settings: () => ctx.switches.settings() ?? defaultSettings(),
    audit: ctx.audit,
    notifier: ctx.notifier,
    alarms: ctx.alarms,
    optionsUrl,
    // The same page a body click opens (the snipe section), not the options top.
    openOptions: () =>
      browser.tabs.create({ url: optionsUrl() }).then(
        () => undefined,
        () => undefined,
      ),
    getSnipe: async (id) => (await ctx.repo.get(STORAGE_KEYS.snipes))[id],
    repo: ctx.repo,
    scheduler: ctx.scheduler,
    awakeHistory: () => ctx.repo.get(STORAGE_KEYS.awake),
    installedAt: async () => (await ctx.repo.find(STORAGE_KEYS.meta))?.installedAt ?? null,
  });
  snipeSeams(ctx).setAuthHealth(impl);
  return impl;
}
