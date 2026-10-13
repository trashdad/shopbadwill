// T-91: the AuthHealth port implementation (T-84's seam, I-12). The 24 h and
// 1 h checks run on cached state only — session, health report, Google status,
// switches, keep-awake — and make zero SGW requests (I-39). `ok: false` ONLY
// when the snipe would certainly fail (R2); everything else is `ok: true` plus
// one warning notification per snipe per check (R4), deduped across restarts
// through the audit log, quiet hours respected only while the end stays more
// than 1 h away after the window.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { browser } from 'wxt/browser';

import type { BackgroundContext } from '../../../src/background/context';
import {
  authWarnAlarmName,
  authWarnDeferUntil,
  createAuthHealth,
  parseAuthHealthAlarm,
  register,
  AUTH_WARN_ALARM_PREFIX,
  AUTH_WARN_KIND,
  type AuthHealthDeps,
} from '../../../src/background/jobs/auth-health';
import type { AuthHealth } from '../../../src/background/jobs/snipe-runner';
import { defaultSettings } from '../../../src/domain/settings/defaults';
import type { Settings } from '../../../src/domain/settings/schema';
import { SESSION_MARGIN_AFTER_END_MS } from '../../../src/domain/snipe/preflight';
import type { Snipe } from '../../../src/domain/snipe/types';
import { Repo } from '../../../src/domain/storage/repo';
import { STORAGE_KEYS } from '../../../src/domain/storage/schema';
import type { EpochMs, HealthReport, SgwSessionState } from '../../../src/domain/types';
import type { SgwSession } from '../../../src/ports/sgw-session';
import { FakeAlarms } from '../../fakes/ports/fake-alarms';
import { FakeAuditLog } from '../../fakes/ports/fake-audit-log';
import { FakeClock } from '../../fakes/ports/fake-clock';
import { FakeGoogleAuth } from '../../fakes/ports/fake-google-auth';
import { FakeNotifier } from '../../fakes/ports/fake-notifier';
import { FakePermissions } from '../../fakes/ports/fake-permissions';
import { FakeSgwApi } from '../../fakes/ports/fake-sgw-api';
import { FakeStorageAreas } from '../../fakes/ports/fake-storage';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

// 2026-10-15 19:00 UTC = 15:00 in New York (EDT, UTC-4).
const NOW = Date.UTC(2026, 9, 15, 19, 0, 0);
const END = NOW + DAY;
// 2026-10-16 03:00 UTC = 23:00 in New York on 2026-10-15 (inside quiet hours).
const NIGHT = Date.UTC(2026, 9, 16, 3, 0, 0);

const SIGN_IN = 'Sign in to ShopGoodwill in this browser';

class FakeSession implements Pick<SgwSession, 'state' | 'current'> {
  stateValue: SgwSessionState = 'ok';
  token: { bearer: string; expiresAt: EpochMs; buyerId: string } | null = {
    bearer: 'test-bearer',
    expiresAt: END + DAY,
    buyerId: '1',
  };
  throwOnState = false;
  throwOnCurrent = false;

  state(): Promise<SgwSessionState> {
    return this.throwOnState ? Promise.reject(new Error('storage down')) : Promise.resolve(this.stateValue);
  }

  current(): Promise<{ bearer: string; expiresAt: EpochMs; buyerId: string } | null> {
    if (this.throwOnCurrent) return Promise.reject(new Error('storage down'));
    return Promise.resolve(this.token === null ? null : { ...this.token });
  }
}

let clock: FakeClock;
let alarms: FakeAlarms;
let audit: FakeAuditLog;
let notifier: FakeNotifier;
let permissions: FakePermissions;
let session: FakeSession;
let google: FakeGoogleAuth;
let sgw: FakeSgwApi;
let repo: Repo;
let settings: Settings;
let healthLast: HealthReport | null;
let sessionRecord: { expiresAt: EpochMs } | null;
let keepAwakeAvailable: boolean;

