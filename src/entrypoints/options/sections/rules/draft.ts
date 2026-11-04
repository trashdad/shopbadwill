// The editor works on string-valued drafts (what the user typed) and converts
// to a schema-valid Rule on save. Nothing here executes a user regex against
// content: `new RegExp` is only used to get syntax feedback.
import { formatCents, parseCents } from '../../../../domain/money';
import { RuleSchema, type Condition, type Rule } from '../../../../domain/rules/schema';

export type ConditionKind = Condition['kind'];
export type KeywordField = 'title' | 'category' | 'seller';

export const CONDITION_KINDS: readonly ConditionKind[] = [
  'keyword',
  'price',
  'landedCost',
  'seller',
  'location',
  'category',
  'endsWithin',
  'bidCount',
  'pickupOnly',
];

export const KIND_LABELS: Record<ConditionKind, string> = {
  keyword: 'Keywords',
  price: 'Price',
  landedCost: 'Estimated total with shipping',
  seller: 'Seller',
  location: 'Seller location',
  category: 'Category',
  endsWithin: 'Time left',
  bidCount: 'Number of bids',
  pickupOnly: 'Pickup only',
};

export const MAX_REGEX_LENGTH = 200;

export interface ConditionDraft {
  /** Stable within the editor; used for ids and React-style keys. */
  key: number;
  kind: ConditionKind;
  /** keyword: any|all|none; seller and location: include|exclude. */
  mode: string;
  terms: string;
  wholeWord: boolean;
  regex: boolean;
  fields: KeywordField[];
  /** Dollars (price, landedCost), minutes (endsWithin) or a count (bidCount). */
  min: string;
  max: string;
  sellerIds: string;
  sellerNames: string;
  states: string;
  categoryIds: string;
  includeChildren: boolean;
  pickup: boolean;
}

export interface RuleDraft {
  id: string;
  name: string;
  enabled: boolean;
  action: Rule['action'];
  tone: '' | NonNullable<Rule['tone']>;
  all: ConditionDraft[];
  any: ConditionDraft[];
  createdAt: number;
}

export type DraftGroup = 'all' | 'any';

export interface DraftError {
  /** "name", "conditions", or `${group}.${key}.${field}`. */
  path: string;
  message: string;
}

export function newCondition(kind: ConditionKind, key: number): ConditionDraft {
  return {
    key,
    kind,
    mode: kind === 'keyword' ? 'any' : 'exclude',
    terms: '',
    wholeWord: false,
    regex: false,
    fields: ['title'],
    min: '',
    max: '',
    sellerIds: '',
    sellerNames: '',
    states: '',
    categoryIds: '',
    includeChildren: true,
    pickup: true,
  };
}

export function newRuleDraft(id: string, now: number): RuleDraft {
  return { id, name: '', enabled: true, action: 'highlight', tone: 'green', all: [], any: [], createdAt: now };
}

const optionalText = (n: number | undefined): string => (n === undefined ? '' : String(n));

function conditionToDraft(c: Condition, key: number): ConditionDraft {
  const d = newCondition(c.kind, key);
  switch (c.kind) {
    case 'keyword':
      return { ...d, mode: c.mode, terms: c.terms.join('\n'), wholeWord: c.wholeWord, regex: c.regex, fields: [...c.fields] };
    case 'price':
    case 'landedCost':
      return {
        ...d,
        min: c.min === undefined ? '' : formatCents(c.min),
        max: c.max === undefined ? '' : formatCents(c.max),
      };
    case 'seller':
      return { ...d, mode: c.mode, sellerIds: c.sellerIds.join(', '), sellerNames: c.sellerNames.join('\n') };
    case 'location':
      return { ...d, mode: c.mode, states: c.states.join(', ') };
    case 'category':
      return { ...d, categoryIds: c.categoryIds.join(', '), includeChildren: c.includeChildren };
    case 'endsWithin':
      return { ...d, min: optionalText(c.minMinutes), max: optionalText(c.maxMinutes) };
    case 'bidCount':
      return { ...d, min: optionalText(c.min), max: optionalText(c.max) };
    case 'pickupOnly':
      return { ...d, pickup: c.value };
  }
}

