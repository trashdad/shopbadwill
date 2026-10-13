// T-118 (L6): deferred one-shot alarms (the quiet-hours digest, the outcome
// notice, the auth-health warning) are recorded in `sbw:deferredAlarms` and
// re-created by the startup reconcile when the browser dropped them (an
// extension update clears alarms; Firefox does not persist them; Chrome
// before 150 may drop them on restart).
import { describe, expect, it } from 'vitest';

import { deferAlarm, startDeferredAlarms } from '../../../src/background/jobs/deferred-alarms';
import { Repo } from '../../../src/domain/storage/repo';
import { STORAGE_KEYS } from '../../../src/domain/storage/schema';
import { FakeAlarms } from '../../fakes/ports/fake-alarms';
import { FakeClock } from '../../fakes/ports/fake-clock';
import { FakeStorageAreas } from '../../fakes/ports/fake-storage';

const T0 = Date.UTC(2026, 9, 10, 23, 0, 0);
const HOUR = 3_600_000;

async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise<void>((r) => setImmediate(r));
}

function world() {
  const clock = new FakeClock(T0);
  const areas = new FakeStorageAreas();
  const repo = new Repo(areas, clock);
  const alarms = new FakeAlarms(clock);
  return { clock, areas, repo, alarms };
}

const names = async (alarms: FakeAlarms): Promise<string[]> => (await alarms.getAll()).map((a) => a.name).sort();

describe('deferred alarms (T-118 L6)', () => {
  it('deferAlarm records the alarm and creates it', async () => {
    const w = world();
    await deferAlarm(w, 'sbw:notify:digest:run-1', T0 + 8 * HOUR);
    expect(await names(w.alarms)).toEqual(['sbw:notify:digest:run-1']);
    expect(await w.repo.get(STORAGE_KEYS.deferredAlarms)).toEqual({ 'sbw:notify:digest:run-1': T0 + 8 * HOUR });
  });

  it('a dropped alarm is re-created at startup, at its time', async () => {
    const w = world();
    await deferAlarm(w, 'sbw:notify:outcome:28', T0 + 8 * HOUR);
    // The browser restarts (Firefox) or the extension updates: the alarm is gone, the record stays.
    const fresh = new FakeAlarms(w.clock);
    startDeferredAlarms({ repo: w.repo, alarms: fresh });
    await flush();
    const all = await fresh.getAll();
    expect(all.map((a) => [a.name, a.scheduledTime])).toEqual([['sbw:notify:outcome:28', T0 + 8 * HOUR]]);
  });

  it('a deferral whose time passed while the browser was closed fires at the restart', async () => {
    const w = world();
    await deferAlarm(w, 'sbw:authhealth:s1:24h', T0 + HOUR);
    w.clock.set(T0 + 5 * HOUR);
    const fresh = new FakeAlarms(w.clock);
    startDeferredAlarms({ repo: w.repo, alarms: fresh });
    await flush();
    const all = await fresh.getAll();
    expect(all.map((a) => a.name)).toEqual(['sbw:authhealth:s1:24h']);
    expect(all[0]?.scheduledTime).toBeLessThanOrEqual(T0 + 5 * HOUR + 1000);
  });

  it('an alarm the browser kept is not created again', async () => {
    const w = world();
    await deferAlarm(w, 'sbw:notify:digest:run-1', T0 + 8 * HOUR);
    let creates = 0;
    const create = w.alarms.create.bind(w.alarms);
    w.alarms.create = (n, o) => {
      creates += 1;
      return create(n, o);
    };
    startDeferredAlarms({ repo: w.repo, alarms: w.alarms });
    await flush();
    expect(creates).toBe(0);
  });

  it('firing removes the record, so a later startup re-creates nothing', async () => {
    const w = world();
    startDeferredAlarms({ repo: w.repo, alarms: w.alarms });
    await deferAlarm(w, 'sbw:notify:digest:run-1', T0 + HOUR);
    w.clock.advance(HOUR);
    await flush();
    expect(await w.repo.get(STORAGE_KEYS.deferredAlarms)).toEqual({});
    const fresh = new FakeAlarms(w.clock);
    startDeferredAlarms({ repo: w.repo, alarms: fresh });
    await flush();
    expect(await names(fresh)).toEqual([]);
  });

  it('a re-deferral made while the alarm fires is kept', async () => {
    const w = world();
    startDeferredAlarms({ repo: w.repo, alarms: w.alarms });
    // The owner's handler defers again (still quiet hours) as the alarm fires.
    w.alarms.onAlarm((a) => {
      if (a.name === 'sbw:notify:digest:run-1' && a.scheduledTime === T0 + HOUR) void deferAlarm(w, a.name, T0 + 9 * HOUR);
    });
    await deferAlarm(w, 'sbw:notify:digest:run-1', T0 + HOUR);
    w.clock.advance(HOUR);
    await flush();
    expect(await w.repo.get(STORAGE_KEYS.deferredAlarms)).toEqual({ 'sbw:notify:digest:run-1': T0 + 9 * HOUR });
  });

  it('other alarms are not recorded or touched', async () => {
    const w = world();
    startDeferredAlarms({ repo: w.repo, alarms: w.alarms });
    await w.alarms.create('sbw:tick', { periodInMinutes: 2 });
    w.clock.advance(5 * 60_000);
    await flush();
    expect(await w.repo.get(STORAGE_KEYS.deferredAlarms)).toEqual({});
  });
});
