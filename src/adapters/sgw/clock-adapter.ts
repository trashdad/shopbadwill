// T-29: SgwClock adapter (PLAN ยง3.3). Keeps recent server-time samples and
// reports the offset of the lowest-RTT one. It makes no HTTP calls; callers
// build samples (see the helpers below for the S-1 serverTime formats).
import type { Clock } from '../../ports/clock';
import type { SgwClock } from '../../ports/sgw-clock';
import type { ClockSample, EpochMs, PacificNaiveRaw } from '../../domain/types';

/** Samples older than this (by receivedAt) are dropped from every calculation. */
export const SAMPLE_TTL_MS = 30 * 60 * 1000;
/** "high" confidence needs at least this many live samples... */
export const HIGH_CONFIDENCE_MIN_SAMPLES = 3;
/** ...and a winning sample with rtt at or below this. */
export const HIGH_CONFIDENCE_MAX_RTT_MS = 400;
const MAX_SAMPLES = 64;

/**
 * ClockSample has no precision field; precision follows the source (S-1):
 * itemDetail.serverTime carries ms, GetCurrentTime and the Date header are 1 s.
 */
function hasMsPrecision(s: ClockSample): boolean {
  return s.source === 'itemDetail';
}

const offsetOf = (s: ClockSample): number => s.serverMs - (s.sentAt + s.rttMs / 2);

/** True when `a` should win over `b`: lower RTT, then ms precision, then newer. */
function beats(a: ClockSample, b: ClockSample): boolean {
  if (a.rttMs !== b.rttMs) return a.rttMs < b.rttMs;
  if (hasMsPrecision(a) !== hasMsPrecision(b)) return hasMsPrecision(a);
  return a.receivedAt > b.receivedAt;
}

/**
 * T-20's Pacific parser, injected because the layer rule (PLAN ง2.1) forbids
 * src/adapters from importing src/domain/time. The composition root passes
 * `{ parsePacific, parsePacificDetailed }` from `domain/time/pacific`.
 */
export interface PacificParser {
  parsePacific(raw: string): number;
  parsePacificDetailed(raw: string): { ms: number; ambiguous: boolean; nonexistent: boolean };
}

export class SgwClockAdapter implements SgwClock {
  private samples: ClockSample[] = [];

  constructor(
    private readonly pacific: PacificParser,
    private readonly clock: Pick<Clock, 'now'> = { now: () => Date.now() },
  ) {}

  parsePacific(raw: PacificNaiveRaw): EpochMs {
    return this.pacific.parsePacific(raw);
  }

  parsePacificDetailed(raw: string): { ms: EpochMs; ambiguous: boolean; nonexistent: boolean } {
    return this.pacific.parsePacificDetailed(raw);
  }

  addSample(s: ClockSample): void {
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
    const high = this.samples.length >= HIGH_CONFIDENCE_MIN_SAMPLES && best.rttMs <= HIGH_CONFIDENCE_MAX_RTT_MS;
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
   * null when the string is not a naive Pacific timestamp.
   */
  sampleFromServerTime(raw: string, sentAt: EpochMs, receivedAt: EpochMs): ClockSample | null {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?$/.test(raw)) return null;
    return {
      serverMs: this.pacific.parsePacific(raw),
      sentAt,
      receivedAt,
      rttMs: Math.max(0, receivedAt - sentAt),
      source: 'itemDetail',
    };
  }

  /**
   * `Dashboard/GetCurrentTime` `data` ("MM/dd/yyyy HH:mm:ss" Pacific, 1 s, S-1) -> sample.
   * null on any other shape.
   */
  sampleFromGetCurrentTime(data: string, sentAt: EpochMs, receivedAt: EpochMs): ClockSample | null {
    const m = /^(\d{2})\/(\d{2})\/(\d{4}) (\d{2}:\d{2}:\d{2})$/.exec(data);
    if (!m) return null;
    const [mm, dd, yyyy, hms] = [m[1] ?? '', m[2] ?? '', m[3] ?? '', m[4] ?? ''];
    return {
      serverMs: this.pacific.parsePacific(`${yyyy}-${mm}-${dd}T${hms}`),
      sentAt,
      receivedAt,
      rttMs: Math.max(0, receivedAt - sentAt),
      source: 'getCurrentTime',
    };
  }
}
