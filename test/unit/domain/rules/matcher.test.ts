import { describe, expect, it, vi } from 'vitest';

import { evaluate, evaluateBatch } from '../../../../src/domain/rules/matcher';
import { preview } from '../../../../src/domain/rules/preview';
import * as keywords from '../../../../src/domain/rules/keywords';
import type { Condition, MatchContext, Rule } from '../../../../src/domain/rules/schema';
import type { Listing } from '../../../../src/domain/types';

const NOW = Date.parse('2026-10-08T00:00:00Z');

const listing = (o: Partial<Listing> = {}): Listing => ({
  itemId: 100,
  title: 'Vintage Pyrex Bowl Set',
  currentPrice: 1500,
  startingMinimumBid: 99,
  numBids: 3,
  endTime: '2026-10-08T01:00:00.000Z',
  endTimeRaw: '2026-10-07T18:00:00',
  sellerId: 7,
  sellerName: 'GlassHouse',
  sellerState: 'AZ',
  categoryId: 55,
  categoryPath: 'Collectibles > Glass',
  shippingPrice: null,
  pickupOnly: false,
  source: 'api',
  observedAt: NOW,
  ...o,
});

const rule = (c: Condition[], o: Partial<Rule> = {}): Rule => ({
  id: 'r1',
  name: 'rule',
  enabled: true,
  action: 'highlight',
  all: c,
  createdAt: 0,
  updatedAt: 0,
  ...o,
});

const kw = (terms: string[], o: Partial<Extract<Condition, { kind: 'keyword' }>> = {}): Condition => ({
  kind: 'keyword',
  mode: 'any',
  terms,
  wholeWord: false,
  regex: false,
  fields: ['title'],
  ...o,
});

const ctx: MatchContext = { now: NOW };

interface Case {
  name: string;
  cond: Condition;
  l?: Partial<Listing>;
  c?: MatchContext;
  match: boolean;
  unknown?: number;
  reason?: { field: string; detail: string };
}

