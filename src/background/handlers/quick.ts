// T-36: the overlay's quick actions (`quick.*`, from content scripts). None of
// them can arm a snipe, bid or write to the calendar (§2.4).
//
// - quick.hideSeller / quick.hideKeyword create a local hide rule, or re-enable
//   the one they created before (stable ids `quick:seller:<id>` and
//   `quick:keyword:<term>`), and broadcast `rules.changed`.
// - quick.favorite (the router already requires settings.overlay.quickFavorite)
//   is a real write to the user's SGW account, so it follows the same order as
//   the daily job's favorite step: already favorited → nothing; kill switch →
//   refused and audited; dry-run → audited as a dry-run intent, nothing sent;
//   writesAllowed('favorites') false → refused and audited; else addFavorite
//   (the adapter checks the switches again) and an audited favorite with undo.
// - quick.track tracks an item the page reported (listing or detail), with
//   reason 'manual'. An item no page reported cannot be tracked (no end time).
//
// Seller names and terms are untrusted page text: stored as data, rendered as
// text only.
import type { Rule } from '../../domain/rules/schema';
import { STORAGE_KEYS } from '../../domain/storage/schema';
import type { ItemId, TrackedItem } from '../../domain/types';
import type { BackgroundContext } from '../context';
import { unfavoriteRef } from '../jobs/steps/favorite';
import { saveRule } from './rules';

/** Longest keyword a quick hide accepts. */
export const QUICK_TERM_MAX_CHARS = 100;
const NAME_MAX_CHARS = 120;

export function register(ctx: BackgroundContext): void {
  const { router } = ctx;

  router.register('quick.hideSeller', async ({ sellerId, sellerName }) => {
    const name = sellerName.trim() === '' ? `seller ${String(sellerId)}` : sellerName.trim();
    await quickHide(ctx, `quick:seller:${String(sellerId)}`, `Hide seller: ${name}`, [
      { kind: 'seller', mode: 'include', sellerIds: [sellerId], sellerNames: [] },
    ]);
    return undefined;
  });

  router.register('quick.hideKeyword', async ({ term }) => {
    const t = term.trim();
    if (t === '') throw new Error('An empty keyword would hide every listing.');
    if (t.length > QUICK_TERM_MAX_CHARS) throw new Error(`Keywords are limited to ${String(QUICK_TERM_MAX_CHARS)} characters.`);
    await quickHide(ctx, `quick:keyword:${t.toLowerCase()}`, `Hide keyword: ${t}`, [
      { kind: 'keyword', mode: 'any', terms: [t], wholeWord: true, regex: false, fields: ['title'] },
    ]);
    return undefined;
  });

  router.register('quick.favorite', async ({ itemId }) => {
    await quickFavorite(ctx, itemId);
    return undefined;
  });

  router.register('quick.track', async ({ itemId }) => {
    await quickTrack(ctx, itemId);
    return undefined;
  });
}

async function quickHide(ctx: BackgroundContext, id: string, name: string, all: Rule['all']): Promise<void> {
  const now = ctx.clock.now();
  const existing = (await ctx.repo.get(STORAGE_KEYS.rules)).find((r) => r.id === id);
  if (existing !== undefined) {
    if (!existing.enabled) await saveRule(ctx, { ...existing, enabled: true, updatedAt: now });
    return;
  }
  await saveRule(ctx, { id, name: name.slice(0, NAME_MAX_CHARS), enabled: true, action: 'hide', all, createdAt: now, updatedAt: now });
}

async function quickFavorite(ctx: BackgroundContext, itemId: ItemId): Promise<void> {
  const { repo, audit, switches } = ctx;
  const [tracked, cache] = await Promise.all([repo.get(STORAGE_KEYS.tracked), repo.get(STORAGE_KEYS.favoritesCache)]);
  if (tracked[itemId]?.favoriteState === 'favorited' || cache.items.some((f) => f.itemId === itemId)) return;

  const details = { source: 'quick.favorite' };
  if (switches.view().killSwitch) {
    await audit.append({ actor: 'user', kind: 'favorite.skipped', itemId, details: { ...details, why: 'kill switch is on' } });
    throw new Error('Favorites are paused: the kill switch is on.');
  }
  if (switches.settings()?.dryRun.favorites !== false) {
    await audit.append({ actor: 'user', kind: 'favorite.add', itemId, details, dryRun: true });
    return;
  }
  const verdict = await switches.writesAllowed('favorites');
  if (!verdict.ok) {
    const why = verdict.why ?? 'writes are not allowed';
    await audit.append({ actor: 'user', kind: 'favorite.skipped', itemId, details: { ...details, why } });
    throw new Error(`Favorites are paused: ${why}.`);
  }
  await ctx.api.addFavorite(itemId);
  await repo.update(STORAGE_KEYS.tracked, (cur) => {
    const t = cur[itemId];
    return t === undefined ? cur : { ...cur, [itemId]: { ...t, favoriteState: 'favorited', updatedAt: ctx.clock.now() } };
  });
  await audit.append({ actor: 'user', kind: 'favorite.add', itemId, details, undo: { kind: 'unfavorite', ref: unfavoriteRef(itemId) } });
}

async function quickTrack(ctx: BackgroundContext, itemId: ItemId): Promise<void> {
  const seen = ctx.pages.findItem(itemId);
  const now = ctx.clock.now();
  await ctx.repo.update(STORAGE_KEYS.tracked, (cur) => {
    const t = cur[itemId];
    if (t !== undefined) {
      if (t.reasons.some((r) => r.kind === 'manual')) return cur;
      return { ...cur, [itemId]: { ...t, reasons: [...t.reasons, { kind: 'manual' }], updatedAt: now } };
    }
    if (seen === undefined) throw new Error('That item has not been seen on a ShopGoodwill page yet; reload the page and try again.');
    const item: TrackedItem = {
      itemId,
      title: seen.title,
      endTime: seen.endTime,
      sellerId: seen.sellerId,
      reasons: [{ kind: 'manual' }],
      favoriteState: 'none',
      calendar: true,
      addedAt: now,
      updatedAt: now,
    };
    return { ...cur, [itemId]: item };
  });
}
