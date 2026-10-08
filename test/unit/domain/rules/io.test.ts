import { describe, expect, it } from 'vitest';

import { exportRules, importRules, RULE_TEMPLATES, ruleFromTemplate } from '../../../../src/domain/rules/io';
import type { Rule } from '../../../../src/domain/rules/schema';

const rule = (over: Partial<Rule> = {}): Rule => ({
  id: 'a',
  name: 'Pyrex',
  enabled: true,
  action: 'highlight',
  tone: 'green',
  all: [{ kind: 'keyword', mode: 'any', terms: ['pyrex', '(a+)+'], wholeWord: true, regex: true, fields: ['title'] }],
  createdAt: 1,
  updatedAt: 2,
  ...over,
});
let n = 0;
const opts = () => ({ now: 99, newId: () => `new-${String(++n)}` });

describe('exportRules', () => {
  it('writes a versioned envelope', () => {
    const parsed = JSON.parse(exportRules([rule()], 5)) as Record<string, unknown>;
    expect(parsed).toMatchObject({ format: 'shopbadwill.rules', version: 1, exportedAt: 5 });
    expect(parsed['rules']).toEqual([rule()]);
  });
});

describe('importRules', () => {
  it('round-trips with fresh ids and timestamps', () => {
    const r = importRules(exportRules([rule(), rule({ id: 'b', name: 'Other' })]), [], opts());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.rules).toHaveLength(2);
    expect(r.rules.map((x) => x.id)).not.toContain('a');
    expect(new Set(r.rules.map((x) => x.id)).size).toBe(2);
    expect(r.rules[0]).toMatchObject({ createdAt: 99, updatedAt: 99, name: 'Pyrex' });
    expect(r.duplicates).toEqual([]);
  });

  it('reports duplicates by name against existing and within the import', () => {
    const text = exportRules([rule({ name: 'pyrex ' }), rule({ id: 'c', name: 'Twice' }), rule({ id: 'd', name: 'TWICE' })]);
    const r = importRules(text, [rule({ id: 'x' })], opts());
    expect(r.ok && r.duplicates).toEqual(['pyrex ', 'TWICE']);
  });

  it('does not execute or reject regexes (the compiler checks on save)', () => {
    expect(importRules(exportRules([rule()]), [], opts()).ok).toBe(true);
  });

  it.each([
    ['empty', ''],
    ['not json', '{nope'],
    ['unknown format', JSON.stringify({ format: 'other', version: 1, rules: [] })],
    ['newer version', JSON.stringify({ format: 'shopbadwill.rules', version: 2, rules: [rule()] })],
    ['bad version', JSON.stringify({ format: 'shopbadwill.rules', version: 'x', rules: [rule()] })],
    ['no rules list', JSON.stringify({ format: 'shopbadwill.rules', version: 1 })],
    ['zero rules', JSON.stringify({ format: 'shopbadwill.rules', version: 1, rules: [] })],
    ['a number', '5'],
  ])('rejects %s', (_n, text) => {
    const r = importRules(text, [], opts());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.length).toBeGreaterThan(0);
  });

  it('names the invalid rule', () => {
    const bad = { ...rule({ name: 'Broken' }), action: 'explode' };
    const r = importRules(JSON.stringify({ format: 'shopbadwill.rules', version: 1, rules: [rule(), bad] }), [], opts());
    expect(r).toEqual({ ok: false, errors: [expect.stringContaining('Rule 2 ("Broken")')] });
  });

  it('rejects more than 500 rules with a clear message', () => {
    const many = Array.from({ length: 501 }, (_, i) => rule({ id: `i${String(i)}` }));
    const r = importRules(exportRules(many), [], opts());
    expect(r).toEqual({ ok: false, errors: [expect.stringContaining('more than 500')] });
  });

  it('does not pollute prototypes from __proto__ / constructor keys', () => {
    const text = `{"format":"shopbadwill.rules","version":1,"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}},"rules":[{"id":"a","name":"P","enabled":true,"action":"hide","all":[],"createdAt":1,"updatedAt":1,"__proto__":{"polluted":true},"constructor":"x"}]}`;
    const r = importRules(text, [], opts());
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
    expect(r.ok).toBe(true);
    if (r.ok) expect(Object.keys(r.rules[0] ?? {})).not.toContain('constructor');
    const bad = importRules('{"format":"shopbadwill.rules","version":1,"rules":[{"__proto__":{"id":"x"}}]}', [], opts());
    expect(bad.ok).toBe(false);
    expect(({} as Record<string, unknown>)['id']).toBeUndefined();
  });

  it('refuses oversized input', () => {
    expect(importRules('x'.repeat(2_000_001), [], opts()).ok).toBe(false);
  });
});

describe('templates', () => {
  it('has the four required templates, each a valid rule', () => {
    expect(RULE_TEMPLATES.map((t) => t.name)).toEqual([
      'Local pickup only items: hide',
      'No clothing lots: hide by keyword',
      'Under $25 landed: highlight',
      'Exclude sellers in a state: hide',
    ]);
    for (const t of RULE_TEMPLATES) expect(ruleFromTemplate(t, opts()).id).toMatch(/^new-/);
  });
  it('flags the landed-cost caveat', () => {
    expect(RULE_TEMPLATES[2]?.note).toMatch(/off by default/);
  });
});
