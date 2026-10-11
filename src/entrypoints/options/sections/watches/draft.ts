// Pure helpers for the Watches editor: URL -> normalized query, query hash,
// the "match everything" rule, and draft -> schema-valid Watch.
import { invalidSearchParams, searchQueryFromUrl } from '../../../../adapters/sgw/query-url';
import { SGW_PAGE_PATTERNS } from '../../../../adapters/sgw/config';
import type { Rule } from '../../../../domain/rules/schema';
import { DEFAULT_WATCH_FAVORITE_MODE } from '../../../../domain/settings/defaults';
import type { SearchQuery } from '../../../../domain/types';
import { WatchSchema, type FavoriteMode, type Watch } from '../../../../domain/watches/schema';

export const MATCH_ALL_RULE_ID = 'sbw-match-everything';
export const DEFAULT_WITHIN_HOURS = 6;

/** Params that describe a page of the SGW site, not the search (R1). */
const STALE_EXTRA = ['catIds', 'cln'];

export type QueryResult = { ok: true; query: SearchQuery } | { ok: false; error: string };

/** True for an https shopgoodwill.com search page URL. */
export function isSgwSearchUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return (
      u.protocol === 'https:' &&
      (u.hostname === 'shopgoodwill.com' || u.hostname === 'www.shopgoodwill.com') &&
      new RegExp(SGW_PAGE_PATTERNS.search).test(u.pathname)
    );
  } catch {
    return false;
  }
}

/** R1: page 1, stale catIds/cln dropped, refuse a query with unparsed named params. */
export function normalizeQuery(q: SearchQuery): QueryResult {
  const next: SearchQuery = { ...q, page: 1 };
  if (q.extra !== undefined) {
    const extra: Record<string, string> = Object.create(null) as Record<string, string>;
    for (const [k, v] of Object.entries(q.extra)) if (!STALE_EXTRA.includes(k)) extra[k] = v;
    if (Object.keys(extra).length === 0) delete next.extra;
    else next.extra = extra;
  }
  const bad = invalidSearchParams(next);
  if (bad.length > 0) {
    return {
      ok: false,
      error: `This search has settings ShopBadwill could not read: ${bad.join(', ')}. Fix those in the address bar on ShopGoodwill and try again.`,
    };
  }
  return { ok: true, query: next };
}

export function queryFromUrl(url: string): QueryResult {
  const trimmed = url.trim();
  if (!isSgwSearchUrl(trimmed)) {
    return { ok: false, error: 'That is not a ShopGoodwill search page. Open a search on shopgoodwill.com first.' };
  }
  const q = searchQueryFromUrl(trimmed);
  if (q === null) return { ok: false, error: 'Could not read that search address.' };
  return normalizeQuery(q);
}

export function defaultWatchName(q: SearchQuery): string {
  const t = q.searchText.trim();
  return t === '' ? 'All items in this search' : t.slice(0, 80);
}

/** The always-true rule offered for a rule-less watch (R2): price at least $0. */
export function matchEverythingRule(now: number): Rule {
  return {
    id: MATCH_ALL_RULE_ID,
    name: 'Match everything new in a search (price at least $0)',
    enabled: true,
    action: 'watch',
    all: [{ kind: 'price', min: 0 }],
    createdAt: now,
    updatedAt: now,
  };
}

export interface WatchDraft {
  id: string;
  name: string;
  enabled: boolean;
  query: SearchQuery;
  ruleIds: string[];
  maxPages: 1 | 2 | 3;
  favoriteMode: FavoriteMode;
  withinHours: string;
  calendar: boolean;
  notify: boolean;
}

export function newDraft(id: string, query: SearchQuery): WatchDraft {
  return {
    id,
    name: defaultWatchName(query),
    enabled: true,
    query,
    ruleIds: [],
    maxPages: 1,
    favoriteMode: DEFAULT_WATCH_FAVORITE_MODE,
    withinHours: String(DEFAULT_WITHIN_HOURS),
    calendar: false,
    notify: true,
  };
}

export function draftFromWatch(w: Watch): WatchDraft {
  return {
    id: w.id,
    name: w.name,
    enabled: w.enabled,
    query: w.query,
    ruleIds: w.ruleIds,
    maxPages: w.maxPages,
    favoriteMode: w.favoriteMode,
    withinHours: String(w.favoriteWithinHours ?? DEFAULT_WITHIN_HOURS),
    calendar: w.calendar,
    notify: w.notify,
  };
}

