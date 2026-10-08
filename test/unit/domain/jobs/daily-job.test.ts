// T-51: DailyJob state machine (PLAN §3.6, T-51 rulings R1–R8).
// Uses the real T-23 matcher (domain → domain), the real T-50
// `invalidSearchParams` as the injected validator (R2), and the T-33 Repo over
// FakeStorageAreas for the R5 round trip.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { invalidSearchParams } from '../../../../src/adapters/sgw/query-url';
import {
  MAX_DETAIL_STEPS_PER_RUN,
  MAX_QUOTE_STEPS_PER_RUN,
  MAX_STEP_ATTEMPTS,
  createDailyJob,
  resume,
  seenUpdates,
  type DailyJobDeps,
} from '../../../../src/domain/jobs/daily-job';
import { evaluateBatch } from '../../../../src/domain/rules/matcher';
import type { Condition, Rule } from '../../../../src/domain/rules/schema';
import { DEFAULT_FAVORITE_WITHIN_HOURS, defaultSettings } from '../../../../src/domain/settings/defaults';
import type { Settings } from '../../../../src/domain/settings/schema';
import { Repo } from '../../../../src/domain/storage/repo';
import { STORAGE_KEYS } from '../../../../src/domain/storage/schema';
import type { ItemDetail, ItemId, Listing } from '../../../../src/domain/types';
import {
  JobRunSchema,
  type DailyJob,
  type JobCandidate,
  type JobRun,
  type JobStep,
  type StepOutcome,
  type Watch,
} from '../../../../src/domain/watches/schema';
import { FakeClock } from '../../../fakes/ports/fake-clock';
import { FakeStorageAreas } from '../../../fakes/ports/fake-storage';

// ── fixtures ────────────────────────────────────────────────────────────────

const NOW = Date.UTC(2026, 9, 8, 11, 0); // 07:00 New York
const HOUR = 3_600_000;
const iso = (ms: number): string => new Date(ms).toISOString();
const endIn = (hours: number): string => iso(NOW + hours * HOUR);

function listing(itemId: number, over: Partial<Listing> = {}): Listing {
  return {
    itemId,
    title: `Pyrex bowl ${String(itemId)}`,
    currentPrice: 1000,
    startingMinimumBid: 500,
    numBids: 0,
    endTime: endIn(48 + itemId / 100),
    endTimeRaw: '2026-10-10T04:00:00',
    sellerId: 7,
    source: 'api',
    observedAt: NOW,
    ...over,
  };
}

function detailOf(row: Listing, over: Partial<ItemDetail> = {}): ItemDetail {
  return {
    ...row,
    sellerName: 'Goodwill Columbus',
    sellerState: 'OH',
    categoryId: 12,
    categoryPath: 'Kitchen > Bowls',
    pickupOnly: false,
    minimumBid: row.currentPrice + 100,
    bidIncrement: 100,
    serverTime: iso(NOW),
    serverTimeRaw: '2026-10-08T04:00:00',
    isClosed: false,
    isHighBidder: null,
    inWatchlist: null,
    bidHistory: [],
    ...over,
  };
}

const kw = (term: string, fields: Array<'title' | 'category' | 'seller'> = ['title']): Condition => ({
  kind: 'keyword',
  mode: 'any',
  terms: [term],
  wholeWord: false,
  regex: false,
  fields,
});

function rule(id: string, all: Condition[], over: Partial<Rule> = {}): Rule {
  return { id, name: id, enabled: true, action: 'watch', all, createdAt: 0, updatedAt: 0, ...over };
}

const PYREX = rule('r-pyrex', [kw('pyrex')]);

function watch(id: string, over: Partial<Watch> = {}): Watch {
  return {
    id,
    name: id,
    enabled: true,
    query: { searchText: 'pyrex', categoryIds: [], sellerIds: [], page: 1 },
    ruleIds: ['r-pyrex'],
    maxPages: 1,
    favoriteMode: 'sgw',
    calendar: false,
    notify: false,
    nextRunAt: NOW,
    seenItemIds: [],
    ...over,
  };
}

function settingsWith(over: { landedCost?: boolean; homeZip?: string; calendar?: boolean } = {}): Settings {
  const s = defaultSettings();
  s.features.landedCost = over.landedCost ?? false;
  if (over.homeZip !== undefined) s.homeZip = over.homeZip;
  s.calendar.enabled = over.calendar ?? false;
  return s;
}

const QUOTES_ON = { landedCost: true, homeZip: '43004' } as const;

interface Setup {
  watches: Watch[];
  rules?: Rule[];
  settings?: Settings;
  validateQuery?: DailyJobDeps['validateQuery'];
}

function setup(s: Setup): { job: DailyJob; run: JobRun } {
  const job = createDailyJob({
    evaluateBatch,
    validateQuery: s.validateQuery ?? invalidSearchParams,
    watches: s.watches,
    rules: s.rules ?? [PYREX],
    settings: s.settings ?? settingsWith(),
    now: () => NOW,
  });
  return { job, run: job.plan(s.watches, NOW) };
}

interface Script {
  /** Rows per `${watchId}:${page}`. */
  search?: Record<string, Listing[]>;
  /** Overrides on the detail built from the item's search row. */
  details?: Record<number, Partial<ItemDetail>>;
  quotes?: Record<number, { shipping: number; handling: number } | null>;
}

/** A well-behaved runner: answers each step from the script. */
function responder(script: Script): (step: JobStep) => StepOutcome {
  const rows = new Map<ItemId, Listing>();
  for (const list of Object.values(script.search ?? {})) for (const r of list) rows.set(r.itemId, r);
  return (step) => {
    switch (step.kind) {
      case 'search': {
        const items = script.search?.[`${step.watchId}:${String(step.page)}`] ?? [];
        return { kind: 'search', items, total: items.length };
      }
      case 'favoritesList':
        return { kind: 'favoritesList', items: [] };
      case 'detail':
      case 'postEnd':
        return { kind: step.kind, detail: detailOf(rows.get(step.itemId) ?? listing(step.itemId), script.details?.[step.itemId]) };
      case 'quote':
        return { kind: 'quote', quote: script.quotes && step.itemId in script.quotes ? (script.quotes[step.itemId] ?? null) : { shipping: 500, handling: 100 } };
      default:
        return { kind: step.kind, done: true };
    }
  };
}

