// Contract v1 (T-02): PLAN §3.9 snipe engine. The functions are exported as
// types only (I-08): T-80 implements `reduce` (state-machine.ts), T-81
// `computeFireAt` (timing.ts) and T-82 `checkCaps` (caps.ts). The SnipeHost
// port is in src/ports/snipe-host.ts.
import { z } from 'zod';

import { AuditEntrySchema } from '../audit/types';
import {
  BidResultSchema,
  CentsSchema,
  EpochMsSchema,
  IsoUtcSchema,
  ItemDetailSchema,
  ItemIdSchema,
  type Cents,
  type EpochMs,
} from '../types';

/** Key of `sbw:snipes` (§2.3). */
export const SnipeIdSchema = z.string().min(1);
export type SnipeId = z.infer<typeof SnipeIdSchema>;

export const SnipeStateSchema = z.enum([
  'draft',
  'armed',
  'fallback-applied',
  'waking',
  'verified',
  'firing',
  'sent',
  'resolved',
  'killed',
]);
export type SnipeState = z.infer<typeof SnipeStateSchema>;

export const SnipeOutcomeSchema = z.enum([
  'won',
  'outbid',
  'below-minimum',
  'auth',
  'network',
  'late',
  'ended',
  'extended',
  'cap-blocked',
  'killed',
  'dry-run',
  'fallback-proxy-placed',
  'skipped',
]);
export type SnipeOutcome = z.infer<typeof SnipeOutcomeSchema>;

/**
 * Snipe lead time in whole milliseconds: configurable 3–30 s (§3.9); the
 * default (8 s) is in settings/defaults.ts. `.int()` is strict: a computed
 * lead (e.g. T-90's clamp(p99 one-way latency + 5 s, 6 s, 15 s)) must be
 * rounded (Math.round) before it is stored or armed.
 */
export const LeadMsSchema = z.number().int().min(3000).max(30000);
export type LeadMs = z.infer<typeof LeadMsSchema>;

const FallbackSchema = z.enum(['early-proxy', 'skip']);

export const SnipeSchema = z.object({
  id: SnipeIdSchema,
  itemId: ItemIdSchema,
  title: z.string(),
  endTime: IsoUtcSchema,
  endTimeAtArm: IsoUtcSchema,
  sellerId: z.number().int().optional(),
  maxBid: CentsSchema,
  allInMax: CentsSchema.optional(),
  estShipping: CentsSchema.optional(),
  estHandling: CentsSchema.optional(),
  leadMs: LeadMsSchema,
  fallback: FallbackSchema,
  dryRun: z.boolean(),
  state: SnipeStateSchema,
  outcome: SnipeOutcomeSchema.optional(),
  outcomeDetail: z.string().optional(),
  armedAt: EpochMsSchema,
  fireAt: EpochMsSchema.optional(),
  wakeAlarm: z.string().optional(),
  attempt: z.object({
    sentAt: EpochMsSchema.optional(),
    idempotencyKey: z.string().optional(),
    ambiguous: z.boolean().optional(),
    /**
     * T-80 contract change: SGW's reply to this attempt's PlaceBid, recorded by
     * the reducer on `result` so the outcome read after it (even after a worker
     * restart) is judged with the reply (T-87). One reply per attempt: a
     * second `result`, or a `result` after `ambiguous`, is refused.
     */
    reply: BidResultSchema.optional(),
  }),
  measured: z
    .object({
      offsetMs: z.number().optional(),
      rttMs: z.number().nonnegative().optional(),
      firedAt: EpochMsSchema.optional(),
      responseAt: EpochMsSchema.optional(),
    })
    .optional(),
  groupId: z.string().optional(),
  history: z.array(
    z.object({ at: EpochMsSchema, from: SnipeStateSchema, to: SnipeStateSchema, why: z.string() }),
  ),
});
export type Snipe = z.infer<typeof SnipeSchema>;

const now = EpochMsSchema;
export const SnipeEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('arm'), now }),
  z.object({ type: z.literal('disarm'), now, by: z.enum(['user', 'kill', 'anomaly']), why: z.string() }),
  z.object({ type: z.literal('wake'), now }),
  z.object({
    type: z.literal('verified'),
    now,
    detail: ItemDetailSchema,
    offsetMs: z.number(),
    rttMs: z.number().nonnegative(),
  }),
  z.object({
    type: z.literal('verify-failed'),
    now,
    reason: z.enum(['ended', 'extended', 'price-over-max', 'already-high', 'auth', 'network', 'clock', 'cap']),
  }),
  z.object({ type: z.literal('fire'), now }),
  z.object({ type: z.literal('sent'), now, key: z.string().min(1) }),
  z.object({ type: z.literal('result'), now, result: BidResultSchema }),
  z.object({ type: z.literal('ambiguous'), now }),
  z.object({ type: z.literal('post-read'), now, detail: ItemDetailSchema }),
  z.object({ type: z.literal('preflight-failed'), now, reason: z.string() }),
  z.object({ type: z.literal('apply-fallback'), now, mode: FallbackSchema }),
]);
export type SnipeEvent = z.infer<typeof SnipeEventSchema>;

