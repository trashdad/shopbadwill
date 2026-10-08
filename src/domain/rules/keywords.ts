// T-22 keyword compiler (implements the `CompileKeyword` contract type).
// Pure domain code: no browser imports.
//
// Both the listing text and the rule terms go through `normalizeText` (NFKC,
// strip format/control characters, strip diacritics, lower-case, collapse
// whitespace), so "Pÿrex", "PYREX" and fullwidth "ＰＹＲＥＸ" all meet. Listing
// text is attacker-controlled, so it is length-capped before any other work.
//
// Regex terms are user input that runs on every listing. JS regexes cannot be
// interrupted, so safety is layered:
//   1. pre-check at compile: length cap, backreferences and nested /
//      overlapping quantifiers are rejected (`analyzeRegex`);
//   2. input cap: text is truncated to MAX_TEXT_LENGTH before testing;
//   3. watchdog: each regex test is timed; one that exceeds REGEX_BUDGET_MS
//      permanently disables that matcher (fail closed: it never matches).
// Rejection happens at compile time, never as a throw from `test`.
import type { Condition } from './schema';

type KeywordCondition = Extract<Condition, { kind: 'keyword' }>;

export const MAX_REGEX_LENGTH = 200;
export const MAX_TEXT_LENGTH = 4096;
export const REGEX_BUDGET_MS = 5;

export interface KeywordMatcher {
  test(text: string): boolean;
  /** True once any regex term exceeded its time budget and was disabled. */
  readonly tripped: boolean;
}