beforeEach(() => {
  clock = new FakeClock(NOW);
  alarms = new FakeAlarms(clock);
  audit = new FakeAuditLog(clock);
  notifier = new FakeNotifier({ supportsActions: true });
  permissions = new FakePermissions({ permissions: ['power', 'background'] });
  session = new FakeSession();
  google = new FakeGoogleAuth({ connected: true });
  sgw = new FakeSgwApi({ clock });
  repo = new Repo(new FakeStorageAreas(), clock);
  settings = defaultSettings();
  healthLast = null;
  sessionRecord = { expiresAt: END + DAY };
  keepAwakeAvailable = true;
});

const snipe = (over: Partial<Snipe> = {}): Snipe => ({
  id: 's1',
  itemId: 279250057,
  title: 'Vintage Pyrex bowl',
  endTime: new Date(END).toISOString(),
  endTimeAtArm: new Date(NOW).toISOString(),
  sellerId: 1,
  maxBid: 2000,
  leadMs: 8000,
  fallback: 'early-proxy',
  dryRun: true,
  state: 'armed',
  armedAt: NOW,
  attempt: {},
  history: [],
  ...over,
});

const failingReport = (checkedAt: EpochMs): HealthReport => ({
  ok: false,
  checkedAt,
  configVersion: 'test',
  checks: [{ name: 'detail-schema', ok: false, detail: 'test failure' }],
});

const deps = (): AuthHealthDeps => ({
  clock,
  session,
  sessionRecord: () => Promise.resolve(sessionRecord),
  google,
  health: { last: () => Promise.resolve(healthLast) },
  keepAwake: { get available() { return keepAwakeAvailable; } },
  permissions,
  settings: () => settings,
  audit,
  notifier,
  alarms,
  optionsUrl: () => 'https://example.invalid/options.html#section-snipe',
  openOptions: () => undefined,
  getSnipe: async (id: string) => (await repo.get(STORAGE_KEYS.snipes))[id],
  repo,
});

const make = (): AuthHealth => createAuthHealth(deps());

/** Asserts the result is a failure and returns its reason/detail (narrowed). */
const failureOf = (r: { ok: true } | { ok: false; reason: string; detail: string }): { reason: string; detail: string } => {
  if (r.ok) throw new Error('expected the check to fail');
  return r;
};

