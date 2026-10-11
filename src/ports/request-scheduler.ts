// Contract v1 (T-02): PLAN §3.4 request scheduler / rate limiter. Implemented
// by T-25 (src/adapters/sgw/request-scheduler.ts). Lane, LaneConfig and
// DEFAULT_LANES are in src/domain/types.ts.
//
// Backoff: on 429 or 5xx, lane backoff = min(2^n × 30 s, 30 min) with jitter;
// on 403, backoff 1 h and mark `blocked`; three consecutive 403s on any lane
// pause all lanes 6 h and notify. Budgets reset at local midnight.
// considerateMode 'tight' halves every budget and doubles every interval.
import type { EpochMs, Lane, RequestSchedulerStats } from '../domain/types';
import type { HttpRequest, HttpResponse } from './http';

export interface ScheduledRequest<T> {
  lane: Lane;
  /** Config key. */
  endpoint: string;
  /** Cache key. */
  key?: string;
  cacheTtlMs?: number;
  priority?: number;
  build(): HttpRequest;
  /** Runs zod; throws SgwApiError('schema'). */
  parse(res: HttpResponse): T;
}

export interface RequestScheduler {
  run<T>(r: ScheduledRequest<T>): Promise<T>;
  stats(): RequestSchedulerStats;
  /** Set by health failure, 403/429 bursts, considerate mode. */
  pause(reason: string, untilMs?: EpochMs): void;
  resume(): void;
}
