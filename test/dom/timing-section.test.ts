// T-90: the dashboard Timing section (R4/R5). Renders over FakeMessaging only;
// no network. Covers: registry pickup; the per-snipe columns (alarm delay is
// 'not recorded', R3); the Apply button writes defaultLeadMs only on click
// (R5); no bid amount ever reaches the page or the export (R4); the export is
// a Blob download; the awake-chart row math.
import { cleanup, fireEvent, render, screen } from '@testing-library/preact';
import { h } from 'preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { defaultSettings } from '../../src/domain/settings/defaults';
import type { Settings } from '../../src/domain/settings/schema';
import type { Snipe } from '../../src/domain/snipe/types';
import { loadSections } from '../../src/ui/dashboard/registry';
import { builtinModules } from '../../src/ui/dashboard/sections';
import { awakeFraction, awakeRows } from '../../src/ui/dashboard/sections/timing/awake';
import { buildTimingExport } from '../../src/ui/dashboard/sections/timing/export';
import { section } from '../../src/ui/dashboard/sections/timing';
import { FakeMessaging } from '../fakes/ports/fake-messaging';

const NOW = Date.UTC(2026, 9, 10, 15, 0, 0);
const END = NOW + 2 * 3_600_000;

const snipe = (over: Partial<Snipe> = {}): Snipe => ({
  id: 's1',
  itemId: 700000001,
  title: 'Pyrex bowl',
  endTime: new Date(END).toISOString(),
  endTimeAtArm: new Date(END).toISOString(),
  maxBid: 5000,
  leadMs: 8000,
  fallback: 'early-proxy',
  dryRun: true,
  state: 'resolved',
  armedAt: NOW,
  attempt: {},
  history: [],
  ...over,
});

const completedDry = (id: string, error: number, latency: number): Snipe =>
  snipe({
    id,
    fireAt: END - 8000,
    measured: { offsetMs: 1300, rttMs: 300, firedAt: END - 8000 + error, responseAt: END - 8000 + error + latency },
  });

/** 5 dry runs whose p99 one-way latency (11 s / 2 = 5.5 s) recommends 10.5 s. */
const soaks = (): Snipe[] => [
  completedDry('a', 100, 3000),
  completedDry('b', 200, 5000),
  completedDry('c', -300, 7000),
  completedDry('d', 400, 9000),
  completedDry('e', 500, 11_000),
];

