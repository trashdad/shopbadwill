// T-83: the awake-history heartbeat. Registered on the scheduler's `onTick`
// hook (T-52 owns it, I-07; the `sbw:tick` alarm runs every 2 min). Records at
// most one heartbeat per HEARTBEAT_INTERVAL_MS (5 min) into `sbw:awake`, kept
// compact by the domain's `recordHeartbeat`. It makes no network request and
// calls no browser API directly: storage goes through the Repo, time through
// the Repo's Clock. T-52 does not exist yet, so the hook is passed in rather
// than imported; T-52/T-36 do the wiring.
import { HEARTBEAT_INTERVAL_MS, recordHeartbeat } from '../../domain/snipe/awake-history';
import type { Repo } from '../../domain/storage/repo';
import { STORAGE_KEYS } from '../../domain/storage/schema';

/** The scheduler hook: calls `cb` on every tick. Its return value is ignored. */
export type OnTick = (cb: () => Promise<void>) => unknown;

export interface HeartbeatDeps {
  /** Also the clock: `repo.now()`. */
  repo: Pick<Repo, 'now' | 'get' | 'set' | 'withLock'>;
}

/**
 * - 'stored': the record changed (a new 15-minute slot, or old entries pruned) and was written;
 * - 'same-slot': the slot already had a heartbeat (nothing written);
 * - 'throttled': less than 5 min since the last heartbeat (storage not touched);
 * - 'error': storage failed (swallowed so the tick loop carries on).
 */
export type BeatResult = 'stored' | 'same-slot' | 'throttled' | 'error';

export interface Heartbeat {
  beat(): Promise<BeatResult>;
}

export function createHeartbeat(deps: HeartbeatDeps): Heartbeat {
  const { repo } = deps;
  // In memory: a restarted worker simply beats on its first tick.
  let lastBeatAt: number | undefined;
  return {
    async beat(): Promise<BeatResult> {
      const now = repo.now();
      // A clock that moved backwards (now < lastBeatAt) beats again rather than going quiet.
      if (lastBeatAt !== undefined && now >= lastBeatAt && now - lastBeatAt < HEARTBEAT_INTERVAL_MS) {
        return 'throttled';
      }
      lastBeatAt = now;
      try {
        // Same lock name as Repo.update, so concurrent writers of sbw:awake serialise.
        return await repo.withLock(STORAGE_KEYS.awake, async (): Promise<BeatResult> => {
          const current = await repo.get(STORAGE_KEYS.awake);
          const next = recordHeartbeat(current, now);
          if (next === current) return 'same-slot';
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
