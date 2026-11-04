// T-83: the awake-history heartbeat. Registered on the scheduler's `onTick`
// hook (T-52 owns it, I-07; the `sbw:tick` alarm runs every 2 min). Records
// one heartbeat per 5-minute cell into `sbw:awake`, kept compact by the
// domain's `recordHeartbeat`. Spacing comes from the persisted ring (its latest
// entry), not from memory, so an MV3 worker restart neither doubles a beat nor
// drifts. It makes no network request and calls no browser API directly:
// storage goes through the Repo, time through the Repo's Clock. T-36 wires it
// through register(ctx) below onto ctx.ticks, the tick hub T-52 drives.
import { heartbeatDue, recordHeartbeat } from '../../domain/snipe/awake-history';
import type { Repo } from '../../domain/storage/repo';
import { STORAGE_KEYS } from '../../domain/storage/schema';
import type { BackgroundContext } from '../context';

/** The scheduler hook: calls `cb` on every tick. Its return value is ignored. */
export type OnTick = (cb: () => Promise<void>) => unknown;

export interface HeartbeatDeps {
  /** Also the clock: `repo.now()`. */
  repo: Pick<Repo, 'now' | 'get' | 'set' | 'withLock'>;
}

/**
 * - 'stored': a heartbeat was recorded and written;
 * - 'throttled': the latest stored heartbeat is in the same 5-minute cell (nothing written);
 * - 'error': storage failed (swallowed so the tick loop carries on).
 */
export type BeatResult = 'stored' | 'throttled' | 'error';

export interface Heartbeat {
  beat(): Promise<BeatResult>;
}

export function createHeartbeat(deps: HeartbeatDeps): Heartbeat {
  const { repo } = deps;
  return {
    async beat(): Promise<BeatResult> {
      const now = repo.now();
      try {
        // Same lock name as Repo.update, so concurrent writers of sbw:awake serialise.
        return await repo.withLock(STORAGE_KEYS.awake, async (): Promise<BeatResult> => {
          const current = await repo.get(STORAGE_KEYS.awake);
          if (!heartbeatDue(current, now)) return 'throttled';
          const next = recordHeartbeat(current, now);
          if (next === current) return 'throttled';
          await repo.set(STORAGE_KEYS.awake, next);
          return 'stored';
        });
      } catch {
        return 'error';
      }
    },
  };
}

/** Registers the heartbeat on the scheduler's tick hook. Returns it (for tests and diagnostics). */
export function registerHeartbeat(onTick: OnTick, deps: HeartbeatDeps): Heartbeat {
  const heartbeat = createHeartbeat(deps);
  onTick(async () => {
    await heartbeat.beat();
  });
  return heartbeat;
}

/** T-36 self-registration (I-01): one heartbeat per scheduler tick (ctx.ticks, driven by T-52). */
export function register(ctx: BackgroundContext): void {
  registerHeartbeat((cb) => ctx.ticks.onTick(cb), { repo: ctx.repo });
}
