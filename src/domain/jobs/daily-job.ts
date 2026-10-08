// T-51: the DailyJob state machine (PLAN §3.6; T-51 rulings R1–R8).
//
// Pure: no clock (time comes from `plan`'s argument and the injected `now`),
// no storage, no SGW names. The runner (T-52) feeds it one step per alarm tick
// and persists the returned run. Everything a restarted worker needs lives in
// the run: `steps`, `cursor`, `results` and `candidates` (R5).
//
// Per watch:
//   search pages 1..maxPages (R2) → de-dup by `seenItemIds` → optimistic pass
//   (R1.1, watch rules relaxed for what the row cannot answer) → candidates →
//   `detail` when a deferred condition, favoriting or the calendar needs it
//   (R1.2, R7) → `quote` only once every other condition holds → strict pass
//   with the full rules (R1.3) → `favorite` per `favoriteMode` and
//   `calendarUpsert`, only on a strict `watch` grounded in known conditions
//   (R1.4) → `notifyDigest` last (R8).
//
// Steps are append-only and every append happens in `apply`. Searches are
// planned first, so all candidates are selected before any detail is fetched,
// and an item returned by several watches gets one candidate and one detail.
import { DEFAULT_FAVORITE_WITHIN_HOURS } from '../settings/defaults';
import type { Settings } from '../settings/schema';
import type { Condition, EvaluateBatch, MatchContext, MatchResult, Rule } from '../rules/schema';
import type { EpochMs, ItemId, Listing, SearchQuery } from '../types';
import type { DailyJob, JobCandidate, JobRun, JobStep, StepOutcome, Watch } from '../watches/schema';

/** R3: per-run caps (no existing setting covers them). */
export const MAX_DETAIL_STEPS_PER_RUN = 20;
export const MAX_QUOTE_STEPS_PER_RUN = 20;
/** R8 (decision 6): a step that fails retryably this many times is skipped. */
export const MAX_STEP_ATTEMPTS = 3;

const HOUR_MS = 3_600_000;

export interface DailyJobDeps {
  /** T-23's matcher, injected. */
  evaluateBatch: EvaluateBatch;
  /** R2: names the query's invalid params (T-52 passes the adapter's `invalidSearchParams`). */
  validateQuery: (query: SearchQuery) => string[];
  /**
   * Rows per page the search request for this query actually asks for.
   * `SearchQuery` has no page-size field; S-1 fixes ItemListing at 40
   * (`SGW_SEARCH_BODY_DEFAULTS.pageSize`), so T-52 passes the body builder's
   * value. Used only to stop paging early; a non-positive or non-integer
   * size never stops it.
   */
  searchPageSize: (query: SearchQuery) => number;
  /** Watches and rules as stored at this tick (`apply` takes no watches). */
  watches: readonly Watch[];
  rules: readonly Rule[];
  settings: Pick<Settings, 'features' | 'homeZip' | 'calendar'>;
  /** Wall clock, for the strict pass (`endsWithin`) and `finishedAt`. */
  now: () => EpochMs;
}

type Kind = JobStep['kind'];

/**
 * Controller ruling (concern 2): a watch match ignores display precedence.
 * Some matched rule of the watch has action `watch` and none has `hide` (a
 * hide vetoes); highlight never matters. Uses `matched`, not `decision`.
 */
function isWatchMatch(res: MatchResult): boolean {
  return res.matched.some((m) => m.action === 'watch') && !res.matched.some((m) => m.action === 'hide');
}

/** What the row has, for the data a detail can supply. */
interface Availability {
  sellerState: boolean;
  pickupOnly: boolean;
  categoryId: boolean;
  /** For `seller` conditions: the matcher treats only undefined as unknown. */
  sellerName: boolean;
  /** For keyword fields (R6): undefined or empty both defer. */
  sellerNameText: boolean;
  categoryPathText: boolean;
}

function availability(row: Listing): Availability {
  return {
    sellerState: row.sellerState !== undefined,
    pickupOnly: row.pickupOnly !== undefined,
    categoryId: row.categoryId !== undefined,
    sellerName: row.sellerName !== undefined,
    sellerNameText: (row.sellerName ?? '') !== '',
    categoryPathText: (row.categoryPath ?? '') !== '',
  };
}

