// Contract v1 (T-02): PLAN §3.5 rule engine. The functions are exported as
// types only (I-08): T-22 implements `compileKeyword` (keywords.ts) and T-23
// `evaluate` / `evaluateBatch` (matcher.ts).
//
// Precedence: hide beats highlight beats watch; a disabled rule never
// matches; conditions in `all` are AND, `any` is OR, both must hold.
import { z } from 'zod';

import {
  CentsSchema,
  EpochMsSchema,
  ItemIdSchema,
  UsStateSchema,
  type Cents,
  type EpochMs,
  type ItemId,
  type Listing,
} from '../types';

const IncludeExcludeSchema = z.enum(['include', 'exclude']);

export const ConditionSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('keyword'),
    mode: z.enum(['any', 'all', 'none']),
    terms: z.array(z.string()),
    wholeWord: z.boolean(),
    regex: z.boolean(),
    fields: z.array(z.enum(['title', 'category', 'seller'])),
  }),
  z.object({ kind: z.literal('price'), min: CentsSchema.optional(), max: CentsSchema.optional() }),
  /** currentPrice + shipping + handling to home ZIP; unknown → the condition is 'unknown'. */
  z.object({ kind: z.literal('landedCost'), min: CentsSchema.optional(), max: CentsSchema.optional() }),
  z.object({
    kind: z.literal('seller'),
    mode: IncludeExcludeSchema,
    sellerIds: z.array(z.number().int()),
    sellerNames: z.array(z.string()),
  }),
  z.object({ kind: z.literal('location'), mode: IncludeExcludeSchema, states: z.array(UsStateSchema) }),
  z.object({ kind: z.literal('category'), categoryIds: z.array(z.number().int()), includeChildren: z.boolean() }),
  z.object({
    kind: z.literal('endsWithin'),
    minMinutes: z.number().nonnegative().optional(),
    maxMinutes: z.number().nonnegative().optional(),
  }),
  z.object({
    kind: z.literal('bidCount'),
    min: z.number().int().nonnegative().optional(),
    max: z.number().int().nonnegative().optional(),
  }),
  z.object({ kind: z.literal('pickupOnly'), value: z.boolean() }),
]);
export type Condition = z.infer<typeof ConditionSchema>;

export const RuleSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  enabled: z.boolean(),
  action: z.enum(['highlight', 'hide', 'watch']),
  tone: z.enum(['green', 'amber', 'blue']).optional(),
  all: z.array(ConditionSchema),
  any: z.array(ConditionSchema).optional(),
  createdAt: EpochMsSchema,
  updatedAt: EpochMsSchema,
});
export type Rule = z.infer<typeof RuleSchema>;

/** In-memory only (holds a function), so it has no schema. */
export interface MatchContext {
  now: EpochMs;
  /** undefined = not fetched. */
  landedCost?: (id: ItemId) => Cents | null | undefined;
}

/** e.g. detail "title contains 'pyrex' (whole word)". */
export const MatchReasonSchema = z.object({
  ruleId: z.string(),
  conditionIndex: z.number().int().nonnegative(),
  field: z.string(),
  detail: z.string(),
});
export type MatchReason = z.infer<typeof MatchReasonSchema>;

export const MatchResultSchema = z.object({
  itemId: ItemIdSchema,
  decision: z.enum(['hide', 'highlight', 'watch', 'none']),
  matched: z.array(
    z.object({ ruleId: z.string(), action: RuleSchema.shape.action, reasons: z.array(MatchReasonSchema) }),
  ),
  unknownConditions: z.number().int().nonnegative(),
});
export type MatchResult = z.infer<typeof MatchResultSchema>;

/** Implemented by T-23 (src/domain/rules/matcher.ts). */
export type Evaluate = (listing: Listing, rules: Rule[], ctx: MatchContext) => MatchResult;
/** Implemented by T-23 (src/domain/rules/matcher.ts). */
export type EvaluateBatch = (listings: Listing[], rules: Rule[], ctx: MatchContext) => MatchResult[];
/**
 * Implemented by T-22 (src/domain/rules/keywords.ts). Regex is RE2-safe-checked:
 * length ≤ 200, no nested quantifiers, 5 ms budget per test. Case-insensitive,
 * NFKC-normalised; `wholeWord` uses \b on word characters plus digits.
 */
export type CompileKeyword = (c: Extract<Condition, { kind: 'keyword' }>) => { test(text: string): boolean };