describe('T-91 auth-health: ok:false only when the snipe would certainly fail (R2)', () => {
  it('24 h check: a session expiring in 20 h (before the end) fails with the sign-in fix action', async () => {
    session.token = { bearer: 'test-bearer', expiresAt: NOW + 20 * HOUR, buyerId: '1' };
    const f = failureOf(await make().check(snipe(), '24h'));
    expect(f.reason).toBe('expires-before-end');
    expect(f.detail).toContain(SIGN_IN);
    expect(f.detail).toContain('too close to the auction end');
  });

  it('logged out: no SGW session fails the check', async () => {
    session.stateValue = 'logged-out';
    session.token = null;
    const f = failureOf(await make().check(snipe(), '24h'));
    expect(f.reason).toBe('logged-out');
    expect(f.detail).toContain(SIGN_IN);
  });

  it('a rejected session (reportRejected history) fails the check', async () => {
    session.stateValue = 'expired';
    sessionRecord = { expiresAt: NOW + HOUR }; // the token is not time-expired: it was rejected
    const f = failureOf(await make().check(snipe(), '1h'));
    expect(f.reason).toBe('rejected');
    expect(f.detail).toContain(SIGN_IN);
  });

  it('a time-expired session fails the check', async () => {
    session.stateValue = 'expired';
    sessionRecord = { expiresAt: NOW - HOUR };
    const f = failureOf(await make().check(snipe(), '1h'));
    expect(f.reason).toBe('expired');
    expect(f.detail).toContain(SIGN_IN);
  });

  it('the 5-minute margin boundary: exactly end + 5 min passes, one millisecond less fails', async () => {
    const at = END + SESSION_MARGIN_AFTER_END_MS;
    session.token = { bearer: 'test-bearer', expiresAt: at, buyerId: '1' };
    expect(await make().check(snipe(), '24h')).toEqual({ ok: true });

    session.token = { bearer: 'test-bearer', expiresAt: at - 1, buyerId: '1' };
    expect(await make().check(snipe({ id: 's-ms' }), '24h')).toMatchObject({ ok: false, reason: 'expires-before-end' });
  });

  it('a session expiring exactly at end + 5 min is ok; end + 4 min 59 s fails', async () => {
    const fiveMin = 5 * 60_000;
    const fourMin59s = 4 * 60_000 + 59_000;
    session.stateValue = 'expiring';
    session.token = { bearer: 'test-bearer', expiresAt: END + fiveMin, buyerId: '1' };
    expect(await make().check(snipe({ id: 's-exact' }), '24h')).toEqual({ ok: true });

    const secret = 'eyJhbGciOi-secret-bearer-T91';
    session.token = { bearer: secret, expiresAt: END + fourMin59s, buyerId: '1' };
    const early = failureOf(await make().check(snipe({ id: 's-4m59' }), '24h'));
    expect(early.reason).toBe('expires-before-end');
    expect(early.detail).toContain(SIGN_IN);
    expect(early.detail).not.toContain(secret);
  });

  it('a usable session state with no token fails closed (no login saved)', async () => {
    session.token = null;
    expect(await make().check(snipe(), '24h')).toMatchObject({ ok: false, reason: 'logged-out' });
  });

  it('a token that cannot be read is a warning, not "no login saved" (no false alarm)', async () => {
    session.stateValue = 'ok';
    session.throwOnCurrent = true;
    expect(await make().check(snipe(), '24h')).toEqual({ ok: true });
    await vi.waitFor(() => {
      expect(notifier.sent).toHaveLength(1);
    });
    expect(notifier.sent[0]?.notification.message).toContain('could not be checked');

    // A certain failure needs no token read: logged out stays ok:false.
    notifier.sent.length = 0;
    session.stateValue = 'logged-out';
    expect(await make().check(snipe({ id: 's-out-unread' }), '24h')).toMatchObject({ ok: false, reason: 'logged-out' });
  });

  it('an ok:false result sends no warning notification from this module (the runner alerts)', async () => {
    session.stateValue = 'logged-out';
    session.token = null;
    await make().check(snipe(), '24h');
    expect(notifier.sent).toHaveLength(0);
  });
});

