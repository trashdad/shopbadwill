// T-102: the exposure sections — the popup's live-gate surface (meter, status,
// honest copy, typed confirmation) and the dashboard's display-only mount of
// the same T-85 meter. Both mount `src/ui/exposure/**` (R4), never a fork.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { h } from 'preact';
import { afterEach, describe, expect, it } from 'vitest';

import { defaultSettings } from '../../src/domain/settings/defaults';
import type { Settings } from '../../src/domain/settings/schema';
import type { Snipe } from '../../src/domain/snipe/types';
import { ExposureSection as DashboardExposureSection } from '../../src/ui/dashboard/sections/exposure';
import { ExposureSection as PopupExposureSection } from '../../src/entrypoints/popup/sections/exposure';
import {
  FIRST_LIVE_CHECKLIST_URL,
  GO_LIVE_CONFIRMATION,
  LIVE_GATE_PORT,
} from '../../src/background/handlers/live-gate';
import { FakeMessaging } from '../fakes/ports/fake-messaging';

const NOW = Date.UTC(2026, 9, 10, 15, 0, 0);
const END = NOW + 3_600_000;

afterEach(cleanup);

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

interface PortCall {
  name: string;
  messages: unknown[];
}

function fakeConnectPort(replyWith: (m: unknown) => unknown = () => ({ ok: true })) {
  const calls: PortCall[] = [];
  const connectPort = (name: string) => {
    const call: PortCall = { name, messages: [] };
    calls.push(call);
    const listeners = new Set<(m: unknown) => void>();
    return {
      postMessage: (m: unknown) => {
        call.messages.push(m);
        queueMicrotask(() => {
          for (const l of [...listeners]) l(replyWith(m));
        });
      },
      onMessage: {
        addListener: (l: (m: unknown) => void) => listeners.add(l),
        removeListener: (l: (m: unknown) => void) => listeners.delete(l),
      },
      disconnect: () => undefined,
    };
  };
  return { calls, connectPort };
}

/** Five dry-run fires, one 2 s late: on-time rate 80% (< 95% → typed confirmation). */
const BELOW_95 = [fired('a'), fired('b'), fired('c'), fired('d'), fired('e', 2000)];
/** Five dry-run fires, all on time: 100% (no confirmation). */
const AT_100 = [fired('a'), fired('b'), fired('c'), fired('d'), fired('e')];

