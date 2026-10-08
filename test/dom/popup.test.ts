/* eslint-disable import/no-restricted-paths -- the popup lives under src/entrypoints; its own test is the one importer */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/preact';
import { h } from 'preact';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { defaultSettings } from '../../src/domain/settings/defaults';
import type { Settings } from '../../src/domain/settings/schema';
import { openDashboard, openOptions, type BrowserLike } from '../../src/entrypoints/popup/openers';
import { Popup } from '../../src/entrypoints/popup/Popup';
import { collectSections, type PopupSection, type SectionModule } from '../../src/entrypoints/popup/registry';
import { FakeMessaging } from '../fakes/ports/fake-messaging';

const NOW = Date.UTC(2026, 9, 7, 12, 0, 0);
const DEFAULT_SETTINGS = defaultSettings();

type SessionState = 'ok' | 'expiring' | 'expired' | 'logged-out';

function health(over: Record<string, unknown> = {}) {
  return {
    sgw: { ok: true, checkedAt: NOW, configVersion: '1', checks: [{ name: 'clock' as const, ok: true }] },
    session: NOW + 48 * 3600_000,
    sessionState: 'ok' as SessionState,
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

function actionsMock() {
  return { openDashboard: vi.fn(() => Promise.resolve()), openOptions: vi.fn(() => Promise.resolve()) };
}

function setup(opts: { settings?: Settings; health?: Record<string, unknown>; sections?: PopupSection[] } = {}) {
  const m = new FakeMessaging();
  const settings = opts.settings ?? DEFAULT_SETTINGS;
  m.handle('settings.get', () => settings);
  m.handle('health.get', () => health(opts.health));
  m.handle('kill.set', () => undefined);
  m.handle('settings.set', () => undefined);
  const actions = actionsMock();
  render(h(Popup, { messaging: m, actions, now: () => NOW, sections: opts.sections ?? [] }));
  return { m, actions };
}

afterEach(cleanup);

describe('popup kill switch', () => {
  it('sends kill.set on when the button is pressed', async () => {
    const { m } = setup();
    const btn = await screen.findByRole('button', { name: /kill switch/i });
    fireEvent.click(btn);
    await waitFor(() => { expect(m.sent.filter((s) => s.type === 'kill.set')).toEqual([{ type: 'kill.set', payload: { on: true } }]); },
    );
  });

  it('badge text reflects switches.changed', async () => {
    const { m } = setup();
    const btn = await screen.findByRole('button', { name: /kill switch/i });
    await waitFor(() => { expect(screen.getByTestId('kill-state').textContent).toMatch(/automation on/i); });
    expect(btn.getAttribute('aria-pressed')).toBe('false');
    m.broadcast('switches.changed', { killSwitch: true, writesAllowed: {} });
    await waitFor(() => { expect(screen.getByTestId('kill-state').textContent).toMatch(/stopped/i); });
    expect(btn.getAttribute('aria-pressed')).toBe('true');
    m.broadcast('switches.changed', { killSwitch: false, writesAllowed: {} });
    await waitFor(() => { expect(screen.getByTestId('kill-state').textContent).toMatch(/automation on/i); });
  });

  it('resuming needs the inline confirm; the shortcut is shown', async () => {
    const { m } = setup({ settings: { ...DEFAULT_SETTINGS, killSwitch: true } });
    const btn = await screen.findByRole('button', { name: /kill switch/i });
    await waitFor(() => {
      expect(btn.getAttribute('aria-pressed')).toBe('true');
    });
    fireEvent.click(btn);
    expect(m.sent.filter((s) => s.type === 'kill.set')).toEqual([]);
    expect(screen.getByText(/resume automation\?/i)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Resume' }));
    await waitFor(() => {
      expect(m.sent.at(-1)).toEqual({ type: 'kill.set', payload: { on: false } });
    });
    expect(document.body.textContent).toContain('Alt+Shift+K');
  });

  it('a double activation while stopped does not resume, and focus lands on Keep stopped', async () => {
    const { m } = setup({ settings: { ...DEFAULT_SETTINGS, killSwitch: true } });
    const btn = await screen.findByRole('button', { name: /kill switch/i });
    await waitFor(() => {
      expect(btn.getAttribute('aria-pressed')).toBe('true');
    });
    fireEvent.click(btn);
    fireEvent.click(btn);
    const keep = await screen.findByRole('button', { name: 'Keep stopped' });
    expect(document.activeElement).toBe(keep);
    expect(m.sent.filter((s) => s.type === 'kill.set')).toEqual([]);
    fireEvent.click(keep);
    expect(screen.getByTestId('kill-state').textContent).toMatch(/stopped/i);
    expect(screen.queryByText(/resume automation\?/i)).toBeNull();
    expect(m.sent.filter((s) => s.type === 'kill.set')).toEqual([]);
  });

  it('a broadcast that turns it off closes the confirm', async () => {
    const { m } = setup({ settings: { ...DEFAULT_SETTINGS, killSwitch: true } });
    const btn = await screen.findByRole('button', { name: /kill switch/i });
    await waitFor(() => {
      expect(btn.getAttribute('aria-pressed')).toBe('true');
    });
    fireEvent.click(btn);
    m.broadcast('switches.changed', { killSwitch: false, writesAllowed: {} });
    await waitFor(() => {
      expect(screen.queryByText(/resume automation\?/i)).toBeNull();
    });
  });

  it('unknown state: offers only Stop (sends on:true), never resume; Retry re-syncs', async () => {
    const m = new FakeMessaging();
    let fail = true;
    m.handle('settings.get', () => {
      if (fail) throw new Error('down');
      return { ...DEFAULT_SETTINGS, killSwitch: true };
    });
    m.handle('health.get', () => health());
    m.handle('kill.set', () => undefined);
    render(h(Popup, { messaging: m, actions: actionsMock(), now: () => NOW, sections: [] }));
    await screen.findByRole('alert');
    expect(screen.getByTestId('kill-state').textContent).toMatch(/unknown/i);
    expect(screen.getByText('Stop all automation')).toBeTruthy();
    expect(screen.queryByText(/resume/i)).toBeNull();
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    await waitFor(() => {
      expect(screen.getByTestId('kill-state').textContent).toMatch(/stopped/i);
    });
  });

  it('unknown state: clicking sends kill.set on:true', async () => {
    const m = new FakeMessaging();
    m.handle('settings.get', () => {
      throw new Error('down');
    });
    m.handle('health.get', () => health());
    m.handle('kill.set', () => undefined);
    render(h(Popup, { messaging: m, actions: actionsMock(), now: () => NOW, sections: [] }));
    await screen.findByRole('alert');
    fireEvent.click(screen.getByRole('button', { name: /kill switch/i }));
    await waitFor(() => {
      expect(m.sent.filter((s) => s.type === 'kill.set')).toEqual([{ type: 'kill.set', payload: { on: true } }]);
    });
  });

  function timeoutSetup(initialKill: boolean, afterKill: () => Settings | Promise<Settings>) {
    const m = new FakeMessaging();
    let calls = 0;
    m.handle('settings.get', () => {
      calls += 1;
      return calls === 1 ? { ...DEFAULT_SETTINGS, killSwitch: initialKill } : afterKill();
    });
    m.handle('health.get', () => health());
    m.handle('kill.set', () => new Promise<never>(() => undefined));
    render(h(Popup, { messaging: m, actions: actionsMock(), now: () => NOW, sections: [], timeoutMs: 40 }));
    return m;
  }

  it('kill.set timeout on stop: unknown, then re-synced', async () => {
    timeoutSetup(false, () => ({ ...DEFAULT_SETTINGS, killSwitch: true }));
    const btn = await screen.findByRole('button', { name: /kill switch/i });
    await waitFor(() => {
      expect(screen.getByTestId('kill-state').textContent).toMatch(/automation on/i);
    });
    fireEvent.click(btn);
    expect((await screen.findByRole('alert')).textContent).toMatch(/unconfirmed/i);
    await waitFor(() => {
      expect(screen.getByTestId('kill-state').textContent).toMatch(/stopped/i);
    });
  });

  it('kill.set timeout on resume: never shows STOPPED as certain; failed re-sync stays unknown', async () => {
    const m = new FakeMessaging();
    let calls = 0;
    m.handle('settings.get', () => {
      calls += 1;
      if (calls > 1) throw new Error('down');
      return { ...DEFAULT_SETTINGS, killSwitch: true };
    });
    m.handle('health.get', () => health());
    m.handle('kill.set', () => new Promise<never>(() => undefined));
    render(h(Popup, { messaging: m, actions: actionsMock(), now: () => NOW, sections: [], timeoutMs: 40 }));
    const btn = await screen.findByRole('button', { name: /kill switch/i });
    await waitFor(() => {
      expect(btn.getAttribute('aria-pressed')).toBe('true');
    });
    fireEvent.click(btn);
    fireEvent.click(await screen.findByRole('button', { name: 'Resume' }));
    await waitFor(() => {
      expect(screen.getByTestId('kill-state').textContent).toMatch(/unknown/i);
    });
    expect(screen.getByTestId('kill-state').textContent).not.toMatch(/STOPPED/);
    expect(screen.queryByText(/resume/i)).toBeNull();
    expect(screen.getByText('Stop all automation')).toBeTruthy();
    expect(document.body.textContent).toMatch(/unconfirmed/i);
  });

  it('kill.set timeout on resume that re-syncs shows the true state', async () => {
    timeoutSetup(true, () => ({ ...DEFAULT_SETTINGS, killSwitch: false }));
    const btn = await screen.findByRole('button', { name: /kill switch/i });
    await waitFor(() => {
      expect(btn.getAttribute('aria-pressed')).toBe('true');
    });
    fireEvent.click(btn);
    fireEvent.click(await screen.findByRole('button', { name: 'Resume' }));
    await waitFor(() => {
      expect(screen.getByTestId('kill-state').textContent).toMatch(/automation on/i);
    });
  });

  it('a broadcast during a reload is not overwritten by the stale read', async () => {
    const m = new FakeMessaging();
    let calls = 0;
    let release: (s: Settings) => void = () => undefined;
    m.handle('settings.get', () => {
      calls += 1;
      if (calls === 1) throw new Error('down');
      return new Promise<Settings>((resolve) => {
        release = resolve;
      });
    });
    m.handle('health.get', () => health());
    render(h(Popup, { messaging: m, actions: actionsMock(), now: () => NOW, sections: [] }));
    await screen.findByRole('alert');
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    await waitFor(() => {
      expect(calls).toBe(2);
    });
    m.broadcast('switches.changed', { killSwitch: true, writesAllowed: {} });
    release({ ...DEFAULT_SETTINGS, killSwitch: false }); // read taken before the broadcast
    await screen.findByTestId('budget'); // the reload has finished
    expect(screen.getByTestId('kill-state').textContent).toMatch(/stopped/i);
  });

  it('an unresponsive background times out with Retry', async () => {
    const m = new FakeMessaging();
    m.handle('settings.get', () => new Promise<never>(() => undefined));
    m.handle('health.get', () => new Promise<never>(() => undefined));
    render(h(Popup, { messaging: m, actions: actionsMock(), now: () => NOW, sections: [], timeoutMs: 30 }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/not responding/i);
    expect(screen.getByRole('button', { name: /retry/i })).toBeTruthy();
  });

  it('shows an error when kill.set fails', async () => {
    const m = new FakeMessaging();
    m.handle('settings.get', () => DEFAULT_SETTINGS);
    m.handle('health.get', () => health());
    m.handle('kill.set', () => {
      throw new Error('boom');
    });
    render(h(Popup, { messaging: m, actions: actionsMock(), now: () => NOW, sections: [] }));
    fireEvent.click(await screen.findByRole('button', { name: /kill switch/i }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/kill switch/i);
  });
});

describe('popup status', () => {
  it('shows dry-run badges for each automation', async () => {
    setup();
    const group = await screen.findByRole('group', { name: /dry-run/i });
    expect(within(group).getAllByText(/dry run/i).length).toBe(3);
  });

  it('shows LIVE when dry-run is off', async () => {
    setup({ settings: { ...DEFAULT_SETTINGS, dryRun: { favorites: false, calendar: true, bidding: true } } });
    const group = await screen.findByRole('group', { name: /dry-run/i });
    expect(within(group).getAllByText(/live/i).length).toBe(1);
  });

  it.each([
    ['ok', /signed in/i, '✓'],
    ['expiring', /expiring/i, '!'],
    ['logged-out', /logged out/i, '✕'],
  ] as const)('session %s has text and a symbol', async (state, text, symbol) => {
    setup({ health: { sessionState: state } });
    await waitFor(() => {
      expect(screen.getByTestId('session-state').textContent).toMatch(text);
    });
    const el = screen.getByTestId('session-state');
    expect(el.textContent).toContain(symbol);
    expect(el.getAttribute('data-state')).toBe(state);
  });

  it('shows failing health checks and budget', async () => {
    setup({
      health: { sgw: { ok: false, checkedAt: NOW, configVersion: '1', checks: [{ name: 'clock', ok: false }] } },
    });
    await waitFor(() => { expect(screen.getByTestId('health').textContent).toMatch(/1 check failing/i); });
    expect(screen.getByTestId('budget').textContent).toContain('12 / 120');
  });

  it('reports an unreachable background with retry', async () => {
    const m = new FakeMessaging();
    render(h(Popup, { messaging: m, actions: actionsMock(), now: () => NOW, sections: [] }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/background/i);
    expect(screen.getByRole('button', { name: /retry/i })).toBeTruthy();
  });
});

describe('popup controls', () => {
  it('overlay toggle sends the full overlay object', async () => {
    const { m } = setup();
    const box = await screen.findByRole('checkbox', { name: /overlay/i });
    await waitFor(() => { expect((box as HTMLInputElement).checked).toBe(true); });
    fireEvent.click(box);
    await waitFor(() => { expect(m.sent.at(-1)).toEqual({
        type: 'settings.set',
        payload: { overlay: { ...DEFAULT_SETTINGS.overlay, enabled: false } },
      }); },
    );
  });

  it('dashboard and options buttons call the actions', async () => {
    const { actions } = setup();
    fireEvent.click(await screen.findByRole('button', { name: /open dashboard/i }));
    fireEvent.click(screen.getByRole('button', { name: /open options/i }));
    expect(actions.openDashboard).toHaveBeenCalledTimes(1);
    expect(actions.openOptions).toHaveBeenCalledTimes(1);
  });

  it('renders registered sections in order', async () => {
    const mk = (id: string, order: number): PopupSection => ({
      id,
      order,
      Component: () => h('p', null, `section ${id}`),
    });
    setup({ sections: [mk('a', 1), mk('b', 2)] });
    const texts = (await screen.findAllByText(/^section /)).map((e) => e.textContent);
    expect(texts).toEqual(['section a', 'section b']);
  });
});

describe('registry', () => {
  const comp = () => null;
  it('sorts by order then id and skips modules without a section', () => {
    const mods: Record<string, SectionModule> = {
      './sections/z/index.tsx': { section: { id: 'z', order: 1, Component: comp } },
      './sections/a/index.tsx': { section: { id: 'a', order: 1, Component: comp } },
      './sections/m/index.tsx': { section: { id: 'm', order: 0, Component: comp } },
      './sections/bad/index.tsx': {},
    };
    expect(collectSections(mods).map((s) => s.id)).toEqual(['m', 'a', 'z']);
  });
  it('rejects duplicate ids', () => {
    const mods: Record<string, SectionModule> = {
      './sections/x/index.tsx': { section: { id: 'x', order: 1, Component: comp } },
      './sections/y/index.tsx': { section: { id: 'x', order: 2, Component: comp } },
    };
    expect(() => collectSections(mods)).toThrow(/duplicate/i);
  });
});

describe('openers', () => {
  it('chrome: opens the side panel for the window', async () => {
    const open = vi.fn(() => Promise.resolve());
    const b: BrowserLike = { sidePanel: { open } };
    await openDashboard(b, 7);
    expect(open).toHaveBeenCalledWith({ windowId: 7 });
  });
  it('firefox: opens the sidebar', async () => {
    const open = vi.fn(() => Promise.resolve());
    await openDashboard({ sidebarAction: { open } }, undefined);
    expect(open).toHaveBeenCalled();
  });
  it('throws a clear error when neither exists', async () => {
    await expect(openDashboard({}, undefined)).rejects.toThrow(/dashboard/i);
    await expect(openOptions({})).rejects.toThrow(/options/i);
  });
  it('options uses runtime.openOptionsPage', async () => {
    const openOptionsPage = vi.fn(() => Promise.resolve());
    await openOptions({ runtime: { openOptionsPage } });
    expect(openOptionsPage).toHaveBeenCalled();
  });
});
