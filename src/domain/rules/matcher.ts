// T-23 rule matcher (implements the `Evaluate` / `EvaluateBatch` contract types).
// Pure domain code: no browser imports; time comes only from `ctx.now`.
//
// Semantics
// - A disabled rule never matches. A rule with no conditions never matches.
// - A rule matches when every condition in `all` holds AND, if `any` is non-empty,
//   at least one condition in `any` holds.
// - A condition is true, false or unknown (data needed is missing: landed cost
//   not fetched, no seller state, no category id, or a keyword that failed to
//   compile). Unknown never holds and adds 1 to `unknownConditions` (once per
//   evaluated condition, enabled rules only).
// - `conditionIndex` in a reason indexes `all` first, then `any` continues at
//   `all.length`.
// - Precedence of `decision`: hide > highlight > watch > none.
// - seller / location: `include` matches when the seller or state IS in the list,
//   `exclude` when it is NOT (like keyword mode 'none'). A missing seller name
//   (with name lists) or missing sellerState makes the condition unknown.
// - category.includeChildren is treated as exact-id matching: a Listing has no
//   category tree to resolve children from.
import { formatMoney } from '../money';
import type { Cents, Listing } from '../types';

import { tryCompileKeyword, type KeywordMatcher } from './keywords';
import type { Condition, Evaluate, EvaluateBatch, MatchContext, MatchReason, MatchResult, Rule } from './schema';

type KeywordCondition = Extract<Condition, { kind: 'keyword' }>;
type KeywordField = KeywordCondition['fields'][number];

export interface RuleCompileError {
  ruleId: string;
  /** Same indexing as `MatchReason.conditionIndex`. */
  conditionIndex: number;
  error: string;
}

interface CompiledKeyword {
  matcher: KeywordMatcher;
  /** One matcher per term (mode 'any'), used only to explain a hit. */
  perTerm: { term: string; matcher: KeywordMatcher }[];
}

type CompiledEntry = CompiledKeyword | { error: string };

/** Compiled keyword conditions of one rule, by condition index. */
export type RuleCache = Map<number, CompiledEntry>;

function compileKeywordCondition(c: KeywordCondition): CompiledEntry {
  const whole = tryCompileKeyword(c);
  if (!whole.ok) return { error: whole.error };
  const perTerm: CompiledKeyword['perTerm'] = [];
  for (const term of c.terms) {
    if (term.trim() === '') continue;
    const one = tryCompileKeyword({ ...c, mode: 'any', terms: [term] });
    if (one.ok) perTerm.push({ term, matcher: one.matcher });
  }
  return { matcher: whole.matcher, perTerm };
}

export function compileRule(rule: Rule): RuleCache {
  const cache: RuleCache = new Map();
  [...rule.all, ...(rule.any ?? [])].forEach((c, i) => {
    if (c.kind === 'keyword') cache.set(i, compileKeywordCondition(c));
  });
  return cache;
}

/** Compile errors of a rule's keyword conditions, for the rule editor. */
export function ruleCompileErrors(rule: Rule, cache: RuleCache = compileRule(rule)): RuleCompileError[] {
  const out: RuleCompileError[] = [];
  for (const [conditionIndex, entry] of cache) {
    if ('error' in entry) out.push({ ruleId: rule.id, conditionIndex, error: entry.error });
  }
  return out.sort((a, b) => a.conditionIndex - b.conditionIndex);
}

type Outcome =
  | { state: 'true'; reason: Pick<MatchReason, 'field' | 'detail'> }
  | { state: 'false' }
  | { state: 'unknown' };

const NO: Outcome = { state: 'false' };
const UNKNOWN: Outcome = { state: 'unknown' };
const yes = (field: string, detail: string): Outcome => ({ state: 'true', reason: { field, detail } });

function range(min: number | undefined, max: number | undefined, fmt: (n: number) => string): string {
  const parts: string[] = [];
  if (min !== undefined) parts.push(`min ${fmt(min)}`);
  if (max !== undefined) parts.push(`max ${fmt(max)}`);
  return parts.length > 0 ? parts.join(', ') : 'any';
}

