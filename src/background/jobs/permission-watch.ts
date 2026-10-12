// T-119: the permission-revoke notice. The user can remove an optional
// permission in browser settings at any time, and nothing else would notice
// until a request failed. On `permissions.onRemoved` (served by main.ts's
// top-level listener through ctx.permissions), and once at start for a removal
// made while the background was down:
//
// - `identity` or a Google host gone while Google is connected: the provider is
//   marked as needing a reconnect (the same flag invalid_grant raises), so the
//   action badge, the options page and the dashboard show it. Reconnecting asks
//   for the permissions again.
// - the ntfy host gone while phone push is on: `sbw:ntfy.status` becomes
//   `needs-permission` (what the ntfy sink itself records), and the ntfy job's
//   tick re-publishes once the permission is granted again.
//
// `onRemoved` carries no reliable detail across browsers, so each event
// re-checks with `contains`. Checks run one at a time and never throw.
import { NTFY_ORIGIN, EMPTY_NTFY_STATE } from '../../adapters/ntfy/ntfy-sink';
import type { PkceRefreshProvider } from '../../adapters/google/auth-pkce';
import type { AuditLog } from '../../domain/audit/types';
import type { Repo } from '../../domain/storage/repo';
import { STORAGE_KEYS } from '../../domain/storage/schema';
import type { Permissions } from '../../ports/permissions';
import type { BackgroundContext } from '../context';

/** wxt.config.ts OPTIONAL_HOSTS: the token endpoint and the Calendar API. */
const GOOGLE_HOSTS: readonly string[] = ['https://oauth2.googleapis.com/*', 'https://www.googleapis.com/*'];

export interface PermissionWatchDeps {
  permissions: Pick<Permissions, 'contains' | 'onRemoved'>;
  google: Pick<PkceRefreshProvider, 'status' | 'markNeedsInteraction'>;
  repo: Repo;
  audit: Pick<AuditLog, 'append'>;
}

export interface PermissionWatch {
  /** One check now (queued behind any check in flight). */
  check(): Promise<void>;
  stop(): void;
}

export function startPermissionWatch(deps: PermissionWatchDeps): PermissionWatch {
  let chain: Promise<void> = Promise.resolve();
  const check = (): Promise<void> => {
    chain = chain.then(() => checkOnce(deps)).catch(() => undefined);
    return chain;
  };
  const off = deps.permissions.onRemoved(() => {
    void check();
  });
  return { check, stop: off };
}

async function checkOnce(deps: PermissionWatchDeps): Promise<void> {
  await checkGoogle(deps).catch(() => undefined);
  await checkNtfy(deps).catch(() => undefined);
}

async function checkGoogle(deps: PermissionWatchDeps): Promise<void> {
  const status = await deps.google.status();
  if (!status.connected || status.needsInteraction) return;
  // Firefox requires `identity` (it cannot be optional there), so this is only ever false on Chrome.
  const held = await deps.permissions.contains({ permissions: ['identity'], origins: [...GOOGLE_HOSTS] });
  if (!held) await deps.google.markNeedsInteraction('permission-revoked');
}

async function checkNtfy(deps: PermissionWatchDeps): Promise<void> {
  const settings = await deps.repo.get(STORAGE_KEYS.settings);
  if (settings.ntfy?.enabled !== true) return;
  if (await deps.permissions.contains({ origins: [NTFY_ORIGIN] })) return;
  const changed = await deps.repo.withLock(STORAGE_KEYS.ntfy, async () => {
    const cur = (await deps.repo.find(STORAGE_KEYS.ntfy)) ?? structuredClone(EMPTY_NTFY_STATE);
    if (cur.status === 'needs-permission') return false;
    await deps.repo.set(STORAGE_KEYS.ntfy, { ...cur, status: 'needs-permission' });
    return true;
  });
  // Same entry the ntfy sink writes on a status change.
  if (changed) await deps.audit.append({ actor: 'calendar', kind: 'ntfy.status', details: { status: 'needs-permission' } });
}

export function register(ctx: BackgroundContext): void {
  const watch = startPermissionWatch({ permissions: ctx.permissions, google: ctx.google, repo: ctx.repo, audit: ctx.audit });
  ctx.lifecycle.onStartup(() => void watch.check());
  ctx.lifecycle.onInstalled(() => void watch.check());
}
