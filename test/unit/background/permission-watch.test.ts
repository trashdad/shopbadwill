// T-119: the permission-revoke notice. When the user removes `identity` or a
// Google host in browser settings, Google is marked as needing a reconnect (the
// badge and the options page show it); when the ntfy host goes, ntfy is marked
// as needing permission. Fakes only.
import { describe, expect, it } from 'vitest';

import { NTFY_ORIGIN } from '../../../src/adapters/ntfy/ntfy-sink';
import { startPermissionWatch, type PermissionWatchDeps } from '../../../src/background/jobs/permission-watch';
import { defaultSettings } from '../../../src/domain/settings/defaults';
import { Repo } from '../../../src/domain/storage/repo';
import { STORAGE_KEYS } from '../../../src/domain/storage/schema';
import { FakeAuditLog } from '../../fakes/ports/fake-audit-log';
import { FakeClock } from '../../fakes/ports/fake-clock';
import { FakePermissions } from '../../fakes/ports/fake-permissions';
import { FakeStorageAreas } from '../../fakes/ports/fake-storage';

const T0 = Date.UTC(2026, 9, 12, 12, 0, 0);
const GOOGLE_HOSTS = ['https://oauth2.googleapis.com/*', 'https://www.googleapis.com/*'];

async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise<void>((r) => setImmediate(r));
}

class FakeGoogle {
  connected = true;
  needsInteraction = false;
  readonly marks: string[] = [];
  status(): Promise<{ connected: boolean; needsInteraction: boolean }> {
    return Promise.resolve({ connected: this.connected, needsInteraction: this.needsInteraction });
  }
  markNeedsInteraction(reason: 'permission-revoked'): Promise<void> {
    this.marks.push(reason);
    this.needsInteraction = true;
    return Promise.resolve();
  }
}

async function world(opts: { ntfyEnabled?: boolean; connected?: boolean } = {}) {
  const clock = new FakeClock(T0);
  const repo = new Repo(new FakeStorageAreas(), clock);
  const audit = new FakeAuditLog(clock);
  const permissions = new FakePermissions({ permissions: ['identity'], origins: [...GOOGLE_HOSTS, NTFY_ORIGIN] });
  const google = new FakeGoogle();
  google.connected = opts.connected ?? true;
  if (opts.ntfyEnabled === true) {
    await repo.set(STORAGE_KEYS.settings, {
      ...defaultSettings(),
      ntfy: { enabled: true, server: 'https://ntfy.sh', topic: 'sbw-test-topic-0123456789' },
    });
  }
  const deps: PermissionWatchDeps = {
    permissions,
    google: google as unknown as PermissionWatchDeps['google'],
    repo,
    audit,
  };
  return { repo, audit, permissions, google, deps };
}

describe('permission watch (T-119)', () => {
  it('revoking identity marks a connected Google as needing a reconnect', async () => {
    const w = await world();
    startPermissionWatch(w.deps);
    await flush();
    expect(w.google.marks).toEqual([]);

    w.permissions.revoke({ permissions: ['identity'] });
    await flush();
    expect(w.google.marks).toEqual(['permission-revoked']);
  });

  it.each(GOOGLE_HOSTS)('revoking the Google host %s marks Google', async (host) => {
    const w = await world();
    startPermissionWatch(w.deps);
    w.permissions.revoke({ origins: [host] });
    await flush();
    expect(w.google.marks).toEqual(['permission-revoked']);
  });

  it('does not mark Google when it is not connected, or already marked', async () => {
    const off = await world({ connected: false });
    startPermissionWatch(off.deps);
    off.permissions.revoke({ permissions: ['identity'] });
    await flush();
    expect(off.google.marks).toEqual([]);

    const flagged = await world();
    flagged.google.needsInteraction = true;
    startPermissionWatch(flagged.deps);
    flagged.permissions.revoke({ permissions: ['identity'] });
    await flush();
    expect(flagged.google.marks).toEqual([]);
  });

  it('revoking the ntfy host marks phone push as needing permission (once), and leaves Google alone', async () => {
    const w = await world({ ntfyEnabled: true });
    startPermissionWatch(w.deps);
    w.permissions.revoke({ origins: [NTFY_ORIGIN] });
    await flush();
    expect((await w.repo.find(STORAGE_KEYS.ntfy))?.status).toBe('needs-permission');
    expect(w.audit.entries.map((e) => [e.actor, e.kind, e.details])).toEqual([
      ['calendar', 'ntfy.status', { status: 'needs-permission' }],
    ]);
    expect(w.google.marks).toEqual([]);

    // Another removal event: no second write or audit entry.
    w.permissions.revoke({ origins: [GOOGLE_HOSTS[0] ?? ''] });
    await flush();
    expect(w.audit.kinds).toEqual(['ntfy.status']);
  });

  it('keeps the scheduled ntfy entries when marking', async () => {
    const w = await world({ ntfyEnabled: true });
    const items = { 42: { fingerprint: 'f', entries: [{ seq: 'sbw-42-15-0', leadMin: 15, fireAt: T0 + 1, status: 'scheduled' as const }] } };
    await w.repo.set(STORAGE_KEYS.ntfy, { items });
    startPermissionWatch(w.deps);
    w.permissions.revoke({ origins: [NTFY_ORIGIN] });
    await flush();
    expect(await w.repo.find(STORAGE_KEYS.ntfy)).toEqual({ status: 'needs-permission', items });
  });

  it('does not mark ntfy when phone push is off', async () => {
    const w = await world({ ntfyEnabled: false });
    startPermissionWatch(w.deps);
    w.permissions.revoke({ origins: [NTFY_ORIGIN] });
    await flush();
    expect(await w.repo.find(STORAGE_KEYS.ntfy)).toBeUndefined();
    expect(w.audit.entries).toEqual([]);
  });

  it('check() (run on browser start and install) catches a removal no event reported', async () => {
    const w = await world({ ntfyEnabled: true });
    w.permissions.revoke({ permissions: ['identity'], origins: [NTFY_ORIGIN] }); // no listener yet
    const watch = startPermissionWatch(w.deps);
    await flush();
    expect(w.google.marks).toEqual([]); // starting the watch alone does no I/O
    await watch.check();
    expect(w.google.marks).toEqual(['permission-revoked']);
    expect((await w.repo.find(STORAGE_KEYS.ntfy))?.status).toBe('needs-permission');
  });

  it('stop() unsubscribes', async () => {
    const w = await world();
    const watch = startPermissionWatch(w.deps);
    await flush();
    watch.stop();
    w.permissions.revoke({ permissions: ['identity'] });
    await flush();
    expect(w.google.marks).toEqual([]);
  });

  it('a failing permissions API never throws out of the watch', async () => {
    const w = await world();
    w.permissions.contains = () => Promise.reject(new Error('permissions API unavailable'));
    startPermissionWatch(w.deps);
    w.permissions.revoke({ permissions: ['identity'] });
    await flush();
    expect(w.google.marks).toEqual([]);
  });
});
