import { createRouter } from '../../../src/background/router';
import { createMessagingClient, type ClientRuntime } from '../../../src/messaging/client';
import { UNDOABLE_KINDS } from '../../../src/ui/activity/undoable';
import { beforeEach, describe, expect, it } from 'vitest';

import { createAuditHandlers, createUndoExecutors, SCAN_BATCH } from '../../../src/background/handlers/audit';
import { unfavoriteRef } from '../../../src/background/jobs/steps/favorite';
import { Repo } from '../../../src/domain/storage/repo';
import { STORAGE_KEYS } from '../../../src/domain/storage/schema';
import type { Rule } from '../../../src/domain/rules/schema';
import type { TrackedItem } from '../../../src/domain/types';
import { FakeAuditLog } from '../../fakes/ports/fake-audit-log';
import { FakeClock } from '../../fakes/ports/fake-clock';
import { FakeSgwApi } from '../../fakes/ports/fake-sgw-api';
import { FakeStorageAreas } from '../../fakes/ports/fake-storage';
import { FakeSwitches } from '../../fakes/ports/fake-switches';

const CTX = { sender: {}, senderClass: 'ui' } as const;
let audit: FakeAuditLog;
let repo: Repo;
let api: FakeSgwApi;
let switches: FakeSwitches;
let h: ReturnType<typeof createAuditHandlers>;

const removeCalls = (): number => api.calls.filter((c) => c.method === 'removeFavorite').length;
const favEntry = (over: Record<string, unknown> = {}) =>
  audit.append({
    actor: 'daily-job',
    kind: 'favorite.add',
    itemId: 101,
    details: {},
    undo: { kind: 'unfavorite', ref: unfavoriteRef(101) },
    ...over,
  });

beforeEach(() => {
  const clock = new FakeClock(1_000_000);
  audit = new FakeAuditLog(clock);
  repo = new Repo(new FakeStorageAreas(), clock);
  switches = new FakeSwitches();
  api = new FakeSgwApi({ clock, switches });
  h = createAuditHandlers({ audit, executors: createUndoExecutors({ api, repo }) });
});

describe('audit.undo', () => {
  it('refuses a dry-run entry', async () => {
    const e = await favEntry({ dryRun: true });
    await expect(h['audit.undo']({ seq: e.seq }, CTX)).rejects.toThrow(/dry run/);
    expect(removeCalls()).toBe(0);
  });

  it('removes the favorite, marks done and appends an undo entry', async () => {
    await repo.set(STORAGE_KEYS.tracked, {
      101: {
        itemId: 101,
        title: 't',
        endTime: new Date(2_000_000_000_000).toISOString(),
        sellerId: 1,
        reasons: [],
        favoriteState: 'favorited',
        calendar: false,
        addedAt: 1,
        updatedAt: 1,
      } satisfies TrackedItem,
    });
    const e = await favEntry();
    await h['audit.undo']({ seq: e.seq }, CTX);
    expect(removeCalls()).toBe(1);
    expect(audit.kinds).toEqual(['favorite.add', 'undo']);
    expect(audit.entries[1]).toMatchObject({ itemId: 101, details: { undoneSeq: e.seq } });
    const listed = (await h['audit.list']({ limit: 10 }, CTX)).find((x) => x.seq === e.seq);
    expect(listed?.undo?.done).toBe(true);
    expect((await repo.get(STORAGE_KEYS.tracked))[101]?.favoriteState).toBe('favorited');
  });

  it('a double undo is a no-op', async () => {
    const e = await favEntry();
    await h['audit.undo']({ seq: e.seq }, CTX);
    await h['audit.undo']({ seq: e.seq }, CTX);
    expect(removeCalls()).toBe(1);
    expect(audit.kinds).toEqual(['favorite.add', 'undo']);
  });

  it('concurrent undos make one write', async () => {
    const e = await favEntry();
    await Promise.all([
      h['audit.undo']({ seq: e.seq }, CTX),
      h['audit.undo']({ seq: e.seq }, CTX),
      h['audit.undo']({ seq: e.seq }, CTX),
    ]);
    expect(removeCalls()).toBe(1);
    expect(audit.kinds.filter((k) => k === 'undo')).toHaveLength(1);
  });

  it('a switch refusal says "not now", stays not done, and can be retried', async () => {
    const e = await favEntry();
    switches.block('favorites', 'kill switch is on');
    await expect(h['audit.undo']({ seq: e.seq }, CTX)).rejects.toThrow(/^not now: .*kill switch is on/);
    expect(audit.kinds).toEqual(['favorite.add']);
    expect((await h['audit.list']({ limit: 10 }, CTX))[0]?.undo?.done).toBeUndefined();
    switches.reset();
    await h['audit.undo']({ seq: e.seq }, CTX);
    expect(removeCalls()).toBe(2); // refused attempt (gated in the adapter), then the retry
    expect(audit.kinds).toEqual(['favorite.add', 'undo']);
  });

  it('re-enables a disabled rule', async () => {
    const rule = { id: 'r1', name: 'x', enabled: false, action: 'highlight', all: [], createdAt: 1, updatedAt: 1 } as unknown as Rule;
    await repo.set(STORAGE_KEYS.rules, [rule]);
    const e = await audit.append({ actor: 'system', kind: 'rule.disabled', details: {}, undo: { kind: 'disableRule', ref: 'r1' } });
    await h['audit.undo']({ seq: e.seq }, CTX);
    expect((await repo.get(STORAGE_KEYS.rules))[0]?.enabled).toBe(true);
    expect(audit.entries[1]).toMatchObject({ kind: 'undo', details: { undoneSeq: e.seq, undoKind: 'disableRule' } });
    expect((await h['audit.list']({ limit: 10 }, CTX)).find((x) => x.seq === e.seq)?.undo?.done).toBe(true);
  });

  it('refuses kinds with no executor yet, and unknown or non-undoable entries', async () => {
    const e = await audit.append({ actor: 'snipe', kind: 'snipe.arm', details: {}, undo: { kind: 'disarm', ref: 's1' } });
    await expect(h['audit.undo']({ seq: e.seq }, CTX)).rejects.toThrow(/not available yet/);
    const plain = await audit.append({ actor: 'user', kind: 'x', details: {} });
    await expect(h['audit.undo']({ seq: plain.seq }, CTX)).rejects.toThrow(/cannot be undone/);
    await expect(h['audit.undo']({ seq: 999 }, CTX)).rejects.toThrow(/no longer exists/);
  });
});

