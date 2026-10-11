import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/preact';
import { h } from 'preact';
import { afterEach, describe, expect, it } from 'vitest';

import type { Rule } from '../../src/domain/rules/schema';
import type { JobRun, Watch } from '../../src/domain/watches/schema';
import { PORT_NAMES } from '../../src/messaging/protocol';
import { Dashboard } from '../../src/ui/dashboard/Dashboard';
import { FAVORITE_SKIP_PREFIX } from '../../src/ui/dashboard/policy';
import { loadSections, type SectionDef } from '../../src/ui/dashboard/registry';
import { builtinModules } from '../../src/ui/dashboard/sections';
import { FakeMessaging } from '../fakes/ports/fake-messaging';

afterEach(cleanup);

const NOW = Date.UTC(2026, 9, 7, 12, 0, 0);

const watch = (over: Partial<Watch> = {}): Watch => ({
  id: 'w1',
  name: 'Vintage cameras',
  enabled: true,
  query: { searchText: 'camera', categoryIds: [], sellerIds: [], page: 1 },
  ruleIds: ['r1'],
  maxPages: 1,
  favoriteMode: 'sgw',
  calendar: false,
  notify: false,
  nextRunAt: NOW + 3600_000,
  lastRunAt: NOW - 3600_000,
  seenItemIds: [],
  ...over,
});

const run = (over: Partial<JobRun> = {}): JobRun => ({
  id: 'run1',
  trigger: 'manual',
  startedAt: NOW - 1000,
  status: 'running',
  steps: [{ kind: 'search', watchId: 'w1', page: 1 }, { kind: 'favoritesList' }, { kind: 'notifyDigest' }],
  cursor: 1,
  results: { newMatches: [], favorited: [], calendarUpserts: [], errors: [] },
  ...over,
});

const rule = (over: Partial<Rule> = {}): Rule => ({
  id: 'r1',
  name: 'Cheap',
  enabled: true,
  action: 'watch',
  all: [],
  createdAt: NOW,
  updatedAt: NOW,
  ...over,
});

function healthReply(over: Record<string, unknown> = {}) {
  return {
    sgw: { ok: true, checkedAt: NOW, configVersion: '1', checks: [{ name: 'clock' as const, ok: true }] },
    session: NOW + 48 * 3600_000,
    sessionState: 'ok' as const,
    google: { connected: false, provider: 'none' as const, grantedScopes: [], needsInteraction: false, configured: false },
    budget: {
      lanes: {
        interactive: { usedToday: 1, budget: 300, nextAllowedAt: 0 },
        background: { usedToday: 12, budget: 120, nextAllowedAt: 0 },
        snipe: { usedToday: 0, budget: 80, nextAllowedAt: 0 },
        canary: { usedToday: 0, budget: 4, nextAllowedAt: 0 },
      },
      cacheHits: 0,
    },
    ...over,
  };
}

function setup(opts: { watches?: Watch[]; rules?: Rule[]; status?: JobRun | null; extra?: Record<string, unknown> } = {}) {
  const m = new FakeMessaging();
  m.handle('watches.list', () => opts.watches ?? [watch()]);
  m.handle('rules.list', () => opts.rules ?? [rule()]);
  m.handle('job.status', () => opts.status ?? null);
  m.handle('job.runNow', () => undefined);
  m.handle('tracked.list', () => []);
  m.handle('health.get', () => healthReply());
  m.handle('audit.list', () => []);
  const opened: string[] = [];
  const sections = loadSections({ ...builtinModules, ...(opts.extra ?? {}) });
  render(
    h(Dashboard, {
      client: m,
      sections,
      userTz: 'America/New_York',
      openOptions: (s?: string) => {
        opened.push(s ?? '');
      },
    }),
  );
  return { m, opened };
}

