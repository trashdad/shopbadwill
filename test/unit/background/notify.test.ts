// T-56: digest, late-add alerts, quiet hours, permission gate, click handling.
// Fakes only; no network (R6).
import { beforeEach, describe, expect, it } from 'vitest';

import {
  buildDigest,
  deliverDigest,
  handleNotificationAction,
  onDigestAlarm,
  openDashboardFromNotification,
  plainText,
  quietHoursEnd,
  sendLateAdds,
  truncateTitle,
  DIGEST_ALARM_PREFIX,
  type NotifyDeps,
} from '../../../src/background/jobs/notify';
import notifyStep from '../../../src/background/jobs/steps/notify-digest';
import { FAVORITE_SKIP_PREFIX } from '../../../src/background/jobs/steps/favorite';
import { isLateAdd } from '../../../src/domain/notify/late-add';
import { Repo } from '../../../src/domain/storage/repo';
import { STORAGE_KEYS } from '../../../src/domain/storage/schema';
import type { Settings } from '../../../src/domain/settings/schema';
import { defaultSettings } from '../../../src/domain/settings/defaults';
import type { TrackedItem } from '../../../src/domain/types';
import type { JobRun, Watch } from '../../../src/domain/watches/schema';
import { FakeAlarms } from '../../fakes/ports/fake-alarms';
import { FakeAuditLog } from '../../fakes/ports/fake-audit-log';
import { FakeClock } from '../../fakes/ports/fake-clock';
import { FakeNotifier } from '../../fakes/ports/fake-notifier';
import { FakePermissions } from '../../fakes/ports/fake-permissions';
import { FakeStorageAreas } from '../../fakes/ports/fake-storage';

const MIN = 60_000;
const H = 3_600_000;
// 2026-10-10 23:00 in New York (EDT, UTC-4) = 2026-10-11 03:00Z
const NIGHT = Date.UTC(2026, 9, 11, 3, 0, 0);
// 2026-10-10 14:00 New York
const DAY = Date.UTC(2026, 9, 10, 18, 0, 0);

let clock: FakeClock;
let repo: Repo;
let audit: FakeAuditLog;
let notifier: FakeNotifier;
let permissions: FakePermissions;
let alarms: FakeAlarms;
let deps: NotifyDeps;

const watch = (over: Partial<Watch> = {}): Watch =>
  ({
    id: 'w1',
    name: 'Pyrex',
    enabled: true,
    query: { searchText: 'pyrex', categoryIds: [], sellerIds: [], page: 1 },
    ruleIds: [],
    maxPages: 1,
    favoriteMode: 'sgw',
    calendar: false,
    notify: true,
    nextRunAt: 0,
    seenItemIds: [],
    ...over,
  });

const item = (itemId: number, endMs: number, over: Partial<TrackedItem> = {}): TrackedItem => ({
  itemId,
  title: `Pyrex bowl ${String(itemId)}`,
  endTime: new Date(endMs).toISOString(),
  sellerId: 1,
  reasons: [{ kind: 'watch', id: 'w1' }],
  favoriteState: 'none',
  calendar: false,
  addedAt: 0,
  updatedAt: 0,
  ...over,
});

const run = (ids: number[], errors: JobRun['results']['errors'] = []): JobRun => ({
  id: 'run-1',
  trigger: 'scheduled',
  startedAt: 0,
  status: 'running',
  steps: [{ kind: 'notifyDigest' }],
  cursor: 0,
  results: { newMatches: ids, favorited: [], calendarUpserts: [], errors },
});

async function seed(items: TrackedItem[], settings: Partial<Settings['notifications']> = {}, watches = [watch()]): Promise<void> {
  const s = defaultSettings();
  await repo.set(STORAGE_KEYS.settings, { ...s, notifications: { ...s.notifications, ...settings } });
  await repo.set(STORAGE_KEYS.watches, watches);
  await repo.set(STORAGE_KEYS.tracked, Object.fromEntries(items.map((i) => [i.itemId, i])));
}

beforeEach(() => {
  clock = new FakeClock(DAY);
  alarms = new FakeAlarms(clock);
  audit = new FakeAuditLog(clock);
  repo = new Repo(new FakeStorageAreas(), clock);
  notifier = new FakeNotifier({ supportsActions: true });
  permissions = new FakePermissions({ permissions: ['notifications'] });
  deps = { repo, audit, notifier, permissions, alarms };
});

