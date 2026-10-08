import { describe, expect, it } from 'vitest';

import type { Condition } from '../../../../src/domain/rules/schema';
import {
  KeywordCompileError,
  MAX_REGEX_LENGTH,
  compileKeyword,
  misspellingVariants,
  normalizeText,
  tryCompileKeyword,
} from '../../../../src/domain/rules/keywords';

type Kw = Extract<Condition, { kind: 'keyword' }>;
const kw = (terms: string[], o: Partial<Kw> = {}): Kw => ({
  kind: 'keyword',
  mode: 'any',
  terms,
  wholeWord: true,
  regex: false,
  fields: ['title'],
  ...o,
});

describe('whole-word matching', () => {
  it('"men" does not match "women" with wholeWord', () => {
    const k = compileKeyword(kw(['men']));
    expect(k.test("Women's Coach Purse")).toBe(false);
    expect(k.test('Lot of men shirts')).toBe(true);
  });
  it('substring matches when wholeWord is false', () => {
    expect(compileKeyword(kw(['men'], { wholeWord: false })).test('women')).toBe(true);
  });
  it('"women" matches women and WOMEN\'S', () => {
    const k = compileKeyword(kw(['women']));
    expect(k.test('vintage women dress')).toBe(true);
    expect(k.test("WOMEN'S Dress")).toBe(true);
  });
  it('treats digits and underscore as word characters', () => {
    const k = compileKeyword(kw(['ps']));
    expect(k.test('ps5 console')).toBe(false);
    expect(k.test('ps_5')).toBe(false);
    expect(k.test('ps 5')).toBe(true);
  });
  it('matches phrases, quoted or not, across whitespace differences', () => {
    expect(compileKeyword(kw(['"pie   plate"'])).test('Pyrex  PIE\tplate set')).toBe(true);
    expect(compileKeyword(kw(['pie plate'])).test('pie, plate')).toBe(false);
  });
  it('escapes regex metacharacters in literal terms', () => {
    const k = compileKeyword(kw(['c++', '(a.b)']));
    expect(k.test('learn c++ fast')).toBe(true);
    expect(k.test('x (a.b) y')).toBe(true);
    expect(k.test('axb')).toBe(false);
  });
});

describe('modes', () => {
  it('any / all / none', () => {
    expect(compileKeyword(kw(['a1', 'b2'])).test('has b2')).toBe(true);
    expect(compileKeyword(kw(['a1', 'b2'], { mode: 'all' })).test('has b2')).toBe(false);
    expect(compileKeyword(kw(['a1', 'b2'], { mode: 'all' })).test('a1 b2')).toBe(true);
  });
  it('negative keyword excludes', () => {
    const k = compileKeyword(kw(['broken', 'parts'], { mode: 'none' }));
    expect(k.test('Pyrex bowl')).toBe(true);
    expect(k.test('For PARTS only')).toBe(false);
  });
  it('ignores blank terms; no terms matches nothing except none', () => {
    expect(compileKeyword(kw(['', '  '])).test('anything')).toBe(false);
    expect(compileKeyword(kw([], { mode: 'all' })).test('anything')).toBe(false);
    expect(compileKeyword(kw([''], { mode: 'none' })).test('anything')).toBe(true);
  });
});

describe('normalisation', () => {
  it('folds "Pÿrex" to pyrex, both directions', () => {
    expect(compileKeyword(kw(['pyrex'])).test('Vintage Pÿrex bowl')).toBe(true);
    expect(compileKeyword(kw(['Pÿrex'])).test('PYREX bowl')).toBe(true);
    expect(normalizeText('Pÿrex')).toBe('pyrex');
  });
  it('NFKC folds compatibility forms (fullwidth, ligatures)', () => {
    expect(compileKeyword(kw(['pyrex'])).test('ＰＹＲＥＸ')).toBe(true);
    expect(compileKeyword(kw(['office'])).test('oﬃce')).toBe(true);
  });
  it('strips zero-width and bidi characters used to evade matches', () => {
    expect(compileKeyword(kw(['pyrex'])).test('py​rex')).toBe(true);
    expect(compileKeyword(kw(['pyrex'])).test('p‮yrex')).toBe(true);
  });
  it('survives lone surrogates and huge input', () => {
    const k = compileKeyword(kw(['pyrex']));
    expect(k.test('\uD800 pyrex')).toBe(true);
    expect(k.test('x'.repeat(5_000_000))).toBe(false);
  });
  it('ignores non-string input defensively', () => {
    expect(compileKeyword(kw(['a'])).test(undefined as unknown as string)).toBe(false);
  });
});

