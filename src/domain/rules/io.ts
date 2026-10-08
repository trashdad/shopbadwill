// T-114: rule import/export and built-in templates.
//
// Pure functions. Nothing here compiles or runs a user regex: keyword
// conditions are validated by the keyword compiler when a rule is saved.
import { RuleSchema, type Rule } from './schema';

export const RULES_FORMAT = 'shopbadwill.rules';
export const RULES_FORMAT_VERSION = 1;
/** Refuse to parse anything bigger than this (characters). */
export const MAX_IMPORT_CHARS = 2_000_000;
export const MAX_IMPORT_RULES = 500;

export interface ImportOptions {
  now: number;
  /** Makes a fresh id; imported ids are never reused. */
  newId: () => string;
}

export type ImportResult =
  | {
      ok: true;
      /** Fresh ids, `createdAt`/`updatedAt` set to `now`. */
      rules: Rule[];
      /** Names of imported rules that match an existing rule or another imported rule (case-insensitive). */
      duplicates: string[];
    }
  | { ok: false; errors: string[] };

/** Versioned JSON text, pretty-printed so it is easy to read and diff. */
export function exportRules(rules: readonly Rule[], exportedAt: number = Date.now()): string {
  return JSON.stringify(
    { format: RULES_FORMAT, version: RULES_FORMAT_VERSION, exportedAt, rules },
    null,
    2,
  );
}

const nameKey = (name: string): string => name.trim().toLowerCase();

/**
 * Parses and validates an export. Accepts the envelope, or a bare array of
 * rules. Any problem returns a list of plain-English errors and no rules.
 */
export function importRules(text: string, existing: readonly Rule[], opts: ImportOptions): ImportResult {
  if (text.length > MAX_IMPORT_CHARS) return { ok: false, errors: ['That text is too large to be a rules export.'] };
  if (text.trim() === '') return { ok: false, errors: ['Nothing to import. Paste the exported text first.'] };

  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, errors: ['That is not valid JSON. Paste the full text from a ShopBadwill rules export.'] };
  }

  let rawRules: unknown;
  if (Array.isArray(data)) {
    rawRules = data;
  } else if (typeof data === 'object' && data !== null) {
    const env = data as Record<string, unknown>;
    if (env['format'] !== RULES_FORMAT) {
      return { ok: false, errors: ['This is not a ShopBadwill rules export (unknown format).'] };
    }
    const version = env['version'];
    if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
      return { ok: false, errors: ['The export has no valid version number.'] };
    }
    if (version > RULES_FORMAT_VERSION) {
      return {
        ok: false,
        errors: [`This export is version ${String(version)}, which is newer than this ShopBadwill can read. Update ShopBadwill and try again.`],
      };
    }
    rawRules = env['rules'];
  } else {
    return { ok: false, errors: ['This is not a ShopBadwill rules export.'] };
  }

  if (!Array.isArray(rawRules)) return { ok: false, errors: ['The export has no list of rules.'] };
  if (rawRules.length === 0) return { ok: false, errors: ['The export contains no rules.'] };
  if (rawRules.length > MAX_IMPORT_RULES) {
    return { ok: false, errors: [`The export has more than ${String(MAX_IMPORT_RULES)} rules.`] };
  }

  const errors: string[] = [];
  const parsed: Rule[] = [];
  rawRules.forEach((raw, i) => {
    const r = RuleSchema.safeParse(raw);
    if (r.success) {
      parsed.push(r.data);
      return;
    }
    const label = typeof (raw as { name?: unknown } | null)?.name === 'string' ? ` ("${(raw as { name: string }).name}")` : '';
    const first = r.error.issues[0];
    const where = first === undefined || first.path.length === 0 ? '' : ` (${first.path.join('.')})`;
    errors.push(`Rule ${String(i + 1)}${label} is not valid${where}.`);
  });
  if (errors.length > 0) return { ok: false, errors };

  const seen = new Set(existing.map((r) => nameKey(r.name)));
  const duplicates: string[] = [];
  const rules = parsed.map((r) => {
    const key = nameKey(r.name);
    if (seen.has(key)) duplicates.push(r.name);
    seen.add(key);
    return { ...r, id: opts.newId(), createdAt: opts.now, updatedAt: opts.now };
  });
  return { ok: true, rules, duplicates };
}

// ── Templates ───────────────────────────────────────────────────────────────

export interface RuleTemplate {
  id: string;
  name: string;
  /** Plain-English explanation shown next to "Add". */
  description: string;
  /** Extra caveat to show beside the template. */
  note?: string;
  rule: Omit<Rule, 'id' | 'createdAt' | 'updatedAt'>;
}

export const RULE_TEMPLATES: readonly RuleTemplate[] = [
  {
    id: 'local-pickup-hide',
    name: 'Local pickup only items: hide',
    description: 'Hides listings that can only be picked up in person.',
    rule: {
      name: 'Local pickup only items: hide',
      enabled: true,
      action: 'hide',
      all: [{ kind: 'pickupOnly', value: true }],
    },
  },
  {
    id: 'clothing-lots-hide',
    name: 'No clothing lots: hide by keyword',
    description: 'Hides listings whose title mentions a lot of clothing.',
    rule: {
      name: 'No clothing lots: hide by keyword',
      enabled: true,
      action: 'hide',
      all: [
        {
          kind: 'keyword',
          mode: 'any',
          terms: ['clothing lot', 'lot of clothing', 'clothes lot', 'lot of clothes', 'womens lot', 'mens lot'],
          wholeWord: false,
          regex: false,
          fields: ['title'],
        },
      ],
    },
  },
  {
    id: 'under-25-landed-highlight',
    name: 'Under $25 landed: highlight',
    description: 'Highlights listings whose price plus shipping and handling is under $25.',
    note: 'Landed cost is off by default. Until you turn it on in Settings (and set your ZIP), this rule shows as unknown and does not highlight anything.',
    rule: {
      name: 'Under $25 landed: highlight',
      enabled: true,
      action: 'highlight',
      tone: 'green',
      all: [{ kind: 'landedCost', max: 2500 }],
    },
  },
  {
    id: 'exclude-state-hide',
    name: 'Exclude sellers in a state: hide',
    description: 'Hides listings from sellers in states you choose.',
    note: 'Added turned off with no states yet. Open it under Rules, pick the states, then turn it on.',
    rule: {
      name: 'Exclude sellers in a state: hide',
      enabled: false,
      action: 'hide',
      all: [{ kind: 'location', mode: 'include', states: [] }],
    },
  },
];

/** A saveable rule from a template, with a fresh id. */
export function ruleFromTemplate(t: RuleTemplate, opts: ImportOptions): Rule {
  return RuleSchema.parse(structuredClone({ ...t.rule, id: opts.newId(), createdAt: opts.now, updatedAt: opts.now }));
}
