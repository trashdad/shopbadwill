// T-32 fix round 1: `rules.disable` (approved contract change). The overlay's
// "Disable rule" (and extension pages) turn a rule off; the activity log's
// `disableRule` undo (T-58: ref = rule id) turns it back on.
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { BackgroundContext } from '../../../src/background/context';
import { createUndoExecutors } from '../../../src/background/handlers/audit';
import { register } from '../../../src/background/handlers/rules';
import { createRouter, type Router, type RouterSender } from '../../../src/background/router';
import type { Rule } from '../../../src/domain/rules/schema';
import { Repo } from '../../../src/domain/storage/repo';
import { STORAGE_KEYS } from '../../../src/domain/storage/schema';
import { FakeAuditLog } from '../../fakes/ports/fake-audit-log';
import { FakeClock } from '../../fakes/ports/fake-clock';
import { FakeSgwApi } from '../../fakes/ports/fake-sgw-api';
import { FakeStorageAreas } from '../../fakes/ports/fake-storage';
import { FakeSwitches } from '../../fakes/ports/fake-switches';

const EXT_ID = 'ext-id';
const CONTENT: RouterSender = { id: EXT_ID, url: 'https://shopgoodwill.com/categories/listing?st=x', tab: { id: 3 } };
const UI: RouterSender = { id: EXT_ID, url: `chrome-extension://${EXT_ID}/options.html` };
const T0 = 1_700_000_000_000;

function rule(id: string, enabled = true): Rule {
  return { id, name: `Rule ${id}`, enabled, action: 'hide', all: [], createdAt: 1, updatedAt: 1 };
}

let clock: FakeClock;
let repo: Repo;
let audit: FakeAuditLog;
let router: Router;
let broadcast: ReturnType<typeof vi.fn>;

const env = (type: string, payload: unknown) => ({ v: 1, reqId: `r-${type}`, type, payload });
const rules = async (): Promise<Rule[]> => repo.get(STORAGE_KEYS.rules);

beforeEach(async () => {
  clock = new FakeClock(T0);
  repo = new Repo(new FakeStorageAreas(), clock);
  audit = new FakeAuditLog(clock);
  router = createRouter({
    runtimeId: EXT_ID,
    getURL: (p) => `chrome-extension://${EXT_ID}/${p}`,
    isQuickFavoriteEnabled: () => false,
    log: () => undefined,
  });
  broadcast = vi.fn(() => Promise.resolve());
  const ctx = { router, repo, audit, clock, broadcast, pages: { listingsFor: () => undefined } } as unknown as BackgroundContext;
  register(ctx);
  await repo.set(STORAGE_KEYS.rules, [rule('a'), rule('b')]);
});

describe('rules.disable', () => {
  it('a content script disables the rule, broadcasts rules.changed and audits an undoable entry', async () => {
    const r = await router.handle(env('rules.disable', { ruleId: 'a' }), CONTENT);
    expect(r).toEqual({ ok: true });
    expect(await rules()).toEqual([{ ...rule('a', false), updatedAt: T0 }, rule('b')]);
    expect(broadcast).toHaveBeenCalledWith('rules.changed');
    expect(audit.entries).toHaveLength(1);
    expect(audit.entries[0]).toMatchObject({
      actor: 'user',
      kind: 'rule.disabled',
      ref: 'a',
      details: { ruleId: 'a', from: 'content' },
      undo: { kind: 'disableRule', ref: 'a' },
    });
  });

  it('an extension page may send it too', async () => {
    expect(await router.handle(env('rules.disable', { ruleId: 'b' }), UI)).toEqual({ ok: true });
    expect((await rules()).find((x) => x.id === 'b')?.enabled).toBe(false);
    expect(audit.entries[0]?.details).toMatchObject({ from: 'ui' });
  });

  it('the audit entry undoes through disableRule: the rule is enabled again', async () => {
    await router.handle(env('rules.disable', { ruleId: 'a' }), CONTENT);
    const undo = createUndoExecutors({ api: new FakeSgwApi({ clock, switches: new FakeSwitches() }), repo }).disableRule;
    if (undo === undefined) throw new Error('no disableRule executor');
    const entry = audit.entries[0];
    if (entry?.undo === undefined) throw new Error('no undoable entry');
    await undo(entry.undo.ref, entry);
    expect((await rules()).find((x) => x.id === 'a')?.enabled).toBe(true);
  });

  it('an already disabled rule is a no-op (no broadcast, no audit)', async () => {
    await repo.set(STORAGE_KEYS.rules, [rule('a', false)]);
    expect(await router.handle(env('rules.disable', { ruleId: 'a' }), CONTENT)).toEqual({ ok: true });
    expect(broadcast).not.toHaveBeenCalled();
    expect(audit.entries).toEqual([]);
  });

  it('an unknown rule fails (content gets the generic error) and changes nothing', async () => {
    const r = await router.handle(env('rules.disable', { ruleId: 'nope' }), CONTENT);
    expect(r).toEqual({ ok: false, error: { code: 'handler_error', message: 'internal error' } });
    expect(await rules()).toEqual([rule('a'), rule('b')]);
    expect(broadcast).not.toHaveBeenCalled();
    expect(audit.entries).toEqual([]);
  });

  it('an empty rule id is refused by the schema', async () => {
    const r = await router.handle(env('rules.disable', { ruleId: '' }), CONTENT);
    expect(r).toMatchObject({ ok: false, error: { code: 'invalid_message' } });
  });
});