const cases: Case[] = [
  { name: 'keyword any hit', cond: kw(['pyrex']), match: true, reason: { field: 'title', detail: 'title contains "pyrex"' } },
  { name: 'keyword any miss', cond: kw(['corelle']), match: false },
  { name: 'keyword all hit', cond: kw(['pyrex', 'bowl'], { mode: 'all' }), match: true, reason: { field: 'title', detail: 'title contains all of "pyrex", "bowl"' } },
  { name: 'keyword all miss', cond: kw(['pyrex', 'plate'], { mode: 'all' }), match: false },
  { name: 'keyword none clean', cond: kw(['broken'], { mode: 'none' }), match: true },
  { name: 'keyword none hit', cond: kw(['pyrex'], { mode: 'none' }), match: false },
  { name: 'keyword whole word miss', cond: kw(['bow'], { wholeWord: true }), match: false },
  { name: 'keyword whole word reason', cond: kw(['bowl'], { wholeWord: true }), match: true, reason: { field: 'title', detail: 'title contains "bowl" (whole word)' } },
  { name: 'keyword regex hit', cond: kw(['py.ex'], { regex: true }), match: true, reason: { field: 'title', detail: 'title matches /py.ex/' } },
  { name: 'keyword category field', cond: kw(['glass'], { fields: ['category'] }), match: true, reason: { field: 'category', detail: 'category contains "glass"' } },
  { name: 'keyword seller field', cond: kw(['glasshouse'], { fields: ['seller'] }), match: true, reason: { field: 'seller', detail: 'seller contains "glasshouse"' } },
  { name: 'keyword bad regex is unknown', cond: kw(['(a)\\1'], { regex: true }), match: false, unknown: 1 },
  { name: 'kw any: all fields missing', cond: kw(['x'], { fields: ['seller'] }), l: { sellerName: undefined }, match: false, unknown: 1 },
  { name: 'kw all: all fields missing', cond: kw(['x'], { mode: 'all', fields: ['category'] }), l: { categoryPath: undefined }, match: false, unknown: 1 },
  { name: 'kw none: all fields missing', cond: kw(['x'], { mode: 'none', fields: ['seller', 'category'] }), l: { sellerName: undefined, categoryPath: undefined }, match: false, unknown: 1 },
  { name: 'kw any partial: hit on present stands', cond: kw(['pyrex'], { fields: ['title', 'seller'] }), l: { sellerName: undefined }, match: true },
  { name: 'kw any partial: miss is unknown', cond: kw(['zzz'], { fields: ['title', 'seller'] }), l: { sellerName: undefined }, match: false, unknown: 1 },
  { name: 'kw all partial: hit on present stands', cond: kw(['pyrex'], { mode: 'all', fields: ['title', 'seller'] }), l: { sellerName: undefined }, match: true },
  { name: 'kw all partial: miss is unknown', cond: kw(['pyrex', 'zzz'], { mode: 'all', fields: ['title', 'seller'] }), l: { sellerName: undefined }, match: false, unknown: 1 },
  { name: 'kw none partial: hit on present is final no', cond: kw(['pyrex'], { mode: 'none', fields: ['title', 'seller'] }), l: { sellerName: undefined }, match: false },
  { name: 'kw none partial: clean is unknown', cond: kw(['zzz'], { mode: 'none', fields: ['title', 'seller'] }), l: { sellerName: undefined }, match: false, unknown: 1 },
  { name: 'kw none all present: clean matches', cond: kw(['zzz'], { mode: 'none', fields: ['title', 'seller'] }), match: true },
  { name: 'price == max', cond: { kind: 'price', max: 1500 }, match: true },
  { name: 'price == min', cond: { kind: 'price', min: 1500 }, match: true },
  { name: 'price min+1 over', cond: { kind: 'price', min: 1501 }, match: false },
  { name: 'endsWithin exactly maxMinutes', cond: { kind: 'endsWithin', maxMinutes: 60 }, match: true },
  { name: 'endsWithin exactly minMinutes', cond: { kind: 'endsWithin', minMinutes: 60 }, match: true },
  { name: 'endsWithin ends exactly at now', cond: { kind: 'endsWithin', maxMinutes: 90 }, l: { endTime: '2026-10-08T00:00:00.000Z' }, match: true },
  { name: 'endsWithin one ms past', cond: { kind: 'endsWithin', maxMinutes: 90 }, l: { endTime: '2026-10-07T23:59:59.999Z' }, match: false },
  { name: 'bidCount == min', cond: { kind: 'bidCount', min: 3 }, match: true },
  { name: 'bidCount == max', cond: { kind: 'bidCount', max: 3 }, match: true },
  { name: 'bidCount over max', cond: { kind: 'bidCount', max: 2 }, match: false },
  { name: 'pickupOnly false on shipping listing', cond: { kind: 'pickupOnly', value: false }, match: true, reason: { field: 'pickup', detail: 'ships (not pickup only)' } },
  { name: 'pickupOnly false on pickup listing', cond: { kind: 'pickupOnly', value: false }, l: { pickupOnly: true }, match: false },
  { name: 'price in range', cond: { kind: 'price', min: 1000, max: 2000 }, match: true, reason: { field: 'price', detail: 'price $15.00 (min $10.00, max $20.00)' } },
  { name: 'price above max', cond: { kind: 'price', max: 1000 }, match: false },
  { name: 'price below min', cond: { kind: 'price', min: 2000 }, match: false },
  { name: 'landedCost known match', cond: { kind: 'landedCost', max: 3000 }, c: { now: NOW, landedCost: () => 2500 }, match: true, reason: { field: 'landed cost', detail: 'landed cost $25.00 (max $30.00)' } },
  { name: 'landedCost known too high', cond: { kind: 'landedCost', max: 2000 }, c: { now: NOW, landedCost: () => 2500 }, match: false },
  { name: 'landedCost not fetched', cond: { kind: 'landedCost', max: 3000 }, match: false, unknown: 1 },
  { name: 'landedCost lookup null', cond: { kind: 'landedCost', max: 3000 }, c: { now: NOW, landedCost: () => null }, match: false, unknown: 1 },
  { name: 'seller by id', cond: { kind: 'seller', mode: 'include', sellerIds: [7], sellerNames: [] }, match: true, reason: { field: 'seller', detail: 'seller is GlassHouse (included)' } },
  { name: 'seller by name case-insensitive', cond: { kind: 'seller', mode: 'include', sellerIds: [], sellerNames: ['glasshouse'] }, match: true },
  { name: 'seller not listed', cond: { kind: 'seller', mode: 'include', sellerIds: [8], sellerNames: ['x'] }, match: false },
  { name: 'location include', cond: { kind: 'location', mode: 'include', states: ['AZ', 'NV'] }, match: true, reason: { field: 'seller location', detail: 'seller location is AZ (included)' } },
  { name: 'location exclude: not in list matches', cond: { kind: 'location', mode: 'exclude', states: ['WA'] }, match: true, reason: { field: 'seller location', detail: 'location AZ is not in excluded states' } },
  { name: 'location exclude: in list fails', cond: { kind: 'location', mode: 'exclude', states: ['AZ'] }, match: false },
  { name: 'location exclude: no state unknown', cond: { kind: 'location', mode: 'exclude', states: ['AZ'] }, l: { sellerState: undefined }, match: false, unknown: 1 },
  { name: 'seller exclude: not in list matches', cond: { kind: 'seller', mode: 'exclude', sellerIds: [8], sellerNames: ['x'] }, match: true, reason: { field: 'seller', detail: 'seller GlassHouse is not in excluded list' } },
  { name: 'seller exclude: id in list fails', cond: { kind: 'seller', mode: 'exclude', sellerIds: [7], sellerNames: [] }, match: false },
  { name: 'seller exclude: name in list fails', cond: { kind: 'seller', mode: 'exclude', sellerIds: [], sellerNames: ['GLASSHOUSE'] }, match: false },
  { name: 'seller exclude: no name, name list is unknown', cond: { kind: 'seller', mode: 'exclude', sellerIds: [], sellerNames: ['x'] }, l: { sellerName: undefined }, match: false, unknown: 1 },
  { name: 'seller include: no name, name list is unknown', cond: { kind: 'seller', mode: 'include', sellerIds: [], sellerNames: ['x'] }, l: { sellerName: undefined }, match: false, unknown: 1 },
  { name: 'category includeChildren is exact', cond: { kind: 'category', categoryIds: [1], includeChildren: true }, match: false },
  { name: 'location other state', cond: { kind: 'location', mode: 'include', states: ['WA'] }, match: false },
  { name: 'location unknown state', cond: { kind: 'location', mode: 'include', states: ['AZ'] }, l: { sellerState: undefined }, match: false, unknown: 1 },
  { name: 'category id', cond: { kind: 'category', categoryIds: [55], includeChildren: false }, match: true, reason: { field: 'category', detail: 'category is Collectibles > Glass' } },
  { name: 'category other', cond: { kind: 'category', categoryIds: [1], includeChildren: false }, match: false },
  { name: 'category missing id', cond: { kind: 'category', categoryIds: [55], includeChildren: false }, l: { categoryId: undefined }, match: false, unknown: 1 },
  { name: 'endsWithin match', cond: { kind: 'endsWithin', maxMinutes: 90 }, match: true, reason: { field: 'time left', detail: 'ends in 60 min (max 90 min)' } },
  { name: 'endsWithin too far', cond: { kind: 'endsWithin', maxMinutes: 30 }, match: false },
  { name: 'endsWithin min', cond: { kind: 'endsWithin', minMinutes: 120 }, match: false },
  { name: 'endsWithin already ended', cond: { kind: 'endsWithin', maxMinutes: 90 }, l: { endTime: '2026-10-07T23:00:00.000Z' }, match: false },
  { name: 'bidCount in range', cond: { kind: 'bidCount', min: 1, max: 5 }, match: true, reason: { field: 'bids', detail: '3 bids (min 1, max 5)' } },
  { name: 'bidCount zero only', cond: { kind: 'bidCount', max: 0 }, match: false },
  { name: 'pickupOnly true listing', cond: { kind: 'pickupOnly', value: true }, l: { pickupOnly: true }, match: true, reason: { field: 'pickup', detail: 'pickup only' } },
  { name: 'pickupOnly mismatch', cond: { kind: 'pickupOnly', value: true }, match: false },
  { name: 'pickupOnly true on unknown pickup is unknown', cond: { kind: 'pickupOnly', value: true }, l: { pickupOnly: undefined }, match: false, unknown: 1 },
  { name: 'pickupOnly false on unknown pickup is unknown, not a match', cond: { kind: 'pickupOnly', value: false }, l: { pickupOnly: undefined }, match: false, unknown: 1 },
];

