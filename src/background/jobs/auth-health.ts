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
// on, a failing health report, keep-awake unavailable. Keep-awake readiness
// matches the runner: tier T1 and the `power` permission, not `background`.
// R4: one notification per snipe per check, deduped
// across restarts through the audit log (`snipe.auth-warn`, ref = snipe id,
// details.check), never a new storage key. Quiet hours hold a warning back only
// while the end stays more than 1 h away after the window ends; the deferred
// delivery is an alarm (`sbw:authhealth:<id>:<which>`) that re-checks, so a
// session that died during the night surfaces through the same copy the
// runner's at-risk notification uses.
import { browser } from 'wxt/browser';

import type { AuthStatus } from '../../domain/calendar/types';
import type { AuditLog } from '../../domain/audit/types';
import type { Repo } from '../../domain/storage/repo';
import { defaultSettings } from '../../domain/settings/defaults';
import type { Settings } from '../../domain/settings/schema';
import { isoMs, SESSION_MARGIN_AFTER_END_MS } from '../../domain/snipe/preflight';
import type { Snipe } from '../../domain/snipe/types';
import { STORAGE_KEYS } from '../../domain/storage/schema';
import { formatDual } from '../../domain/time/pacific';
import type { EpochMs, HealthReport, SgwSessionState } from '../../domain/types';
import type { Alarms } from '../../ports/alarms';
import type { Clock } from '../../ports/clock';
import type { GoogleAuthProvider } from '../../ports/google-auth';
import type { KeepAwake } from '../../ports/keep-awake';
import type { Notifier } from '../../ports/notifier';
import type { Permissions } from '../../ports/permissions';
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
}

const HEALTH_WARN_NAMES_LIMIT = 3;

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

  const gather = async (): Promise<AuthHealthSnapshot & { now: EpochMs; quiet: Settings['notifications']['quietHours'] }> => {
    const settings = deps.settings();
    const [state, tokenRead, record, google, healthReport, powerGranted] = await Promise.all([
      safe(() => deps.session.state(), null),
      // `{ token }` when read (token may be null: no login); null when the read failed.
      safe(async () => ({ token: await deps.session.current() }), null),
      safe(() => deps.sessionRecord(), null),
      safe(() => deps.google.status(), null),
      safe(() => deps.health.last(), null),
      safe(() => deps.permissions.contains({ permissions: ['power'] }), false),
    ]);
    // R2: a usable state whose token could not be read is unknown (a warning),
    // never "no login saved" (a failure). Logged-out/expired need no token.
    const sessionState = tokenRead === null && (state === 'ok' || state === 'expiring') ? null : state;
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
  });
  snipeSeams(ctx).setAuthHealth(impl);
  return impl;
}