describe('audit.list', () => {
  it('pages newest first with before', async () => {
    for (let i = 0; i < 5; i++) await audit.append({ actor: 'user', kind: `k${String(i)}`, details: {} });
    const p1 = await h['audit.list']({ limit: 2 }, CTX);
    expect(p1.map((e) => e.seq)).toEqual([5, 4]);
    const p2 = await h['audit.list']({ limit: 2, before: 4 }, CTX);
    expect(p2.map((e) => e.seq)).toEqual([3, 2]);
  });
});

describe('audit.list cost', () => {
  it('scans only entries newer than the page, not the whole log', async () => {
    for (let i = 0; i < 500; i++) await audit.append({ actor: 'user', kind: 'old', details: {}, undo: { kind: 'unfavorite', ref: unfavoriteRef(5) } });
    let returned = 0;
    const spy = {
      append: audit.append.bind(audit),
      exportJson: audit.exportJson.bind(audit),
      list: async (q: Parameters<typeof audit.list>[0]) => {
        const r = await audit.list(q);
        returned += r.length;
        return r;
      },
    };
    const hh = createAuditHandlers({ audit: spy, executors: {} });
    const page = await hh['audit.list']({ limit: 5 }, CTX);
    expect(page).toHaveLength(5);
    expect(returned).toBeLessThanOrEqual(5 + SCAN_BATCH);
  });

  it('still finds an undo entry newer than the page', async () => {
    const e = await favEntry();
    for (let i = 0; i < 250; i++) await audit.append({ actor: 'user', kind: 'x', details: {} });
    await h['audit.undo']({ seq: e.seq }, CTX);
    const page = await h['audit.list']({ limit: 5, before: e.seq + 1 }, CTX);
    expect(page[0]?.undo?.done).toBe(true);
  });
});

describe('undoable kinds', () => {
  it('the UI list matches the wired executors', () => {
    expect([...UNDOABLE_KINDS].sort()).toEqual(Object.keys(createUndoExecutors({ api, repo })).sort());
  });
});

describe('error text on the real wire', () => {
  it('"not now: <why>" reaches a UI client through router and messaging/client', async () => {
    const router = createRouter({
      runtimeId: 'ext-id',
      getURL: (p) => `chrome-extension://ext-id/${p}`,
      isQuickFavoriteEnabled: () => true,
      log: () => undefined,
    });
    router.register('audit.undo', h['audit.undo']);
    const sender = { id: 'ext-id', url: 'chrome-extension://ext-id/options.html' };
    const client = createMessagingClient({ id: 'ext-id', sendMessage: (m: unknown) => router.handle(m, sender) } as unknown as ClientRuntime);
    const e = await favEntry();
    switches.block('favorites', 'kill switch is on');
    await expect(client.send('audit.undo', { seq: e.seq })).rejects.toMatchObject({
      code: 'handler_error',
      message: expect.stringMatching(/^not now: .*kill switch is on/) as unknown,
    });
  });
});