const blobs: Blob[] = [];
beforeEach(() => {
  blobs.length = 0;
  vi.spyOn(URL, 'createObjectURL').mockImplementation((b: Blob | MediaSource) => {
    blobs.push(b as Blob);
    return 'blob:sbw-test';
  });
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const mount = (m: FakeMessaging) =>
  render(h(section.Component, { client: m, userTz: 'America/New_York', openOptions: () => undefined }));

function settingsClient(current: Settings) {
  const m = new FakeMessaging();
  m.handle('settings.get', () => current);
  m.handle('settings.set', (patch: Partial<Settings>) => {
    // applySettingsPatch semantics: shallow merge of top-level groups.
    const merged = { ...current, ...patch } as Settings;
    current = merged;
    return undefined;
  });
  m.handle('snipe.list', () => soaks());
  return m;
}

describe('timing section registry', () => {
  it('is picked up by the T-54 registry', () => {
    expect(loadSections(builtinModules).map((s) => s.id)).toContain('timing');
  });
});

describe('timing section', () => {
  it('shows the soak summary and the per-snipe columns, with alarm delay not recorded', async () => {
    const m = new FakeMessaging();
    m.handle('snipe.list', () => soaks());
    const s = defaultSettings();
    s.snipe.completedDryRuns = 3;
    m.handle('settings.get', () => s);
    mount(m);

    expect(await screen.findByText(/Completed dry runs: 3 of 5 required/)).toBeTruthy();
    expect(screen.getByText(/Fires attempted: 5; on time: 5 \(100%\)/)).toBeTruthy();
    expect(screen.getByText(/p50 \+7.00 s, p95 \+11.00 s, p99 \+11.00 s/)).toBeTruthy();
    expect(screen.getByText(/The soak recommends 10.5 s/)).toBeTruthy();
    // The table: fire error and alarm delay columns.
    expect(screen.getAllByText('+100 ms').length).toBeGreaterThan(0);
    expect(screen.getAllByText('not recorded').length).toBeGreaterThan(0); // alarm delay (R3)
    expect(screen.getByText(/Awake history is not recorded/)).toBeTruthy();
    // The max bid ($50.00 = 5000 cents) never reaches the page.
    expect(document.body.textContent).not.toContain('5000');
  });

  it('Apply writes defaultLeadMs only on the button click (R5)', async () => {
    const m = settingsClient(defaultSettings());
    mount(m);
    expect(await screen.findByText(/The soak recommends 10.5 s/)).toBeTruthy();
    // Rendering and loading never write settings.
    expect(m.sent.some((x) => x.type === 'settings.set')).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'Apply 10.5 s lead' }));
    await screen.findByText(/Applied: the default lead is now 10.5 s/);
    const writes = m.sent.filter((x) => x.type === 'settings.set');
    expect(writes).toHaveLength(1);
    const expected = defaultSettings().snipe;
    expect(writes[0]?.payload).toEqual({ snipe: { ...expected, defaultLeadMs: 10_500 } });
  });

  it('no recommendation or one equal to the current default leaves the button off (no write possible)', async () => {
    // Recommendation equals the current default.
    const s = defaultSettings();
    s.snipe.defaultLeadMs = 10_500;
    const m = settingsClient(s);
    mount(m);
    await screen.findByText(/The soak recommendation matches the current default/);
    const button = screen.getByRole<HTMLButtonElement>('button', { name: 'Apply' });
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(m.sent.some((x) => x.type === 'settings.set')).toBe(false);
  });

  it('with no soak data the Apply button is off and the page says so', async () => {
    const m = new FakeMessaging();
    m.handle('snipe.list', () => []);
    m.handle('settings.get', () => defaultSettings());
    mount(m);
    expect(await screen.findByText(/Not enough soak data for a recommendation/)).toBeTruthy();
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Apply' }).disabled).toBe(true);
  });

  it('exports timing data plus snipe ids only, as a Blob download with no network', async () => {
    const m = settingsClient(defaultSettings());
    mount(m);
    await screen.findByText(/The soak recommends 10.5 s/);

    const data = buildTimingExport(soaks(), defaultSettings());
    const json = JSON.stringify(data);
    expect(json).toContain('"snipeId":"a"');
    expect(json).toContain('"fireErrorMs"');
    expect(json).toContain('"alarmDelayMs":null');
    // Timing data plus snipe ids only: exactly the row's field set, no bid amounts.
    expect(data.rows).toHaveLength(5);
    expect(Object.keys(data.rows[0] as object).sort()).toEqual([
      'alarmDelayMs',
      'fireErrorMs',
      'latencyMs',
      'offsetMs',
      'onTime',
      'rttMs',
      'snipeId',
    ]);
    expect(json).not.toContain('"maxBid"');
    expect(json).not.toContain('maxBid');
    expect(Object.keys(data)).toEqual(['exportedAt', 'summary', 'gate', 'rows']);

    fireEvent.click(screen.getByRole('button', { name: 'Export JSON' }));
    await screen.findByText('Exported.');
    expect(blobs).toHaveLength(1);
    expect(blobs[0]?.type).toBe('application/json');
    expect(m.sent.some((x) => x.type !== 'settings.get' && x.type !== 'snipe.list' && x.type !== 'settings.set')).toBe(false);
  });

  it('a missing background handler reads as unavailable, not as a problem', async () => {
    const m = new FakeMessaging();
    mount(m);
    expect(await screen.findByText(/snipe timing is unavailable/)).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('awake chart rows (text-based)', () => {
  it('counts days with a heartbeat in each local hour', () => {
    const beat = Date.UTC(2026, 9, 10, 12, 30, 0); // 2026-10-10 12:30 UTC
    const now = beat + 3_600_000; // 13:30 the same day: that hour 12 has ended, so today counts
    const rows = awakeRows([beat], 'UTC', now);
    expect(rows).toHaveLength(24);
    expect(rows[12]).toEqual({ hour: 12, label: '12:00', awake: 1, observed: 14 });
    expect(rows[13]?.awake).toBe(0);
    expect(awakeFraction(rows[12] as (typeof rows)[number])).toBe(1 / 14);
    expect(awakeFraction(rows[0] as (typeof rows)[number])).toBe(0);
  });

  it('no history gives zero fractions, never a division by zero', () => {
    const rows = awakeRows([], 'UTC', NOW);
    for (const row of rows) expect(awakeFraction(row)).toBe(0);
  });
});