export function toDraft(rule: Rule): RuleDraft {
  let key = 0;
  const next = (c: Condition): ConditionDraft => conditionToDraft(c, key++);
  return {
    id: rule.id,
    name: rule.name,
    enabled: rule.enabled,
    action: rule.action,
    tone: rule.tone ?? '',
    all: rule.all.map(next),
    any: (rule.any ?? []).map(next),
    createdAt: rule.createdAt,
  };
}

/** The next unused condition key. */
export function nextKey(draft: RuleDraft): number {
  return Math.max(-1, ...draft.all.map((c) => c.key), ...draft.any.map((c) => c.key)) + 1;
}

const lines = (text: string): string[] =>
  text
    .split('\n')
    .map((s) => s.trim())
    .filter((s) => s !== '');
const tokens = (text: string): string[] => text.split(/[\s,]+/).filter((s) => s !== '');

type Parsed<T> = { value: T; error?: undefined } | { value?: undefined; error: string };

function parseDollars(text: string): Parsed<number | undefined> {
  if (text.trim() === '') return { value: undefined };
  const cents = parseCents(text);
  return cents === null ? { error: 'Enter an amount such as 20 or 19.99.' } : { value: cents };
}

function parseNumber(text: string, integer: boolean): Parsed<number | undefined> {
  const t = text.trim();
  if (t === '') return { value: undefined };
  const ok = integer ? /^\d+$/.test(t) : /^\d+(\.\d+)?$/.test(t);
  return ok ? { value: Number(t) } : { error: integer ? 'Enter a whole number, 0 or more.' : 'Enter a number, 0 or more.' };
}

/** Syntax feedback only. The pattern is compiled, never run against anything. */
export function regexSyntaxError(pattern: string): string | null {
  if (pattern.length > MAX_REGEX_LENGTH) return `longer than ${String(MAX_REGEX_LENGTH)} characters`;
  try {
    new RegExp(pattern, 'iu');
    return null;
  } catch (e) {
    return e instanceof Error ? e.message.replace(/^Invalid regular expression: /, '') : 'invalid syntax';
  }
}

