// T-118 (L6): deferred one-shot alarms survive a dropped alarm. The quiet-hours
// digest (`sbw:notify:digest:<run>`), the outcome notice
// (`sbw:notify:outcome:<item>`) and the auth-health warning
// (`sbw:authhealth:<id>:<which>`) wait on a one-shot alarm. An extension update
// clears alarms, Firefox does not persist them, and Chrome before 150 may drop
// them on a browser restart, so each is also recorded in `sbw:deferredAlarms`
// (name -> when). At every background start a recorded alarm that is missing
// is created again (a past `when` fires at once); firing removes the record.
// The owners' alarm handlers are idempotent (each re-checks its audit marker
// or state), so a re-created alarm can never send a notice twice.
import type { Repo } from '../../domain/storage/repo';
import { STORAGE_KEYS } from '../../domain/storage/schema';
import type { EpochMs } from '../../domain/types';
import type { Alarms } from '../../ports/alarms';
import type { BackgroundContext } from '../context';

interface Deps {
  repo: Pick<Repo, 'get' | 'update'>;
  alarms: Pick<Alarms, 'create' | 'getAll' | 'onAlarm'>;
}

/** Records, then creates, a deferred one-shot alarm. */
export async function deferAlarm(deps: { repo: Pick<Repo, 'update'>; alarms: Pick<Alarms, 'create'> }, name: string, when: EpochMs): Promise<void> {
  await deps.repo.update(STORAGE_KEYS.deferredAlarms, (r) => ({ ...r, [name]: when }));
  await deps.alarms.create(name, { when });
}

/** Re-creates every recorded alarm the browser no longer holds. */
async function restore(deps: Deps): Promise<void> {
  const recorded = await deps.repo.get(STORAGE_KEYS.deferredAlarms);
  const names = Object.keys(recorded);
  if (names.length === 0) return;
  const held = new Set((await deps.alarms.getAll()).map((a) => a.name));
  for (const name of names) {
    const when = recorded[name];
    if (when === undefined || held.has(name)) continue;
    await deps.alarms.create(name, { when });
  }
}

/** Listens for the recorded alarms firing, and restores the dropped ones now. */
export function startDeferredAlarms(deps: Deps, log: (message: string, error?: unknown) => void = () => undefined): void {
  deps.alarms.onAlarm((alarm) => {
    // Only the occurrence that fired: a re-deferral (a later `when`) made by the owner stays recorded.
    void deps.repo
      .update(STORAGE_KEYS.deferredAlarms, (r) => {
        const when = r[alarm.name];
        if (when === undefined || when > alarm.scheduledTime) return r;
        const next = { ...r };
        Reflect.deleteProperty(next, alarm.name);
        return next;
      })
      .catch((e: unknown) => {
        log('deferred alarms: clearing a fired alarm failed', e);
      });
  });
  restore(deps).catch((e: unknown) => {
    log('deferred alarms: restoring dropped alarms failed', e);
  });
}

/** T-36 self-registration (I-01). */
export function register(ctx: BackgroundContext): void {
  startDeferredAlarms({ repo: ctx.repo, alarms: ctx.alarms }, (message, error) => {
    console.error(`[ShopBadwill] ${message}`, error);
  });
}
