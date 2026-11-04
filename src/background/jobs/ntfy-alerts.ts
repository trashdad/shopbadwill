// R-3: night-time alerts reach the phone through ntfy. Every priority-2
// notification (the runner's notify effects, unconfirmed, at risk, auth-health
// warnings, the calendar reconnect notice, outcomes, the companion's "not
// scheduled") is mirrored to the user's ntfy topic at once, so an alert that
// matters while the user sleeps does not wait in a browser nobody is looking at.
//
// Self-registering through the jobs glob (I-01): it adds one mirror to
// ctx.notifyMirrors; main.ts runs it after the browser notification.
//
// - Gate (R1): `ntfy.enabled`, `ntfy.alerts` (absent = on), a valid topic, a
//   normalized https server (`isAllowedServer`) and its host permission.
//   Quiet hours do NOT hold an alert: that is the point.
// - Best effort (R2): at most one request per alert, no retry, paced 1 s apart
//   by its own Pacer (the sink's is private to the sink); never throws.
// - Audit (R4): `ntfy.alert` with the notification id and title, or
//   `ntfy.alert.failed` with the id and the error kind only. Never the body,
//   the topic or the token. The token is read raw through `parseNtfyAuth`,
//   never through `Repo.find`, and never logged.
import { DEFAULT_MIN_INTERVAL_MS, Pacer, ntfyRequest } from '../../adapters/ntfy/ntfy-sink';
import { isAllowedServer, serverPermissionPattern } from '../../adapters/ntfy/server';
import { isValidTopic } from '../../adapters/ntfy/topic';
import type { AuditLog } from '../../domain/audit/types';
import type { Settings } from '../../domain/settings/schema';
import { STORAGE_KEYS, parseNtfyAuth } from '../../domain/storage/schema';
import type { Clock } from '../../ports/clock';
import { HttpNetworkError, HttpTimeoutError } from '../../ports/errors';
import type { Http } from '../../ports/http';
import type { Notification } from '../../ports/notifier';
import type { Permissions } from '../../ports/permissions';
import type { BackgroundContext, NotifyMirror } from '../context';

/** What the mirror reads: the ntfy group and the saved access token (a secret). */
export interface NtfyAlertSettings {
  ntfy?: Settings['ntfy'];
  token?: string | undefined;
}

export interface NtfyAlertDeps {
  http: Pick<Http, 'send'>;
  clock: Clock;
  permissions: Pick<Permissions, 'contains'>;
  audit: Pick<AuditLog, 'append'>;
  settings: () => Promise<NtfyAlertSettings>;
  /** Production uses the sink's 1 s. */
  minIntervalMs?: number;
}

/** A label safe to audit: never the error message, which could carry the topic or the token. */
function errorKind(e: unknown): string {
  if (e instanceof HttpTimeoutError) return 'timeout';
  if (e instanceof HttpNetworkError) return 'network';
  return 'error';
}

/** The mirror: sends one ntfy alert for a priority-2 notification when the gate is open. Never throws. */
export function createNtfyAlertMirror(deps: NtfyAlertDeps): NotifyMirror {
  const pacer = new Pacer(deps.clock, deps.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS);
  const audit = async (kind: string, details: Record<string, string | null>): Promise<void> => {
    try {
      await deps.audit.append({ actor: 'system', kind, details });
    } catch {
      // The audit log must never break the mirror.
    }
  };

  return async (n: Notification): Promise<void> => {
    if (n.priority !== 2) return;
    let view: NtfyAlertSettings;
    try {
      view = await deps.settings();
    } catch {
      return; // unreadable settings: no alert, nothing to audit
    }
    const g = view.ntfy;
    if (g === undefined || !g.enabled || g.alerts === false) return;
    if (!isValidTopic(g.topic) || !isAllowedServer(g.server)) return;
    try {
      if (!(await deps.permissions.contains({ origins: [serverPermissionPattern(g.server)] }))) return;
    } catch {
      return;
    }
    const token = view.token === undefined || view.token === '' ? undefined : view.token;
    const id = n.id ?? null;
    try {
      const request = ntfyRequest(
        'alert',
        { server: g.server, topic: g.topic, ...(token === undefined ? {} : { token }) },
        { title: n.title, body: n.message, clickUrl: n.openUrlOnClick },
      );
      const response = await pacer.run(() => deps.http.send(request));
      if (response.status >= 200 && response.status < 300) {
        await audit('ntfy.alert', { id, title: n.title });
        return;
      }
      await audit('ntfy.alert.failed', { id, error: `http ${String(response.status)}` });
    } catch (e) {
      await audit('ntfy.alert.failed', { id, error: errorKind(e) });
    }
  };
}

export function register(ctx: BackgroundContext): void {
  const mirror = createNtfyAlertMirror({
    http: ctx.http,
    clock: ctx.clock,
    permissions: ctx.permissions,
    audit: ctx.audit,
    // The same view ntfy-reminders.ts reads: settings, plus the raw token record.
    settings: async () => {
      const s = await ctx.repo.get(STORAGE_KEYS.settings);
      const token = parseNtfyAuth(await ctx.repo.getRaw(STORAGE_KEYS.ntfyAuth))?.token;
      return { ntfy: s.ntfy, ...(token === undefined ? {} : { token }) };
    },
  });
  ctx.notifyMirrors.add(mirror);
}