describe('isLateAdd (I-18)', () => {
  const now = DAY;
  const at = (ms: number) => ({ itemId: 1, endTime: new Date(ms).toISOString() });
  it('is true under 60 min out, false at 60 min, past or unparseable', () => {
    expect(isLateAdd(at(now + 59 * MIN), now)).toBe(true);
    expect(isLateAdd(at(now + 1), now)).toBe(true);
    expect(isLateAdd(at(now + 60 * MIN), now)).toBe(false);
    expect(isLateAdd(at(now), now)).toBe(false);
    expect(isLateAdd(at(now - MIN), now)).toBe(false);
    expect(isLateAdd({ itemId: 1, endTime: 'nope' }, now)).toBe(false);
  });
});

describe('quietHoursEnd', () => {
  const q = { from: '22:00', to: '07:00' };
  const NY = 'America/New_York';
  it('is null outside the window and when from === to or unset', () => {
    expect(quietHoursEnd(DAY, q, NY)).toBeNull();
    expect(quietHoursEnd(NIGHT, { from: '08:00', to: '08:00' }, NY)).toBeNull();
    expect(quietHoursEnd(NIGHT, undefined, NY)).toBeNull();
  });
  it('late evening: ends at 07:00 the next morning', () => {
    expect(quietHoursEnd(NIGHT, q, NY)).toBe(Date.UTC(2026, 9, 11, 11, 0, 0));
  });
  it('after midnight: ends at 07:00 the same morning', () => {
    const t = Date.UTC(2026, 9, 11, 6, 30, 0); // 02:30 EDT
    expect(quietHoursEnd(t, q, NY)).toBe(Date.UTC(2026, 9, 11, 11, 0, 0));
  });
  it('same-day window', () => {
    const t = Date.UTC(2026, 9, 10, 15, 0, 0); // 11:00 EDT
    expect(quietHoursEnd(t, { from: '09:00', to: '12:00' }, NY)).toBe(Date.UTC(2026, 9, 10, 16, 0, 0));
    expect(quietHoursEnd(Date.UTC(2026, 9, 10, 16, 0, 0), { from: '09:00', to: '12:00' }, NY)).toBeNull();
  });
  it('fall back day (2026-11-01): the end is the real 07:00 EST', () => {
    const t = Date.UTC(2026, 10, 1, 4, 0, 0); // 00:00 EDT, before the 02:00->01:00 repeat
    expect(quietHoursEnd(t, q, NY)).toBe(Date.UTC(2026, 10, 1, 12, 0, 0)); // 07:00 EST = 12:00Z
  });
  it('spring forward day (2026-03-08): the end is 07:00 EDT', () => {
    const t = Date.UTC(2026, 2, 8, 5, 30, 0); // 00:30 EST
    expect(quietHoursEnd(t, q, NY)).toBe(Date.UTC(2026, 2, 8, 11, 0, 0)); // 07:00 EDT = 11:00Z
  });
  it('a bad zone is not quiet', () => {
    expect(quietHoursEnd(NIGHT, q, 'Not/AZone')).toBeNull();
  });
});

describe('quietHoursEnd: DST and degenerate windows (round 1)', () => {
  const NY = 'America/New_York';
  const q = { from: '22:00', to: '07:00' };
  it('now inside the repeated 01:30 hour on 2026-11-01 (both passes) ends at 07:00 EST', () => {
    const firstPass = Date.UTC(2026, 10, 1, 5, 30, 0); // 01:30 EDT
    const secondPass = Date.UTC(2026, 10, 1, 6, 30, 0); // 01:30 EST
    expect(quietHoursEnd(firstPass, q, NY)).toBe(Date.UTC(2026, 10, 1, 12, 0, 0));
    expect(quietHoursEnd(secondPass, q, NY)).toBe(Date.UTC(2026, 10, 1, 12, 0, 0));
  });
  it('a window ending inside the repeated hour ends in the pass the caller is in', () => {
    const w = { from: '00:30', to: '01:45' };
    expect(quietHoursEnd(Date.UTC(2026, 10, 1, 5, 30, 0), w, NY)).toBe(Date.UTC(2026, 10, 1, 5, 45, 0)); // 01:45 EDT
    expect(quietHoursEnd(Date.UTC(2026, 10, 1, 6, 30, 0), w, NY)).toBe(Date.UTC(2026, 10, 1, 6, 45, 0)); // 01:45 EST
  });
  it('a `to` of 02:30 on 2026-03-08 (which does not exist) resolves to 03:30 EDT', () => {
    const now = Date.UTC(2026, 2, 8, 5, 30, 0); // 00:30 EST
    expect(quietHoursEnd(now, { from: '22:00', to: '02:30' }, NY)).toBe(Date.UTC(2026, 2, 8, 7, 30, 0));
  });
  it('a zero-length window (from === to) is never quiet', () => {
    for (const t of [NIGHT, DAY, Date.UTC(2026, 9, 11, 4, 0, 0)]) {
      expect(quietHoursEnd(t, { from: '00:00', to: '00:00' }, NY)).toBeNull();
      expect(quietHoursEnd(t, { from: '22:00', to: '22:00' }, NY)).toBeNull();
    }
  });
});