export type BuildResult = { ok: true; watch: Watch } | { ok: false; errors: Record<string, string> };

/** `base` is the existing watch when editing (keeps its run state). */
export function buildWatch(draft: WatchDraft, nextRunAt: number, base?: Watch): BuildResult {
  const errors: Record<string, string> = {};
  const norm = normalizeQuery(draft.query);
  if (!norm.ok) errors['query'] = norm.error;
  if (draft.name.trim() === '') errors['name'] = 'Give the watch a name.';
  let within: number | undefined;
  if (draft.favoriteMode === 'sgw-late') {
    within = Number(draft.withinHours);
    if (!Number.isFinite(within) || within <= 0) errors['within'] = 'Enter a number of hours greater than zero.';
  }
  if (Object.keys(errors).length > 0 || !norm.ok) return { ok: false, errors };
  const candidate = {
    ...(base ?? { nextRunAt, seenItemIds: [] }),
    id: draft.id,
    name: draft.name.trim(),
    enabled: draft.enabled,
    query: norm.query,
    ruleIds: draft.ruleIds,
    maxPages: draft.maxPages,
    favoriteMode: draft.favoriteMode,
    calendar: draft.calendar,
    notify: draft.notify,
  } as Record<string, unknown>;
  if (within !== undefined) candidate['favoriteWithinHours'] = within;
  else delete candidate['favoriteWithinHours'];
  const parsed = WatchSchema.safeParse(candidate);
  if (!parsed.success) return { ok: false, errors: { form: 'That watch is not valid. Check the fields and try again.' } };
  return { ok: true, watch: parsed.data };
}

/**
 * T-52's `watches.importSaved` stores an imported saved search as
 * `sgw-saved-<savedSearchId>`: disabled, no rules, favoriteMode the schema
 * default ('sgw'). The Watch schema has no other import marker.
 */
export const IMPORTED_WATCH_ID_PREFIX = 'sgw-saved-';

export function isImportedWatch(w: { id: string }): boolean {
  return w.id.startsWith(IMPORTED_WATCH_ID_PREFIX);
}

/** Appended to the import result when anything was imported. */
export const IMPORT_STATUS_NOTE =
  'Imported watches start disabled with no rules. Once you enable one and add rules, matches are favorited on your ShopGoodwill account (unless dry-run is on).';

/**
 * What an imported watch will do once it runs (T-52 carry): favorite on the
 * user's ShopGoodwill account unless it is local-only or favorites dry-run is
 * on. `dryRunFavorites` is `settings.dryRun.favorites`, or undefined when the
 * settings could not be read (then the current state is not claimed).
 */
export function importedWatchNote(
  w: { enabled: boolean; favoriteMode: FavoriteMode; ruleIds: readonly string[] },
  dryRunFavorites: boolean | undefined,
): string {
  const lead = w.enabled ? 'Imported from your ShopGoodwill saved searches.' : 'Imported disabled.';
  const steps = [...(w.enabled ? [] : ['enable it']), ...(w.ruleIds.length === 0 ? ['add rules'] : [])];
  const effect =
    w.favoriteMode === 'local'
      ? 'matches are tracked in ShopBadwill only; nothing is favorited on your ShopGoodwill account.'
      : `matches are favorited on your ShopGoodwill account${w.favoriteMode === 'sgw-late' ? ' shortly before they end' : ''} (unless dry-run is on).`;
  const sentence = steps.length === 0 ? effect.charAt(0).toUpperCase() + effect.slice(1) : `Once you ${steps.join(' and ')}, ${effect}`;
  let now = '';
  if (w.favoriteMode !== 'local' && dryRunFavorites !== undefined) {
    now = dryRunFavorites
      ? ' Favorites dry-run is on right now, so nothing is written to your ShopGoodwill account yet.'
      : ' Favorites dry-run is off right now, so these favorites are real.';
  }
  return `${lead} ${sentence}${now}`;
}

/** The URL of the most recently used SGW search tab, or undefined when none is open. */
export function pickSearchTab(tabs: ReadonlyArray<{ url?: string | undefined; lastAccessed?: number | undefined }>): string | undefined {
  let best: { url: string; at: number } | undefined;
  for (const t of tabs) {
    if (t.url === undefined || !isSgwSearchUrl(t.url)) continue;
    const at = t.lastAccessed ?? 0;
    if (best === undefined || at > best.at) best = { url: t.url, at };
  }
  return best?.url;
}