function drive(job: DailyJob, start: JobRun, respond: (step: JobStep) => StepOutcome, limit = 1000): JobRun {
  let run = start;
  for (let i = 0; i < limit; i++) {
    const step = job.next(run);
    if (step === null) return run;
    run = job.apply(run, step, respond(step));
  }
  throw new Error('run did not finish');
}

function at<T>(xs: readonly T[], i: number): T {
  const x = xs[i];
  if (x === undefined) throw new Error(`no element at ${String(i)}`);
  return x;
}

const kinds = (run: JobRun): string[] => run.steps.map((s) => s.kind);
const stepsOf = <K extends JobStep['kind']>(run: JobRun, kind: K): Array<Extract<JobStep, { kind: K }>> =>
  run.steps.filter((s): s is Extract<JobStep, { kind: K }> => s.kind === kind);
const candidate = (run: JobRun, id: ItemId): JobCandidate | undefined => run.candidates?.find((c) => c.itemId === id);

// ── brief: Tests first ──────────────────────────────────────────────────────

describe('DailyJob (brief tests)', () => {
  it('a plan for 3 watches × 2 pages yields 6 search steps then 1 favoritesList', () => {
    const ws = ['a', 'b', 'c'].map((id) => watch(id, { maxPages: 2 }));
    const { run } = setup({ watches: ws });
    expect(run.steps).toEqual([
      { kind: 'search', watchId: 'a', page: 1 },
      { kind: 'search', watchId: 'a', page: 2 },
      { kind: 'search', watchId: 'b', page: 1 },
      { kind: 'search', watchId: 'b', page: 2 },
      { kind: 'search', watchId: 'c', page: 1 },
      { kind: 'search', watchId: 'c', page: 2 },
      { kind: 'favoritesList' },
    ]);
    expect(run).toMatchObject({ status: 'running', cursor: 0, startedAt: NOW, trigger: 'scheduled', candidates: [] });
    expect(run.results).toEqual({ newMatches: [], favorited: [], calendarUpserts: [], errors: [] });
    expect(JobRunSchema.parse(run)).toEqual(run);
  });

  it('a search outcome with 2 new matches appends 2 detail steps (seen and non-matching rows skipped)', () => {
    const w = watch('w1', { seenItemIds: [103] });
    const { job, run } = setup({ watches: [w] });
    const rows = [
      listing(101, { endTime: endIn(30) }),
      listing(102, { title: 'Teapot' }),
      listing(103), // already seen
      listing(104, { endTime: endIn(20) }),
    ];
    const after = job.apply(run, at(run.steps, 0), { kind: 'search', items: rows, total: 4 });
    expect(after.cursor).toBe(1);
    expect(after.steps.slice(run.steps.length)).toEqual([
      { kind: 'detail', itemId: 104, reason: 'new-match' },
      { kind: 'detail', itemId: 101, reason: 'new-match' },
    ]);
    expect(after.candidates?.map((c) => [c.itemId, c.status, c.watchIds])).toEqual([
      [104, 'pending', ['w1']],
      [101, 'pending', ['w1']],
    ]);
    expect(run.steps).toHaveLength(2); // the input run is not mutated
  });

  it('`local` mode never adds a favorite step', () => {
    for (const calendar of [false, true]) {
      const w = watch('w1', { favoriteMode: 'local', calendar });
      const { job, run } = setup({ watches: [w], settings: settingsWith({ calendar: true }) });
      const done = drive(job, run, responder({ search: { 'w1:1': [listing(1), listing(2)] } }));
      expect(done.status).toBe('done');
      expect(stepsOf(done, 'favorite')).toEqual([]);
      expect(done.results.newMatches.sort()).toEqual([1, 2]);
    }
  });

  it('`sgw-late` adds a favorite step with notBefore = end − N h', () => {
    const end = NOW + 50 * HOUR;
    const w = watch('w1', { favoriteMode: 'sgw-late', favoriteWithinHours: 12 });
    const { job, run } = setup({ watches: [w] });
    const done = drive(job, run, responder({ search: { 'w1:1': [listing(1, { endTime: iso(end) })] } }));
    expect(stepsOf(done, 'favorite')).toEqual([{ kind: 'favorite', itemId: 1, watchId: 'w1', notBefore: end - 12 * HOUR }]);

    const w2 = watch('w2', { favoriteMode: 'sgw-late' }); // N defaults to the settings constant
    const s2 = setup({ watches: [w2] });
    const done2 = drive(s2.job, s2.run, responder({ search: { 'w2:1': [listing(1, { endTime: iso(end) })] } }));
    expect(stepsOf(done2, 'favorite')).toEqual([
      { kind: 'favorite', itemId: 1, watchId: 'w2', notBefore: end - DEFAULT_FAVORITE_WITHIN_HOURS * HOUR },
    ]);

    const w3 = watch('w3', { favoriteMode: 'sgw' }); // plain sgw: no notBefore
    const s3 = setup({ watches: [w3] });
    const done3 = drive(s3.job, s3.run, responder({ search: { 'w3:1': [listing(1)] } }));
    expect(stepsOf(done3, 'favorite')).toEqual([{ kind: 'favorite', itemId: 1, watchId: 'w3' }]);
  });

  it('a `landedCost` rule adds one quote step per new match that passed every other condition', () => {
    const lc = rule('r-lc', [kw('pyrex'), { kind: 'price', max: 2000 }, { kind: 'landedCost', max: 3000 }]);
    const w = watch('w1', { ruleIds: ['r-lc'] });
    const { job, run } = setup({ watches: [w], rules: [lc], settings: settingsWith(QUOTES_ON) });
    const done = drive(
      job,
      run,
      responder({
        search: { 'w1:1': [listing(1), listing(2), listing(3, { title: 'Teapot' })] },
        details: { 1: { currentPrice: 1500 }, 2: { currentPrice: 2500 } }, // 2 fails `price` on the detail
        quotes: { 1: { shipping: 800, handling: 200 } }, // 1500 + 1000 = 2500 ≤ 3000
      }),
    );
    expect(stepsOf(done, 'quote')).toEqual([{ kind: 'quote', itemId: 1 }]);
    const order = done.steps.map((s) => ('itemId' in s ? `${s.kind}:${String(s.itemId)}` : s.kind));
    expect(order.indexOf('quote:1')).toBeGreaterThan(order.indexOf('detail:1')); // R1.2: after its detail
    expect(stepsOf(done, 'favorite').map((s) => s.itemId)).toEqual([1]);
    expect(candidate(done, 2)?.status).toBe('rejected');

    // Without a detail need (local, no calendar), the quote is planned on the row alone.
    const wl = watch('wl', { ruleIds: ['r-lc'], favoriteMode: 'local' });
    const sl = setup({ watches: [wl], rules: [lc], settings: settingsWith(QUOTES_ON) });
    const doneL = drive(
      sl.job,
      sl.run,
      responder({ search: { 'wl:1': [listing(1), listing(2, { currentPrice: 2500 })] }, quotes: { 1: { shipping: 4000, handling: 0 } } }),
    );
    expect(kinds(doneL)).toEqual(['search', 'favoritesList', 'quote']);
    expect(stepsOf(doneL, 'quote')).toEqual([{ kind: 'quote', itemId: 1 }]);
    expect(candidate(doneL, 1)?.status).toBe('rejected'); // landed 5000 > 3000
    expect(doneL.results.newMatches).toEqual([]);
  });

  it('applying an outcome to a finished run is a no-op', () => {
    const { job, run } = setup({ watches: [watch('w1')] });
    const done = drive(job, run, responder({}));
    expect(done.status).toBe('done');
    expect(done.finishedAt).toBe(NOW);
    expect(job.next(done)).toBeNull();
    expect(job.apply(done, at(done.steps, 0), { kind: 'search', items: [listing(1)], total: 1 })).toBe(done);
    const failed: JobRun = { ...done, status: 'failed' };
    expect(job.apply(failed, at(failed.steps, 0), { kind: 'error', message: 'x', retryable: false })).toBe(failed);
  });
});