export interface CompileOptions {
  /** Misspelling expansion for literal terms (Phase 6 fills the real one). */
  variants?: (term: string) => string[];
  /** Millisecond clock for the watchdog; injectable for tests. */
  now?: () => number;
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

/** Fold text for matching. Input is capped first so hostile titles cost O(cap). */
export function normalizeText(text: string): string {
  return fold(text.slice(0, MAX_TEXT_LENGTH)).toLowerCase().replace(/\s+/g, ' ').trim();
}

const WORD = String.raw`[\p{L}\p{N}_]`;
const BEFORE = `(?<!${WORD})`;
const AFTER = `(?!${WORD})`;

function escapeRegex(s: string): string {
  return s.replace(/[\\^$.*+?()[\]{}|/-]/g, '\\$&');
}

interface Frame {
  unb: boolean;
  bnd: boolean;
  alt: boolean;
}

function readQuantifier(p: string, i: number): { kind: 'none' | 'bnd' | 'unb'; next: number } {
  const c = p[i];
  let kind: 'none' | 'bnd' | 'unb' = 'none';
  let next = i;
  if (c === '*' || c === '+') {
    kind = 'unb';
    next = i + 1;
  } else if (c === '?') {
    next = i + 1;
  } else if (c === '{') {
    const m = /^\{(\d+)(,(\d*))?\}/.exec(p.slice(i, i + 24));
    if (m) {
      next = i + m[0].length;
      if (m[2] !== undefined) kind = m[3] === '' ? 'unb' : Number(m[3]) > 1 ? 'bnd' : 'none';
      else kind = Number(m[1]) > 1 ? 'bnd' : 'none';
    }
  }
  if (next > i && p[next] === '?') next += 1; // lazy suffix
  return { kind, next };
}

/** Returns a rejection reason, or null when the pattern passes the pre-check. */
export function analyzeRegex(pattern: string): string | null {
  if (pattern.length > MAX_REGEX_LENGTH) return `regex longer than ${String(MAX_REGEX_LENGTH)} characters`;
  const stack: Frame[] = [{ unb: false, bnd: false, alt: false }];
  const top = (): Frame => stack[stack.length - 1] as Frame;
  let i = 0;
  const atomQuant = (): void => {
    const q = readQuantifier(pattern, i);
    if (q.kind === 'unb') top().unb = true;
    else if (q.kind === 'bnd') top().bnd = true;
    i = q.next;
  };
  while (i < pattern.length) {
    const c = pattern[i] as string;
    if (c === '\\') {
      const n = pattern[i + 1] ?? '';
      if (/[1-9]/.test(n) || n === 'k') return 'backreferences are not allowed';
      i += 2;
      atomQuant();
    } else if (c === '[') {
      i += 1;
      while (i < pattern.length && pattern[i] !== ']') i += pattern[i] === '\\' ? 2 : 1;
      i += 1;
      atomQuant();
    } else if (c === '(') {
      stack.push({ unb: false, bnd: false, alt: false });
      i += 1;
      if (pattern[i] === '?') {
        const named = pattern[i + 1] === '<' && pattern[i + 2] !== '=' && pattern[i + 2] !== '!';
        if (named) {
          const end = pattern.indexOf('>', i);
          i = end < 0 ? pattern.length : end + 1;
        } else i += pattern[i + 1] === '<' ? 3 : 2;
      }
    } else if (c === ')') {
      if (stack.length < 2) return 'unbalanced parentheses';
      const f = stack.pop() as Frame;
      const q = readQuantifier(pattern, i + 1);
      i = q.next === i + 1 ? i + 1 : q.next;
      if (q.kind === 'unb' && (f.unb || f.alt || f.bnd)) return 'nested quantifiers are not allowed';
      if (q.kind === 'bnd' && f.unb) return 'nested quantifiers are not allowed';
      const parent = top();
      parent.unb ||= f.unb || q.kind === 'unb';
      parent.bnd ||= f.bnd || q.kind === 'bnd';
      parent.alt ||= f.alt;
    } else if (c === '|') {
      top().alt = true;
      i += 1;
    } else {
      i += 1;
      atomQuant();
    }
  }
  return stack.length === 1 ? null : 'unbalanced parentheses';
}

interface TermMatcher {
  test(norm: string): boolean;
  tripped: boolean;
}

function compileRegexTerm(raw: string, wholeWord: boolean, now: () => number): TermMatcher {
  const pattern = fold(raw);
  const reason = analyzeRegex(pattern);
  if (reason) throw new KeywordCompileError(`unsafe regex /${raw.slice(0, 40)}/: ${reason}`);
  let re: RegExp;
  try {
    re = new RegExp(wholeWord ? `${BEFORE}(?:${pattern})${AFTER}` : pattern, 'iu');
  } catch (e) {
    throw new KeywordCompileError(`invalid regex /${raw.slice(0, 40)}/: ${e instanceof Error ? e.message : String(e)}`);
  }
  const m: TermMatcher = {
    tripped: false,
    test(norm) {
      if (m.tripped) return false;
      const start = now();
      const hit = re.test(norm);
      if (now() - start > REGEX_BUDGET_MS) m.tripped = true;
      return hit;
    },
  };
  return m;
}

function compileLiteralTerm(term: string, wholeWord: boolean): TermMatcher | null {
  const t = normalizeText(term);
  if (t === '') return null;
  if (!wholeWord) return { tripped: false, test: (norm) => norm.includes(t) };
  const re = new RegExp(`${BEFORE}${escapeRegex(t)}${AFTER}`, 'u');
  return { tripped: false, test: (norm) => re.test(norm) };
}

function stripQuotes(term: string): string {
  const t = term.trim();
  return t.length >= 2 && t.startsWith('"') && t.endsWith('"') ? t.slice(1, -1) : t;
}

export function tryCompileKeyword(c: KeywordCondition, opts: CompileOptions = {}): CompileResult {
  const now = opts.now ?? (() => performance.now());
  const variants = opts.variants ?? misspellingVariants;
  const matchers: TermMatcher[][] = [];
  try {
    for (const raw of c.terms) {
      const term = stripQuotes(raw);
      if (term.trim() === '') continue;
      if (c.regex) {
        matchers.push([compileRegexTerm(term, c.wholeWord, now)]);
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
    get tripped() {
      return matchers.some((alts) => alts.some((m) => m.tripped));
    },
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