describe('T-91 auth-health: everything else is ok:true plus a warning (R2)', () => {
  it('a session expiring soon but after the end warns with the sign-in fix action', async () => {
    session.stateValue = 'expiring';
    session.token = { bearer: 'test-bearer', expiresAt: END + 2 * HOUR, buyerId: '1' };
    const r = await make().check(snipe(), '24h');
    expect(r).toEqual({ ok: true });
    await vi.waitFor(() => {
      expect(notifier.sent).toHaveLength(1);
    });
    expect(notifier.sent[0]?.notification.message).toContain(SIGN_IN);
  });

  it('Google disconnected warns with the reconnect fix action only when the calendar is on; an unconfigured Google never warns', async () => {
    settings.calendar.enabled = true;
    google = new FakeGoogleAuth({ connected: false, configured: true });
    await make().check(snipe(), '24h');
    await vi.waitFor(() => {
      expect(notifier.sent).toHaveLength(1);
    });
    expect(notifier.sent[0]?.notification.message).toContain('Reconnect Google');
    expect(notifier.sent[0]?.notification.message).not.toContain('test-bearer');

    notifier.sent.length = 0;
    google = new FakeGoogleAuth({ connected: false, configured: false });
    await make().check(snipe({ id: 's-unconfigured' }), '24h');
    expect(notifier.sent).toHaveLength(0);
  });

  it('a disconnected or interaction-needed Google does not warn when the calendar is off', async () => {
    settings.calendar.enabled = false;
    google = new FakeGoogleAuth({ connected: false, configured: true });
    expect(await make().check(snipe(), '24h')).toEqual({ ok: true });
    expect(notifier.sent).toHaveLength(0);

    google = new FakeGoogleAuth({ connected: true, configured: true });
    google.needsInteraction = true;
    expect(await make().check(snipe({ id: 's-interact' }), '1h')).toEqual({ ok: true });
    expect(notifier.sent).toHaveLength(0);
  });

  it('Google needing interaction warns with the reconnect fix action when the calendar is on', async () => {
    settings.calendar.enabled = true;
    google = new FakeGoogleAuth({ connected: true });
    google.needsInteraction = true;
    await make().check(snipe(), '24h');
    await vi.waitFor(() => {
      expect(notifier.sent).toHaveLength(1);
    });
    expect(notifier.sent[0]?.notification.message).toContain('Reconnect Google');
  });

  it('a failing health report within 24 h warns; a stale or passing one does not', async () => {
    healthLast = failingReport(NOW - HOUR);
    await make().check(snipe(), '24h');
    await vi.waitFor(() => {
      expect(notifier.sent).toHaveLength(1);
    });
    expect(notifier.sent[0]?.notification.message).toContain('health check');

    notifier.sent.length = 0;
    healthLast = failingReport(NOW - 25 * HOUR);
    await make().check(snipe({ id: 's-stale-health' }), '24h');
    expect(notifier.sent).toHaveLength(0);

    healthLast = { ok: true, checkedAt: NOW - HOUR, configVersion: 'test', checks: [] };
    await make().check(snipe({ id: 's-healthy-report' }), '24h');
    expect(notifier.sent).toHaveLength(0);
  });

  it('keep-awake warnings follow the runner: T1 warns only when the power permission is missing', async () => {
    settings.snipe.tier = 'T1';
    permissions = new FakePermissions({ permissions: ['background'] }); // power missing
    await make().check(snipe(), '24h');
    await vi.waitFor(() => {
      expect(notifier.sent).toHaveLength(1);
    });
    expect(notifier.sent[0]?.notification.message).toContain('Turn on Keep awake');

    // Power is granted and background is not. The runner treats that as keep-awake
    // available, so this check must not warn.
    notifier.sent.length = 0;
    audit = new FakeAuditLog(clock);
    permissions = new FakePermissions({ permissions: ['power'] });
    await make().check(snipe({ id: 's-power-only' }), '24h');
    expect(notifier.sent).toHaveLength(0);

    audit = new FakeAuditLog(clock);
    permissions = new FakePermissions({ permissions: ['power', 'background'] });
    await make().check(snipe({ id: 's-both' }), '24h');
    expect(notifier.sent).toHaveLength(0);
  });

  it('keep-awake unavailable (Firefox) with T1 warns; tier T0 never warns about keep-awake', async () => {
    settings.snipe.tier = 'T1';
    keepAwakeAvailable = false;
    await make().check(snipe(), '24h');
    await vi.waitFor(() => {
      expect(notifier.sent).toHaveLength(1);
    });
    expect(notifier.sent[0]?.notification.message).toContain('Keep awake');

    notifier.sent.length = 0;
    settings.snipe.tier = 'T0';
    await make().check(snipe(), '24h');
    expect(notifier.sent).toHaveLength(0);
  });

  it('an unreadable session warns instead of failing (the snipe is not certainly lost)', async () => {
    session.throwOnState = true;
    const r = await make().check(snipe(), '24h');
    expect(r).toEqual({ ok: true });
    await vi.waitFor(() => {
      expect(notifier.sent).toHaveLength(1);
    });
    expect(notifier.sent[0]?.notification.message).toContain('could not be checked');
    // R4: every warning states its fix action.
    expect(notifier.sent[0]?.notification.message).toContain(SIGN_IN);
  });

  it('one notification per snipe per check, deduped across restarts through the audit log (R4)', async () => {
    session.stateValue = 'expiring';
    session.token = { bearer: 'test-bearer', expiresAt: END + 2 * HOUR, buyerId: '1' };
    const s = snipe();

    await make().check(s, '24h');
    await vi.waitFor(() => {
      expect(notifier.sent).toHaveLength(1);
    });
    // The same check again, and a fresh instance (restart) over the same audit log: no repeats.
    await make().check(s, '24h');
    await make().check(s, '24h');
    expect(notifier.sent).toHaveLength(1);
    // The 1 h check is its own notification.
    await make().check(s, '1h');
    await vi.waitFor(() => {
      expect(notifier.sent).toHaveLength(2);
    });
    // A second snipe is not swallowed by the first snipe's dedupe.
    await make().check(snipe({ id: 's2' }), '24h');
    await vi.waitFor(() => {
      expect(notifier.sent).toHaveLength(3);
    });
    await make().check(snipe({ id: 's2' }), '24h');
    expect(notifier.sent).toHaveLength(3);
    expect(audit.kinds.filter((k) => k === AUTH_WARN_KIND)).toHaveLength(3);
    expect(notifier.sent[0]?.notification).toMatchObject({
      id: 'sbw:snipe:s1:auth-warn-24h',
      priority: 2,
      openUrlOnClick: 'https://example.invalid/options.html#section-snipe',
    });
    expect(notifier.sent[0]?.notification.actions).toEqual([{ id: 'options', title: 'Open snipe settings' }]);
  });
});

