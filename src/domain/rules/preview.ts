// T-23 rule preview for the rule editor: what would this rule do to these listings?
// Pure domain code. Previews a rule even when it is disabled.
import type { Listing } from '../types';

import { compileRule, evaluateBatch, ruleCompileErrors, type RuleCompileError } from './matcher';
import type { MatchContext, MatchResult, Rule } from './schema';

export interface RulePreview {
  /** One result per input listing, evaluated against this rule alone. */
  results: MatchResult[];
  matchedItemIds: Listing['itemId'][];
  matchCount: number;
  /** Listings with at least one unknown condition (e.g. landed cost not fetched). */
  unknownCount: number;
  /** Per-term keyword compile errors for the editor to show. */
  compileErrors: RuleCompileError[];
}

export function preview(rule: Rule, listings: Listing[], ctx: MatchContext): RulePreview {
  const enabled: Rule = rule.enabled ? rule : { ...rule, enabled: true };
  const results = evaluateBatch(listings, [enabled], ctx);
  const matchedItemIds = results.filter((r) => r.matched.length > 0).map((r) => r.itemId);
  return {
    results,
    matchedItemIds,
    matchCount: matchedItemIds.length,
    unknownCount: results.filter((r) => r.unknownConditions > 0).length,
    compileErrors: ruleCompileErrors(rule, compileRule(rule)),
  };
}