// ── R1: two-pass evaluation ────────────────────────────────────────────────

describe('R1 two-pass evaluation', () => {
  type Case = {
    name: string;
    cond: Condition;
    rowLacks: Partial<Listing>;
    rowKnownMiss: Partial<Listing>;
    hit: Partial<ItemDetail>;
    miss: Partial<ItemDetail>;
  };
  const cases: Case[] = [
    {
      name: 'location (no sellerState on the row)',
      cond: { kind: 'location', mode: 'include', states: ['OH'] },
      rowLacks: {},
      rowKnownMiss: { sellerState: 'CA' },
      hit: { sellerState: 'OH' },
      miss: { sellerState: 'CA' },
    },
    {
      name: 'pickupOnly (unknown on the row)',
      cond: { kind: 'pickupOnly', value: false },
      rowLacks: {},
      rowKnownMiss: { pickupOnly: true },
      hit: { pickupOnly: false },
      miss: { pickupOnly: true },
    },
    {
      name: 'category (no categoryId on the row)',
      cond: { kind: 'category', categoryIds: [12], includeChildren: false },
      rowLacks: {},
      rowKnownMiss: { categoryId: 99 },
      hit: { categoryId: 12 },
      miss: { categoryId: 99 },
    },
    {
      name: 'seller name list (no sellerName on the row)',
      cond: { kind: 'seller', mode: 'include', sellerIds: [], sellerNames: ['Goodwill Columbus'] },
      rowLacks: {},
      rowKnownMiss: { sellerName: 'Other Store' },
      hit: { sellerName: 'Goodwill Columbus' },
      miss: { sellerName: 'Other Store' },
    },
    {
      name: 'R6 keyword on the category field (no categoryPath on the row)',
      cond: kw('bowls', ['category']),
      rowLacks: {},
      rowKnownMiss: { categoryPath: 'Toys' },
      hit: { categoryPath: 'Kitchen > Bowls' },
      miss: { categoryPath: 'Toys' },
    },
    {
      name: 'R6 keyword on the seller field (empty sellerName on the row)',
      cond: kw('columbus', ['seller']),
      rowLacks: { sellerName: '' },
      rowKnownMiss: { sellerName: 'Goodwill Akron' },
      hit: { sellerName: 'Goodwill Columbus' },
      miss: { sellerName: 'Goodwill Akron' },
    },
  ];

  const run1 = (c: Case, row: Listing, detail: Partial<ItemDetail>): JobRun => {
    const r = rule('r', [kw('pyrex'), c.cond]);
    const { job, run } = setup({ watches: [watch('w1', { ruleIds: ['r'] })], rules: [r] });
    return drive(job, run, responder({ search: { 'w1:1': [row] }, details: { [row.itemId]: detail } }));
  };

  it.each(cases)('$name: deferred on the row, decided strictly on the detail', (c) => {
    const row = listing(201, c.rowLacks);
    const hit = run1(c, row, c.hit);
    expect(stepsOf(hit, 'detail')).toEqual([{ kind: 'detail', itemId: 201, reason: 'new-match' }]);
    expect(stepsOf(hit, 'favorite')).toEqual([{ kind: 'favorite', itemId: 201, watchId: 'w1' }]);
    expect(hit.results.newMatches).toEqual([201]);
    expect(seenUpdates(hit)).toEqual({ w1: [201] });

    const miss = run1(c, row, c.miss);
    expect(stepsOf(miss, 'detail')).toHaveLength(1);
    expect(stepsOf(miss, 'favorite')).toEqual([]);
    expect(miss.results.newMatches).toEqual([]);
    expect(candidate(miss, 201)).toMatchObject({ status: 'rejected' });
    expect(seenUpdates(miss)).toEqual({ w1: [201] }); // R1.3: evaluated, so recorded as seen
  });

  it.each(cases)('$name: a row that answers the condition (and fails it) is not a candidate', (c) => {
    const missRun = run1(c, listing(202, c.rowKnownMiss), c.hit);
    expect(stepsOf(missRun, 'detail')).toEqual([]);
    expect(missRun.candidates).toEqual([]);
  });

  it('drops a whole `any` group when one member is deferred', () => {
    const r = rule('r', [kw('pyrex')], { any: [{ kind: 'location', mode: 'include', states: ['OH'] }, { kind: 'price', max: 500 }] });
    const { job, run } = setup({ watches: [watch('w1', { ruleIds: ['r'] })], rules: [r] });
    // Row price 1000 fails the `price` member; the deferred location member might hold.
    const done = drive(job, run, responder({ search: { 'w1:1': [listing(1)] }, details: { 1: { sellerState: 'OH' } } }));
    expect(stepsOf(done, 'detail')).toHaveLength(1);
    expect(stepsOf(done, 'favorite').map((s) => s.itemId)).toEqual([1]);
  });

  it('a rule emptied by the transform matches every new row; a rule with no conditions never does', () => {
    const emptied = rule('r', [{ kind: 'location', mode: 'include', states: ['OH'] }]);
    const a = setup({ watches: [watch('w1', { ruleIds: ['r'] })], rules: [emptied] });
    const rows = [listing(1, { title: 'Teapot' }), listing(2, { title: 'Lamp' })];
    const afterA = a.job.apply(a.run, at(a.run.steps, 0), { kind: 'search', items: rows, total: 2 });
    expect(stepsOf(afterA, 'detail').map((s) => s.itemId).sort()).toEqual([1, 2]);

    const empty = rule('r', []);
    const b = setup({ watches: [watch('w1', { ruleIds: ['r'] })], rules: [empty] });
    const afterB = b.job.apply(b.run, at(b.run.steps, 0), { kind: 'search', items: rows, total: 2 });
    expect(stepsOf(afterB, 'detail')).toEqual([]);
  });

  it('does not relax hide rules: an unknown hide condition keeps the row a candidate, the detail decides', () => {
    const hide = rule('h', [{ kind: 'pickupOnly', value: true }], { action: 'hide' });
    const w = watch('w1', { ruleIds: ['r-pyrex', 'h'] });
    const go = (pickupOnly: boolean): JobRun => {
      const { job, run } = setup({ watches: [w], rules: [PYREX, hide] });
      return drive(job, run, responder({ search: { 'w1:1': [listing(1)] }, details: { 1: { pickupOnly } } }));
    };
    expect(stepsOf(go(false), 'favorite').map((s) => s.itemId)).toEqual([1]);
    const hidden = go(true);
    expect(stepsOf(hidden, 'favorite')).toEqual([]);
    expect(candidate(hidden, 1)?.status).toBe('rejected');
  });

  describe('R1.4 never write on an unknown', () => {
    const loc = (states: string[]): Condition => ({ kind: 'location', mode: 'include', states });

    it('a watch decision with the matched rule fully known still writes (another rule unknown)', () => {
      const other = rule('r-loc', [loc(['OH'])]);
      const w = watch('w1', { ruleIds: ['r-pyrex', 'r-loc'], calendar: true });
      const { job, run } = setup({ watches: [w], rules: [PYREX, other], settings: settingsWith({ calendar: true }) });
      const done = drive(job, run, responder({ search: { 'w1:1': [listing(1)] }, details: { 1: { sellerState: undefined } } }));
      expect(stepsOf(done, 'favorite').map((s) => s.itemId)).toEqual([1]);
      expect(stepsOf(done, 'calendarUpsert').map((s) => s.itemId)).toEqual([1]);
    });

    it('an unknown in the matched rule itself withholds every write', () => {
      const r = rule('r', [kw('pyrex')], { any: [loc(['OH']), { kind: 'price', max: 5000 }] });
      const w = watch('w1', { ruleIds: ['r'], calendar: true });
      const { job, run } = setup({ watches: [w], rules: [r], settings: settingsWith({ calendar: true }) });
      const done = drive(job, run, responder({ search: { 'w1:1': [listing(1)] }, details: { 1: { sellerState: undefined } } }));
      expect(stepsOf(done, 'favorite')).toEqual([]);
      expect(stepsOf(done, 'calendarUpsert')).toEqual([]);
      expect(done.results.newMatches).toEqual([]);
      expect(candidate(done, 1)?.status).toBe('rejected');
      expect(candidate(done, 1)?.note).toMatch(/unknown/);
    });

    it('an unknown hide (or highlight) rule withholds the write: it could flip the decision', () => {
      const hide = rule('h', [loc(['CA'])], { action: 'hide' });
      const w = watch('w1', { ruleIds: ['r-pyrex', 'h'] });
      const { job, run } = setup({ watches: [w], rules: [PYREX, hide] });
      const done = drive(job, run, responder({ search: { 'w1:1': [listing(1)] }, details: { 1: { sellerState: undefined } } }));
      expect(stepsOf(done, 'favorite')).toEqual([]);
      expect(candidate(done, 1)?.note).toMatch(/unknown/);
    });

    it('a strictly unmatched location (still unknown after the detail) is rejected, not written', () => {
      const r = rule('r', [kw('pyrex'), loc(['OH'])]);
      const { job, run } = setup({ watches: [watch('w1', { ruleIds: ['r'] })], rules: [r] });
      const done = drive(job, run, responder({ search: { 'w1:1': [listing(1)] }, details: { 1: { sellerState: undefined } } }));
      expect(stepsOf(done, 'favorite')).toEqual([]);
      expect(candidate(done, 1)?.status).toBe('rejected');
    });
  });

  it('a closed item is rejected on its detail', () => {
    const { job, run } = setup({ watches: [watch('w1')] });
    const done = drive(job, run, responder({ search: { 'w1:1': [listing(1)] }, details: { 1: { isClosed: true } } }));
    expect(stepsOf(done, 'favorite')).toEqual([]);
    expect(candidate(done, 1)?.status).toBe('rejected');
    expect(candidate(done, 1)?.note).toMatch(/closed/);
  });
});

