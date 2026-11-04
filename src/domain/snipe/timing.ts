// T-81: snipe timing. Pure: no clocks, timers or browser APIs; time is passed in.
// All instants are EpochMs. `offsetMs = server - local` (SgwClock port).
import type { EpochMs } from '../types';
import type { ComputeFireAt } from './types';

/** Clock samples taken at wake: 3, 20 s apart; the lowest-RTT one wins (SgwClock.offset()). */
export const CLOCK_SAMPLE_COUNT = 3;
export const CLOCK_SAMPLE_SPACING_MS = 20_000;
/** Clock-sample quality only (assessClock): a sample whose rtt is strictly above this is not usable. */
export const MAX_RTT_MS = 2000;
/** Abort when |offset| is strictly above this (5 min). */
export const MAX_CLOCK_OFFSET_MS = 300_000;

/**
 * R-2: latency is an anomaly only when the bid cannot be timed: the best verify
 * read slower than this, or a fire closer than FIRE_MIN_AHEAD_MS (below).
 */
export const LATENCY_ABORT_RTT_MS = 8000;
/** R-2: the planned fire must be at least this far ahead of server-now at the verify. */
export const FIRE_MIN_AHEAD_MS = 2000;

/**
 * R-2: how long a real send takes to reach SGW: the ShowBidModal round trip,
 * the snipe lane's gap (measured from the END of the modal read), then
 * PlaceBid's one way. Throws RangeError on a negative or non-finite input.
 */
export function sendChainMs(rttMs: number, gapMs: number): number {
  if (!Number.isFinite(rttMs) || rttMs < 0) throw new RangeError('sendChainMs: rttMs must be finite and >= 0');
  if (!Number.isFinite(gapMs) || gapMs < 0) throw new RangeError('sendChainMs: gapMs must be finite and >= 0');
  return rttMs + gapMs + rttMs / 2;
}

/**
 * Fire time in SERVER time: end - lead - sendChain (R-2: `sendChainMs`, so the
 * bid is RECEIVED about `lead` before the end). Throws RangeError on a negative
 * or non-finite input rather than silently clamping, since a bad latency means
 * the caller's clock data is broken.
 */
export const computeFireAt: ComputeFireAt = (endMs, leadMs, sendChain) => {
  if (!Number.isFinite(endMs) || !Number.isFinite(leadMs)) {
    throw new RangeError('computeFireAt: endMs and leadMs must be finite');
  }
  if (!Number.isFinite(sendChain) || sendChain < 0) {
    throw new RangeError('computeFireAt: the send chain must be finite and >= 0');
  }
  return endMs - leadMs - sendChain;
};

/** Convert a server-time instant to the local clock: local = server - offsetMs. */
export function toLocalFireAt(fireAtServer: EpochMs, offsetMs: number): EpochMs {
  return fireAtServer - offsetMs;
}

/** Sample instants (same timebase as `wakeAtMs`): wake, wake+20 s, wake+40 s. */
export function planClockSamples(wakeAtMs: EpochMs): EpochMs[] {
  return Array.from({ length: CLOCK_SAMPLE_COUNT }, (_, i) => wakeAtMs + i * CLOCK_SAMPLE_SPACING_MS);
}

export type ClockAbortReason = 'no-offset' | 'bad-rtt' | 'clock-skew';
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
  if (!(offset.rttMs >= 0 && offset.rttMs <= MAX_RTT_MS)) return { ok: false, reason: 'bad-rtt' };
  const sane = clockSanity(offset);
  if (!sane.ok) return sane;
  return { ok: true, offsetMs: offset.offsetMs, rttMs: offset.rttMs, oneWayMs: offset.rttMs / 2 };
}