function conditionFromDraft(
  d: ConditionDraft,
  at: (field: string, message: string) => void,
): Condition | undefined {
  const before = { count: 0 };
  const fail = (field: string, message: string): undefined => {
    before.count++;
    at(field, message);
    return undefined;
  };
  const range = (
    minText: string,
    maxText: string,
    parse: (t: string) => Parsed<number | undefined>,
  ): { min?: number; max?: number } | undefined => {
    const lo = parse(minText);
    const hi = parse(maxText);
    if (lo.error !== undefined) fail('min', lo.error);
    if (hi.error !== undefined) fail('max', hi.error);
    if (lo.error !== undefined || hi.error !== undefined) return undefined;
    if (lo.value === undefined && hi.value === undefined) {
      fail('min', 'Enter a minimum, a maximum, or both.');
      return undefined;
    }
    if (lo.value !== undefined && hi.value !== undefined && lo.value > hi.value) {
      fail('max', 'The maximum must not be below the minimum.');
      return undefined;
    }
    return {
      ...(lo.value === undefined ? {} : { min: lo.value }),
      ...(hi.value === undefined ? {} : { max: hi.value }),
    };
  };

  switch (d.kind) {
    case 'keyword': {
      const terms = lines(d.terms);
      if (terms.length === 0) fail('terms', 'Enter at least one term.');
      if (d.regex) {
        for (const term of terms) {
          const reason = regexSyntaxError(term);
          if (reason !== null) {
            fail('terms', `"${term}" is not a valid regular expression (${reason}).`);
            break;
          }
        }
      }
      if (d.fields.length === 0) fail('fields', 'Choose at least one place to look.');
      if (before.count > 0) return undefined;
      return {
        kind: 'keyword',
        mode: d.mode === 'all' || d.mode === 'none' ? d.mode : 'any',
        terms,
        wholeWord: d.wholeWord,
        regex: d.regex,
        fields: d.fields,
      };
    }
    case 'price':
    case 'landedCost': {
      const r = range(d.min, d.max, parseDollars);
      return r === undefined ? undefined : { kind: d.kind, ...r };
    }
    case 'seller': {
      const ids = tokens(d.sellerIds);
      const names = lines(d.sellerNames);
      if (ids.some((s) => !/^\d+$/.test(s))) {
        fail('sellerIds', 'Seller numbers must be digits only.');
        return undefined;
      }
      if (ids.length === 0 && names.length === 0) {
        fail('sellerNames', 'Enter a seller name or number.');
        return undefined;
      }
      return {
        kind: 'seller',
        mode: d.mode === 'include' ? 'include' : 'exclude',
        sellerIds: ids.map(Number),
        sellerNames: names,
      };
    }
    case 'location': {
      const states = tokens(d.states).map((s) => s.toUpperCase());
      if (states.length === 0) {
        fail('states', 'Enter at least one state, such as OH.');
        return undefined;
      }
      if (states.some((s) => !/^[A-Z]{2}$/.test(s))) {
        fail('states', 'Use two-letter state codes, such as OH, PA.');
        return undefined;
      }
      return { kind: 'location', mode: d.mode === 'include' ? 'include' : 'exclude', states };
    }
    case 'category': {
      const ids = tokens(d.categoryIds);
      if (ids.length === 0) {
        fail('categoryIds', 'Enter at least one category number.');
        return undefined;
      }
      if (ids.some((s) => !/^\d+$/.test(s))) {
        fail('categoryIds', 'Category numbers must be digits only.');
        return undefined;
      }
      return { kind: 'category', categoryIds: ids.map(Number), includeChildren: d.includeChildren };
    }
    case 'endsWithin': {
      const r = range(d.min, d.max, (t) => parseNumber(t, false));
      return r === undefined
        ? undefined
        : {
            kind: 'endsWithin',
            ...(r.min === undefined ? {} : { minMinutes: r.min }),
            ...(r.max === undefined ? {} : { maxMinutes: r.max }),
          };
    }
    case 'bidCount': {
      const r = range(d.min, d.max, (t) => parseNumber(t, true));
      return r === undefined ? undefined : { kind: 'bidCount', ...r };
    }
    case 'pickupOnly':
      return { kind: 'pickupOnly', value: d.pickup };
  }
}

export type DraftResult = { ok: true; rule: Rule } | { ok: false; errors: DraftError[] };

/** Validates the draft and builds a schema-valid Rule. `now` becomes updatedAt. */
export function fromDraft(draft: RuleDraft, now: number): DraftResult {
  const errors: DraftError[] = [];
  const name = draft.name.trim();
  if (name === '') errors.push({ path: 'name', message: 'Give the rule a name.' });

  const build = (group: DraftGroup, list: ConditionDraft[]): Condition[] => {
    const out: Condition[] = [];
    for (const d of list) {
      const c = conditionFromDraft(d, (field, message) => {
        errors.push({ path: `${group}.${String(d.key)}.${field}`, message });
      });
      if (c !== undefined) out.push(c);
    }
    return out;
  };
  const all = build('all', draft.all);
  const any = build('any', draft.any);
  if (draft.all.length === 0 && draft.any.length === 0) {
    errors.push({ path: 'conditions', message: 'Add at least one condition. A rule with none would match every listing.' });
  }
  if (errors.length > 0) return { ok: false, errors };

  const candidate = {
    id: draft.id,
    name,
    enabled: draft.enabled,
    action: draft.action,
    ...(draft.action === 'highlight' && draft.tone !== '' ? { tone: draft.tone } : {}),
    all,
    ...(any.length > 0 ? { any } : {}),
    createdAt: draft.createdAt,
    updatedAt: now,
  };
  const parsed = RuleSchema.safeParse(candidate);
  if (!parsed.success) return { ok: false, errors: [{ path: 'conditions', message: 'This rule is not valid.' }] };
  return { ok: true, rule: parsed.data };
}