/**
 * What the pure reducer asks the runner (T-84) to do. §3.9 fixes the kinds
 * and `snipeId`; the per-kind payloads are T-02's (I-08).
 */
export const EffectSchema = z.discriminatedUnion('kind', [
  /** Create the `sbw:snipe:<id>:wake` alarm at `at`. */
  z.object({ kind: z.literal('scheduleWake'), snipeId: SnipeIdSchema, at: EpochMsSchema }),
  /** Hold (`true`) or release (`false`) KeepAwake; the runner ignores it unless tier T1 is enabled. */
  z.object({ kind: z.literal('holdKeepAwake'), snipeId: SnipeIdSchema, hold: z.boolean() }),
  /** Take clock samples per T-81's policy; the runner reports back with `verified` / `verify-failed`. */
  z.object({ kind: z.literal('sampleClock'), snipeId: SnipeIdSchema }),
  /**
   * Read ItemDetail on lane `snipe`; the runner then dispatches:
   * - `verify` (the T−60 s read) → `verified`, or `verify-failed` with its reason;
   * - `post-read` (the outcome read after `sent`, a `result` or `ambiguous`) → `post-read`;
   * - `measure` (dry run only: the harmless read at fire time, in place of
   *   PlaceBid, that measures real latency) → `post-read` with the detail it
   *   read; the reducer resolves the snipe with outcome 'dry-run'.
   */
  z.object({
    kind: z.literal('readDetail'),
    snipeId: SnipeIdSchema,
    purpose: z.enum(['verify', 'post-read', 'measure']),
  }),
  /**
   * Send PlaceBid at most once; `amount` is derived only from `Snipe.maxBid`.
   * The runner (T-101's SendStrategy) generates the idempotency key, persists
   * it as `attempt.idempotencyKey` and dispatches `sent { key }` BEFORE the
   * request leaves, so a restarted worker treats the attempt as sent (§3.9
   * idempotency rule); then it dispatches `result` or `ambiguous`.
   */
  z.object({ kind: z.literal('placeBid'), snipeId: SnipeIdSchema, amount: CentsSchema }),
  z.object({ kind: z.literal('notify'), snipeId: SnipeIdSchema, title: z.string(), message: z.string() }),
  /** `CalendarSink.stamp(itemId, outcome, finalPrice)`. */
  z.object({
    kind: z.literal('stampCalendar'),
    snipeId: SnipeIdSchema,
    outcome: z.enum(['won', 'lost', 'ended-early']),
    finalPrice: CentsSchema.optional(),
  }),
  /** `AuditLog.append(entry)`. */
  z.object({
    kind: z.literal('audit'),
    snipeId: SnipeIdSchema,
    entry: AuditEntrySchema.omit({ seq: true, at: true }),
  }),
  /** Place the early proxy bid now (fallback policy); `amount` is derived only from `Snipe.maxBid`. */
  z.object({ kind: z.literal('applyFallbackProxy'), snipeId: SnipeIdSchema, amount: CentsSchema }),
  /** Ask the user to re-arm (e.g. after an extended end). */
  z.object({ kind: z.literal('proposeRearm'), snipeId: SnipeIdSchema }),
]);
export type Effect = z.infer<typeof EffectSchema>;

export const CapsCheckSchema = z.object({
  perItemMax: CentsSchema,
  perDayMax: CentsSchema,
  openExposureMax: CentsSchema,
  typoMultiplier: z.literal(3),
  typoAbsolute: CentsSchema,
});
export type CapsCheck = z.infer<typeof CapsCheckSchema>;

export const CapsResultSchema = z.object({ ok: z.boolean(), violations: z.array(z.string()) });
export type CapsResult = z.infer<typeof CapsResultSchema>;

/** Pure; the caller runs `checkCaps` first and passes its result (I-08). Implemented by T-80. */
export type Reduce = (s: Snipe, e: SnipeEvent, capsResult: CapsResult) => { next: Snipe; effects: Effect[] };
/** end − lead − oneWay; oneWay = rtt/2 of the lowest-RTT sample. Implemented by T-81. */
export type ComputeFireAt = (endMs: EpochMs, leadMs: number, oneWayLatencyMs: number) => EpochMs;
/** Implemented by T-82. */
export type CheckCaps = (s: Snipe, others: Snipe[], spentToday: Cents, caps: CapsCheck) => CapsResult;
