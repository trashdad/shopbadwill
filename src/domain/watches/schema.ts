// Contract v1 (T-02): PLAN §3.6 watches and the daily job (with I-07's
// `notBefore`, `quote` and `postEnd` steps and `StepOutcome`; T-51 added the
// optional `JobRun.candidates`), and the §3.7 favorites reconciler. T-50 owns the watch helpers, T-51 the DailyJob, T-52
// the Scheduler and T-53 the FavoritesReconciler.
//
// Manual "Run now" uses lane `interactive`; scheduled and catch-up runs use
// lane `background`.
import { z } from 'zod';

import { DEFAULT_WATCH_FAVORITE_MODE } from '../settings/defaults';
import {
  CentsSchema,
  EpochMsSchema,
  FavoriteSchema,
  IsoUtcSchema,
  ItemDetailSchema,
  ItemIdSchema,
  ListingSchema,
  SearchQuerySchema,
  type EpochMs,
  type Favorite,
  type ItemId,
  type TrackedItem,
} from '../types';

/** sgw = favorite on SGW immediately; sgw-late = only within `favoriteWithinHours` of the end; local = track locally only. */
export const FavoriteModeSchema = z.enum(['sgw', 'sgw-late', 'local']);
export type FavoriteMode = z.infer<typeof FavoriteModeSchema>;

/** `Watch.seenItemIds` is a ring of this many ids (§3.6); T-50's helper keeps it. */
export const WATCH_SEEN_RING_SIZE = 2000;

export const WatchSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  enabled: z.boolean(),
  query: SearchQuerySchema,
  ruleIds: z.array(z.string()),
  maxPages: z.literal([1, 2, 3]),
  /** A new watch without one gets 'sgw' (§15 Q5, I-09). */
  favoriteMode: FavoriteModeSchema.default(DEFAULT_WATCH_FAVORITE_MODE),
  favoriteWithinHours: z.number().positive().optional(),
  calendar: z.boolean(),
  notify: z.boolean(),
  lastRunAt: EpochMsSchema.optional(),
  nextRunAt: EpochMsSchema,
  lastError: z.string().optional(),
  seenItemIds: z.array(ItemIdSchema),
});
export type Watch = z.infer<typeof WatchSchema>;

export const JobStepSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('search'), watchId: z.string().min(1), page: z.number().int().positive() }),
  z.object({ kind: z.literal('favoritesList') }),
  z.object({ kind: z.literal('detail'), itemId: ItemIdSchema, reason: z.enum(['new-match', 'calendar']) }),
  /** `notBefore` is set for 'sgw-late'. */
  z.object({
    kind: z.literal('favorite'),
    itemId: ItemIdSchema,
    watchId: z.string().min(1),
    notBefore: EpochMsSchema.optional(),
  }),
  /** Landed-cost quote, planned by T-51 (I-07). */
  z.object({ kind: z.literal('quote'), itemId: ItemIdSchema }),
  z.object({ kind: z.literal('calendarUpsert'), itemId: ItemIdSchema }),
  z.object({ kind: z.literal('notifyDigest') }),
  /** Outcome read ≥ 2 min after the end (T-103, I-07). */
  z.object({ kind: z.literal('postEnd'), itemId: ItemIdSchema }),
]);
export type JobStep = z.infer<typeof JobStepSchema>;

/** One variant per step kind (I-07, I-08), plus `deferred` and `error`. */
export const StepOutcomeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('search'), items: z.array(ListingSchema), total: z.number().int().nonnegative() }),
  z.object({ kind: z.literal('favoritesList'), items: z.array(FavoriteSchema) }),
  z.object({ kind: z.literal(['detail', 'postEnd']), detail: ItemDetailSchema }),
  z.object({
    kind: z.literal('quote'),
    quote: z.object({ shipping: CentsSchema, handling: CentsSchema }).nullable(),
  }),
  z.object({ kind: z.literal(['favorite', 'calendarUpsert', 'notifyDigest']), done: z.literal(true) }),
  /** `notBefore` not reached. */
  z.object({ kind: z.literal('deferred'), until: EpochMsSchema }),
  z.object({ kind: z.literal('error'), message: z.string(), retryable: z.boolean() }),
]);
export type StepOutcome = z.infer<typeof StepOutcomeSchema>;

/**
 * T-51 contract change (rulings R5): one item the daily job's two-pass
 * evaluation is working on. It lives in the run because the worker dies
 * between ticks. Not exported as a schema (validated through `JobRunSchema`).
 */
const JobCandidateSchema = z.object({
  itemId: ItemIdSchema,
  /** Watches whose search returned the item and whose optimistic pass selected it. */
  watchIds: z.array(z.string().min(1)).min(1),
  endTime: IsoUtcSchema,
  status: z.enum(['pending', 'matched', 'rejected', 'skipped-budget', 'failed']),
  /** The search row, kept until the strict pass decides. */
  row: ListingSchema.optional(),
  /** The fetched detail, kept until the strict pass decides. */
  detail: ItemDetailSchema.optional(),
  /** undefined = not quoted; null = no quote available. */
  quote: z.object({ shipping: CentsSchema, handling: CentsSchema }).nullable().optional(),
  /** Why rejected, skipped or a write withheld. Never param values or tokens. */
  note: z.string().optional(),
});
export type JobCandidate = z.infer<typeof JobCandidateSchema>;

export const JobRunSchema = z.object({
  id: z.string().min(1),
  trigger: z.enum(['scheduled', 'catch-up', 'manual']),
  startedAt: EpochMsSchema,
  finishedAt: EpochMsSchema.optional(),
  status: z.enum(['running', 'done', 'failed', 'paused']),
  steps: z.array(JobStepSchema),
  cursor: z.number().int().nonnegative(),
  results: z.object({
    newMatches: z.array(ItemIdSchema),
    favorited: z.array(ItemIdSchema),
    calendarUpserts: z.array(ItemIdSchema),
    errors: z.array(z.object({ step: z.number().int().nonnegative(), message: z.string() })),
  }),
  /** T-51 two-pass working state (R5); absent on runs written before it. */
  candidates: z.array(JobCandidateSchema).optional(),
});
export type JobRun = z.infer<typeof JobRunSchema>;

/** Pure state machine; the runner feeds it one step at a time. Implemented by T-51. */
export interface DailyJob {
  plan(watches: Watch[], now: EpochMs): JobRun;
  next(run: JobRun): JobStep | null;
  /** Returns a new run; may append steps (e.g. details for new matches). */
  apply(run: JobRun, step: JobStep, outcome: StepOutcome): JobRun;
}

/** Implemented by T-52 (src/background/jobs/scheduler.ts). */
export interface Scheduler {
  reconcile(now: EpochMs): Promise<void>;
  dueWatches(now: EpochMs): Promise<Watch[]>;
}

/** §3.7. Removal is never automatic. Implemented by T-53. */
export interface FavoritesReconciler {
  /**
   * Idempotent: 'add' only when favoriteState is 'none' or 'failed' AND the
   * item is not in `favorites` (the favoritesCache list) AND the watch mode
   * permits it now.
   */
  desired(
    tracked: TrackedItem[],
    watches: Watch[],
    now: EpochMs,
    favorites: readonly Favorite[],
  ): Array<{ itemId: ItemId; action: 'add' | 'none'; reason: string }>;
}