describe('sent check and coalescing (round 1)', () => {
  const Q = { quietHours: { from: '22:00', to: '07:00' } };
  const runOf = (id: string, ids: number[]): JobRun => ({ ...run(ids), id });

  it('an old run is never re-sent however many audit rows follow', async () => {
    await seed([item(1, DAY + 10 * H)]);
    expect(await deliverDigest(deps, runOf('old', [1]))).toBe('sent');
    for (let i = 0; i < 450; i += 1) {
      await audit.append({ actor: 'daily-job', kind: 'notify.digest', ref: `other-${String(i)}`, details: {} });
    }
    expect(await deliverDigest(deps, runOf('old', [1]))).toBe('skipped');
    expect(notifier.sent).toHaveLength(1);
  });

  it('runs deferred in one quiet period go out as ONE combined digest; every run is marked sent', async () => {
    clock.set(NIGHT);
    await seed([1, 2, 3, 4, 5].map((i) => item(i, NIGHT + 10 * H)), Q);
    const r1 = runOf('r1', [1, 2, 3]);
    const r2 = runOf('r2', [4, 5]);
    await repo.set(STORAGE_KEYS.jobRuns, [r1, r2]);
    expect(await deliverDigest(deps, r1)).toBe('deferred');
    expect(await deliverDigest(deps, r2)).toBe('deferred');
    expect(audit.kinds.filter((k) => k === 'notify.deferred')).toHaveLength(2);

    clock.set(Date.UTC(2026, 9, 11, 11, 0, 5));
    expect(await onDigestAlarm(deps, 'r1')).toBe('sent');
    expect(await onDigestAlarm(deps, 'r2')).toBe('skipped'); // its alarm fires too: nothing left
    expect(notifier.sent).toHaveLength(1);
    expect(notifier.sent[0]?.notification.title).toBe('5 new matches across 2 runs');
    const sentRefs = audit.entries.filter((e) => e.kind === 'notify.digest').map((e) => e.ref);
    expect(sentRefs.sort()).toEqual(['r1', 'r2']);
  });

  it('re-deferring a run adds no second notify.deferred row', async () => {
    clock.set(NIGHT);
    await seed([item(1, NIGHT + 10 * H)], Q);
    const r1 = runOf('r1', [1]);
    expect(await deliverDigest(deps, r1)).toBe('deferred');
    expect(await deliverDigest(deps, r1)).toBe('deferred');
    expect(audit.kinds.filter((k) => k === 'notify.deferred')).toHaveLength(1);
  });
});

describe('text', () => {
  it('strips markup and truncates', () => {
    expect(plainText('<b>Pyrex</b>\n  bowl\u0007')).toBe('Pyrex bowl');
    const long = 'x'.repeat(100);
    const t = truncateTitle(long);
    expect(Array.from(t)).toHaveLength(60);
    expect(t.endsWith('…')).toBe(true);
    expect(truncateTitle('short')).toBe('short');
  });
});

describe('buildDigest', () => {
  it('names the single watch, lists titles and counts only real failures', () => {
    const items = Object.fromEntries([1, 2, 3, 4].map((i) => [i, item(i, DAY + 10 * H)]));
    const r = run([1, 2, 3, 4], [
      { step: 0, message: `${FAVORITE_SKIP_PREFIX}dry-run` },
      { step: 1, message: `favorite: ${FAVORITE_SKIP_PREFIX}kill switch is on` },
      { step: 2, message: 'step skipped: no executor for quote' },
      { step: 3, message: 'search: boom' },
    ]);
    const d = buildDigest(r, items, [watch()]);
    expect(d?.title).toBe('4 new matches in Pyrex');
    expect(d?.message).toBe('Pyrex bowl 1\nPyrex bowl 2\nPyrex bowl 3\nand 1 more\n1 step had errors');
  });
  it('ignores matches of watches with notify off and returns null for none', () => {
    const items = { 1: item(1, DAY + H) };
    expect(buildDigest(run([1]), items, [watch({ notify: false })])).toBeNull();
    expect(buildDigest(run([]), items, [watch()])).toBeNull();
  });
  it('summarises several watches', () => {
    const items = { 1: item(1, DAY + H), 2: item(2, DAY + H, { reasons: [{ kind: 'watch', id: 'w2' }] }) };
    expect(buildDigest(run([1, 2]), items, [watch(), watch({ id: 'w2', name: 'Lamps' })])?.title).toBe(
      '2 new matches in 2 watches',
    );
  });
});