describe('T-91 auth-health: quiet hours (R4)', () => {
  it('authWarnDeferUntil: defers only while quiet hours cover now and the end stays >1 h away after them', () => {
    const quiet = { from: '22:00', to: '07:00' };
    const end = NIGHT + DAY;
    // 23:00 NY inside quiet hours: 07:00 ends them, the end is 16 h later.
    expect(authWarnDeferUntil(NIGHT, end, quiet, 'America/New_York')).toBe(Date.UTC(2026, 9, 16, 11, 0, 0));
    // The end 40 min after the quiet window: never hold the warning back.
    expect(authWarnDeferUntil(NIGHT, Date.UTC(2026, 9, 16, 11, 40, 0), quiet, 'America/New_York')).toBeNull();
    // Outside quiet hours, no deferral.
    expect(authWarnDeferUntil(NOW, end, quiet, 'America/New_York')).toBeNull();
    expect(authWarnDeferUntil(NIGHT, end, undefined, 'America/New_York')).toBeNull();
    expect(authWarnDeferUntil(NIGHT, end, { from: '07:00', to: '07:00' }, 'America/New_York')).toBeNull();
    // Quiet hours end at 11:00 UTC. Exactly 1 h later is not "more than 1 h", so send now.
    const quietEnd = Date.UTC(2026, 9, 16, 11, 0, 0);
    expect(authWarnDeferUntil(NIGHT, quietEnd + HOUR, quiet, 'America/New_York')).toBeNull();
    expect(authWarnDeferUntil(NIGHT, quietEnd + HOUR + 1, quiet, 'America/New_York')).toBe(quietEnd);
  });

  it('the 24 h warning inside quiet hours waits for a deferral alarm, then notifies once at the quiet end', async () => {
    clock.set(NIGHT);
    const endMs = NIGHT + DAY;
    const s = snipe({ endTime: new Date(endMs).toISOString() });
    settings.notifications.quietHours = { from: '22:00', to: '07:00' };
    session.stateValue = 'expiring';
    session.token = { bearer: 'test-bearer', expiresAt: endMs + 2 * HOUR, buyerId: '1' };
    await repo.set(STORAGE_KEYS.snipes, { [s.id]: s });

    await make().check(s, '24h');
    expect(notifier.sent).toHaveLength(0);
    const alarm = (await alarms.getAll()).find((a) => a.name === authWarnAlarmName(s.id, '24h'));
    expect(alarm?.scheduledTime).toBe(Date.UTC(2026, 9, 16, 11, 0, 0)); // 07:00 NY
    // T-118 (L6): recorded, so a startup reconcile re-creates it if the browser drops it.
    expect(await repo.get(STORAGE_KEYS.deferredAlarms)).toEqual({ [authWarnAlarmName(s.id, '24h')]: Date.UTC(2026, 9, 16, 11, 0, 0) });

    alarms.advance(Date.UTC(2026, 9, 16, 11, 0, 0) - NIGHT);
    await vi.waitFor(() => {
      expect(notifier.sent).toHaveLength(1);
    });
    expect(notifier.sent[0]?.notification.message).toContain(SIGN_IN);
    expect((await alarms.getAll()).filter((a) => a.name.startsWith(AUTH_WARN_ALARM_PREFIX))).toHaveLength(0);
  });

  it('the 1 h check inside quiet hours is never held back (under 1 h remains after the window)', async () => {
    clock.set(NIGHT);
    const endMs = NIGHT + HOUR;
    const s = snipe({ endTime: new Date(endMs).toISOString() });
    settings.notifications.quietHours = { from: '22:00', to: '07:00' };
    session.stateValue = 'expiring';
    session.token = { bearer: 'test-bearer', expiresAt: endMs + 2 * HOUR, buyerId: '1' };

    await make().check(s, '1h');
    await vi.waitFor(() => {
      expect(notifier.sent).toHaveLength(1);
    });
    expect((await alarms.getAll()).filter((a) => a.name.startsWith(AUTH_WARN_ALARM_PREFIX))).toHaveLength(0);
  });

  it('a deferred re-check that now fails notifies with the runner at-risk copy; a disarmed snipe is skipped', async () => {
    clock.set(NIGHT);
    const endMs = NIGHT + DAY;
    const s = snipe({ endTime: new Date(endMs).toISOString() });
    settings.notifications.quietHours = { from: '22:00', to: '07:00' };
    session.stateValue = 'expiring';
    session.token = { bearer: 'test-bearer', expiresAt: endMs + 2 * HOUR, buyerId: '1' };
    await repo.set(STORAGE_KEYS.snipes, { [s.id]: s });
    const impl = make();
    await impl.check(s, '24h');

    // The session dies during the night: the deferred re-check surfaces it.
    session.stateValue = 'logged-out';
    session.token = null;
    alarms.advance(Date.UTC(2026, 9, 16, 11, 0, 0) - NIGHT);
    await vi.waitFor(() => {
      expect(notifier.sent).toHaveLength(1);
    });
    expect(notifier.sent[0]?.notification).toMatchObject({ id: 'sbw:snipe:s1:at-risk' });
    expect(notifier.sent[0]?.notification.message).toContain(SIGN_IN);
  });

  it('a deferred re-check of a disarmed (killed) or resolved snipe sends nothing', async () => {
    clock.set(NIGHT);
    const endMs = NIGHT + DAY;
    settings.notifications.quietHours = { from: '22:00', to: '07:00' };
    session.stateValue = 'expiring';
    session.token = { bearer: 'test-bearer', expiresAt: endMs + 2 * HOUR, buyerId: '1' };
    const killed = snipe({ id: 's-killed', endTime: new Date(endMs).toISOString() });
    const resolved = snipe({ id: 's-resolved', endTime: new Date(endMs).toISOString() });
    await repo.set(STORAGE_KEYS.snipes, { [killed.id]: killed, [resolved.id]: resolved });
    const impl = make();
    await impl.check(killed, '24h');
    await impl.check(resolved, '24h');
    expect((await alarms.getAll()).filter((a) => a.name.startsWith(AUTH_WARN_ALARM_PREFIX))).toHaveLength(2);

    // Overnight the user disarms one snipe and the other resolves; the session also dies.
    await repo.set(STORAGE_KEYS.snipes, {
      [killed.id]: { ...killed, state: 'killed' },
      [resolved.id]: { ...resolved, state: 'resolved' },
    });
    session.stateValue = 'logged-out';
    session.token = null;
    alarms.advance(Date.UTC(2026, 9, 16, 11, 0, 0) - NIGHT);
    await new Promise((r) => setTimeout(r, 20));
    expect(notifier.sent).toHaveLength(0);
  });

  it('authWarnDeferUntil across DST: the quiet end is the real instant and the 1 h rule is elapsed time', () => {
    const quiet = { from: '22:00', to: '07:00' };
    const NY = 'America/New_York';
    // Fall back (2026-11-01): 01:30 EDT, first pass of the repeated hour. Quiet ends 07:00 EST = 12:00Z.
    const fallNow = Date.UTC(2026, 10, 1, 5, 30, 0);
    const fallEnd = Date.UTC(2026, 10, 1, 12, 0, 0);
    expect(authWarnDeferUntil(fallNow, fallEnd + HOUR + 1, quiet, NY)).toBe(fallEnd);
    expect(authWarnDeferUntil(fallNow, fallEnd + HOUR, quiet, NY)).toBeNull();
    // Second pass of the repeated hour (01:30 EST): the same quiet end.
    expect(authWarnDeferUntil(Date.UTC(2026, 10, 1, 6, 30, 0), fallEnd + DAY, quiet, NY)).toBe(fallEnd);
    // Spring forward (2026-03-08): 00:30 EST. Quiet ends 07:00 EDT = 11:00Z.
    const springNow = Date.UTC(2026, 2, 8, 5, 30, 0);
    const springEnd = Date.UTC(2026, 2, 8, 11, 0, 0);
    expect(authWarnDeferUntil(springNow, springEnd + HOUR + 1, quiet, NY)).toBe(springEnd);
    expect(authWarnDeferUntil(springNow, springEnd + HOUR, quiet, NY)).toBeNull();
  });
});