describe('evaluate: every condition kind', () => {
  it('has at least 30 cases covering every kind', () => {
    expect(cases.length).toBeGreaterThanOrEqual(30);
    const kinds = new Set(cases.map((c) => c.cond.kind));
    expect(kinds.size).toBe(9);
  });

  it.each(cases)('$name', ({ cond, l, c, match, unknown, reason }) => {
    const res = evaluate(listing(l), [rule([cond])], c ?? ctx);
    expect(res.matched.length > 0).toBe(match);
    expect(res.decision).toBe(match ? 'highlight' : 'none');
    expect(res.unknownConditions).toBe(unknown ?? 0);
    if (reason !== undefined) {
      expect(res.matched[0]?.reasons[0]).toMatchObject({ ruleId: 'r1', conditionIndex: 0, ...reason });
    }
  });
});

describe('precedence and rule logic', () => {
  const hide = rule([kw(['pyrex'])], { id: 'h', action: 'hide' });
  const hi = rule([kw(['pyrex'])], { id: 'hl', action: 'highlight' });
  const watch = rule([kw(['pyrex'])], { id: 'w', action: 'watch' });

  it('hide beats highlight regardless of order, and both are listed', () => {
    for (const rules of [[hi, hide], [hide, hi]]) {
      const r = evaluate(listing(), rules, ctx);
      expect(r.decision).toBe('hide');
      expect(r.matched.map((m) => m.ruleId).sort()).toEqual(['h', 'hl']);
    }
  });
  it('highlight beats watch', () => {
    expect(evaluate(listing(), [watch, hi], ctx).decision).toBe('highlight');
    expect(evaluate(listing(), [watch], ctx).decision).toBe('watch');
  });
  it('disabled rule is ignored (and its unknowns are not counted)', () => {
    const off = rule([kw(['pyrex']), { kind: 'landedCost', max: 1 }], { enabled: false, action: 'hide' });
    const r = evaluate(listing(), [off], ctx);
    expect(r).toMatchObject({ decision: 'none', matched: [], unknownConditions: 0 });
  });
  it('all is AND: one false condition fails the rule', () => {
    expect(evaluate(listing(), [rule([kw(['pyrex']), { kind: 'price', max: 100 }])], ctx).decision).toBe('none');
  });
  it('unknown condition in all blocks the match and counts', () => {
    const r = evaluate(listing(), [rule([kw(['pyrex']), { kind: 'landedCost', max: 9999 }])], ctx);
    expect(r).toMatchObject({ decision: 'none', matched: [], unknownConditions: 1 });
  });
  it('any is OR and combined with all; reasons index any after all', () => {
    const r = rule([kw(['pyrex'])], { any: [{ kind: 'price', max: 100 }, { kind: 'bidCount', min: 1 }] });
    const res = evaluate(listing(), [r], ctx);
    expect(res.decision).toBe('highlight');
    expect(res.matched[0]?.reasons.map((x) => x.conditionIndex)).toEqual([0, 2]);
    const none = rule([kw(['pyrex'])], { any: [{ kind: 'price', max: 100 }] });
    expect(evaluate(listing(), [none], ctx).decision).toBe('none');
  });
  it('a rule with no conditions never matches', () => {
    expect(evaluate(listing(), [rule([])], ctx).decision).toBe('none');
  });
  it('endsWithin uses ctx.now', () => {
    const r = rule([{ kind: 'endsWithin', maxMinutes: 90 }]);
    expect(evaluate(listing(), [r], { now: NOW }).decision).toBe('highlight');
    expect(evaluate(listing(), [r], { now: NOW - 3 * 3_600_000 }).decision).toBe('none');
    expect(evaluate(listing(), [r], { now: NOW + 2 * 3_600_000 }).decision).toBe('none');
  });
  it('a bad regex term does not break other conditions or rules', () => {
    const bad = rule([kw(['(a)\\1'], { regex: true })], { id: 'bad', action: 'hide' });
    const good = rule([kw(['pyrex'])], { id: 'good' });
    const r = evaluate(listing(), [bad, good], ctx);
    expect(r.decision).toBe('highlight');
    expect(r.unknownConditions).toBe(1);
  });
});