/** R1/R6: the row cannot answer this condition but the item's detail can. */
function deferredByDetail(c: Condition, a: Availability): boolean {
  switch (c.kind) {
    case 'location':
      return !a.sellerState;
    case 'pickupOnly':
      return !a.pickupOnly;
    case 'category':
      return !a.categoryId;
    case 'seller':
      return c.sellerNames.length > 0 && !a.sellerName;
    case 'keyword':
      return c.fields.some((f) => (f === 'category' && !a.categoryPathText) || (f === 'seller' && !a.sellerNameText));
    default:
      return false;
  }
}

const conditionsOf = (r: Rule): Condition[] => [...r.all, ...(r.any ?? [])];
const usesLandedCost = (r: Rule): boolean => conditionsOf(r).some((c) => c.kind === 'landedCost');

/** Holds for every listing: a price condition with neither bound. */
const ALWAYS: Condition = { kind: 'price' };

/**
 * R1.1 transform of a `watch` rule: drop deferred conditions from `all`, drop
 * the whole `any` group if any member is deferred. A rule emptied by this
 * matches every row (R1); a rule that had no conditions still never matches.
 * Hide and highlight rules are left alone: relaxing them would hide rows, and
 * their unknown conditions already never hold.
 */
function relax(rule: Rule, deferred: (c: Condition) => boolean): Rule {
  if (rule.action !== 'watch') return rule;
  const any = rule.any ?? [];
  const all = rule.all.filter((c) => !deferred(c));
  const keptAny = any.some(deferred) ? [] : any;
  if (all.length + keptAny.length === 0 && rule.all.length + any.length > 0) return { ...rule, all: [ALWAYS], any: [] };
  return { ...rule, all, any: keptAny };
}

/** Defined fields of `detail` over `row` (a detail lacking a field keeps the row's). */
function enrich(c: JobCandidate): Listing | undefined {
  if (c.detail === undefined) return c.row;
  const out: Record<string, unknown> = { ...c.row };
  // An in-memory detail may carry explicit `undefined` keys; they must not erase row data.
  for (const [k, v] of Object.entries(c.detail as Record<string, unknown>)) if (v !== undefined) out[k] = v;
  return out as Listing;
}

const endMs = (iso: string): number => new Date(iso).getTime(); // IsoUtc with Z; Date.parse is banned
const byEnd = <T extends { endTime: string }>(a: T, b: T): number => endMs(a.endTime) - endMs(b.endTime);

function sameStep(a: JobStep, b: JobStep): boolean {
  const ra = a as Record<string, unknown>;
  const rb = b as Record<string, unknown>;
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) if (ra[k] !== rb[k]) return false;
  return true;
}

/** Which outcome kinds answer a step (besides `error`). */
const ANSWERS: Record<Kind, readonly StepOutcome['kind'][]> = {
  search: ['search'],
  favoritesList: ['favoritesList'],
  detail: ['detail'],
  postEnd: ['postEnd'],
  quote: ['quote'],
  favorite: ['favorite', 'deferred'],
  calendarUpsert: ['calendarUpsert'],
  notifyDigest: ['notifyDigest'],
};

const countKind = (run: JobRun, kind: Kind): number => run.steps.filter((s) => s.kind === kind).length;

/** A paused run (R8, decision 6) back to running; anything else unchanged. */
export function resume(run: JobRun): JobRun {
  return run.status === 'paused' ? { ...run, status: 'running' } : run;
}

/**
 * Per watch, the item ids T-52 records in `Watch.seenItemIds` (with `recordSeen`):
 * strict matches and strict rejections (R1.3). Budget skips and failures are
 * left out so the next run retries them (R3).
 */
export function seenUpdates(run: JobRun): Record<string, ItemId[]> {
  const out: Record<string, ItemId[]> = {};
  for (const c of run.candidates ?? []) {
    if (c.status !== 'matched' && c.status !== 'rejected') continue;
    for (const w of c.watchIds) (out[w] ??= []).push(c.itemId);
  }
  return out;
}

