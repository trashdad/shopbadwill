// T-90: the dashboard Timing section (R4/R5). Renders over FakeMessaging only;
// no network. Covers: registry pickup; the per-snipe columns (alarm delay is
// 'not recorded', R3); the Apply button writes defaultLeadMs only on click
// (R5); no bid amount ever reaches the page or the export (R4); the export is
// a Blob download whose anchor is in the document; the awake chart from
// timing.awake; text only (no innerHTML).
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
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
/** True only when the download anchor is in the document at click time. */
let anchorConnected: boolean | null = null;
beforeEach(() => {
  blobs.length = 0;
  anchorConnected = null;
  vi.spyOn(URL, 'createObjectURL').mockImplementation((b: Blob | MediaSource) => {
    blobs.push(b as Blob);
    return 'blob:sbw-test';
  });
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    anchorConnected = this.isConnected;
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const mount = (m: FakeMessaging, userTz = 'America/New_York') =>
  render(h(section.Component, { client: m, userTz, openOptions: () => undefined }));

function handleAwake(m: FakeMessaging, history: number[] = []): void {
  m.handle('timing.awake', () => history);
}

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
  handleAwake(m);
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
    handleAwake(m);
    mount(m);

    expect(await screen.findByText(/Completed dry runs: 3 of 5 required/)).toBeTruthy();
    expect(screen.getByText(/Fires attempted: 5; on time: 5 \(100%\)/)).toBeTruthy();
    expect(screen.getByText(/p50 \+7.00 s, p95 \+11.00 s, p99 \+11.00 s/)).toBeTruthy();
    expect(screen.getByText(/The soak recommends 10.5 s/)).toBeTruthy();
    // The table: fire error and alarm delay columns.
    expect(screen.getAllByText('+100 ms').length).toBeGreaterThan(0);
    expect(screen.getAllByText('not recorded').length).toBeGreaterThan(0); // alarm delay (R3)
    expect(screen.getByText('No heartbeats recorded yet.')).toBeTruthy();
    expect(screen.getAllByRole('progressbar')).toHaveLength(24);
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
    const downloaded = await blobs[0]?.text();
    expect(downloaded).toContain('"snipeId"');
    expect(downloaded).not.toContain('maxBid');
    // The anchor has to be in the document or the browser drops the download.
    expect(anchorConnected).toBe(true);
    const allowed = new Set(['settings.get', 'snipe.list', 'settings.set', 'timing.awake']);
    expect(m.sent.every((x) => allowed.has(x.type))).toBe(true);
    expect(m.sent.some((x) => x.type === 'timing.awake')).toBe(true);
  });

  it('labels a fire error of exactly 1000 ms as on time and a larger one as off time', async () => {
    const m = new FakeMessaging();
    m.handle('snipe.list', () => [completedDry('edge', 1000, 1000), completedDry('early', -1500, 1000)]);
    m.handle('settings.get', () => defaultSettings());
    handleAwake(m);
    mount(m);
    await screen.findByText(/Fires attempted: 2/);
    expect(screen.getAllByText('on time')).toHaveLength(1);
    expect(screen.getAllByText('off time')).toHaveLength(1);
    expect(screen.queryByText('late')).toBeNull();
  });

  it('draws the awake chart from timing.awake, including one heartbeat in its local hour', async () => {
    const beat = Date.UTC(2026, 9, 10, 12, 30, 0); // 2026-10-10 12:30 UTC
    const now = beat + 3_600_000; // 13:30: hour 12 has ended, so today counts
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const m = new FakeMessaging();
    m.handle('snipe.list', () => []);
    m.handle('settings.get', () => defaultSettings());
    handleAwake(m, [beat]);
    mount(m, 'UTC');
    const bar = await screen.findByRole('progressbar', { name: /12:00/ });
    expect(bar.getAttribute('aria-valuenow')).toBe('1');
    expect(bar.getAttribute('aria-valuemax')).toBe('14');
    expect(bar.querySelector<HTMLElement>('.sbw-bar')?.style.width).toBe('7%');
    expect(screen.getByText('1/14')).toBeTruthy();
    expect(screen.queryByText('No heartbeats recorded yet.')).toBeNull();
    expect(screen.getAllByRole('progressbar')).toHaveLength(24);

    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await vi.waitFor(() => {
      expect(m.sent.filter((x) => x.type === 'timing.awake')).toHaveLength(2);
    });
  });

  it('a missing background handler reads as unavailable, not as a problem', async () => {
    const m = new FakeMessaging();
    mount(m);
    expect(await screen.findByText(/snipe timing is unavailable/)).toBeTruthy();
    expect(screen.getByText(/awake history is unavailable/)).toBeTruthy();
    expect(screen.queryByRole('progressbar')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('timing section source builds the page from text nodes, not innerHTML', () => {
    const dir = path.join(process.cwd(), 'src/ui/dashboard/sections/timing');
    const files = readdirSync(dir).filter((name) => /\.(ts|tsx)$/.test(name));
    expect(files.length).toBeGreaterThan(2);
    const sink = /\b(innerHTML|outerHTML|insertAdjacentHTML|dangerouslySetInnerHTML)\b/;
    const offenders = files.filter((name) => {
      const src = readFileSync(path.join(dir, name), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '');
      return sink.test(src);
    });
    expect(offenders).toEqual([]);
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