function inRange(v: number, min: number | undefined, max: number | undefined): boolean {
  return (min === undefined || v >= min) && (max === undefined || v <= max);
}

function fieldText(l: Listing, f: KeywordField): string | undefined {
  if (f === 'title') return l.title;
  if (f === 'category') return l.categoryPath;
  return l.sellerName;
}

function evalKeyword(c: KeywordCondition, l: Listing, entry: CompiledEntry | undefined): Outcome {
  if (entry === undefined || 'error' in entry) return UNKNOWN;
  const present = c.fields
    .map((f) => ({ f, text: fieldText(l, f) }))
    .filter((x): x is { f: KeywordField; text: string } => x.text !== undefined);
  if (present.length === 0) return UNKNOWN; // none of the selected fields has text
  // `holds` is the matcher's own verdict (for mode 'none' it means no term was found).
  // Joined so that mode 'none' means none of the fields and 'all' may span fields.
  const holds = entry.matcher.test(present.map((x) => x.text).join(' | '));
  // Some selected fields may be absent. A verdict is final only if more text
  // cannot change it: 'any' / 'all' are monotone (extra text only adds hits), so
  // a hit stands but a miss might flip; for 'none' a hit stands but a clean
  // result might flip. Otherwise the condition is unknown.
  const partial = present.length < c.fields.length;
  if (c.mode === 'none') {
    if (!holds) return NO;
    if (partial) return UNKNOWN;
  } else if (!holds) {
    return partial ? UNKNOWN : NO;
  }

  const shown = (t: string): string => (c.regex ? `/${t}/` : `"${t}"`);
  const suffix = c.wholeWord ? ' (whole word)' : '';
  if (c.mode === 'none') {
    const field = present.map((x) => x.f).join(', ');
    return yes(field, `${field} contains none of ${c.terms.map(shown).join(', ')}${suffix}`);
  }
  const hits = entry.perTerm.filter((t) => present.some((x) => t.matcher.test(x.text)));
  const hitFields = present.filter((x) => hits.some((t) => t.matcher.test(x.text))).map((x) => x.f);
  const field = (hitFields.length > 0 ? hitFields : present.map((x) => x.f)).join(', ');
  const terms = (hits.length > 0 ? hits.map((h) => h.term) : c.terms).map(shown).join(', ');
  const verb = c.regex ? 'matches' : 'contains';
  return yes(field, `${field} ${verb} ${c.mode === 'all' ? 'all of ' : ''}${terms}${suffix}`);
}

