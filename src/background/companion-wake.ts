// T-111 / T-111b: the companion's wake time, shared by companion-sync (which
// schedules it) and the snipe runner (which holds KeepAwake from it under T2).
// Outside jobs/ so it is not registered as a job, and so the runner need not
// import companion-sync (which imports the runner).
import { isoMs } from '../domain/snipe/preflight';
import { WAKE_BEFORE_FIRE_MS } from '../domain/snipe/state-machine';
import { computeFireAt } from '../domain/snipe/timing';
import type { Snipe } from '../domain/snipe/types';
import type { EpochMs } from '../domain/types';

/**
 * The companion wakes the computer this long before the runner's own T-5 min
 * wake: resume (S3 or hibernate), the browser launch, network-up and the
 * worker start all fit, and the runner's wake alarm then fires on time.
 */
export const COMPANION_WAKE_MARGIN_MS = 3 * 60_000;

/**
 * The companion's wake (local epoch ms) for a snipe: the runner's T-5 min wake
 * (`fireAt`, or the planned fire before the verify, minus the clock offset)
 * minus the margin. Null when the snipe's times are unusable.
 */
export function companionWakeAt(s: Snipe, fallbackOffsetMs: number): EpochMs | null {
  try {
    const fireServer = s.fireAt ?? computeFireAt(isoMs(s.endTime), s.leadMs, 0);
    const offset = s.measured?.offsetMs ?? fallbackOffsetMs;
    const at = fireServer - offset - WAKE_BEFORE_FIRE_MS - COMPANION_WAKE_MARGIN_MS;
    return Number.isFinite(at) ? at : null;
  } catch {
    return null;
  }
}
