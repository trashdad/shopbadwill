// T-36: `rules.list`, `rules.save`, `rules.delete`, `rules.evaluate` and
// `rules.preview`. Every change broadcasts `rules.changed` (options pages and
// the overlay re-read the rules).
//
// - rules.save upserts by id and refuses a rule whose keyword conditions do not
//   compile (a regex that is not RE2-safe, for one): rules are validated when
//   they are saved (T-114).
// - rules.preview uses the last `page.listings` of `tabId`, else the most
//   recent SGW page's (I-08); with no page it answers 0 of 0.
// - rules.evaluate (content) evaluates against the stored rules. Landed cost is
//   not supplied, so `landedCost` conditions stay unknown until T-57 adds it.
// - rules.disable (T-32 contract change; content or an extension page) turns a
//   rule off, broadcasts `rules.changed` and audits it with the T-58 undo
//   `{ kind: 'disableRule', ref: ruleId }`, which the activity log re-enables.
//   The router admits only content and ui senders; both are allowed here. An
//   already disabled rule is a no-op; an unknown one is an error.
import { ruleCompileErrors, evaluateBatch } from '../../domain/rules/matcher';
import { preview } from '../../domain/rules/preview';
import type { Rule } from '../../domain/rules/schema';
import { STORAGE_KEYS } from '../../domain/storage/schema';
import type { BackgroundContext } from '../context';

export function register(ctx: BackgroundContext): void {
  const { router, repo, clock } = ctx;

  router.register('rules.list', () => repo.get(STORAGE_KEYS.rules));

  router.register('rules.save', async (rule) => {
    await saveRule(ctx, rule);
    return undefined;
  });

  router.register('rules.delete', async ({ id }) => {
    const result = { removed: false };
    await repo.update(STORAGE_KEYS.rules, (rules) => {
      const next = rules.filter((r) => r.id !== id);
      result.removed = next.length !== rules.length;
      return next;
    });
    if (result.removed) await ctx.broadcast('rules.changed');
    return undefined;
  });

  router.register('rules.evaluate', async ({ listings }) => evaluateBatch(listings, await repo.get(STORAGE_KEYS.rules), { now: clock.now() }));

  router.register('rules.disable', async ({ ruleId }, hctx) => {
    const found: { rule?: Rule; changed: boolean } = { changed: false };
    await repo.update(STORAGE_KEYS.rules, (rules) =>
      rules.map((r) => {
        if (r.id !== ruleId) return r;
        found.rule = r;
        if (!r.enabled) return r;
        found.changed = true;
        return { ...r, enabled: false, updatedAt: clock.now() };
      }),
    );
    if (found.rule === undefined) throw new Error('That rule no longer exists.');
    if (!found.changed) return undefined;
    await ctx.audit.append({
      actor: 'user',
      kind: 'rule.disabled',
      ref: ruleId,
      details: { ruleId, name: found.rule.name, from: hctx.senderClass },
      undo: { kind: 'disableRule', ref: ruleId },
    });
    await ctx.broadcast('rules.changed');
    return undefined;
  });

  router.register('rules.preview', ({ rule, tabId }) => {
    const listings = ctx.pages.listingsFor(tabId)?.listings ?? [];
    const p = preview(rule, listings, { now: clock.now() });
    return { matched: p.matchCount, total: listings.length, ids: p.matchedItemIds };
  });
}

/** Throws when a keyword condition does not compile; nothing is stored then. */
export function assertRuleCompiles(rule: Rule): void {
  const errors = ruleCompileErrors(rule);
  if (errors.length > 0) {
    throw new Error(`The rule was not saved: ${errors.map((e) => `condition ${String(e.conditionIndex + 1)}: ${e.error}`).join('; ')}`);
  }
}

/**
 * Validates, then inserts or replaces the rule with the same id, and
 * broadcasts `rules.changed` when anything changed. Returns whether it did.
 */
export async function saveRule(ctx: BackgroundContext, rule: Rule): Promise<boolean> {
  assertRuleCompiles(rule);
  const result = { changed: false };
  await ctx.repo.update(STORAGE_KEYS.rules, (rules) => {
    const at = rules.findIndex((r) => r.id === rule.id);
    if (at >= 0 && JSON.stringify(rules[at]) === JSON.stringify(rule)) return rules;
    result.changed = true;
    return at >= 0 ? rules.map((r, i) => (i === at ? rule : r)) : [...rules, rule];
  });
  if (result.changed) await ctx.broadcast('rules.changed');
  return result.changed;
}