describe('deliverDigest', () => {
  it('sends one plain digest and audits it; a repeat sends nothing', async () => {
    await seed([item(1, DAY + 10 * H), item(2, DAY + 10 * H), item(3, DAY + 10 * H)]);
    expect(await deliverDigest(deps, run([1, 2, 3]))).toBe('sent');
    expect(notifier.sent).toHaveLength(1);
    expect(notifier.sent[0]?.notification.title).toBe('3 new matches in Pyrex');
    expect(audit.kinds).toEqual(['notify.digest']);
    expect(await deliverDigest(deps, run([1, 2, 3]))).toBe('skipped');
    expect(notifier.sent).toHaveLength(1);
  });

  it('during quiet hours is deferred to their end, then sent by the alarm', async () => {
    clock.set(NIGHT);
    await seed([item(1, NIGHT + 10 * H)], { quietHours: { from: '22:00', to: '07:00' } });
    await repo.set(STORAGE_KEYS.jobRuns, [run([1])]);
    expect(await deliverDigest(deps, run([1]))).toBe('deferred');
    expect(notifier.sent).toHaveLength(0);
    const all = await alarms.getAll();
    expect(all).toHaveLength(1);
    expect(all[0]?.name).toBe(`${DIGEST_ALARM_PREFIX}run-1`);
    expect(all[0]?.scheduledTime).toBe(Date.UTC(2026, 9, 11, 11, 0, 0));
    expect(audit.kinds).toEqual(['notify.deferred']);

    // The alarm fires at the end of quiet hours.
    clock.set(Date.UTC(2026, 9, 11, 11, 0, 5));
    expect(await onDigestAlarm(deps, 'run-1')).toBe('sent');
    expect(notifier.sent).toHaveLength(1);
  });

  it('the alarm re-defers if quiet hours were extended meanwhile', async () => {
    clock.set(Date.UTC(2026, 9, 11, 11, 0, 5));
    await seed([item(1, NIGHT + 10 * H)], { quietHours: { from: '07:00', to: '09:00' } });
    await repo.set(STORAGE_KEYS.jobRuns, [run([1])]);
    expect(await onDigestAlarm(deps, 'run-1')).toBe('deferred');
    expect(notifier.sent).toHaveLength(0);
  });

  it('sends nothing, and audits, when the permission is absent', async () => {
    permissions = new FakePermissions();
    deps = { ...deps, permissions };
    await seed([item(1, DAY + 10 * H)]);
    expect(await deliverDigest(deps, run([1]))).toBe('skipped');
    expect(notifier.sent).toHaveLength(0);
    expect(audit.kinds).toEqual(['notify.skipped']);
    expect(audit.entries[0]?.details['why']).toMatch(/permission/);
  });

  it('respects the toggles and watches without notify', async () => {
    await seed([item(1, DAY + H)], { digest: false });
    expect(await deliverDigest(deps, run([1]))).toBe('skipped');
    await seed([item(1, DAY + H)], { enabled: false });
    expect(await deliverDigest(deps, run([1]))).toBe('skipped');
    await seed([item(1, DAY + H)], {}, [watch({ notify: false })]);
    expect(await deliverDigest(deps, run([1]))).toBe('skipped');
    expect(notifier.sent).toHaveLength(0);
  });

  it('a run with only policy skips and no matches is silent', async () => {
    await seed([]);
    expect(await deliverDigest(deps, run([], [{ step: 0, message: `${FAVORITE_SKIP_PREFIX}dry-run` }]))).toBe('skipped');
    expect(notifier.sent).toHaveLength(0);
  });

  it('Firefox variant: no buttons offered', async () => {
    notifier = new FakeNotifier({ supportsActions: false });
    deps = { ...deps, notifier };
    await seed([item(1, DAY + 10 * H)]);
    await deliverDigest(deps, run([1]));
    expect(notifier.sent[0]?.notification.actions).toBeUndefined();
  });

  it('a notifier failure is audited, not thrown', async () => {
    await seed([item(1, DAY + 10 * H)]);
    notifier.notify = () => Promise.reject(new Error('<b>nope</b>'));
    expect(await deliverDigest(deps, run([1]))).toBe('skipped');
    expect(audit.kinds).toEqual(['notify.failed']);
    expect(audit.entries[0]?.details['error']).toBe('nope');
  });
});

