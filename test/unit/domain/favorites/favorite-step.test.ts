import { beforeEach, describe, expect, it } from 'vitest';

import { createFavoritesHandlers } from '../../../../src/background/handlers/favorites';
import favoriteStep, {
  FAVORITE_SKIP_PREFIX,
  executeFavoriteStep,
  parseUnfavoriteRef,
  unfavoriteRef,
  type FavoriteStepDeps,
} from '../../../../src/background/jobs/steps/favorite';
import { createAuditLog } from '../../../../src/domain/audit/log';
import { desired } from '../../../../src/domain/favorites/reconcile';
import { defaultSettings } from '../../../../src/domain/settings/defaults';
import { Repo } from '../../../../src/domain/storage/repo';
import { STORAGE_KEYS } from '../../../../src/domain/storage/schema';
import type { Favorite, TrackedItem } from '../../../../src/domain/types';
import type { JobStep, StepOutcome, Watch } from '../../../../src/domain/watches/schema';
import { FakeClock } from '../../../fakes/ports/fake-clock';
import { FakeSgwApi } from '../../../fakes/ports/fake-sgw-api';
import { FakeStorageAreas } from '../../../fakes/ports/fake-storage';
import { FakeSwitches } from '../../../fakes/ports/fake-switches';

const NOW = Date.UTC(2026, 9, 8, 11, 0);
const HOUR = 3_600_000;

const watch = (over: Partial<Watch> = {}): Watch => ({
  id: 'w1',
  name: 'w',
  enabled: true,
  query: { searchText: 'x', categoryIds: [], sellerIds: [], page: 1 },
  ruleIds: [],
  maxPages: 1,
  favoriteMode: 'sgw',
  calendar: false,
  notify: false,
  nextRunAt: 0,
  seenItemIds: [],
  ...over,
});
const tracked = (over: Partial<TrackedItem> = {}): TrackedItem => ({
  itemId: 101,
  title: 't',
  endTime: new Date(NOW + 48 * HOUR).toISOString(),
  sellerId: 1,
  reasons: [{ kind: 'watch', id: 'w1' }],
  favoriteState: 'none',
  calendar: false,
  addedAt: NOW,
  updatedAt: NOW,
  ...over,
});
const step: JobStep = { kind: 'favorite', itemId: 101, watchId: 'w1' };

let clock: FakeClock;
let repo: Repo;
let api: FakeSgwApi;
let switches: FakeSwitches;
let deps: FavoriteStepDeps;
let audit: ReturnType<typeof createAuditLog>;

const state = async (): Promise<TrackedItem['favoriteState'] | undefined> => (await repo.get(STORAGE_KEYS.tracked))[101]?.favoriteState;
const setDryRun = async (on: boolean): Promise<void> => {
  const s = defaultSettings();
  await repo.set(STORAGE_KEYS.settings, { ...s, dryRun: { ...s.dryRun, favorites: on } });
};
const addCalls = (): number => api.calls.filter((c) => c.method === 'addFavorite').length;

beforeEach(async () => {
  clock = new FakeClock(NOW);
  repo = new Repo(new FakeStorageAreas(), clock);
  switches = new FakeSwitches();
  api = new FakeSgwApi({ clock, switches });
  audit = createAuditLog(repo);
  deps = { api, switches, audit, repo };
  await repo.set(STORAGE_KEYS.watches, [watch()]);
  await repo.set(STORAGE_KEYS.tracked, { 101: tracked() });
  await setDryRun(false);
});

