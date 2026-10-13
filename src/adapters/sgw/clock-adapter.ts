// T-29: SgwClock adapter (PLAN §3.3). Keeps recent server-time samples and
// reports the offset of the lowest-RTT one. It makes no HTTP calls; callers
// build samples (see the helpers below for the S-1 serverTime formats).
import type { Clock } from '../../ports/clock';
import type { SgwClock } from '../../ports/sgw-clock';
import type { ClockSample, EpochMs, PacificNaiveRaw } from '../../domain/types';
import { parsePacific, parsePacificDetailed } from '../../domain/time/pacific';

/** Samples older than this (by receivedAt) are dropped from every calculation. */
export const SAMPLE_TTL_MS = 30 * 60 * 1000;
/** "high" confidence needs at least this many live samples... */
export const HIGH_CONFIDENCE_MIN_SAMPLES = 3;
/** ...and an ms-precision winning sample with rtt at or below this. */
export const HIGH_CONFIDENCE_MAX_RTT_MS = 400;
const MAX_SAMPLES = 64;

/**
 * ClockSample has no precision field; precision follows the source (S-1):
 * itemDetail.serverTime carries ms, GetCurrentTime and the Date header are 1 s.
 */
function hasMsPrecision(s: ClockSample): boolean {
  return s.source === 'itemDetail';
}

/** Seconds-only servers truncate, so the true time is on average 500 ms later. */
const TRUNCATION_BIAS_MS = 500;
/** A seconds-only sample's RTT is penalised by the truncation window (1 s). */
const SECONDS_ONLY_PENALTY_MS = 1000;

const effectiveRtt = (s: ClockSample): number => s.rttMs + (hasMsPrecision(s) ? 0 : SECONDS_ONLY_PENALTY_MS);

const offsetOf = (s: ClockSample): number =>
  s.serverMs + (hasMsPrecision(s) ? 0 : TRUNCATION_BIAS_MS) - (s.sentAt + s.rttMs / 2);

/** True when `a` should win over `b`: lower effective RTT, then ms precision, then newer. */
function beats(a: ClockSample, b: ClockSample): boolean {
  const ea = effectiveRtt(a);
  const eb = effectiveRtt(b);
  if (ea !== eb) return ea < eb;
  if (hasMsPrecision(a) !== hasMsPrecision(b)) return hasMsPrecision(a);
  return a.receivedAt > b.receivedAt;
}

export class SgwClockAdapter implements SgwClock {
  private samples: ClockSample[] = [];

  constructor(private readonly clock: Pick<Clock, 'now'> = { now: () => Date.now() }) {}

  parsePacific(raw: PacificNaiveRaw): EpochMs {
    return parsePacific(raw);
  }

  parsePacificDetailed(raw: string): { ms: EpochMs; ambiguous: boolean; nonexistent: boolean } {
    return parsePacificDetailed(raw);
  }

  addSample(s: ClockSample): void {
    if (![s.serverMs, s.sentAt, s.receivedAt, s.rttMs].every(Number.isFinite)) return;
    this.prune();
    this.samples.push(s);
    if (this.samples.length > MAX_SAMPLES) {
      // Keep the best candidates; recency breaks ties via beats().
      this.samples.sort((a, b) => (beats(a, b) ? -1 : beats(b, a) ? 1 : 0));
      this.samples.length = MAX_SAMPLES;
    }
  }

  offset(): { offsetMs: number; rttMs: number; samples: number; confidence: 'none' | 'low' | 'high' } | null {
    this.prune();
    let best: ClockSample | undefined;
    for (const s of this.samples) if (!best || beats(s, best)) best = s;
    if (!best) return null;
    const high =
      this.samples.length >= HIGH_CONFIDENCE_MIN_SAMPLES &&
      hasMsPrecision(best) &&
      best.rttMs <= HIGH_CONFIDENCE_MAX_RTT_MS;
    return {
      offsetMs: offsetOf(best),
      rttMs: best.rttMs,
      samples: this.samples.length,
      confidence: high ? 'high' : 'low',
    };
  }

  serverNow(): EpochMs | null {
    const o = this.offset();
    return o ? this.clock.now() + o.offsetMs : null;
  }

  private prune(): void {
    const cutoff = this.clock.now() - SAMPLE_TTL_MS;
    this.samples = this.samples.filter((s) => s.receivedAt >= cutoff);
  }

  /**
   * ItemDetail `serverTime` (naive Pacific, ms precision, S-1 verdict 1) -> sample.
   * null for a malformed, impossible, ambiguous (fall-back) or nonexistent
   * (spring-forward) timestamp, or when receivedAt precedes sentAt.
   */
  sampleFromServerTime(raw: string, sentAt: EpochMs, receivedAt: EpochMs): ClockSample | null {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?$/.test(raw)) return null;
    return buildSample(raw, sentAt, receivedAt, 'itemDetail');
  }

  /**
   * `Dashboard/GetCurrentTime` `data` ("MM/dd/yyyy HH:mm:ss" Pacific, 1 s, S-1) -> sample.
   * null on any other shape, or for the same reasons as `sampleFromServerTime`.
   */
  sampleFromGetCurrentTime(data: string, sentAt: EpochMs, receivedAt: EpochMs): ClockSample | null {
    const m = /^(\d{2})\/(\d{2})\/(\d{4}) (\d{2}:\d{2}:\d{2})$/.exec(data);
    if (!m) return null;
    const [mm, dd, yyyy, hms] = [m[1] ?? '', m[2] ?? '', m[3] ?? '', m[4] ?? ''];
    return buildSample(`${yyyy}-${mm}-${dd}T${hms}`, sentAt, receivedAt, 'getCurrentTime');
  }
}

function buildSample(
  naive: string,
  sentAt: EpochMs,
  receivedAt: EpochMs,
  source: ClockSample['source'],
): ClockSample | null {
  if (!Number.isFinite(sentAt) || !Number.isFinite(receivedAt) || receivedAt < sentAt) return null;
  let parsed: { ms: number; ambiguous: boolean; nonexistent: boolean };
  try {
    parsed = parsePacificDetailed(naive);
  } catch {
    return null;
  }
  if (parsed.ambiguous || parsed.nonexistent || !Number.isFinite(parsed.ms)) return null;
  return { serverMs: parsed.ms, sentAt, receivedAt, rttMs: receivedAt - sentAt, source };
}
