// T-90: the dry-run soak rule and timing diagnostics, pure (PLAN §6, R2).
// No clock, no I/O, no randomness: every value comes in on the snipe.
//
// The lead rule (PLAN §693): after the soak, the default becomes
//   clamp(p99 one-way latency + 5 s, 6 s, 15 s),
// where "one-way latency" is half the measure-read round trip the runner
// persisted (responseAt − firedAt). The recommendation NEVER writes
// `defaultLeadMs` by itself (R2): the Timing page shows it, and only the
// user's click on "Apply" writes it. `LeadMsSchema` is `.int()`, so the
// recommendation is Math.round-ed before the clamp.
//
// Percentiles use the NEAREST-RANK method (documented here because the card
// requires the method to be documented and tested): after sorting the values
// ascending, the p-th percentile is the ⌈p/100 × n⌉-th smallest value (1-based).
// It is the smallest value that is at least p% of the values; for the
// 1..100 example, p50 = 50, p95 = 95 and p99 = 99 exactly.
import type { Snipe } from './types';

/** On-time means the fire error is within this of the planned fire, inclusive (R2). */
export const ON_TIME_TOLERANCE_MS = 1000;
/** The recommended lead never goes below this (R2). */
export const RECOMMENDED_LEAD_MIN_MS = 6000;
/** The recommended lead never goes above this (R2). */
export const RECOMMENDED_LEAD_MAX_MS = 15000;
/** Added to the p99 one-way latency (PLAN §693). */
export const RECOMMENDED_LEAD_PAD_MS = 5000;

/**
 * The p-th percentile (nearest-rank, see the file header), or null when there
 * are no (finite) values. Never mutates its input.
 */
export function percentile(values: readonly number[], p: number): number | null {
  if (!(Number.isFinite(p) && p > 0 && p <= 100)) throw new RangeError(`p must be in (0, 100], got ${String(p)}`);
  const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[rank - 1] as number;
}

/**
 * The fire error in ms: when the fire actually happened (server time, the
 * runner's `measured.firedAt`) minus the planned fire (`fireAt`, server time).
 * Null when either was never persisted.
 */
export function fireErrorMs(s: Snipe): number | null {
  const firedAt = s.measured?.firedAt;
  if (s.fireAt === undefined || firedAt === undefined || !Number.isFinite(firedAt)) return null;
  return firedAt - s.fireAt;
}

/**
 * The measure-read round trip in ms: `responseAt − firedAt` (both are server
 * time, so the offset cancels and this is the real elapsed latency of the
 * dry-run read at fire time). Null when either was never persisted.
 */
export function measureLatencyMs(s: Snipe): number | null {
  const firedAt = s.measured?.firedAt;
  const responseAt = s.measured?.responseAt;
  if (firedAt === undefined || responseAt === undefined || !Number.isFinite(firedAt) || !Number.isFinite(responseAt)) {
    return null;
  }
  return responseAt - firedAt;
}

/** On-time means |fire error| ≤ 1 s, the boundary included (R2, R5). */
export function isOnTime(errorMs: number): boolean {
  return Math.abs(errorMs) <= ON_TIME_TOLERANCE_MS;
}

/**
 * The rule that sets the lead from the soak: clamp(p99 one-way latency + 5 s,
 * 6 s, 15 s), rounded to a whole millisecond. Null when there are no samples.
 */
export function recommendLeadMs(oneWayLatencySamplesMs: readonly number[]): number | null {
  const p99 = percentile(oneWayLatencySamplesMs, 99);
  if (p99 === null) return null;
  const raw = Math.round(p99 + RECOMMENDED_LEAD_PAD_MS);
  return Math.min(RECOMMENDED_LEAD_MAX_MS, Math.max(RECOMMENDED_LEAD_MIN_MS, raw));
}

/**
 * One snipe's timing columns, timing data plus the snipe id only. Never any
 * bid amount (R4): the export and the table read exactly these fields.
 * `alarmDelayMs` is always null: the runner never persisted an alarm delay
 * (R3), so the page shows "not recorded" for that column and the gap is
 * reported.
 */
export interface TimingMeasurements {
  snipeId: string;
  /** The T−60 s verify's measured clock offset (server − local), when it ran. */
  offsetMs: number | null;
  /** The T−60 s verify's round trip, when it ran. */
  rttMs: number | null;
  /** firedAt − fireAt (server time). */
  fireErrorMs: number | null;
  /** Never persisted (R3): always null, "not recorded". */
  alarmDelayMs: null;
  /** The dry-run measure read's round trip (responseAt − firedAt). */
  latencyMs: number | null;
  /** isOnTime(fireErrorMs), or null when the snipe never fired. */
  onTime: boolean | null;
}

export function timingMeasurements(s: Snipe): TimingMeasurements {
  const error = fireErrorMs(s);
  return {
    snipeId: s.id,
    offsetMs: s.measured?.offsetMs ?? null,
    rttMs: s.measured?.rttMs ?? null,
    fireErrorMs: error,
    alarmDelayMs: null,
    latencyMs: measureLatencyMs(s),
    onTime: error === null ? null : isOnTime(error),
  };
}

/** The soak summary the Timing page renders (fires attempted, on-time %, p50/p95/p99). */
export interface SoakSummary {
  /** Dry-run snipes that reached the fire (a persisted firedAt). */
  firesAttempted: number;
  /** Of those, how many have a measure-read latency sample. */
  latencySamples: number;
  /** Fires with |error| ≤ 1 s. */
  onTime: number;
  offTime: number;
  /** onTime / firesAttempted; 0 when nothing fired. */
  onTimeRate: number;
  /** Nearest-rank percentiles of the measure-read round trips (ms); null with no samples. */
  p50Ms: number | null;
  p95Ms: number | null;
  p99Ms: number | null;
  /** clamp(p99 one-way + 5 s, 6 s, 15 s); null with no samples. */
  recommendedLeadMs: number | null;
}

/**
 * The soak summary over the dry-run snipes. A live snipe's fire is not part of
 * the soak (the live gate and A-4 judge the dry runs), and a dry-run snipe
 * that never fired is not attempted.
 */
export function soakSummary(snipes: readonly Snipe[]): SoakSummary {
  let firesAttempted = 0;
  let onTime = 0;
  const latencies: number[] = [];
  for (const s of snipes) {
    if (!s.dryRun) continue;
    const error = fireErrorMs(s);
    if (error === null) continue;
    firesAttempted += 1;
    if (isOnTime(error)) onTime += 1;
    const latency = measureLatencyMs(s);
    if (latency !== null) latencies.push(latency);
  }
  return {
    firesAttempted,
    latencySamples: latencies.length,
    onTime,
    offTime: firesAttempted - onTime,
    onTimeRate: firesAttempted === 0 ? 0 : onTime / firesAttempted,
    p50Ms: percentile(latencies, 50),
    p95Ms: percentile(latencies, 95),
    p99Ms: percentile(latencies, 99),
    recommendedLeadMs: recommendLeadMs(latencies.map((rtt) => rtt / 2)),
  };
}
