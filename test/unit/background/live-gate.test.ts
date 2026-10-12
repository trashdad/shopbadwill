// T-102: the live-bidding gate (src/background/handlers/live-gate.ts).
// Fakes only, no browser. The gate is the settings.set interceptor (R1): the
// only authority over turning `dryRun.bidding` off. The typed confirmation
// arrives ONLY through the gate's own port (LIVE_GATE_PORT); a settings.set
// sent directly, without it, is refused — this file proves it (R6).
import { describe, expect, it } from 'vitest';

import { Channel, createPortRegistry, EventGate, SettingsSetInterceptors, SettingsVetoError } from '../../../src/background/context';
import type { BackgroundContext, RuntimePort, SettingsSetChange } from '../../../src/background/context';
import {
  CONFIRM_TTL_MS,
  FIRST_LIVE_CHECKLIST_URL,
  GO_LIVE_CONFIRMATION,
  LIVE_GATE_PORT,
  liveGateVerdict,
  register,
  type BiddingOffAudit,
} from '../../../src/background/handlers/live-gate';
import { defaultSettings } from '../../../src/domain/settings/defaults';
import type { Settings } from '../../../src/domain/settings/schema';
import type { Snipe } from '../../../src/domain/snipe/types';
import { Repo } from '../../../src/domain/storage/repo';
import { STORAGE_KEYS } from '../../../src/domain/storage/schema';
import { FakeClock } from '../../fakes/ports/fake-clock';
import { FakeStorageAreas } from '../../fakes/ports/fake-storage';

const NOW = Date.UTC(2026, 9, 10, 15, 0, 0);
const END = NOW + 3_600_000;

interface CtxHarness {
  ctx: BackgroundContext;
  repo: Repo;
  auditEntries: Array<{ actor: string; kind: string; details: Record<string, unknown> }>;
  connections: Channel<[RuntimePort]>;
  interceptors: SettingsSetInterceptors;
}

/** A minimal background context with only what register() touches. */
function makeCtx(): CtxHarness {
  const clock = new FakeClock(NOW);
  const storage = new FakeStorageAreas();
  const repo = new Repo(storage, clock);
  const auditEntries: CtxHarness['auditEntries'] = [];
  const gate = new EventGate(() => undefined);
  gate.open();
  const connections = new Channel<[RuntimePort]>(gate);
  const ports = createPortRegistry(connections);
  const interceptors = new SettingsSetInterceptors();
  const ctx = {
    clock,
    repo,
    audit: {
      append: (e: { actor: string; kind: string; details: Record<string, unknown> }) => {
        auditEntries.push(structuredClone(e));
        return Promise.resolve({ seq: auditEntries.length, at: clock.now(), ...e });
      },
    },
    ports,
    interceptors: { settingsSet: interceptors },
  } as unknown as BackgroundContext;
  return { ctx, repo, auditEntries, connections, interceptors };
}

/** A dry-run snipe that fired: on-time unless `offByMs` says otherwise. */
const fired = (id: string, offByMs = 0): Snipe => ({
  id,
  itemId: 700_000_001,
  title: 'Pyrex bowl',
  endTime: new Date(END).toISOString(),
  endTimeAtArm: new Date(END).toISOString(),
  maxBid: 5000,
  leadMs: 8000,
  fallback: 'early-proxy',
  dryRun: true,
  state: 'resolved',
  outcome: 'dry-run',
  armedAt: NOW - 3_600_000,
  fireAt: NOW,
  measured: { firedAt: NOW + offByMs },
  attempt: {},
  history: [],
});

const settingsWith = (completed: number, required: number, bidding = true): Settings => {
  const s = defaultSettings();
  s.snipe.completedDryRuns = completed;
  s.snipe.requiredDryRuns = required;
  s.dryRun.bidding = bidding;
  return s;
};

/** next = current + patch, as the settings handler merges them (killSwitch and completedDryRuns are kept). */
const change = (current: Settings, next: Settings, patch: Partial<Settings>): SettingsSetChange => ({
  patch,
  current,
  next,
  sender: { sender: { id: 'sbw', url: 'chrome-extension://sbw/popup.html' }, senderClass: 'ui' },
});

const off = (current: Settings): SettingsSetChange => {
  const next = structuredClone(current);
  next.dryRun = { ...current.dryRun, bidding: false };
  return change(current, next, { dryRun: { ...current.dryRun, bidding: false } });
};

const on = (current: Settings): SettingsSetChange => {
  const next = structuredClone(current);
  next.dryRun = { ...current.dryRun, bidding: true };
  return change(current, next, { dryRun: { ...current.dryRun, bidding: true } });
};