describe('popup exposure section', () => {
  function setupPopup(opts: {
    settings?: Settings;
    snipes?: Snipe[];
    replyWith?: (m: unknown) => unknown;
  } = {}) {
    const m = new FakeMessaging();
    // The fake background keeps the stored settings, merging whole groups like
    // the real settings.set handler, so a reload after a write sees the change.
    const stored = { settings: structuredClone(opts.settings ?? settingsWith(5, 5)) };
    m.handle('settings.get', () => structuredClone(stored.settings));
    m.handle('snipe.list', () => structuredClone(opts.snipes ?? BELOW_95));
    m.handle('settings.set', (patch) => {
      stored.settings = { ...stored.settings, ...structuredClone(patch) };
      return undefined;
    });
    const ports = fakeConnectPort(opts.replyWith);
    render(h(PopupExposureSection, { messaging: m, connectPort: ports.connectPort, now: () => NOW }));
    return { m, ports };
  }

  it('shows the exposure meter, the dry-run progress and the on-time rate', async () => {
    setupPopup();
    expect(await screen.findByTestId('exposure-section')).toBeTruthy();
    expect(screen.getByTestId('bidding-state').getAttribute('data-state')).toBe('dry');
    expect(screen.getByText(/5 of 5 dry-run snipes completed/i)).toBeTruthy();
    expect(screen.getByText(/80% on time/i)).toBeTruthy();
    // R4: the one meter from src/ui/exposure, not a fork.
    expect(screen.getByRole('progressbar', { name: 'Exposure against the daily cap' })).toBeTruthy();
  });

  it('is locked below requiredDryRuns: no go-live control, a plain statement', async () => {
    setupPopup({ settings: settingsWith(3, 5) });
    await screen.findByTestId('exposure-section');
    expect(screen.queryByRole('button', { name: /go live/i })).toBeNull();
    expect(screen.getByText(/2 more dry-run snipes before going live/i)).toBeTruthy();
  });

  it('go live shows the honest copy and the checklist link (R5)', async () => {
    setupPopup();
    fireEvent.click(await screen.findByRole('button', { name: /go live…/i }));
    const copy = await screen.findByText(/real money/i);
    expect(copy.textContent).toContain('$50.00');
    expect(copy.textContent).toContain('$100.00');
    expect(copy.textContent).toContain("ShopGoodwill's terms may forbid automated bidding");
    const link = screen.getByRole('link', { name: /first live snipe checklist/i });
    expect(link.getAttribute('href')).toBe(FIRST_LIVE_CHECKLIST_URL);
  });

  it('with on-time < 95%, going live sends the typed confirmation over the gate port, then settings.set', async () => {
    const { m, ports } = setupPopup();
    fireEvent.click(await screen.findByRole('button', { name: /go live…/i }));
    const input = await screen.findByLabelText(/type go live to confirm/i);
    fireEvent.input(input, { target: { value: 'GO LIVE' } });
    fireEvent.click(screen.getByRole('button', { name: /^go live$/i }));

    await waitFor(() => {
      expect(ports.calls).toHaveLength(1);
    });
    expect(ports.calls[0]?.name).toBe(LIVE_GATE_PORT);
    expect(ports.calls[0]?.messages).toEqual([{ confirmation: 'GO LIVE' }]);

    await waitFor(() => {
      const sends = m.sent.filter((s) => s.type === 'settings.set');
      expect(sends).toHaveLength(1);
      expect(sends[0]?.payload).toEqual({ dryRun: { ...defaultSettings().dryRun, bidding: false } });
    });
    await waitFor(() => {
      expect(screen.getByTestId('bidding-state').getAttribute('data-state')).toBe('live');
    });
  });

  it('a typed confirmation that does not match is not sent: the input is checked exactly (R6)', async () => {
    const { m, ports } = setupPopup();
    fireEvent.click(await screen.findByRole('button', { name: /go live…/i }));
    const input = await screen.findByLabelText(/type go live to confirm/i);
    fireEvent.input(input, { target: { value: 'go live' } });
    fireEvent.click(screen.getByRole('button', { name: /^go live$/i }));
    await screen.findByText(/that is not the confirmation text/i);
    expect(ports.calls).toHaveLength(0);
    expect(m.sent.filter((s) => s.type === 'settings.set')).toHaveLength(0);
  });

  it('a refused confirmation (ok: false) is reported and nothing is written', async () => {
    const { m, ports } = setupPopup({ replyWith: () => ({ ok: false }) });
    fireEvent.click(await screen.findByRole('button', { name: /go live…/i }));
    const input = await screen.findByLabelText(/type go live to confirm/i);
    fireEvent.input(input, { target: { value: GO_LIVE_CONFIRMATION } });
    fireEvent.click(screen.getByRole('button', { name: /^go live$/i }));
    await screen.findByText(/the background did not accept the confirmation/i);
    expect(ports.calls).toHaveLength(1);
    expect(m.sent.filter((s) => s.type === 'settings.set')).toHaveLength(0);
  });

  it('a background veto on settings.set is shown (the gate is the authority)', async () => {
    const m = new FakeMessaging();
    m.handle('settings.get', () => structuredClone(settingsWith(5, 5)));
    m.handle('snipe.list', () => structuredClone(BELOW_95));
    m.handle('settings.set', () => {
      throw new Error('Live bidding stays locked: complete 5 dry-run snipes.');
    });
    const ports = fakeConnectPort();
    render(h(PopupExposureSection, { messaging: m, connectPort: ports.connectPort, now: () => NOW }));
    fireEvent.click(await screen.findByRole('button', { name: /go live…/i }));
    const input = await screen.findByLabelText(/type go live to confirm/i);
    fireEvent.input(input, { target: { value: GO_LIVE_CONFIRMATION } });
    fireEvent.click(screen.getByRole('button', { name: /^go live$/i }));
    await screen.findByText(/complete 5 dry-run snipes/i);
    expect(screen.getByTestId('bidding-state').getAttribute('data-state')).toBe('dry');
  });

  it('at >= 95% no typed confirmation is asked: one click goes live with no port message', async () => {
    const { m, ports } = setupPopup({ snipes: AT_100 });
    fireEvent.click(await screen.findByRole('button', { name: /go live…/i }));
    expect(await screen.findByText(/real money/i)).toBeTruthy();
    expect(screen.queryByLabelText(/type go live to confirm/i)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /^go live$/i }));
    await waitFor(() => {
      expect(m.sent.filter((s) => s.type === 'settings.set')).toHaveLength(1);
    });
    expect(ports.calls).toHaveLength(0);
  });

  it('turning dry-run back on is one click with no confirmation (R2)', async () => {
    const { m, ports } = setupPopup({ settings: settingsWith(5, 5, false), snipes: AT_100 });
    fireEvent.click(await screen.findByRole('button', { name: /dry run again/i }));
    await waitFor(() => {
      expect(m.sent.filter((s) => s.type === 'settings.set')).toHaveLength(1);
    });
    expect(m.sent.filter((s) => s.type === 'settings.set')[0]?.payload).toEqual({ dryRun: { ...defaultSettings().dryRun, bidding: true } });
    expect(ports.calls).toHaveLength(0);
    expect(screen.queryByLabelText(/type go live to confirm/i)).toBeNull();
  });

  it('degrades to a muted notice when the background handlers are missing', async () => {
    const m = new FakeMessaging();
    const ports = fakeConnectPort();
    render(h(PopupExposureSection, { messaging: m, connectPort: ports.connectPort, now: () => NOW }));
    expect(await screen.findByText(/live-bidding status is unavailable/i)).toBeTruthy();
  });
});

