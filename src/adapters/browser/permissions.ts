import { browser } from 'wxt/browser';
import type { Permissions } from '../../ports/permissions';

interface Req {
  permissions?: string[];
  origins?: string[];
}

// The typed API wants literal unions; callers pass plain strings.
const cast = (p: Req): never => p as never;

export class BrowserPermissions implements Permissions {
  contains(p: Req): Promise<boolean> {
    return browser.permissions.contains(cast(p));
  }

  /** User gesture only. */
  request(p: Req): Promise<boolean> {
    return browser.permissions.request(cast(p));
  }

  onRemoved(cb: () => void): () => void {
    const listener = (): void => {
      cb();
    };
    browser.permissions.onRemoved.addListener(listener);
    return () => {
      browser.permissions.onRemoved.removeListener(listener);
    };
  }
}
