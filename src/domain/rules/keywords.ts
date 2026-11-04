// T-22 keyword compiler (implements the `CompileKeyword` contract type).
// Pure domain code: no browser imports.
//
// Both the listing text and the rule terms go through `normalizeText` (NFKC,
// strip format/control characters, strip diacritics, lower-case, collapse
// whitespace), so "Pÿrex", "PYREX" and fullwidth "ＰＹＲＥＸ" all meet. Listing
// text is attacker-controlled, so it is length-capped before any other work.
//
// Regex terms are user input that runs on every listing, so they execute on
// `re2js` (a linear-time RE2 port): catastrophic backtracking cannot happen,
// and no static "is this pattern safe" heuristic is needed. RE2 rejects
// backreferences (and other unsupported syntax) at compile time, which becomes
// a `KeywordCompileError`. Pattern length and text length are capped. Nothing
// is ever disabled at match time, so exclusion (`none`) terms cannot fail open.
//
// Native `RegExp` is used ONLY for patterns this module generates itself from
// escaped literals (whole-word lookarounds, phrases); those are safe by
// construction. `test` never throws.
import { RE2JS } from 're2js';

import type { Condition } from './schema';

type KeywordCondition = Extract<Condition, { kind: 'keyword' }>;

export const MAX_REGEX_LENGTH = 200;
export const MAX_TEXT_LENGTH = 4096;
const PRE_CAP = 16_384; // bounds work before control characters are stripped

export interface KeywordMatcher {
  test(text: string): boolean;
}

export interface CompileOptions {
  /** Misspelling expansion for literal terms (Phase 6 fills the real one). */
  variants?: (term: string) => string[];
}

export type CompileResult = { ok: true; matcher: KeywordMatcher } | { ok: false; error: string };

export class KeywordCompileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KeywordCompileError';
  }
}

/** Phase 6 hook. Stub: no variants beyond the term itself. */
export function misspellingVariants(term: string): string[] {
  return [term];
}

function fold(s: string): string {
  return s
    .normalize('NFKC')
    .replace(/[\p{Cf}\p{Co}]/gu, '')
    .replace(/\p{Cc}/gu, ' ')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .normalize('NFC');
}

/**
 * Fold text for matching. Work is bounded by PRE_CAP; format/control characters
 * are stripped before the MAX_TEXT_LENGTH cap so zero-width padding cannot push
 * a term out of view.
 */
export function normalizeText(text: string): string {
  return fold(text.slice(0, PRE_CAP)).slice(0, MAX_TEXT_LENGTH).toLowerCase().replace(/\s+/g, ' ').trim();
}

const WORD = String.raw`[\p{L}\p{N}_]`;
const BEFORE = `(?<!${WORD})`;
const AFTER = `(?!${WORD})`;

function escapeRegex(s: string): string {
  return s.replace(/[\\^$.*+?()[\]{}|/-]/g, '\\$&');
}

interface TermMatcher {
  test(norm: string): boolean;
}

// Whole-word wrapper in RE2 syntax (RE2 has no lookarounds and its  is
// ASCII-only): consume one non-word character or the text edge on each side.
// Only existence of a match matters, so consuming the neighbours is harmless.
const RE2_EDGE_L = String.raw`(?:^|[^\p{L}\p{N}_])`;
const RE2_EDGE_R = String.raw`(?:$|[^\p{L}\p{N}_])`;

function compileRegexTerm(raw: string, wholeWord: boolean): TermMatcher {
  const pattern = fold(raw);
  if (pattern.length > MAX_REGEX_LENGTH) {
    throw new KeywordCompileError(`regex longer than ${String(MAX_REGEX_LENGTH)} characters`);
  }
  let re: RE2JS;
  try {
    re = RE2JS.compile(wholeWord ? `${RE2_EDGE_L}(?:${pattern})${RE2_EDGE_R}` : pattern, RE2JS.CASE_INSENSITIVE);
  } catch (e) {
    throw new KeywordCompileError(`unsupported regex /${raw.slice(0, 40)}/: ${e instanceof Error ? e.message : String(e)}`);
  }
  return { test: (norm) => re.matcher(norm).find() };
}

function compileLiteralTerm(term: string, wholeWord: boolean): TermMatcher | null {
  const t = normalizeText(term);
  if (t === '') return null;
  if (!wholeWord) return { test: (norm) => norm.includes(t) };
  // Native RegExp is safe here: the pattern is an escaped literal we generated.
  const re = new RegExp(`${BEFORE}${escapeRegex(t)}${AFTER}`, 'u');
  return { test: (norm) => re.test(norm) };
}

function stripQuotes(term: string): string {
  const t = term.trim();
  return t.length >= 2 && t.startsWith('"') && t.endsWith('"') ? t.slice(1, -1) : t;
}

export function tryCompileKeyword(c: KeywordCondition, opts: CompileOptions = {}): CompileResult {
  const variants = opts.variants ?? misspellingVariants;
  const matchers: TermMatcher[][] = [];
  try {
    for (const raw of c.terms) {
      const term = stripQuotes(raw);
      if (term.trim() === '') continue;
      if (c.regex) {
        matchers.push([compileRegexTerm(term, c.wholeWord)]);
      } else {
        const alts = variants(term)
          .map((v) => compileLiteralTerm(v, c.wholeWord))
          .filter((m): m is TermMatcher => m !== null);
        if (alts.length > 0) matchers.push(alts);
      }
    }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  const termHit = (alts: TermMatcher[], norm: string): boolean => alts.some((m) => m.test(norm));
  const mode = c.mode;
  const matcher: KeywordMatcher = {
    test(text) {
      if (typeof text !== 'string') return false;
      if (matchers.length === 0) return mode === 'none';
      const norm = normalizeText(text);
      if (mode === 'any') return matchers.some((alts) => termHit(alts, norm));
      if (mode === 'all') return matchers.every((alts) => termHit(alts, norm));
      return !matchers.some((alts) => termHit(alts, norm));
    },
  };
  return { ok: true, matcher };
}

/** Throws `KeywordCompileError` for an unsafe or invalid regex term; `test` itself never throws. */
export function compileKeyword(c: KeywordCondition, opts?: CompileOptions): KeywordMatcher {
  const r = tryCompileKeyword(c, opts);
  if (!r.ok) throw new KeywordCompileError(r.error);
  return r.matcher;
}