/** The gate's port reply: ok only for the exact phrase. */
function portProbe(ctx: { connections: Channel<[RuntimePort]> }, senderUrl?: string): { posts: unknown[]; send: (m: unknown) => void } {
  const posts: unknown[] = [];
  const listeners: Array<(m: unknown) => void> = [];
  ctx.connections.emit({
    name: LIVE_GATE_PORT,
    sender: senderUrl === undefined ? { id: 'sbw' } : { id: 'sbw', url: senderUrl },
    postMessage: (m: unknown) => {
      posts.push(m);
    },
    disconnect: () => undefined,
    onMessage: { addListener: (l) => listeners.push(l), removeListener: () => undefined },
    onDisconnect: { addListener: () => undefined, removeListener: () => undefined },
  });
  return { posts, send: (m) => listeners[0]?.(m) };
}

describe('liveGateVerdict (pure)', () => {
  it('turning dryRun.bidding off is refused while completedDryRuns < requiredDryRuns', () => {
    const verdict = liveGateVerdict(off(settingsWith(3, 5)), [], null, NOW);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.veto).toContain('Complete 2 dry-run snipes before bidding live');
    }
  });

  it('the boundary: completed === required is not refused, one below is', () => {
    expect(liveGateVerdict(off(settingsWith(4, 5)), [], null, NOW).ok).toBe(false);
    // 5 of 5 completed with no fires at all: the on-time rate is 0, so the typed
    // confirmation is still required — but the count itself no longer blocks.
    const v = liveGateVerdict(off(settingsWith(5, 5)), [], null, NOW);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.veto).toContain(GO_LIVE_CONFIRMATION);
  });

  it('with on-time < 95% the typed confirmation is required and vetoed without one', () => {
    const snipes = [fired('a'), fired('b'), fired('c'), fired('d'), fired('e', 2000)]; // 4/5 = 80%
    const verdict = liveGateVerdict(off(settingsWith(5, 5)), snipes, null, NOW);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      // R5 honest copy: real money, the max bid, the daily cap, the terms warning,
      // the checklist link and the exact phrase.
      expect(verdict.veto).toContain('real money');
      expect(verdict.veto).toContain('$50.00');
      expect(verdict.veto).toContain('$100.00');
      expect(verdict.veto).toContain('terms may forbid automated bidding');
      expect(verdict.veto).toContain(FIRST_LIVE_CHECKLIST_URL);
      expect(verdict.veto).toContain(GO_LIVE_CONFIRMATION);
      expect(verdict.veto).toContain('80%');
      expect(verdict.veto).toContain('95%');
    }
  });

  it('with on-time < 95% and a fresh confirmation, the transition is allowed and audited as confirmed', () => {
    const snipes = [fired('a'), fired('b'), fired('c'), fired('d'), fired('e', 2000)];
    const verdict = liveGateVerdict(off(settingsWith(5, 5)), snipes, { at: NOW - 30_000 }, NOW);
    expect(verdict.ok).toBe(true);
    if (verdict.ok) {
      expect(verdict.audit).not.toBeNull();
      expect((verdict.audit as BiddingOffAudit).confirmed).toBe(true);
      expect((verdict.audit as BiddingOffAudit).onTimeRate).toBe(0.8);
    }
  });

  it('at >= 95% no confirmation is asked (95% exactly, and 100%)', () => {
    const ninetyFive = Array.from({ length: 20 }, (_, i) => fired(`s${String(i)}`, i === 19 ? 2000 : 0)); // 19/20
    const v95 = liveGateVerdict(off(settingsWith(5, 5)), ninetyFive, null, NOW);
    expect(v95.ok).toBe(true);
    if (v95.ok) {
      expect(v95.audit).not.toBeNull();
      expect((v95.audit as BiddingOffAudit).confirmed).toBe(false);
    }

    const perfect = [fired('a'), fired('b'), fired('c'), fired('d'), fired('e')];
    const v100 = liveGateVerdict(off(settingsWith(5, 5)), perfect, null, NOW);
    expect(v100.ok).toBe(true);
    if (v100.ok) {
      expect(v100.audit).not.toBeNull();
      expect((v100.audit as BiddingOffAudit).confirmed).toBe(false);
    }
  });

  it('the soak counts only dry-run fires (a live fire is not part of the rate)', () => {
    // 2 dry-run fires, both on-time; one live fire 5 s late must not drag the rate down.
    const snipes = [fired('a'), fired('b'), { ...fired('c', 5000), dryRun: false }];
    const verdict = liveGateVerdict(off(settingsWith(5, 5)), snipes, null, NOW);
    expect(verdict.ok).toBe(true);
    if (verdict.ok) expect((verdict.audit as BiddingOffAudit).onTimeRate).toBe(1);
  });

  it('a requiredDryRuns decrease is refused, whatever the rest of the patch says', () => {
    const current = settingsWith(5, 5);
    const next = structuredClone(current);
    next.snipe.requiredDryRuns = 4;
    const verdict = liveGateVerdict(change(current, next, { snipe: { ...current.snipe, requiredDryRuns: 4 } }), [], null, NOW);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.veto).toContain('cannot be lowered');
  });

  it('a requiredDryRuns decrease below the schema default of 5 is refused too', () => {
    const current = settingsWith(5, 6);
    const next = structuredClone(current);
    next.snipe.requiredDryRuns = 3;
    const verdict = liveGateVerdict(change(current, next, { snipe: { ...current.snipe, requiredDryRuns: 3 } }), [], null, NOW);
    expect(verdict.ok).toBe(false);
  });

  it('a requiredDryRuns increase is allowed', () => {
    const current = settingsWith(5, 5);
    const next = structuredClone(current);
    next.snipe.requiredDryRuns = 6;
    const verdict = liveGateVerdict(change(current, next, { snipe: { ...current.snipe, requiredDryRuns: 6 } }), [], null, NOW);
    expect(verdict.ok).toBe(true);
    if (verdict.ok) expect(verdict.audit).toBeNull();
  });

  it('turning dry-run back ON is always allowed, with no confirmation and no audit', () => {
    const current = settingsWith(0, 5, false);
    const verdict = liveGateVerdict(on(current), [], null, NOW);
    expect(verdict.ok).toBe(true);
    if (verdict.ok) expect(verdict.audit).toBeNull();
  });

  it('a stale confirmation beyond the TTL is refused', () => {
    const snipes = [fired('a'), fired('b'), fired('c'), fired('d'), fired('e', 2000)];
    const verdict = liveGateVerdict(off(settingsWith(5, 5)), snipes, { at: NOW - CONFIRM_TTL_MS - 1 }, NOW);
    expect(verdict.ok).toBe(false);
  });

  it('a crafted completedDryRuns in the patch does not open the gate: the verdict judges next, the kept count (R3)', () => {
    // The handler (T-90) keeps the stored count: the patch claims 99, but next
    // has the stored 3. The gate must judge next, so the transition stays locked.
    const current = settingsWith(3, 5);
    const next = structuredClone(current);
    next.dryRun = { ...current.dryRun, bidding: false };
    const patch = { dryRun: { ...current.dryRun, bidding: false }, snipe: { ...current.snipe, completedDryRuns: 99 } };
    const verdict = liveGateVerdict(change(current, next, patch), [fired('a'), fired('b'), fired('c')], null, NOW);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.veto).toContain('Complete 2 dry-run snipes before bidding live');
  });

  it('a no-op write (bidding already off) is allowed without confirmation and without audit', () => {
    const current = settingsWith(0, 5, false);
    const next = structuredClone(current);
    next.dryRun = { ...current.dryRun, bidding: false };
    const verdict = liveGateVerdict(change(current, next, { dryRun: { ...current.dryRun, bidding: false } }), [], null, NOW);
    expect(verdict.ok).toBe(true);
    if (verdict.ok) expect(verdict.audit).toBeNull();
  });

  it('unrelated patches are allowed without audit', () => {
    const current = settingsWith(5, 5);
    const next = structuredClone(current);
    next.overlay = { ...current.overlay, enabled: false };
    const verdict = liveGateVerdict(change(current, next, { overlay: { ...current.overlay, enabled: false } }), [], null, NOW);
    expect(verdict.ok).toBe(true);
    if (verdict.ok) expect(verdict.audit).toBeNull();
  });
});