describe('T-91 auth-health: notification actions', () => {
  it('a body click opens nothing more (the notifier itself opens openUrlOnClick); the button opens the settings once', async () => {
    const opened: string[] = [];
    session.stateValue = 'expiring';
    session.token = { bearer: 'test-bearer', expiresAt: END + 2 * HOUR, buyerId: '1' };
    const impl = createAuthHealth({
      ...deps(),
      openOptions: () => {
        opened.push('options');
      },
    });
    await impl.check(snipe(), '24h');
    await vi.waitFor(() => {
      expect(notifier.sent).toHaveLength(1);
    });
    const id = notifier.sent[0]?.id ?? '';
    expect(notifier.sent[0]?.notification.openUrlOnClick).toBe('https://example.invalid/options.html#section-snipe');

    notifier.click(id);
    await new Promise((r) => setTimeout(r, 20));
    expect(opened).toEqual([]); // one tab, from the notifier, not two

    notifier.triggerAction(id, 'options');
    await vi.waitFor(() => {
      expect(opened).toEqual(['options']);
    });
  });

  it('register(): the "Open snipe settings" button opens the snipe section, the same page a click opens', async () => {
    const created = async (): Promise<string[]> => (await browser.tabs.query({})).map((t) => String(t.url));
    const before = (await created()).length;
    session.stateValue = 'expiring';
    session.token = { bearer: 'test-bearer', expiresAt: END + 2 * HOUR, buyerId: '1' };
    const ctx = {
      clock,
      session,
      google,
      health: { last: () => Promise.resolve(healthLast) },
      keepAwake: { available: true },
      permissions,
      switches: { settings: () => settings },
      audit,
      notifier,
      alarms,
      repo,
    } as unknown as BackgroundContext;
    await register(ctx).check(snipe(), '24h');
    await vi.waitFor(() => {
      expect(notifier.sent).toHaveLength(1);
    });
    const n = notifier.sent[0];
    notifier.triggerAction(n?.id ?? '', 'options');
    await vi.waitFor(async () => {
      expect(await created()).toHaveLength(before + 1);
    });
    const url = (await created()).at(-1);
    expect(url).toBe(n?.notification.openUrlOnClick);
    expect(url).toMatch(/\/options\.html#section-snipe$/);
  });
});

describe('T-91 auth-health: alarm names and the register() seam', () => {
  it('parses only its own alarm names', () => {
    expect(parseAuthHealthAlarm('sbw:authhealth:s1:24h')).toEqual({ id: 's1', which: '24h' });
    expect(parseAuthHealthAlarm('sbw:authhealth:s1:1h')).toEqual({ id: 's1', which: '1h' });
    expect(parseAuthHealthAlarm('sbw:snipe:s1:health24')).toBeNull();
    expect(parseAuthHealthAlarm('sbw:authhealth:s1')).toBeNull();
  });

  it('register() wires the runner seam and the checks make zero SGW requests (I-39)', async () => {
    settings.snipe.tier = 'T1';
    permissions = new FakePermissions(); // power and background missing
    session.stateValue = 'expiring';
    session.token = { bearer: 'test-bearer', expiresAt: END + 2 * HOUR, buyerId: '1' };
    const s = snipe();
    await repo.set(STORAGE_KEYS.snipes, { [s.id]: s });
    const touched: string[] = [];
    const ctx = new Proxy(
      {
        clock,
        session,
        google,
        health: { last: () => Promise.resolve(healthLast) },
        keepAwake: { get available() { return keepAwakeAvailable; } },
        permissions,
        switches: { settings: () => settings },
        audit,
        notifier,
        alarms,
        repo,
        api: sgw,
        http: {},
        scheduler: {},
        calendarApi: {},
        sgwClock: {},
      } as unknown as BackgroundContext,
      {
        get(target, prop, receiver) {
          if (prop === 'api' || prop === 'http' || prop === 'scheduler' || prop === 'calendarApi' || prop === 'sgwClock') {
            touched.push(prop);
          }
          const value: unknown = Reflect.get(target, prop, receiver);
          return value;
        },
      },
    );

    const impl = register(ctx);
    expect(typeof impl.check).toBe('function');
    const r = await impl.check(s, '1h');
    expect(r).toEqual({ ok: true });
    await vi.waitFor(() => {
      expect(notifier.sent).toHaveLength(1);
    });
    expect(notifier.sent[0]?.notification.message).toContain('Turn on Keep awake');
    // R3 / I-39: the check never touches the SGW API, HTTP, or the scheduler.
    expect(sgw.calls).toEqual([]);
    expect(touched).toEqual([]);
  });

  it('checks make zero SGW requests (I-39) across every condition, and the text has no token', async () => {
    const SECRET = 'eyJhbGciOi-secret-bearer-T91';
    const network: string[] = [];
    const watch = <T extends object>(obj: T, blocked: readonly string[]): T =>
      new Proxy(obj, {
        get(target, prop, receiver) {
          const value: unknown = Reflect.get(target, prop, receiver);
          if (typeof prop === 'string' && blocked.includes(prop) && typeof value === 'function') {
            return (...args: unknown[]) => {
              network.push(prop);
              return (value as (...a: unknown[]) => unknown).apply(target, args);
            };
          }
          return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
        },
      });
    session.token = { bearer: SECRET, expiresAt: END + 2 * HOUR, buyerId: '1' };
    session.stateValue = 'expiring';
    settings.calendar.enabled = true;
    google = watch(
      new FakeGoogleAuth({ connected: false, configured: true, account: SECRET }),
      ['getAccessToken', 'connect', 'disconnect'],
    );
    healthLast = {
      ok: false,
      checkedAt: NOW - HOUR,
      configVersion: 'test',
      checks: [{ name: 'detail-schema', ok: false, detail: SECRET }],
    };
    let healthRuns = 0;
    const fetches: string[] = [];
    const origFetch = globalThis.fetch;
    globalThis.fetch = (input: unknown) => {
      fetches.push(String(input));
      return Promise.reject(new Error('SGW fetch'));
    };
    const health = {
      last: () => Promise.resolve(healthLast),
      run: () => {
        healthRuns += 1;
        network.push('health.run');
        return Promise.resolve(healthLast);
      },
    };
    try {
      const impl = createAuthHealth({
        ...deps(),
        session: watch(session, ['refresh', 'observe', 'clear', 'reportRejected']),
        google,
        health,
      });
      await impl.check(snipe({ title: 'Vintage Pyrex bowl' }), '24h');
      session.stateValue = 'logged-out';
      session.token = null;
      await impl.check(snipe({ id: 's-out' }), '1h');
      await vi.waitFor(() => {
        expect(notifier.sent.length).toBeGreaterThan(0);
      });
      const text = notifier.sent.map((n) => `${n.notification.title}\n${n.notification.message}`).join('\n');
      expect(text).not.toContain(SECRET);
      expect(text).toContain(SIGN_IN);
      expect(text).toContain('Reconnect Google');
      expect(JSON.stringify(audit.entries)).not.toContain(SECRET);
      expect(sgw.calls).toEqual([]);
      expect(network).toEqual([]);
      expect(healthRuns).toBe(0);
      expect(fetches).toEqual([]);
      expect(google.calls.every((c) => c.method === 'status')).toBe(true);
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});