describe('regex', () => {
  const rx = (terms: string[], o: Partial<Kw> = {}): Kw => kw(terms, { regex: true, wholeWord: false, ...o });
  it('matches case-insensitively and diacritic-folded', () => {
    const k = compileKeyword(rx(['py(re|r)x\\s+\\d+']));
    expect(k.test('PŸREX 404')).toBe(true);
    expect(k.test('pyrex')).toBe(false);
  });
  it('is stateless across calls', () => {
    const k = compileKeyword(rx(['pyrex']));
    expect([k.test('pyrex'), k.test('pyrex'), k.test('pyrex')]).toEqual([true, true, true]);
  });
  it('wholeWord applies to regex terms', () => {
    const k = compileKeyword(rx(['men'], { wholeWord: true }));
    expect(k.test('women')).toBe(false);
    expect(k.test('men')).toBe(true);
  });
  it.each(['(a+)+$', '(a*)*b', '(a|aa)+$', '(.*a){10,}', '(\\d+)*x', '((a+)b)+', '(a+){2,5}'])(
    'rejects catastrophic pattern %s at compile',
    (p) => {
      expect(() => compileKeyword(rx([p]))).toThrow(KeywordCompileError);
      const r = tryCompileKeyword(rx([p]));
      expect(r.ok).toBe(false);
    },
  );
  it('rejects backreferences, bad syntax and over-long patterns', () => {
    for (const p of ['(a)\\1', '(?<n>a)\\k<n>', '(', '[', 'a{2,1}', 'a'.repeat(MAX_REGEX_LENGTH + 1)]) {
      const r = tryCompileKeyword(rx([p]));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toBeTruthy();
    }
  });
  it('accepts safe quantified groups and escaped/class lookalikes', () => {
    for (const p of ['(ab)+', '(\\d{3}-?){2}', '\\(a+\\)+', '[(a+)+]', '(?:ab|cd)?x', 'a+b*c?']) {
      expect(tryCompileKeyword(rx([p])).ok).toBe(true);
    }
  });
  it('a failing term in none-mode is a compile error, never a match-time throw', () => {
    expect(tryCompileKeyword(rx(['(a+)+$'], { mode: 'none' })).ok).toBe(false);
  });
  it('watchdog: a regex that exceeds the 5 ms budget is disabled (fail closed)', () => {
    let t = 0;
    const clock = () => (t += 10); // every test appears to take 10 ms
    const r = tryCompileKeyword(rx(['pyrex']), { now: clock });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.matcher.test('pyrex')).toBe(true); // the slow call still returns its result
    expect(r.matcher.tripped).toBe(true);
    expect(r.matcher.test('pyrex')).toBe(false); // then the pattern is disabled
  });
  it('does not trip when fast', () => {
    const r = tryCompileKeyword(rx(['pyrex']));
    if (!r.ok) throw new Error('unexpected');
    r.matcher.test('pyrex');
    expect(r.matcher.tripped).toBe(false);
  });
});

describe('misspelling hook', () => {
  it('stub returns [term]', () => {
    expect(misspellingVariants('pyrex')).toEqual(['pyrex']);
  });
  it('compileKeyword consults an injected variants function for literal terms', () => {
    const k = compileKeyword(kw(['pyrex']), { variants: (t) => [t, 'pirex'] });
    expect(k.test('pirex bowl')).toBe(true);
  });
});