// ── R2: search steps ───────────────────────────────────────────────────────

describe('R2 search steps', () => {
  it('uses pages 1..maxPages and ignores the page saved in the query', () => {
    const w = watch('w1', { maxPages: 3, query: { searchText: 'pyrex', categoryIds: [], sellerIds: [], page: 3 } });
    const { run } = setup({ watches: [w] });
    expect(stepsOf(run, 'search').map((s) => s.page)).toEqual([1, 2, 3]);
  });

  it('plans no search for a watch with invalid params and names the keys, never the values', () => {
    const bad = watch('bad', {
      query: { searchText: 'x', categoryIds: [], sellerIds: [], page: 1, extra: { lp: 'cheapo', c: 'abc', foo: 'bar' } },
    });
    const good = watch('good');
    const { run } = setup({ watches: [bad, good] });
    expect(run.steps).toEqual([{ kind: 'search', watchId: 'good', page: 1 }, { kind: 'favoritesList' }]);
    expect(run.results.errors).toHaveLength(1);
    const { step, message } = at(run.results.errors, 0);
    expect(step).toBe(0);
    expect(message).toBe('watch bad: invalid search params: lp, c');
    expect(message).not.toMatch(/cheapo|abc|foo|bar/);
  });

  it('uses the injected validator, and a run with nothing to search is done at once', () => {
    const { run } = setup({ watches: [watch('w1')], validateQuery: () => ['st'] });
    expect(run.steps).toEqual([]);
    expect(run).toMatchObject({ status: 'done', finishedAt: NOW, cursor: 0 });
    expect(run.results.errors.map((e) => e.message)).toEqual(['watch w1: invalid search params: st']);
  });
});

