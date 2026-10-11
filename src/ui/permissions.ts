// T-56 (I-21): the one place UI pages ask for an optional permission. There is
// no background handler: browser.permissions.request must run inside the click
// that asked for it, so callers invoke `requestPermissions` straight from their
// click handler (before any await) with the Permissions port for their page.
import type { Permissions } from '../ports/permissions';

export type PermissionResult = { kind: 'granted' } | { kind: 'denied' } | { kind: 'error'; message: string };

type Api = Pick<Permissions, 'contains' | 'request'>;

/** Never throws: the API can be missing or reject. */
export async function hasPermissions(api: Api, names: readonly string[]): Promise<boolean> {
  try {
    return await api.contains({ permissions: [...names] });
  } catch {
    return false;
  }
}

/**
 * Call synchronously from a click handler. The request is the first thing that
 * happens, so the user gesture is still alive.
 */
export function requestPermissions(api: Api, names: readonly string[]): Promise<PermissionResult> {
  let pending: Promise<boolean>;
  try {
    pending = api.request({ permissions: [...names] });
  } catch (e) {
    return Promise.resolve({ kind: 'error', message: e instanceof Error ? e.message : String(e) });
  }
  return pending.then(
    (granted): PermissionResult => (granted ? { kind: 'granted' } : { kind: 'denied' }),
    (e: unknown): PermissionResult => ({ kind: 'error', message: e instanceof Error ? e.message : String(e) }),
  );
}