describe('dashboard exposure section', () => {
  function setupDashboard(opts: { settings?: Settings; snipes?: Snipe[] } = {}) {
    const m = new FakeMessaging();
    m.handle('settings.get', () => structuredClone(opts.settings ?? settingsWith(5, 5)));
    m.handle('snipe.list', () => structuredClone(opts.snipes ?? BELOW_95));
    render(h(DashboardExposureSection, { client: m, userTz: 'America/New_York', openOptions: () => undefined }));
    return { m };
  }

  it('mounts the one meter with the status, the copy and the checklist link', async () => {
    setupDashboard();
    expect(await screen.findByTestId('exposure-section')).toBeTruthy();
    expect(screen.getByRole('progressbar', { name: 'Exposure against the daily cap' })).toBeTruthy();
    expect(screen.getByTestId('bidding-state').getAttribute('data-state')).toBe('dry');
    expect(screen.getByText(/5 of 5 dry-run snipes completed/i)).toBeTruthy();
    const copy = screen.getByText(/real money/i);
    expect(copy.textContent).toContain('$50.00');
    expect(copy.textContent).toContain('$100.00');
    const link = screen.getByRole('link', { name: /first live snipe checklist/i });
    expect(link.getAttribute('href')).toBe(FIRST_LIVE_CHECKLIST_URL);
  });

  it('shows the live state and no copy once bidding is live', async () => {
    setupDashboard({ settings: settingsWith(5, 5, false), snipes: AT_100 });
    await screen.findByTestId('exposure-section');
    expect(screen.getByTestId('bidding-state').getAttribute('data-state')).toBe('live');
    expect(screen.queryByText(/real money/i)).toBeNull();
  });

  it('degrades to a muted notice when the background handlers are missing', async () => {
    const m = new FakeMessaging();
    render(h(DashboardExposureSection, { client: m, userTz: 'America/New_York', openOptions: () => undefined }));
    expect(await screen.findByText(/live bidding is unavailable/i)).toBeTruthy();
  });
});