// ── R3: budget ─────────────────────────────────────────────────────────────

describe('R3 budget', () => {
  // 25 matches with shuffled end times: item n ends in n hours.
  const ids = Array.from({ length: 25 }, (_, i) => ((i * 7) % 25) + 1);
  const rows = ids.map((n) => listing(n, { endTime: endIn(n) }));

  it('exports the per-run caps', () => {
    expect(MAX_DETAIL_STEPS_PER_RUN).toBe(20);
    expect(MAX_QUOTE_STEPS_PER_RUN).toBe(20);
  });

  it('caps detail steps soonest-ending first; the excess is skipped-budget and not marked seen', () => {
    const { job, run } = setup({ watches: [watch('w1')] });
    const after = job.apply(run, at(run.steps, 0), { kind: 'search', items: rows, total: 25 });
    expect(stepsOf(after, 'detail').map((s) => s.itemId)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    const skipped = after.candidates?.filter((c) => c.status === 'skipped-budget').map((c) => c.itemId);
    expect(skipped?.sort((a, b) => a - b)).toEqual([21, 22, 23, 24, 25]);
    expect(after.results.errors.map((e) => e.message)).toEqual([
      'budget: 5 candidate(s) skipped (max 20 detail steps per run); retried next run',
    ]);
    const done = drive(job, after, responder({ search: { 'w1:1': rows } }));
    const seen = seenUpdates(done).w1 ?? [];
    expect(seen).toHaveLength(20);
    expect(seen.some((id) => id > 20)).toBe(false);
  });

  it('caps quote steps soonest-ending first', () => {
    const lc = rule('r-lc', [kw('pyrex'), { kind: 'landedCost', max: 5000 }]);
    const w = watch('w1', { ruleIds: ['r-lc'], favoriteMode: 'local' });
    const { job, run } = setup({ watches: [w], rules: [lc], settings: settingsWith(QUOTES_ON) });
    const after = job.apply(run, at(run.steps, 0), { kind: 'search', items: rows, total: 25 });
    expect(stepsOf(after, 'quote').map((s) => s.itemId)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    expect(after.candidates?.filter((c) => c.status === 'skipped-budget')).toHaveLength(5);
    const done = drive(job, after, responder({ search: { 'w1:1': rows } }));
    expect(done.results.newMatches).toHaveLength(20);
    expect(seenUpdates(done).w1).toHaveLength(20);
  });

  it('counts the budget across the whole run, not per search page', () => {
    const w = watch('w1', { maxPages: 2 });
    const page1 = rows.slice(0, 15);
    const page2 = rows.slice(15).concat([listing(30, { endTime: endIn(0.5) })]);
    const { job, run } = setup({ watches: [w] });
    const done = drive(job, run, responder({ search: { 'w1:1': page1, 'w1:2': page2 } }));
    expect(stepsOf(done, 'detail')).toHaveLength(MAX_DETAIL_STEPS_PER_RUN);
    expect(done.candidates?.filter((c) => c.status === 'skipped-budget')).toHaveLength(6);
  });
});

// ── R5: JobRun.candidates ──────────────────────────────────────────────────

describe('R5 JobRun.candidates', () => {
  it('survives StorageRepo.set → get, row, detail and quote included', async () => {
    const repo = new Repo(new FakeStorageAreas(), new FakeClock(NOW));
    const row = listing(1);
    const run: JobRun = {
      ...setup({ watches: [watch('w1')] }).run,
      candidates: [
        { itemId: 1, watchIds: ['w1', 'w2'], endTime: row.endTime, status: 'pending', row, detail: detailOf(row), quote: { shipping: 500, handling: 0 } },
        { itemId: 2, watchIds: ['w1'], endTime: row.endTime, status: 'rejected', quote: null, note: 'w1: no rule matched' },
        { itemId: 3, watchIds: ['w2'], endTime: row.endTime, status: 'skipped-budget' },
      ],
    };
    await repo.set(STORAGE_KEYS.jobRuns, [run]);
    expect(await repo.get(STORAGE_KEYS.jobRuns)).toEqual([run]);
  });

  it('keeps row/detail only while pending; drops them once the strict pass decides', () => {
    const lc = rule('r-lc', [kw('pyrex'), { kind: 'landedCost', max: 5000 }]);
    const { job, run } = setup({ watches: [watch('w1', { ruleIds: ['r-lc'] })], rules: [lc], settings: settingsWith(QUOTES_ON) });
    const respond = responder({ search: { 'w1:1': [listing(1)] } });
    let r = run;
    for (let s = job.next(r); s !== null && s.kind !== 'quote'; s = job.next(r)) r = job.apply(r, s, respond(s));
    expect(job.next(r)).toEqual({ kind: 'quote', itemId: 1 });
    expect(candidate(r, 1)).toMatchObject({ status: 'pending', row: { itemId: 1 }, detail: { itemId: 1 } });
    const done = drive(job, r, respond);
    const c = candidate(done, 1);
    expect(c).toMatchObject({ status: 'matched', quote: { shipping: 500, handling: 100 } });
    expect(c).not.toHaveProperty('row');
    expect(c).not.toHaveProperty('detail');
  });

  it('one candidate per item across watches: one detail, every selecting watch in watchIds and seenUpdates', () => {
    const a = watch('a', { favoriteMode: 'sgw-late' });
    const b = watch('b', { favoriteMode: 'sgw' });
    const c = watch('c', { favoriteMode: 'local', seenItemIds: [1] });
    const { job, run } = setup({ watches: [a, b, c] });
    const row = listing(1);
    const done = drive(job, run, responder({ search: { 'a:1': [row], 'b:1': [row], 'c:1': [row] } }));
    expect(stepsOf(done, 'detail')).toHaveLength(1);
    expect(candidate(done, 1)?.watchIds).toEqual(['a', 'b']);
    // One favorite per item; plain `sgw` wins over `sgw-late` (favoriting now satisfies both).
    expect(stepsOf(done, 'favorite')).toEqual([{ kind: 'favorite', itemId: 1, watchId: 'b' }]);
    expect(seenUpdates(done)).toEqual({ a: [1], b: [1] });
    expect(done.results.newMatches).toEqual([1]);
  });
});

// ── R7: calendar ───────────────────────────────────────────────────────────

describe('R7 calendar needs watch.calendar AND settings.calendar.enabled', () => {
  const go = (opts: { watchCal: boolean; settingsCal: boolean; mode: Watch['favoriteMode'] }): JobRun => {
    const w = watch('w1', { calendar: opts.watchCal, favoriteMode: opts.mode });
    const { job, run } = setup({ watches: [w], settings: settingsWith({ calendar: opts.settingsCal }) });
    return drive(job, run, responder({ search: { 'w1:1': [listing(1)] } }));
  };

  it('both on: a calendar detail (local mode) then a calendarUpsert, counted when done', () => {
    const done = go({ watchCal: true, settingsCal: true, mode: 'local' });
    expect(stepsOf(done, 'detail')).toEqual([{ kind: 'detail', itemId: 1, reason: 'calendar' }]);
    expect(stepsOf(done, 'calendarUpsert')).toEqual([{ kind: 'calendarUpsert', itemId: 1 }]);
    expect(done.results.calendarUpserts).toEqual([1]);
  });

  it('either off: no calendar step and no calendar-driven detail', () => {
    for (const [watchCal, settingsCal] of [
      [true, false],
      [false, true],
    ] as const) {
      const done = go({ watchCal, settingsCal, mode: 'local' });
      expect(stepsOf(done, 'detail')).toEqual([]);
      expect(stepsOf(done, 'calendarUpsert')).toEqual([]);
      expect(done.results.newMatches).toEqual([1]);
    }
  });

  it('sgw mode with the calendar on: one favorite and one calendarUpsert', () => {
    const done = go({ watchCal: true, settingsCal: true, mode: 'sgw' });
    expect(kinds(done)).toEqual(['search', 'favoritesList', 'detail', 'favorite', 'calendarUpsert']);
    expect(done.results.favorited).toEqual([1]);
  });
});

// ── R8: accepted decisions 1–9 ─────────────────────────────────────────────

describe('R8 decisions', () => {
  it('a retryable error pauses at the same step; resume() continues; the 3rd failure skips the step', () => {
    const { job, run } = setup({ watches: [watch('w1')] });
    const step = at(run.steps, 0);
    const err: StepOutcome = { kind: 'error', message: 'paused', retryable: true };
    let r = job.apply(run, step, err);
    expect(r).toMatchObject({ status: 'paused', cursor: 0 });
    expect(job.next(r)).toBeNull();
    expect(job.apply(r, step, { kind: 'search', items: [], total: 0 })).toBe(r); // paused: no-op until resumed
    r = resume(r);
    expect(r.status).toBe('running');
    expect(job.next(r)).toEqual(step);
    for (let i = 1; i < MAX_STEP_ATTEMPTS; i++) r = resume(job.apply(r, step, err));
    expect(r).toMatchObject({ status: 'running', cursor: 1 });
    expect(r.results.errors).toEqual(Array.from({ length: MAX_STEP_ATTEMPTS }, () => ({ step: 0, message: 'search: paused' })));
    expect(resume(r)).toBe(r);
  });

  it('a non-retryable error is recorded and the run moves on; a failed detail is not marked seen', () => {
    const { job, run } = setup({ watches: [watch('w1')] });
    const ok = responder({ search: { 'w1:1': [listing(1), listing(2)] } });
    const done = drive(job, run, (step) =>
      step.kind === 'detail' && step.itemId === 1 ? { kind: 'error', message: 'HTTP 500', retryable: false } : ok(step),
    );
    expect(done.status).toBe('done');
    expect(candidate(done, 1)?.status).toBe('failed');
    expect(done.results.errors).toEqual([{ step: 2, message: 'detail: HTTP 500' }]);
    expect(seenUpdates(done)).toEqual({ w1: [2] });
    expect(stepsOf(done, 'favorite').map((s) => s.itemId)).toEqual([2]);
  });

  it('a `deferred` favorite advances the cursor and is not counted as favorited', () => {
    const { job, run } = setup({ watches: [watch('w1', { favoriteMode: 'sgw-late' })] });
    const ok = responder({ search: { 'w1:1': [listing(1)] } });
    const done = drive(job, run, (step) => (step.kind === 'favorite' ? { kind: 'deferred', until: NOW + HOUR } : ok(step)));
    expect(done.status).toBe('done');
    expect(done.results.favorited).toEqual([]);
    expect(done.results.errors).toEqual([]);
  });

  it('notifyDigest is appended last, once, only when a watch in the run has notify', () => {
    const on = setup({ watches: [watch('a'), watch('b', { notify: true })] });
    expect(kinds(on.run)).not.toContain('notifyDigest');
    const done = drive(on.job, on.run, responder({ search: { 'a:1': [listing(1)] } }));
    expect(kinds(done)).toEqual(['search', 'search', 'favoritesList', 'detail', 'favorite', 'notifyDigest']);
    expect(done.status).toBe('done');

    const off = setup({ watches: [watch('a')] });
    expect(kinds(drive(off.job, off.run, responder({})))).not.toContain('notifyDigest');
  });

  it('ignores a stale apply (step is not the one at the cursor)', () => {
    const { job, run } = setup({ watches: [watch('w1', { maxPages: 2 })] });
    expect(job.apply(run, { kind: 'search', watchId: 'w1', page: 2 }, { kind: 'search', items: [], total: 0 })).toBe(run);
    const r1 = job.apply(run, at(run.steps, 0), { kind: 'search', items: [], total: 0 });
    expect(job.apply(r1, at(run.steps, 0), { kind: 'search', items: [listing(1)], total: 1 })).toBe(r1);
  });

  it('records an outcome of the wrong kind as an error and moves on', () => {
    const { job, run } = setup({ watches: [watch('w1')] });
    const r = job.apply(run, at(run.steps, 0), { kind: 'favorite', done: true });
    expect(r.cursor).toBe(1);
    expect(r.results.errors).toEqual([{ step: 0, message: "search: unexpected outcome 'favorite'" }]);
    const s2 = setup({ watches: [watch('w1')] });
    const r2 = drive(s2.job, s2.run, (step) => {
      const base = responder({ search: { 'w1:1': [listing(1)] } })(step);
      return step.kind === 'detail' ? { kind: 'detail', detail: detailOf(listing(99)) } : base;
    });
    expect(candidate(r2, 1)?.status).toBe('failed');
    expect(stepsOf(r2, 'favorite')).toEqual([]);
  });

  it('without features.landedCost (or homeZip) no quote is planned and landed-cost-only rows are not fetched', () => {
    const lc = rule('r-lc', [kw('pyrex'), { kind: 'landedCost', max: 5000 }]);
    for (const settings of [settingsWith({ homeZip: '43004' }), settingsWith({ landedCost: true })]) {
      const { job, run } = setup({ watches: [watch('w1', { ruleIds: ['r-lc'] })], rules: [lc], settings });
      const done = drive(job, run, responder({ search: { 'w1:1': [listing(1), listing(2)] } }));
      expect(kinds(done)).toEqual(['search', 'favoritesList']);
      expect(done.candidates).toEqual([]);
      expect(seenUpdates(done)).toEqual({});
      expect(done.results.errors.map((e) => e.message)).toEqual([
        'landed cost: 2 row(s) of watch w1 need a landed-cost quote, which is off (features.landedCost or homeZip); not fetched',
      ]);
    }
  });

  it('a null quote leaves landed cost unknown: rejected, no write', () => {
    const lc = rule('r-lc', [kw('pyrex'), { kind: 'landedCost', max: 5000 }]);
    const { job, run } = setup({ watches: [watch('w1', { ruleIds: ['r-lc'] })], rules: [lc], settings: settingsWith(QUOTES_ON) });
    const done = drive(job, run, responder({ search: { 'w1:1': [listing(1)] }, quotes: { 1: null } }));
    expect(stepsOf(done, 'favorite')).toEqual([]);
    expect(candidate(done, 1)?.status).toBe('rejected');
  });
});

// ── property ───────────────────────────────────────────────────────────────

/** mulberry32: a tiny seeded PRNG so each fast-check case replays exactly. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PROP_RULES: Rule[] = [
  PYREX,
  rule('r-loc', [kw('pyrex'), { kind: 'location', mode: 'include', states: ['OH'] }]),
  rule('r-lc', [kw('bowl'), { kind: 'landedCost', max: 2500 }]),
  rule('r-any', [kw('pyrex')], { any: [{ kind: 'pickupOnly', value: false }, { kind: 'price', max: 800 }] }),
  rule('r-hide', [{ kind: 'category', categoryIds: [99], includeChildren: false }], { action: 'hide' }),
];

describe('property', () => {
  it('cursor never exceeds steps.length; runs stay schema-valid, append-only, within budget, and finish', () => {
    const watchArb = fc.record({
      maxPages: fc.constantFrom(1 as const, 2 as const, 3 as const),
      favoriteMode: fc.constantFrom('sgw' as const, 'sgw-late' as const, 'local' as const),
      calendar: fc.boolean(),
      notify: fc.boolean(),
      ruleIds: fc.subarray(PROP_RULES.map((r) => r.id), { minLength: 1 }),
      seenItemIds: fc.subarray(Array.from({ length: 60 }, (_, i) => i + 1), { maxLength: 10 }),
      invalid: fc.boolean(),
    });
    fc.assert(
      fc.property(
        fc.array(watchArb, { minLength: 1, maxLength: 3 }),
        fc.boolean(),
        fc.boolean(),
        fc.integer(),
        (ws, quotes, cal, seed) => {
          const rand = prng(seed);
          const pick = <T>(xs: readonly T[]): T => at(xs, Math.floor(rand() * xs.length));
          const watches = ws.map(({ invalid, ...w }, i) =>
            watch(`w${String(i)}`, { ...w, query: { searchText: 'p', categoryIds: [], sellerIds: [], page: 1, ...(invalid && rand() < 0.3 ? { extra: { lp: 'x' } } : {}) } }),
          );
          const job = createDailyJob({
            evaluateBatch,
            validateQuery: invalidSearchParams,
            watches,
            rules: PROP_RULES,
            settings: settingsWith({ landedCost: quotes, homeZip: '43004', calendar: cal }),
            now: () => NOW,
          });
          const row = (id: number): Listing =>
            listing(id, {
              title: pick(['Pyrex bowl', 'Pyrex dish', 'Teapot', 'Glass bowl']),
              currentPrice: pick([500, 1000, 3000]),
              endTime: endIn(1 + (id % 50)),
              ...(rand() < 0.5 ? { sellerState: pick(['OH', 'CA']) } : {}),
              ...(rand() < 0.5 ? { pickupOnly: rand() < 0.5 } : {}),
              ...(rand() < 0.5 ? { categoryId: pick([12, 99]) } : {}),
            });
          const outcomeFor = (step: JobStep): StepOutcome => {
            const roll = rand();
            if (roll < 0.08) return { kind: 'error', message: 'boom', retryable: rand() < 0.5 };
            if (roll < 0.1) return { kind: 'notifyDigest', done: true }; // wrong kind for most steps
            switch (step.kind) {
              case 'search': {
                const items = Array.from({ length: Math.floor(rand() * 45) }, () => row(1 + Math.floor(rand() * 60)));
                return { kind: 'search', items, total: items.length };
              }
              case 'favoritesList':
                return { kind: 'favoritesList', items: [] };
              case 'detail':
              case 'postEnd':
                return {
                  kind: step.kind,
                  detail: detailOf(row(step.itemId), {
                    sellerState: rand() < 0.2 ? undefined : pick(['OH', 'CA']),
                    pickupOnly: rand() < 0.5,
                    categoryId: pick([12, 99]),
                    isClosed: rand() < 0.1,
                  }),
                };
              case 'quote':
                return { kind: 'quote', quote: rand() < 0.2 ? null : { shipping: pick([100, 900, 3000]), handling: pick([0, 200]) } };
              case 'favorite':
                return rand() < 0.3 ? { kind: 'deferred', until: NOW + HOUR } : { kind: 'favorite', done: true };
              default:
                return { kind: step.kind, done: true };
            }
          };

          let run = job.plan(watches, NOW);
          for (let i = 0; i < 5000; i++) {
            expect(run.cursor).toBeGreaterThanOrEqual(0);
            expect(run.cursor).toBeLessThanOrEqual(run.steps.length);
            if (run.status === 'paused') run = resume(run);
            const step = job.next(run);
            if (step === null) break;
            if (run.cursor > 0 && rand() < 0.05) {
              // A stale apply (an already-executed step) must change nothing.
              const old = at(run.steps, Math.floor(rand() * run.cursor));
              if (JSON.stringify(old) !== JSON.stringify(step)) expect(job.apply(run, old, outcomeFor(old))).toBe(run);
            }
            const before = run;
            run = job.apply(run, step, outcomeFor(step));
            expect(run.steps.slice(0, before.steps.length)).toEqual(before.steps); // append-only
            expect(run.cursor - before.cursor).toBeGreaterThanOrEqual(0);
            expect(run.cursor - before.cursor).toBeLessThanOrEqual(1);
          }
          expect(run.status).toBe('done');
          expect(run.cursor).toBe(run.steps.length);
          expect(JobRunSchema.parse(run)).toEqual(run);
          expect(stepsOf(run, 'detail').length).toBeLessThanOrEqual(MAX_DETAIL_STEPS_PER_RUN);
          expect(stepsOf(run, 'quote').length).toBeLessThanOrEqual(MAX_QUOTE_STEPS_PER_RUN);
          const digests = run.steps.flatMap((s, i) => (s.kind === 'notifyDigest' ? [i] : []));
          expect(digests.length).toBeLessThanOrEqual(1);
          if (digests.length === 1) expect(digests[0]).toBe(run.steps.length - 1);
          const status = new Map(run.candidates?.map((c) => [c.itemId, c.status]));
          for (const s of run.steps) {
            if (s.kind === 'favorite' || s.kind === 'calendarUpsert') expect(status.get(s.itemId)).toBe('matched');
            if (s.kind === 'quote') {
              const d = run.steps.findIndex((x) => x.kind === 'detail' && x.itemId === s.itemId);
              if (d >= 0) expect(d).toBeLessThan(run.steps.indexOf(s));
            }
          }
          for (const c of run.candidates ?? []) {
            if (c.status !== 'pending') {
              expect(c.row).toBeUndefined();
              expect(c.detail).toBeUndefined();
            }
          }
          const seen = seenUpdates(run);
          for (const [w, ids] of Object.entries(seen)) {
            for (const id of ids) expect(['matched', 'rejected']).toContain(status.get(id));
            expect(watches.find((x) => x.id === w)).toBeDefined();
          }
        },
      ),
      { numRuns: 150 },
    );
  });
});