describe('register (background wiring: port + interceptor + audit)', () => {
  it('the UI cannot bypass the gate by sending settings.set directly: no port confirmation → veto (R6)', async () => {
    const { ctx, interceptors, auditEntries, repo } = makeCtx();
    register(ctx);
    await repo.set(STORAGE_KEYS.snipes, { a: fired('a'), b: fired('b'), c: fired('c'), d: fired('d'), e: fired('e', 2000) });

    await expect(interceptors.check(off(settingsWith(5, 5)))).rejects.toThrow(SettingsVetoError);
    expect(auditEntries).toHaveLength(0);
  });

  it('the typed confirmation must match exactly: only GO LIVE arms the gate', async () => {
    const { ctx, interceptors, auditEntries, connections, repo } = makeCtx();
    register(ctx);
    await repo.set(STORAGE_KEYS.snipes, { a: fired('a'), b: fired('b'), c: fired('c'), d: fired('d'), e: fired('e', 2000) });

    const wrong = ['go live', 'GO LIVE ', 'GO LIVE.', 'CONFIRM', '', 'GO  LIVE'];
    for (const phrase of wrong) {
      const probe = portProbe({ connections });
      probe.send({ confirmation: phrase });
      expect(probe.posts).toEqual([{ ok: false }]);
      await expect(interceptors.check(off(settingsWith(5, 5)))).rejects.toThrow(SettingsVetoError);
    }

    const right = portProbe({ connections });
    right.send({ confirmation: GO_LIVE_CONFIRMATION });
    expect(right.posts).toEqual([{ ok: true }]);
    await expect(interceptors.check(off(settingsWith(5, 5)))).resolves.toBeUndefined();
    expect(auditEntries).toHaveLength(1);
    expect(auditEntries[0]).toMatchObject({ actor: 'user', kind: 'dryrun.bidding.off' });
    expect(auditEntries[0]?.details).toMatchObject({ confirmed: true, completedDryRuns: 5, requiredDryRuns: 5 });
  });

  it('at >= 95% the interceptor allows the transition with no confirmation and writes the audit entry', async () => {
    const { ctx, interceptors, auditEntries, repo } = makeCtx();
    register(ctx);
    await repo.set(STORAGE_KEYS.snipes, { a: fired('a'), b: fired('b'), c: fired('c'), d: fired('d'), e: fired('e') });

    await expect(interceptors.check(off(settingsWith(5, 5)))).resolves.toBeUndefined();
    expect(auditEntries).toHaveLength(1);
    expect(auditEntries[0]?.details).toMatchObject({ confirmed: false, onTimeRate: 1, firesAttempted: 5 });
    // R5: the audit records the money limits in effect.
    expect(auditEntries[0]?.details).toMatchObject({ maxBid: 5000, perDayMax: 10_000 });
  });

  it('a confirmation is one-shot: a second transition needs a new one', async () => {
    const { ctx, interceptors, connections, repo } = makeCtx();
    register(ctx);
    await repo.set(STORAGE_KEYS.snipes, { a: fired('a'), b: fired('b'), c: fired('c'), d: fired('d'), e: fired('e', 2000) });

    const probe = portProbe({ connections });
    probe.send({ confirmation: GO_LIVE_CONFIRMATION });
    await expect(interceptors.check(off(settingsWith(5, 5)))).resolves.toBeUndefined();

    // Go back to dry-run (one click, no confirmation), then off again: refused.
    const live = settingsWith(5, 5, false);
    await expect(interceptors.check(on(live))).resolves.toBeUndefined();
    await expect(interceptors.check(off(settingsWith(5, 5)))).rejects.toThrow(SettingsVetoError);
  });

  it('a confirmation from a web page is ignored (content scripts cannot arm it)', async () => {
    const { ctx, interceptors, connections, repo } = makeCtx();
    register(ctx);
    await repo.set(STORAGE_KEYS.snipes, { a: fired('a'), b: fired('b'), c: fired('c'), d: fired('d'), e: fired('e', 2000) });

    const probe = portProbe({ connections }, 'https://shopgoodwill.com/');
    probe.send({ confirmation: GO_LIVE_CONFIRMATION });
    expect(probe.posts).toEqual([]);
    await expect(interceptors.check(off(settingsWith(5, 5)))).rejects.toThrow(SettingsVetoError);
  });

  it('a requiredDryRuns decrease through settings.set is vetoed by the interceptor (R3)', async () => {
    const { ctx, interceptors, auditEntries } = makeCtx();
    register(ctx);
    const current = settingsWith(5, 5);
    const next = structuredClone(current);
    next.snipe.requiredDryRuns = 4;
    await expect(
      interceptors.check(change(current, next, { snipe: { ...current.snipe, requiredDryRuns: 4 } })),
    ).rejects.toThrow(SettingsVetoError);
    expect(auditEntries).toHaveLength(0);
  });

  it('a failed audit refuses the write (fail closed)', async () => {
    const { ctx, interceptors, repo } = makeCtx();
    await repo.set(STORAGE_KEYS.snipes, { a: fired('a'), b: fired('b'), c: fired('c'), d: fired('d'), e: fired('e') });
    (ctx.audit as unknown as { append: () => Promise<unknown> }).append = () => Promise.reject(new Error('audit storage failed'));
    register(ctx);
    await expect(interceptors.check(off(settingsWith(5, 5)))).rejects.toThrow(SettingsVetoError);
  });

  it('register serves the port only once (duplicate serve throws)', () => {
    const { ctx } = makeCtx();
    register(ctx);
    expect(() => {
      ctx.ports.serve(LIVE_GATE_PORT, () => undefined);
    }).toThrow(/already served/);
  });
});