function evalCondition(c: Condition, l: Listing, ctx: MatchContext, entry: CompiledEntry | undefined): Outcome {
  switch (c.kind) {
    case 'keyword':
      return evalKeyword(c, l, entry);
    case 'price': {
      if (!inRange(l.currentPrice, c.min, c.max)) return NO;
      return yes('price', `price ${formatMoney(l.currentPrice)} (${range(c.min, c.max, formatMoney)})`);
    }
    case 'landedCost': {
      const v: Cents | null | undefined = ctx.landedCost?.(l.itemId);
      if (v === null || v === undefined) return UNKNOWN;
      if (!inRange(v, c.min, c.max)) return NO;
      return yes('landed cost', `landed cost ${formatMoney(v)} (${range(c.min, c.max, formatMoney)})`);
    }
    case 'seller': {
      const name = l.sellerName?.trim().toLowerCase();
      const byId = c.sellerIds.includes(l.sellerId);
      const byName = name !== undefined && c.sellerNames.some((n) => n.trim().toLowerCase() === name);
      const listed = byId || byName;
      // Without a seller name we cannot rule out a name-list hit.
      if (!listed && name === undefined && c.sellerNames.length > 0) return UNKNOWN;
      if (c.mode === 'exclude') return listed ? NO : yes('seller', `seller ${l.sellerName ?? `#${String(l.sellerId)}`} is not in excluded list`);
      if (!listed) return NO;
      return yes('seller', `seller is ${l.sellerName ?? `#${String(l.sellerId)}`} (included)`);
    }
    case 'location': {
      if (l.sellerState === undefined) return UNKNOWN;
      const listed = c.states.includes(l.sellerState);
      if (c.mode === 'exclude') {
        return listed ? NO : yes('seller location', `location ${l.sellerState} is not in excluded states`);
      }
      return listed ? yes('seller location', `seller location is ${l.sellerState} (included)`) : NO;
    }
    case 'category': {
      if (l.categoryId === undefined) return UNKNOWN;
      // No category tree on a Listing: `includeChildren` true or false both match the exact id.
      if (!c.categoryIds.includes(l.categoryId)) return NO;
      return yes('category', `category is ${l.categoryPath ?? `#${String(l.categoryId)}`}`);
    }
    case 'endsWithin': {
      const end = new Date(l.endTime).getTime(); // endTime is RFC 3339 with Z, already parsed from Pacific
      if (Number.isNaN(end)) return UNKNOWN;
      const minutes = (end - ctx.now) / 60_000;
      if (minutes < 0 || !inRange(minutes, c.minMinutes, c.maxMinutes)) return NO;
      const left = String(Math.round(minutes * 10) / 10);
      return yes('time left', `ends in ${left} min (${range(c.minMinutes, c.maxMinutes, (n) => `${String(n)} min`)})`);
    }
    case 'bidCount': {
      if (!inRange(l.numBids, c.min, c.max)) return NO;
      return yes('bids', `${String(l.numBids)} bids (${range(c.min, c.max, String)})`);
    }
    case 'pickupOnly': {
      if (l.pickupOnly === undefined) return UNKNOWN;
      if (l.pickupOnly !== c.value) return NO;
      return yes('pickup', c.value ? 'pickup only' : 'ships (not pickup only)');
    }
  }
}

interface RuleOutcome {
  matched: boolean;
  reasons: MatchReason[];
  unknown: number;
}

function evalRule(rule: Rule, l: Listing, ctx: MatchContext, cache: RuleCache): RuleOutcome {
  const any = rule.any ?? [];
  let unknown = 0;
  const reasons: MatchReason[] = [];
  const run = (c: Condition, index: number): boolean => {
    const o = evalCondition(c, l, ctx, cache.get(index));
    if (o.state === 'unknown') unknown++;
    if (o.state !== 'true') return false;
    reasons.push({ ruleId: rule.id, conditionIndex: index, ...o.reason });
    return true;
  };
  // No short-circuit: every unknown condition is counted.
  const allHold = rule.all.map((c, i) => run(c, i)).every(Boolean);
  const anyHits = any.map((c, i) => run(c, rule.all.length + i)).filter(Boolean).length;
  const matched = rule.all.length + any.length > 0 && allHold && (any.length === 0 || anyHits > 0);
  return { matched, reasons: matched ? reasons : [], unknown };
}

const RANK = { none: 0, watch: 1, highlight: 2, hide: 3 } as const;

function evaluateWith(listing: Listing, rules: Rule[], ctx: MatchContext, caches: Map<Rule, RuleCache>): MatchResult {
  const matched: MatchResult['matched'] = [];
  let unknownConditions = 0;
  let decision: MatchResult['decision'] = 'none';
  for (const rule of rules) {
    if (!rule.enabled) continue;
    let cache = caches.get(rule);
    if (cache === undefined) {
      cache = compileRule(rule);
      caches.set(rule, cache);
    }
    const r = evalRule(rule, listing, ctx, cache);
    unknownConditions += r.unknown;
    if (!r.matched) continue;
    matched.push({ ruleId: rule.id, action: rule.action, reasons: r.reasons });
    if (RANK[rule.action] > RANK[decision]) decision = rule.action;
  }
  return { itemId: listing.itemId, decision, matched, unknownConditions };
}

export const evaluate: Evaluate = (listing, rules, ctx) => evaluateWith(listing, rules, ctx, new Map());

/** Compiles each rule's keywords once for the whole batch. */
export const evaluateBatch: EvaluateBatch = (listings, rules, ctx) => {
  const caches = new Map<Rule, RuleCache>();
  return listings.map((l) => evaluateWith(l, rules, ctx, caches));
};
