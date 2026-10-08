// Contract v1 (T-02): PLAN §3.3 SgwClock port. Implemented by T-29
// (src/adapters/sgw/clock-adapter.ts) over T-20's Pacific time module.
import type { ClockSample, EpochMs, PacificNaiveRaw } from '../domain/types';

export interface SgwClock {
  /** Resolves fall-back ambiguity to the EARLIER instant (see parsePacificDetailed for the flags). */
  parsePacific(raw: PacificNaiveRaw): EpochMs;
  parsePacificDetailed(raw: string): { ms: EpochMs; ambiguous: boolean; nonexistent: boolean };
  addSample(s: ClockSample): void;
  /** The lowest-RTT sample wins; null before any sample. */
  offset(): { offsetMs: number; rttMs: number; samples: number; confidence: 'none' | 'low' | 'high' } | null;
  serverNow(): EpochMs | null;
}
