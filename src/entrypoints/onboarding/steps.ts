// T-71: pure helpers for the onboarding wizard. No browser imports, no storage,
// no logging of user data (R4: the home ZIP is never logged or audited).
import type { SearchQuery } from '../../domain/types';
import type { FavoriteMode, Watch } from '../../domain/watches/schema';
import { MATCH_ALL_RULE_ID, buildWatch, newDraft } from '../options/sections/watches/draft';

/** A US ZIP: five digits, optionally ZIP+4. */
export const US_ZIP_RE = /^\d{5}(-\d{4})?$/;

/** The error to show for a bad ZIP, or undefined when it is valid (R4: validate as a US ZIP). */
export function zipError(value: string): string | undefined {
  return US_ZIP_RE.test(value) ? undefined : 'Enter a 5-digit US ZIP code, like 98122 (98122-1234 also works).';
}

/** The whole-site search used as the template when no SGW search tab is open. */
export function templateQuery(): SearchQuery {
  return { searchText: '', categoryIds: [], sellerIds: [], page: 1 };
}

/** T-70 options flow: the options page opened at the Google Calendar section. */
export function googleOptionsUrl(optionsPageUrl: string): string {
  return `${optionsPageUrl}#section-google`;
}

export type FirstWatchResult = { ok: true; watch: Watch } | { ok: false; error: string };

/**
 * The first watch: the given search, enabled, one page, favorites on SGW right
 * away (the `Watch` schema default, §15 Q5), matching everything new through
 * the shared match-everything rule (a watch with no rules never matches).
 * `favoriteMode` defaults to the Watch schema default (`sgw`). Pass `'local'`
 * when the user chose not to favorite on ShopGoodwill. The stored `nextRunAt`
 * is ignored: T-52's `watches.save` computes the next daily slot for a new watch.
 */
export function buildFirstWatch(
  query: SearchQuery,
  now: number,
  id: string,
  favoriteMode?: FavoriteMode,
): FirstWatchResult {
  const draft = newDraft(id, query);
  draft.ruleIds = [MATCH_ALL_RULE_ID];
  if (favoriteMode !== undefined) draft.favoriteMode = favoriteMode;
  const built = buildWatch(draft, now);
  if (!built.ok) return { ok: false, error: built.errors['form'] ?? 'That watch is not valid.' };
  return { ok: true, watch: built.watch };
}