describe('evaluateBatch', () => {
  it('compiles each rule once per batch, not once per listing', () => {
    const spy = vi.spyOn(keywords, 'tryCompileKeyword');
    const r = rule([kw(['pyrex', 'bowl'])]);
    const ls = Array.from({ length: 40 }, (_, i) => listing({ itemId: i + 1 }));
    const out = evaluateBatch(ls, [r], ctx);
    expect(out).toHaveLength(40);
    expect(out.every((x) => x.decision === 'highlight')).toBe(true);
    // 1 whole-condition compile + 2 per-term compiles, independent of listing count.
    expect(spy).toHaveBeenCalledTimes(3);
    spy.mockRestore();
  });
  it('returns results in input order with item ids', () => {
    const out = evaluateBatch([listing({ itemId: 5 }), listing({ itemId: 6, title: 'Toaster' })], [rule([kw(['pyrex'])])], ctx);
    expect(out.map((x) => [x.itemId, x.decision])).toEqual([[5, 'highlight'], [6, 'none']]);
  });
});

describe('preview', () => {
  it('counts matches and previews a disabled rule', () => {
    const r = rule([kw(['pyrex'])], { enabled: false });
    const p = preview(r, [listing({ itemId: 1 }), listing({ itemId: 2, title: 'Toaster' })], ctx);
    expect(p.matchedItemIds).toEqual([1]);
    expect(p.matchCount).toBe(1);
    expect(p.unknownCount).toBe(0);
    expect(p.compileErrors).toEqual([]);
  });
  it('surfaces keyword compile errors and unknown counts', () => {
    const r = rule([kw(['ok']), kw(['(a)\\1'], { regex: true }), { kind: 'landedCost', max: 1 }]);
    const p = preview(r, [listing()], ctx);
    expect(p.compileErrors).toHaveLength(1);
    expect(p.compileErrors[0]).toMatchObject({ ruleId: 'r1', conditionIndex: 1 });
    expect(p.unknownCount).toBe(1);
    expect(p.matchCount).toBe(0);
  });
});
