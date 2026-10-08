// T-81: snipe timing. Pure: no clocks, timers or browser APIs; time is passed in.
// All instants are EpochMs. `offsetMs = server - local` (SgwClock port).
import type { EpochMs } from '../types';
import type { ComputeFireAt } from './types';

/** Clock samples taken at wake: 3, 20 s apart; the lowest-RTT one wins (SgwClock.offset()). */
export const CLOCK_SAMPLE_COUNT = 3;
export const CLOCK_SAMPLE_SPACING_MS = 20_000;
/** Abort when rtt is strictly above this. */
export const MAX_RTT_MS = 2000;
/** Abort when |offset| is strictly above this (5 min). */
export const MAX_CLOCK_OFFSET_MS = 300_000;

/**
 * Fire time in SERVER time: end - lead - oneWay (oneWay = rtt/2 of the lowest-RTT
 * sample). Throws RangeError on a negative or non-finite input rather than
 * silently clamping, since a bad latency means the caller's clock data is broken.
 */
export const computeFireAt: ComputeFireAt = (endMs, leadMs, oneWayLatencyMs) => {
  if (!Number.isFinite(endMs) || !Number.isFinite(leadMs)) {
    throw new RangeError('computeFireAt: endMs and leadMs must be finite');
  }
  if (!Number.isFinite(oneWayLatencyMs) || oneWayLatencyMs < 0) {
    throw new RangeError('computeFireAt: oneWayLatencyMs must be finite and >= 0');
  }
  return endMs - leadMs - oneWayLatencyMs;
};

/** Convert a server-time instant to the local clock: local = server - offsetMs. */
export function toLocalFireAt(fireAtServer: EpochMs, offsetMs: number): EpochMs {
  return fireAtServer - offsetMs;
}

/** Sample instants (same timebase as `wakeAtMs`): wake, wake+20 s, wake+40 s. */
export function planClockSamples(wakeAtMs: EpochMs): EpochMs[] {
  return Array.from({ length: CLOCK_SAMPLE_COUNT }, (_, i) => wakeAtMs + i * CLOCK_SAMPLE_SPACING_MS);
}

export type ClockAbortReason = 'no-offset' | 'rtt-too-high' | 'clock-skew';
export type ClockSanityResult = { ok: true } | { ok: false; reason: 'clock-skew' };

/** Abort if |offset| > 5 min (exactly 5 min is allowed). Non-finite offsets abort. */
export function clockSanity(offset: { offsetMs: number }): ClockSanityResult {
  return Math.abs(offset.offsetMs) <= MAX_CLOCK_OFFSET_MS ? { ok: true } : { ok: false, reason: 'clock-skew' };
}

export interface ClockOffsetInput {
  offsetMs: number;
  rttMs: number;
  confidence: 'none' | 'low' | 'high';
}

export type ClockAssessment =
  | { ok: true; offsetMs: number; rttMs: number; oneWayMs: number }
  | { ok: false; reason: ClockAbortReason };

/** Gate on SgwClock.offset(): null or confidence none, rtt > 2 s, or insane skew abort. */
export function assessClock(offset: ClockOffsetInput | null): ClockAssessment {
  if (offset === null || offset.confidence === 'none') return { ok: false, reason: 'no-offset' };
  if (!(offset.rttMs <= MAX_RTT_MS)) return { ok: false, reason: 'rtt-too-high' };
  const sane = clockSanity(offset);
  if (!sane.ok) return sane;
  return { ok: true, offsetMs: offset.offsetMs, rttMs: offset.rttMs, oneWayMs: offset.rttMs / 2 };
}