describe('dashboard watches', () => {
  it('renders JobRun progress from the job-progress port', async () => {
    const { m } = setup();
    await screen.findByText('Vintage cameras');
    await waitFor(() => {
      expect(m.openPorts(PORT_NAMES.jobProgress)).toBe(1);
    });
    m.emitTick(PORT_NAMES.jobProgress, run({ cursor: 2 }));
    const bar = await screen.findByRole('progressbar');
    expect(bar.getAttribute('aria-valuenow')).toBe('2');
    expect(bar.getAttribute('aria-valuemax')).toBe('3');
    m.emitTick(
      PORT_NAMES.jobProgress,
      run({ status: 'done', cursor: 3, finishedAt: NOW, results: { newMatches: [1, 2], favorited: [], calendarUpserts: [], errors: [] } }),
    );
    await waitFor(() => {
      expect(screen.queryByRole('progressbar')).toBeNull();
    });
    expect(screen.getByText(/2 new matches/)).toBeTruthy();
  });

  it('Run now sends job.runNow', async () => {
    const { m } = setup();
    fireEvent.click(await screen.findByRole('button', { name: /^run now$/i }));
    await waitFor(() => {
      expect(m.sent.filter((s) => s.type === 'job.runNow')).toEqual([{ type: 'job.runNow', payload: {} }]);
    });
  });

  it('Run now for one watch passes its id', async () => {
    const { m } = setup();
    fireEvent.click(await screen.findByRole('button', { name: /run vintage cameras now/i }));
    await waitFor(() => {
      expect(m.sent.filter((s) => s.type === 'job.runNow')).toEqual([
        { type: 'job.runNow', payload: { watchIds: ['w1'] } },
      ]);
    });
  });

  it('shows dual time for last and next run', async () => {
    setup();
    await screen.findByText('Vintage cameras');
    expect(document.querySelectorAll('time').length).toBeGreaterThanOrEqual(2);
    expect(document.body.textContent).toMatch(/PT/);
    expect(document.body.textContent).toMatch(/ET/);
  });

  it('warns on a watch with no enabled rules', async () => {
    setup({ watches: [watch({ ruleIds: [] }), watch({ id: 'w2', name: 'Other', ruleIds: ['r1'] })], rules: [rule()] });
    await screen.findByText('Other');
    const warns = screen.getAllByText('This watch has no rules, so it will never match. Add a rule in Options → Watches.');
    expect(warns).toHaveLength(1);
  });

  it('warns when all referenced rules are disabled', async () => {
    setup({ rules: [rule({ enabled: false })] });
    expect(await screen.findByText(/This watch has no rules/)).toBeTruthy();
  });

  it('shows favorite policy skips as skipped, not as errors', async () => {
    setup({
      status: run({
        status: 'done',
        cursor: 3,
        results: {
          newMatches: [],
          favorited: [],
          calendarUpserts: [],
          errors: [
            { step: 0, message: `${FAVORITE_SKIP_PREFIX}dry-run` },
            { step: 1, message: 'search failed: HTTP 500' },
          ],
        },
      }),
    });
    expect(await screen.findByText(/skipped \(policy\)/i)).toBeTruthy();
    expect(screen.getByText(/1 error\b/)).toBeTruthy();
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('search failed: HTTP 500');
    expect(alert.textContent).not.toContain('dry-run');
  });

  it('degrades to unavailable when the handler is missing', async () => {
    const m = new FakeMessaging();
    render(h(Dashboard, { client: m, sections: loadSections(builtinModules), userTz: 'UTC', openOptions: () => undefined }));
    await waitFor(() => {
      expect(screen.getAllByText(/unavailable/i).length).toBeGreaterThan(0);
    });
  });
});

describe('dashboard sections', () => {
  it('renders a section added under sections/ without editing the shell', async () => {
    const Extra = () => h('p', null, 'extra section body');
    const extra: SectionDef = { id: 'extra', title: 'Extra', order: 5, Component: Extra };
    setup({ extra: { './sections/extra/index.tsx': { section: extra } } });
    expect(await screen.findByRole('heading', { name: 'Extra' })).toBeTruthy();
    expect(screen.getByText('extra section body')).toBeTruthy();
    const order = screen.getAllByRole('heading', { level: 2 }).map((e) => e.textContent);
    expect(order[0]).toBe('Extra');
  });

  it('registers the four built-in sections and rejects a malformed or duplicate one', () => {
    expect(loadSections(builtinModules).map((s) => s.id)).toEqual(['watches', 'matches', 'health', 'activity']);
    expect(() => loadSections({ './x': {} })).toThrow(/valid "section"/);
    const dup = (builtinModules['./sections/health/index.tsx'] as { section: SectionDef }).section;
    expect(() => loadSections({ ...builtinModules, './y': { section: dup } })).toThrow(/duplicate/);
  });

  it('Activity mounts the T-58 ActivityList (fetches audit.list)', async () => {
    const { m } = setup();
    await waitFor(() => {
      expect(m.sent.some((s) => s.type === 'audit.list')).toBe(true);
    });
    const region = screen.getByRole('heading', { name: 'Activity' }).closest('section');
    expect(region).not.toBeNull();
    expect(within(region as HTMLElement).getByRole('heading', { name: 'Activity' })).toBeTruthy();
  });
});

describe('dashboard matches and health', () => {
  it('lists matches and favorites as text only and syncs favorites', async () => {
    const m = new FakeMessaging();
    const base = { sellerId: 3, reasons: [{ kind: 'watch' as const, id: 'w1' }], calendar: false, addedAt: NOW, updatedAt: NOW };
    m.handle('tracked.list', () => [
      { ...base, itemId: 7, title: '<img src=x onerror=alert(1)> Canon', endTime: '2026-10-08T02:00:00.000Z', favoriteState: 'favorited' as const },
      { ...base, itemId: 8, title: 'Nikon', endTime: '2026-10-09T02:00:00.000Z', favoriteState: 'none' as const },
    ]);
    m.handle('favorites.sync', () => undefined);
    render(h(Dashboard, { client: m, sections: loadSections(builtinModules), userTz: 'UTC', openOptions: () => undefined }));
    await screen.findAllByText(/Canon/);
    expect(document.querySelector('img')).toBeNull();
    expect(screen.getByText(/Nikon/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /sync favorites/i }));
    await waitFor(() => {
      expect(m.sent.some((s) => s.type === 'favorites.sync')).toBe(true);
    });
  });

  it('summarizes health and links to Options', async () => {
    const m = new FakeMessaging();
    m.handle('health.get', () =>
      healthReply({
        sessionState: 'expired',
        sticky: [{ endpoint: 'search', at: NOW, detail: 'schema changed', features: ['favorite'] }],
      }),
    );
    const opened: string[] = [];
    render(
      h(Dashboard, {
        client: m,
        sections: loadSections(builtinModules),
        userTz: 'UTC',
        openOptions: (s?: string) => {
          opened.push(s ?? '');
        },
      }),
    );
    await screen.findByText(/rejected your sign-in/i);
    expect(screen.getByText(/schema changed/)).toBeTruthy();
    expect(screen.getByText(/12 \/ 120/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /open health options/i }));
    expect(opened).toEqual(['health']);
  });
});