describe('executeFavoriteStep', () => {
  it('adds the favorite, marks it favorited, audits with an undo reference to removeFavorite', async () => {
    const out = await executeFavoriteStep(step, deps);
    expect(out).toEqual({ kind: 'favorite', done: true });
    expect(addCalls()).toBe(1);
    expect(await state()).toBe('favorited');
    const [e] = await audit.list({ limit: 5, kinds: ['favorite.add'] });
    expect(e).toMatchObject({ kind: 'favorite.add', itemId: 101, undo: { kind: 'unfavorite', ref: 'removeFavorite:101' } });
    expect(e?.dryRun).toBeUndefined();
  });

  it('dry-run: audit favorite.add {dryRun:true}, no call, state untouched', async () => {
    await setDryRun(true);
    const out = await executeFavoriteStep(step, deps);
    expect(out).toMatchObject({ kind: 'error', retryable: false });
    expect(api.calls).toEqual([]);
    expect(await state()).toBe('none');
    const [e] = await audit.list({ limit: 5 });
    expect(e).toMatchObject({ kind: 'favorite.add', dryRun: true });
    expect(e?.undo).toBeUndefined();
  });

  it('already in the favorites cache: done, no call, no undo', async () => {
    const f: Favorite = { itemId: 101, watchlistId: 1, notes: '', endTime: new Date(NOW + HOUR).toISOString(), sellerId: 1, status: 'open' };
    await repo.set(STORAGE_KEYS.favoritesCache, { fetchedAt: NOW, items: [f] });
    expect(await executeFavoriteStep(step, deps)).toEqual({ kind: 'favorite', done: true });
    expect(api.calls).toEqual([]);
    expect(await audit.list({ limit: 5 })).toEqual([]);
    expect(await state()).toBe('favorited');
  });

  it('writesAllowed refusal: non-retryable skip with the reason, never failed, no call', async () => {
    switches.block('favorites', 'health check failed');
    const out = await executeFavoriteStep(step, deps);
    expect(out).toMatchObject({ kind: 'error', retryable: false });
    expect((out as Extract<StepOutcome, { kind: 'error' }>).message).toContain('health check failed');
    expect(switches.checks).toContain('favorites');
    expect(addCalls()).toBe(0);
    expect(await state()).toBe('none');
  });

  it('SgwApiError paused from the adapter is a skip, not failed', async () => {
    api.failNext('addFavorite', 'paused');
    const out = await executeFavoriteStep(step, deps);
    expect(out).toMatchObject({ kind: 'error', retryable: false });
    expect(await state()).toBe('none');
  });

  it('an addFavorite failure marks failed, audits, and is not retryable; desired() re-adds it', async () => {
    api.failNext('addFavorite', 'server');
    const out = await executeFavoriteStep(step, deps);
    expect(out).toMatchObject({ kind: 'error', retryable: false });
    expect((out as Extract<StepOutcome, { kind: 'error' }>).message.startsWith(FAVORITE_SKIP_PREFIX)).toBe(false);
    expect(await state()).toBe('failed');
    expect((await audit.list({ limit: 5, kinds: ['favorite.failed'] })).length).toBe(1);
    const t = Object.values(await repo.get(STORAGE_KEYS.tracked));
    expect(desired(t, [watch()], NOW, [])[0]?.action).toBe('add');
  });

  it('a later run that succeeds ends favorited', async () => {
    api.failNext('addFavorite', 'network');
    await executeFavoriteStep(step, deps);
    expect(await executeFavoriteStep(step, deps)).toEqual({ kind: 'favorite', done: true });
    expect(await state()).toBe('favorited');
  });

  it('kill switch: favorite.skipped audit, never a dry-run entry, no call', async () => {
    await setDryRun(true);
    const s = await repo.get(STORAGE_KEYS.settings);
    await repo.set(STORAGE_KEYS.settings, { ...s, killSwitch: true });
    const out = await executeFavoriteStep(step, deps);
    expect(out).toMatchObject({ kind: 'error', retryable: false });
    expect(api.calls).toEqual([]);
    const all = await audit.list({ limit: 10 });
    expect(all.map((e) => e.kind)).toEqual(['favorite.skipped']);
    expect(all[0]?.dryRun).toBeUndefined();
  });

  it('switches.killAll refuses without a call or a dry-run entry', async () => {
    switches.killAll('kill switch');
    const out = await executeFavoriteStep(step, deps);
    expect(out).toMatchObject({ kind: 'error', retryable: false });
    expect(addCalls()).toBe(0);
    expect((await audit.list({ limit: 10 })).some((e) => e.dryRun === true)).toBe(false);
  });

  it('every policy skip starts with FAVORITE_SKIP_PREFIX', async () => {
    const msgs: string[] = [];
    const msg = (o: StepOutcome): string => (o.kind === 'error' ? o.message : '');
    await setDryRun(true);
    msgs.push(msg(await executeFavoriteStep(step, deps)));
    await setDryRun(false);
    switches.block('favorites', 'x');
    msgs.push(msg(await executeFavoriteStep(step, deps)));
    switches.reset();
    api.failNext('addFavorite', 'paused');
    msgs.push(msg(await executeFavoriteStep(step, deps)));
    await repo.set(STORAGE_KEYS.watches, [watch({ favoriteMode: 'local' })]);
    msgs.push(msg(await executeFavoriteStep(step, deps)));
    await repo.set(STORAGE_KEYS.watches, [watch({ enabled: false })]);
    msgs.push(msg(await executeFavoriteStep(step, deps)));
    expect(msgs).toHaveLength(5);
    for (const m of msgs) expect(m.startsWith(FAVORITE_SKIP_PREFIX)).toBe(true);
  });

  it('a watch disabled mid-run is refused', async () => {
    await repo.set(STORAGE_KEYS.watches, [watch({ enabled: false })]);
    expect(await executeFavoriteStep(step, deps)).toMatchObject({ kind: 'error', retryable: false });
    expect(api.calls).toEqual([]);
  });

  it('an item that already ended is refused', async () => {
    await repo.set(STORAGE_KEYS.tracked, { 101: tracked({ endTime: new Date(NOW - 1000).toISOString() }) });
    expect(await executeFavoriteStep(step, deps)).toMatchObject({ kind: 'error', retryable: false });
    expect(api.calls).toEqual([]);
  });

  it('a favorited item is done with no call (the user owns it now)', async () => {
    await repo.set(STORAGE_KEYS.tracked, { 101: tracked({ favoriteState: 'favorited' }) });
    expect(await executeFavoriteStep(step, deps)).toEqual({ kind: 'favorite', done: true });
    expect(api.calls).toEqual([]);
  });

  it('undo refs round trip', () => {
    expect(parseUnfavoriteRef(unfavoriteRef(101))).toBe(101);
    expect(parseUnfavoriteRef('nope')).toBeUndefined();
    expect(parseUnfavoriteRef('removeFavorite:abc')).toBeUndefined();
  });

  it('local mode never favorites', async () => {
    await repo.set(STORAGE_KEYS.watches, [watch({ favoriteMode: 'local' })]);
    expect(await executeFavoriteStep(step, deps)).toMatchObject({ kind: 'error', retryable: false });
    expect(api.calls).toEqual([]);
  });

  it('sgw-late with notBefore in the future is deferred, no call', async () => {
    await repo.set(STORAGE_KEYS.watches, [watch({ favoriteMode: 'sgw-late' })]);
    const out = await executeFavoriteStep({ ...step, notBefore: NOW + HOUR }, deps);
    expect(out).toEqual({ kind: 'deferred', until: NOW + HOUR });
    expect(api.calls).toEqual([]);
    expect(await executeFavoriteStep({ ...step, notBefore: NOW }, deps)).toEqual({ kind: 'favorite', done: true });
  });

  it('sgw-late without notBefore is checked against the end time', async () => {
    await repo.set(STORAGE_KEYS.watches, [watch({ favoriteMode: 'sgw-late' })]);
    expect(await executeFavoriteStep(step, deps)).toMatchObject({ kind: 'deferred' });
    expect(api.calls).toEqual([]);
  });

  it('unknown watch and wrong step kind are skips', async () => {
    expect(await executeFavoriteStep({ ...step, watchId: 'nope' }, deps)).toMatchObject({ kind: 'error', retryable: false });
    expect(await executeFavoriteStep({ kind: 'notifyDigest' }, deps)).toMatchObject({ kind: 'error', retryable: false });
  });

  it('default export is the registry shape', () => {
    expect(favoriteStep.kind).toBe('favorite');
    expect(favoriteStep.run).toBe(executeFavoriteStep);
  });
});