describe('sendLateAdds', () => {
  it('alerts for a match ending in under 60 min, even during quiet hours, once', async () => {
    clock.set(NIGHT);
    await seed([item(1, NIGHT + 30 * MIN), item(2, NIGHT + 3 * H)], { quietHours: { from: '22:00', to: '07:00' } });
    expect(await sendLateAdds(deps, run([1, 2]))).toEqual([1]);
    expect(notifier.sent).toHaveLength(1);
    expect(notifier.sent[0]?.notification.title).toBe('Ends in 30 min: Pyrex bowl 1');
    expect(notifier.sent[0]?.notification.actions?.map((a) => a.id)).toEqual(['open-item', 'dashboard']);
    expect(await sendLateAdds(deps, run([1, 2]))).toEqual([]);
    expect(notifier.sent).toHaveLength(1);
  });

  it('is silent without the permission (audit only) and when disabled', async () => {
    await seed([item(1, DAY + 10 * MIN)]);
    permissions = new FakePermissions();
    expect(await sendLateAdds({ ...deps, permissions }, run([1]))).toEqual([]);
    expect(audit.kinds).toEqual(['notify.skipped']);
    await seed([item(1, DAY + 10 * MIN)], { enabled: false });
    expect(await sendLateAdds(deps, run([1]))).toEqual([]);
    expect(notifier.sent).toHaveLength(0);
  });

  it('skips an item that already ended', async () => {
    await seed([item(1, DAY - MIN)]);
    expect(await sendLateAdds(deps, run([1]))).toEqual([]);
  });
});

describe('notifyDigest step executor', () => {
  it('sends the late-add alert then the digest, and reports done', async () => {
    await seed([item(1, DAY + 20 * MIN), item(2, DAY + 5 * H)]);
    const out = await notifyStep.run(
      { kind: 'notifyDigest' },
      { repo, audit, run: run([1, 2]), ctx: { audit, notifier, permissions, alarms } },
    );
    expect(out).toEqual({ kind: 'notifyDigest', done: true });
    expect(notifier.sent.map((s) => s.notification.title)).toEqual([
      'Ends in 20 min: Pyrex bowl 1',
      '2 new matches in Pyrex',
    ]);
  });
  it('has the registry shape', () => {
    expect(notifyStep.kind).toBe('notifyDigest');
  });
});

describe('click handling (R4)', () => {
  const mk = (opts: { sidebar?: 'ok' | 'fail' | 'none' }) => {
    const calls: string[] = [];
    const b = {
      ...(opts.sidebar === 'none'
        ? {}
        : {
            sidebarAction: {
              open: () => {
                calls.push('sidebar');
                return opts.sidebar === 'fail' ? Promise.reject(new Error('gesture')) : Promise.resolve();
              },
            },
          }),
      runtime: {
        openOptionsPage: () => {
          calls.push('options');
          return Promise.resolve();
        },
      },
      tabs: {
        create: (o: { url: string }) => {
          calls.push(o.url);
          return Promise.resolve();
        },
      },
    };
    return { b, calls };
  };

  it('Firefox opens the sidebar, falling back to the options page', async () => {
    const a = mk({ sidebar: 'ok' });
    expect(await openDashboardFromNotification(a.b, true)).toBe('sidebar');
    expect(a.calls).toEqual(['sidebar']);
    const f = mk({ sidebar: 'fail' });
    expect(await openDashboardFromNotification(f.b, true)).toBe('options');
    expect(f.calls).toEqual(['sidebar', 'options']);
  });
  it('Chrome opens the options page', async () => {
    const c = mk({ sidebar: 'none' });
    expect(await openDashboardFromNotification(c.b, false)).toBe('options');
  });
  it('acts only on our notifications', async () => {
    const a = mk({ sidebar: 'ok' });
    await handleNotificationAction({ browser: a.b, firefox: true }, 'other:1', 'click');
    expect(a.calls).toEqual([]);
    await handleNotificationAction({ browser: a.b, firefox: true }, 'sbw:notify:digest:run-1', 'click');
    expect(a.calls).toEqual(['sidebar']);
  });
  it('the Chrome "Open item" button opens the item page', async () => {
    const a = mk({ sidebar: 'none' });
    await handleNotificationAction({ browser: a.b, firefox: false }, 'sbw:notify:late:42', 'open-item');
    expect(a.calls).toEqual(['https://shopgoodwill.com/item/42']);
  });
});
