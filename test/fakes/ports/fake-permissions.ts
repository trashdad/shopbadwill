import type { Permissions } from '../../../src/ports/permissions';

type Perm = { permissions?: string[]; origins?: string[] };

export class FakePermissions implements Permissions {
  /** Answer for request(); `false` simulates the user declining. */
  grantRequests = true;
  readonly requested: Perm[] = [];
  private readonly permissions = new Set<string>();
  private readonly origins = new Set<string>();
  private readonly removedListeners = new Set<() => void>();

  constructor(initial: Perm = {}) {
    this.add(initial);
  }

  contains(p: Perm): Promise<boolean> {
    const ok = (p.permissions ?? []).every((x) => this.permissions.has(x)) && (p.origins ?? []).every((x) => this.origins.has(x));
    return Promise.resolve(ok);
  }

  request(p: Perm): Promise<boolean> {
    this.requested.push(structuredClone(p));
    if (this.grantRequests) this.add(p);
    return Promise.resolve(this.grantRequests);
  }

  onRemoved(cb: () => void): () => void {
    this.removedListeners.add(cb);
    return () => {
      this.removedListeners.delete(cb);
    };
  }

  /** Test helper: the user revoked these in browser settings. Fires onRemoved. */
  revoke(p: Perm): void {
    for (const x of p.permissions ?? []) this.permissions.delete(x);
    for (const x of p.origins ?? []) this.origins.delete(x);
    for (const cb of [...this.removedListeners]) cb();
  }

  private add(p: Perm): void {
    for (const x of p.permissions ?? []) this.permissions.add(x);
    for (const x of p.origins ?? []) this.origins.add(x);
  }
}