describe('favorites.sync handler', () => {
  it('reads the list once on the interactive lane, caches it, aligns favoriteState', async () => {
    await repo.set(STORAGE_KEYS.tracked, {
      101: tracked(),
      102: tracked({ itemId: 102, favoriteState: 'favorited' }),
      103: tracked({ itemId: 103, favoriteState: 'failed' }),
    });
    api.favoriteList = [{ itemId: 101, watchlistId: 5, notes: '', endTime: new Date(NOW + HOUR).toISOString(), sellerId: 1, status: 'open' }];
    const h = createFavoritesHandlers({ api, repo });
    const ctx = { sender: {}, senderClass: 'ui' as const };
    await h['favorites.sync'](undefined, ctx);
    const reads = api.calls.filter((c) => c.method === 'favorites');
    expect(reads).toHaveLength(1);
    expect(reads[0]?.args).toEqual(['all', 'interactive']);
    expect((await repo.get(STORAGE_KEYS.favoritesCache)).items.map((f) => f.itemId)).toEqual([101]);
    const t = await repo.get(STORAGE_KEYS.tracked);
    expect([t[101]?.favoriteState, t[102]?.favoriteState, t[103]?.favoriteState]).toEqual(['favorited', 'favorited', 'failed']);
  });

  it('user removed X on SGW: sync keeps favorited, desired() is none, a second watch makes no call', async () => {
    await repo.set(STORAGE_KEYS.tracked, { 101: tracked({ favoriteState: 'favorited', reasons: [{ kind: 'watch', id: 'w1' }, { kind: 'watch', id: 'w2' }] }) });
    await repo.set(STORAGE_KEYS.watches, [watch(), watch({ id: 'w2' })]);
    api.favoriteList = [];
    const h = createFavoritesHandlers({ api, repo });
    await h['favorites.sync'](undefined, { sender: {}, senderClass: 'ui' });
    const t = await repo.get(STORAGE_KEYS.tracked);
    expect(t[101]?.favoriteState).toBe('favorited');
    const cache = await repo.get(STORAGE_KEYS.favoritesCache);
    expect(desired(Object.values(t), await repo.get(STORAGE_KEYS.watches), NOW, cache.items)[0]?.action).toBe('none');
    expect(await executeFavoriteStep({ kind: 'favorite', itemId: 101, watchId: 'w2' }, deps)).toEqual({ kind: 'favorite', done: true });
    expect(addCalls()).toBe(0);
  });
});
