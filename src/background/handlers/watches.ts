// T-52: `watches.list`, `watches.save`, `watches.delete` and
// `watches.importSaved` (SGW saved searches → watches, I-33).
//
// - Saved watches (T-50 carry): a query saved from a search URL or a saved
//   search runs from page 1 (the job pages 1..maxPages itself), and the stale
//   `catIds` / `cln` category-navigation params are dropped from `extra`.
//   A query with a named param that did not parse (`lp=cheap`) is refused: it
//   could never be searched.
// - watches.save keeps the runner-owned fields of a stored watch (seen ring,
//   nextRunAt, lastRunAt, lastError); the UI's copies are not trusted. A new
//   watch is first due at the next daily slot, with an empty seen ring.
// - watches.importSaved reads the saved searches once (auth, lane
//   interactive, user-triggered). Each becomes a DISABLED watch with no rules
//   (`sgw-saved-<id>`, favoriteMode the schema default): nothing is searched or
//   favorited until the user picks rules and enables it. A saved search whose
//   query equals an existing watch's (or an earlier one's in the same import),
//   or that cannot be searched, is skipped; so a re-import is idempotent. An
//   unsearchable one is audited by its saved-search id only, never its terms.
import { invalidSearchParams } from '../../adapters/sgw/query-url';
import { STORAGE_KEYS } from '../../domain/storage/schema';
import type { SearchQuery } from '../../domain/types';
import { WatchSchema, type Watch } from '../../domain/watches/schema';
import type { BackgroundContext } from '../context';
import { nextDailySlot } from '../jobs/daily-job-runner';

/** `extra` params a saved URL carries that go stale (category navigation state). */
const STALE_EXTRA = ['catIds', 'cln'];

/** The query a watch stores: page 1, without the stale params. */
export function savedWatchQuery(q: SearchQuery): SearchQuery {
  const out: SearchQuery = { ...q, page: 1 };
  if (q.extra !== undefined) {
    const extra = Object.fromEntries(Object.entries(q.extra).filter(([k]) => !STALE_EXTRA.includes(k)));
    if (Object.keys(extra).length > 0) out.extra = extra;
    else delete out.extra;
  }
  return out;
}

/** Order-independent identity of a stored query (for import de-duplication). */
export function queryKey(q: SearchQuery): string {
  const canon = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(canon);
    if (typeof v === 'object' && v !== null) {
      return Object.fromEntries(
        Object.entries(v)
          .filter(([, x]) => x !== undefined)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, x]) => [k, canon(x)]),
      );
    }
    return v;
  };
  return JSON.stringify(canon(savedWatchQuery(q)));
}

function assertSearchable(q: SearchQuery): void {
  const bad = invalidSearchParams(q);
  if (bad.length > 0) {
    throw new Error(`The watch was not saved: these search filters could not be read: ${bad.join(', ')}. Recreate it from the search page.`);
  }
}

export function register(ctx: BackgroundContext): void {
  const { router, repo, clock } = ctx;

  router.register('watches.list', () => repo.get(STORAGE_KEYS.watches));

  router.register('watches.save', async (input) => {
    const query = savedWatchQuery(input.query);
    assertSearchable(query);
    const settings = await repo.get(STORAGE_KEYS.settings);
    const now = clock.now();
    await repo.update(STORAGE_KEYS.watches, (watches) => {
      const at = watches.findIndex((w) => w.id === input.id);
      const old = watches[at];
      const next: Watch = { ...input, query, seenItemIds: old?.seenItemIds ?? [], nextRunAt: old?.nextRunAt ?? nextDailySlot(settings, now) };
      delete next.lastRunAt;
      delete next.lastError;
      if (old?.lastRunAt !== undefined) next.lastRunAt = old.lastRunAt;
      if (old?.lastError !== undefined) next.lastError = old.lastError;
      return at >= 0 ? watches.map((w, i) => (i === at ? next : w)) : [...watches, next];
    });
    return undefined;
  });

  router.register('watches.delete', async ({ id }) => {
    await repo.update(STORAGE_KEYS.watches, (watches) => (watches.some((w) => w.id === id) ? watches.filter((w) => w.id !== id) : watches));
    return undefined;
  });

  router.register('watches.importSaved', async () => {
    const saved = await ctx.api.savedSearches('interactive');
    const settings = await repo.get(STORAGE_KEYS.settings);
    const nextRunAt = nextDailySlot(settings, clock.now());
    const result = { imported: 0, skipped: 0 };
    const unsearchable: number[] = [];
    await repo.update(STORAGE_KEYS.watches, (watches) => {
      const keys = new Set(watches.map((w) => queryKey(w.query)));
      const ids = new Set(watches.map((w) => w.id));
      const added: Watch[] = [];
      for (const s of saved) {
        const id = `sgw-saved-${String(s.id)}`;
        const query = savedWatchQuery(s.query);
        const key = queryKey(query);
        if (invalidSearchParams(query).length > 0) unsearchable.push(s.id);
        if (ids.has(id) || keys.has(key) || invalidSearchParams(query).length > 0) {
          result.skipped++;
          continue;
        }
        ids.add(id);
        keys.add(key);
        added.push(
          WatchSchema.parse({ id, name: s.name, enabled: false, query, ruleIds: [], maxPages: 1, calendar: false, notify: false, nextRunAt, seenItemIds: [] }),
        );
      }
      result.imported = added.length;
      return added.length > 0 ? [...watches, ...added] : watches;
    });
    for (const savedSearchId of unsearchable) {
      await ctx.audit.append({ actor: 'user', kind: 'watches.import.skipped', details: { savedSearchId, reason: 'invalid search params' } });
    }
    return result;
  });
}