export function createDailyJob(deps: DailyJobDeps): DailyJob {
  const watchById = new Map(deps.watches.map((w) => [w.id, w]));
  const ruleById = new Map(deps.rules.map((r) => [r.id, r]));
  const homeZip = deps.settings.homeZip ?? '';
  const quotesAvailable = deps.settings.features.landedCost && homeZip.trim() !== '';
  const calendarOn = (w: Watch): boolean => w.calendar && deps.settings.calendar.enabled;

  const rulesOf = (w: Watch): Rule[] =>
    w.ruleIds.map((id) => ruleById.get(id)).filter((r): r is Rule => r !== undefined && r.enabled);

  const evaluateOne = (l: Listing, rules: Rule[], ctx: MatchContext): MatchResult => {
    const [res] = deps.evaluateBatch([l], rules, ctx);
    /* c8 ignore next: evaluateBatch returns one result per listing */
    if (res === undefined) throw new Error('evaluateBatch returned no result');
    return res;
  };

  /**
   * R1.3/R1.4: the strict match for one watch, and whether a write may rest on
   * it: some matched `watch` rule has every condition known, and no hide rule
   * has an unknown condition (one could veto the match). Highlight rules never
   * affect a watch match (controller ruling, concern 2).
   */
  const judge = (w: Watch, l: Listing, ctx: MatchContext): { match: boolean; confident: boolean; why: string } => {
    const rules = rulesOf(w);
    const res = evaluateOne(l, rules, ctx);
    if (!isWatchMatch(res)) {
      return { match: false, confident: false, why: res.matched.some((m) => m.action === 'hide') ? 'hidden' : 'no rule matched' };
    }
    if (res.unknownConditions === 0) return { match: true, confident: true, why: '' };
    const known = (r: Rule | undefined): boolean => r !== undefined && evaluateOne(l, [r], ctx).unknownConditions === 0;
    const ruleKnown = res.matched.some((m) => m.action === 'watch' && known(rules.find((r) => r.id === m.ruleId)));
    const hidesKnown = rules.filter((r) => r.action === 'hide').every(known);
    return { match: true, confident: ruleKnown && hidesKnown, why: 'unknown conditions; write withheld' };
  };

  const ctxFor = (c: JobCandidate, l: Listing): MatchContext => ({
    now: deps.now(),
    landedCost: (id) => {
      if (id !== c.itemId || c.quote === undefined) return undefined;
      return c.quote === null ? null : l.currentPrice + c.quote.shipping + c.quote.handling;
    },
  });

  /** R1.2/R7: why this watch needs the item's detail, or null. */
  const detailNeed = (w: Watch, a: Availability): 'new-match' | 'calendar' | null => {
    if (w.favoriteMode !== 'local') return 'new-match';
    if (rulesOf(w).some((r) => conditionsOf(r).some((c) => deferredByDetail(c, a)))) return 'new-match';
    return calendarOn(w) ? 'calendar' : null;
  };

  /** R1.1: rows the relaxed watch rules select (a watch match, concern 2). */
  const optimistic = (rows: Listing[], rules: Rule[], deferLandedCost: boolean): Set<ItemId> => {
    const groups = new Map<string, { a: Availability; rows: Listing[] }>();
    for (const row of rows) {
      const a = availability(row);
      const key = JSON.stringify(a);
      const g = groups.get(key) ?? { a, rows: [] };
      g.rows.push(row);
      groups.set(key, g);
    }
    const selected = new Set<ItemId>();
    for (const { a, rows: group } of groups.values()) {
      const deferred = (c: Condition): boolean => (c.kind === 'landedCost' && deferLandedCost) || deferredByDetail(c, a);
      const relaxed = rules.map((r) => relax(r, deferred));
      for (const res of deps.evaluateBatch(group, relaxed, { now: deps.now() })) {
        if (isWatchMatch(res)) selected.add(res.itemId);
      }
    }
    return selected;
  };

  const errorAt = (run: JobRun, message: string): void => {
    run.results.errors.push({ step: run.cursor, message });
  };

  const close = (c: JobCandidate, status: JobCandidate['status'], note?: string): void => {
    c.status = status;
    if (note !== undefined && note !== '') c.note = note;
    delete c.row;
    delete c.detail;
  };

  const applySearch = (run: JobRun, step: Extract<JobStep, { kind: 'search' }>, items: Listing[]): void => {
    const w = watchById.get(step.watchId);
    if (w === undefined) {
      errorAt(run, `search: watch ${step.watchId} no longer exists`);
      return;
    }
    const seen = new Set(w.seenItemIds);
    const fresh = new Map<ItemId, Listing>();
    for (const row of items) if (!seen.has(row.itemId) && !fresh.has(row.itemId)) fresh.set(row.itemId, row);
    const rows = [...fresh.values()];
    const rules = rulesOf(w);
    if (rows.length === 0 || rules.length === 0) return;

    const picked = optimistic(rows, rules, quotesAvailable);
    if (!quotesAvailable && rules.some(usesLandedCost)) {
      const lost = [...optimistic(rows, rules, true)].filter((id) => !picked.has(id)).length;
      if (lost > 0) {
        errorAt(
          run,
          `landed cost: ${String(lost)} row(s) of watch ${w.id} need a landed-cost quote, which is off (features.landedCost or homeZip); not fetched`,
        );
      }
    }

    const candidates = (run.candidates ??= []);
    let skipped = 0;
    for (const row of rows.filter((r) => picked.has(r.itemId)).sort(byEnd)) {
      let c = candidates.find((x) => x.itemId === row.itemId);
      if (c === undefined) {
        c = { itemId: row.itemId, watchIds: [w.id], endTime: row.endTime, status: 'pending', row };
        candidates.push(c);
      } else if (!c.watchIds.includes(w.id)) {
        c.watchIds.push(w.id);
      }
      if (c.status !== 'pending') continue;
      const reason = detailNeed(w, availability(row));
      if (reason === null || run.steps.some((s) => s.kind === 'detail' && s.itemId === row.itemId)) continue;
      if (countKind(run, 'detail') < MAX_DETAIL_STEPS_PER_RUN) {
        run.steps.push({ kind: 'detail', itemId: row.itemId, reason });
      } else {
        close(c, 'skipped-budget', 'detail budget');
        skipped++;
      }
    }
    if (skipped > 0) {
      errorAt(
        run,
        `budget: ${String(skipped)} candidate(s) skipped (max ${String(MAX_DETAIL_STEPS_PER_RUN)} detail steps per run); retried next run`,
      );
    }
  };

  /** R1.3/R1.4: the strict pass for every selecting watch; plans the writes. */
  const decide = (run: JobRun, c: JobCandidate, watches: Watch[], l: Listing): void => {
    const ctx = ctxFor(c, l);
    const matched: Watch[] = [];
    const notes: string[] = [];
    for (const w of watches) {
      const j = judge(w, l, ctx);
      if (j.match && j.confident) matched.push(w);
      else notes.push(`${w.id}: ${j.why}`);
    }
    if (matched.length === 0) {
      close(c, 'rejected', notes.join('; '));
      return;
    }
    if (!run.results.newMatches.includes(c.itemId)) run.results.newMatches.push(c.itemId);
    // Writes rest on the detail (R1.2); without one, none is planned.
    if (c.detail !== undefined) {
      const writers = matched.filter((w) => w.favoriteMode !== 'local');
      const now = writers.find((w) => w.favoriteMode === 'sgw');
      if (now !== undefined) {
        run.steps.push({ kind: 'favorite', itemId: c.itemId, watchId: now.id });
      } else if (writers.length > 0) {
        // sgw-late: within every late watch's window = the latest notBefore.
        const late = writers
          .map((w) => ({ w, at: endMs(l.endTime) - (w.favoriteWithinHours ?? DEFAULT_FAVORITE_WITHIN_HOURS) * HOUR_MS }))
          .reduce((a, b) => (b.at > a.at ? b : a));
        if (Number.isFinite(late.at)) {
          run.steps.push({ kind: 'favorite', itemId: c.itemId, watchId: late.w.id, notBefore: Math.max(0, late.at) });
        } else {
          notes.push(`${late.w.id}: no end time; favorite withheld`);
        }
      }
      if (matched.some(calendarOn)) run.steps.push({ kind: 'calendarUpsert', itemId: c.itemId });
    }
    close(c, 'matched', notes.join('; '));
  };

  /**
   * Moves one pending candidate on once nothing is queued for it: a quote if a
   * landed-cost rule needs one and every other condition holds, else the
   * strict pass. Returns true when it was skipped for the quote budget.
   */
  const progress = (run: JobRun, c: JobCandidate, queued: Set<string>): boolean => {
    if (queued.has(`detail:${String(c.itemId)}`) || queued.has(`quote:${String(c.itemId)}`)) return false;
    const watches = c.watchIds.map((id) => watchById.get(id)).filter((w): w is Watch => w !== undefined);
    const l = enrich(c);
    if (watches.length === 0 || l === undefined) {
      close(c, 'failed', 'watch or listing missing');
      return false;
    }
    if (c.detail?.isClosed === true) {
      close(c, 'rejected', 'closed');
      return false;
    }
    if (c.quote === undefined && quotesAvailable) {
      const ctx = ctxFor(c, l);
      const wantsQuote = watches.some((w) => {
        const rules = rulesOf(w);
        if (!rules.some(usesLandedCost) || judge(w, l, ctx).confident) return false;
        const relaxed = rules.map((r) => relax(r, (x) => x.kind === 'landedCost'));
        return isWatchMatch(evaluateOne(l, relaxed, ctx));
      });
      if (wantsQuote) {
        if (countKind(run, 'quote') >= MAX_QUOTE_STEPS_PER_RUN) {
          close(c, 'skipped-budget', 'quote budget');
          return true;
        }
        run.steps.push({ kind: 'quote', itemId: c.itemId });
        queued.add(`quote:${String(c.itemId)}`);
        return false;
      }
    }
    decide(run, c, watches, l);
    return false;
  };

  /** After every apply: once all searches ran, move pending candidates on (soonest-ending first). */
  const settle = (run: JobRun): void => {
    const rest = run.steps.slice(run.cursor);
    if (rest.some((s) => s.kind === 'search')) return;
    const queued = new Set(rest.flatMap((s) => ('itemId' in s ? [`${s.kind}:${String(s.itemId)}`] : [])));
    let skipped = 0;
    for (const c of (run.candidates ?? []).filter((x) => x.status === 'pending').sort(byEnd)) {
      if (progress(run, c, queued)) skipped++;
    }
    if (skipped > 0) {
      errorAt(
        run,
        `budget: ${String(skipped)} candidate(s) skipped (max ${String(MAX_QUOTE_STEPS_PER_RUN)} quote steps per run); retried next run`,
      );
    }
  };

  const failStep = (run: JobRun, step: JobStep, why: string): void => {
    if (step.kind !== 'detail' && step.kind !== 'quote') return;
    const c = run.candidates?.find((x) => x.itemId === step.itemId);
    if (c?.status === 'pending') close(c, 'failed', `${step.kind} failed: ${why}`);
  };

  const record = (run: JobRun, step: JobStep, outcome: StepOutcome): void => {
    const c = 'itemId' in step ? run.candidates?.find((x) => x.itemId === step.itemId) : undefined;
    if (step.kind === 'search' && outcome.kind === 'search') {
      applySearch(run, step, outcome.items);
    } else if (step.kind === 'detail' && outcome.kind === 'detail') {
      if (outcome.detail.itemId !== step.itemId) {
        errorAt(run, `detail: outcome is for item ${String(outcome.detail.itemId)}`);
        failStep(run, step, 'wrong item');
      } else if (c?.status === 'pending') {
        c.detail = outcome.detail;
      }
    } else if (step.kind === 'quote' && outcome.kind === 'quote') {
      if (c?.status === 'pending') c.quote = outcome.quote;
    } else if (step.kind === 'favorite' && outcome.kind === 'favorite') {
      if (!run.results.favorited.includes(step.itemId)) run.results.favorited.push(step.itemId);
    } else if (step.kind === 'calendarUpsert' && outcome.kind === 'calendarUpsert') {
      if (!run.results.calendarUpserts.includes(step.itemId)) run.results.calendarUpserts.push(step.itemId);
    }
    // favoritesList: T-52 caches the list. deferred: T-53's reconciler adds the
    // favorite once its window opens (R8, decision 7). notifyDigest, postEnd: nothing.
  };

  /**
   * Controller ruling (concern 4): this page was the watch's last one, being
   * short (fewer rows than the page size) or reaching `total`
   * (page × pageSize ≥ total).
   */
  const lastPage = (step: Extract<JobStep, { kind: 'search' }>, rows: number, total: number): boolean => {
    const w = watchById.get(step.watchId);
    if (w === undefined) return false;
    const size = deps.searchPageSize(w.query);
    if (!Number.isInteger(size) || size <= 0) return false;
    return rows < size || step.page * size >= total;
  };

  /** The same watch's later search pages right after the cursor (`plan` keeps a watch's pages together). */
  const laterPages = (run: JobRun, step: Extract<JobStep, { kind: 'search' }>): number => {
    let n = 0;
    for (let s = run.steps[run.cursor + 1]; s?.kind === 'search' && s.watchId === step.watchId && s.page > step.page; ) {
      n++;
      s = run.steps[run.cursor + 1 + n];
    }
    return n;
  };

  /**
   * Advance past the step (and `skip` unexecuted pages); append the digest
   * when the queue drains (only if wanted); else finish.
   */
  const advance = (run: JobRun, skip = 0): void => {
    run.cursor += 1 + skip;
    settle(run);
    if (run.cursor < run.steps.length) return;
    const wantsDigest = run.steps.some((s) => s.kind === 'search' && watchById.get(s.watchId)?.notify === true);
    if (wantsDigest && !run.steps.some((s) => s.kind === 'notifyDigest')) {
      run.steps.push({ kind: 'notifyDigest' });
      return;
    }
    run.status = 'done';
    run.finishedAt = deps.now();
  };

  return {
    plan(watches, now) {
      const steps: JobStep[] = [];
      const errors: JobRun['results']['errors'] = [];
      const planned = new Set<string>();
      for (const w of watches) {
        if (planned.has(w.id)) continue;
        planned.add(w.id);
        const invalid = deps.validateQuery(w.query);
        if (invalid.length > 0) {
          // R2: keys only, never values; no search, no widening.
          errors.push({ step: steps.length, message: `watch ${w.id}: invalid search params: ${invalid.join(', ')}` });
          continue;
        }
        for (let page = 1; page <= w.maxPages; page++) steps.push({ kind: 'search', watchId: w.id, page });
      }
      if (steps.length > 0) steps.push({ kind: 'favoritesList' });
      const run: JobRun = {
        id: `run-${String(now)}`,
        trigger: 'scheduled',
        startedAt: now,
        status: steps.length > 0 ? 'running' : 'done',
        steps,
        cursor: 0,
        results: { newMatches: [], favorited: [], calendarUpserts: [], errors },
        candidates: [],
      };
      if (steps.length === 0) run.finishedAt = now;
      return run;
    },

    next(run) {
      return run.status === 'running' ? (run.steps[run.cursor] ?? null) : null;
    },

    apply(run, step, outcome) {
      // Finished, paused, or a stale/duplicate step: no-op.
      if (run.status !== 'running') return run;
      const current = run.steps[run.cursor];
      if (current === undefined || !sameStep(current, step)) return run;

      const next = structuredClone(run);
      let skip = 0;
      if (outcome.kind === 'error') {
        errorAt(next, `${step.kind}: ${outcome.message}`);
        const prefix = `${step.kind}: `;
        const attempts = next.results.errors.filter((e) => e.step === next.cursor && e.message.startsWith(prefix)).length;
        if (outcome.retryable && attempts < MAX_STEP_ATTEMPTS) {
          next.status = 'paused';
          return next;
        }
        failStep(next, step, outcome.message);
      } else if (!ANSWERS[step.kind].includes(outcome.kind)) {
        errorAt(next, `${step.kind}: unexpected outcome '${outcome.kind}'`);
        failStep(next, step, 'unexpected outcome');
      } else {
        record(next, step, outcome);
        // Stop paging (concern 4): skip the watch's remaining pages; not an error.
        if (step.kind === 'search' && outcome.kind === 'search' && lastPage(step, outcome.items.length, outcome.total)) {
          skip = laterPages(next, step);
        }
      }
      advance(next, skip);
      return next;
    },
  };
}
