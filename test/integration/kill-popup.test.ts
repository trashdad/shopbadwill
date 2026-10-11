// @vitest-environment happy-dom
// T-86 popup (ruling: one kill control). The shell's switch in Popup.tsx is the
// only kill control: kill ON is one click, kill OFF asks before it resumes.
// sections/kill renders the auto-kill reasons as text and sends nothing.
//
// happy-dom, and no `node:*` import: the background half lives in kill.test.ts.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { h } from 'preact';
import { afterEach, describe, expect, it } from 'vitest';

import type { AuditEntry } from '../../src/domain/audit/types';
import { defaultSettings } from '../../src/domain/settings/defaults';
import type { Settings } from '../../src/domain/settings/schema';
import { Popup } from '../../src/entrypoints/popup/Popup';
import { loadSections } from '../../src/entrypoints/popup/registry';
import { KillSection } from '../../src/entrypoints/popup/sections/kill/index';
import { MSG_SENDER } from '../../src/messaging/protocol';
import { FakeMessaging } from '../fakes/ports/fake-messaging';

const T0 = Date.UTC(2026, 9, 10, 15, 0, 0);

function settingsWith(killSwitch: boolean): Settings {
  return { ...defaultSettings(), killSwitch };
}

function health() {
  return {
    sgw: { ok: true, checkedAt: T0, configVersion: '1', checks: [{ name: 'clock' as const, ok: true }] },
    session: T0 + 48 * 3600_000,
    sessionState: 'ok' as const,
    google: { connected: false, provider: 'none' as const, grantedScopes: [], needsInteraction: false, configured: false },
    budget: {
      lanes: {
        interactive: { usedToday: 0, budget: 300, nextAllowedAt: 0 },
        background: { usedToday: 0, budget: 120, nextAllowedAt: 0 },
        snipe: { usedToday: 0, budget: 80, nextAllowedAt: 0 },
        canary: { usedToday: 0, budget: 4, nextAllowedAt: 0 },
      },
      cacheHits: 0,
    },
  };
}

const disarmKill: AuditEntry = {
  seq: 4,
  at: T0,
  actor: 'snipe',
  kind: 'snipe.disarm',
  itemId: 710000004,
  ref: 'a1',
  details: { event: 'disarm', from: 'armed', to: 'killed', outcome: 'killed', by: 'kill', why: 'stopped before it could bid' },
};
const disarmAnomaly: AuditEntry = {
  seq: 3,
  at: T0 - 60_000,
  actor: 'snipe',
  kind: 'snipe.disarm',
  itemId: 710000003,
  ref: 'a2',
  details: { event: 'disarm', from: 'waking', to: 'killed', outcome: 'killed', by: 'anomaly', why: 'three reads in a row failed' },
};
const sentRefusal: AuditEntry = {
  seq: 2,
  at: T0 - 120_000,
  actor: 'system',
  kind: 'kill.snipe-sent',
  ref: 's1',
  details: { note: 'kill: snipe s1 already sent; outcome pending' },
};
const markupReason: AuditEntry = {
  seq: 5,
  at: T0 + 1_000,
  actor: 'snipe',
  kind: 'snipe.disarm',
  ref: 'x1',
  details: { by: 'kill', why: '<img src=x onerror=alert(1)><script>bad()</script><a href="https://evil.example">go</a>' },
};
const unrelated: AuditEntry = { seq: 1, at: T0 - 180_000, actor: 'user', kind: 'kill.on', details: { source: 'kill.set' } };

function setupSection(audit: AuditEntry[] = []) {
  const m = new FakeMessaging();
  m.handle('audit.list', () => audit);
  render(h(KillSection, { messaging: m }));
  return { m };
}

function setupPopup(killSwitch: boolean) {
  const m = new FakeMessaging();
  m.handle('settings.get', () => settingsWith(killSwitch));
  m.handle('health.get', () => health());
  m.handle('kill.set', () => undefined);
  m.handle('audit.list', () => [disarmKill]);
  const sections = loadSections();
  render(
    h(Popup, {
      messaging: m,
      actions: { openDashboard: () => Promise.resolve(), openOptions: () => Promise.resolve() },
      now: () => T0,
      sections,
    }),
  );
  return { m, sections };
}

function killPresses(name: RegExp): HTMLElement[] {
  return screen.getAllByRole('button', { name });
}

afterEach(cleanup);

describe('one kill control (the shell switch)', () => {
  it('registers a single kill section and renders no second toggle', async () => {
    const { sections } = setupPopup(false);
    expect(sections.map((s) => s.id)).toEqual(['kill']);
    const stop = await screen.findByRole('button', { name: /stop all automation/i });
    await waitFor(() => {
      expect(stop.getAttribute('aria-pressed')).toBe('false');
    });
    // A second Stop / Resume button is a second kill control.
    expect(killPresses(/stop all automation/i)).toHaveLength(1);
    expect(screen.getByTestId('kill-section').querySelectorAll('button')).toHaveLength(0);
    expect(screen.getAllByRole('region', { name: /kill switch/i })).toHaveLength(1);
  });

  it('kill off: one click sends kill.set { on: true } and does not ask first', async () => {
    const { m } = setupPopup(false);
    const stop = await screen.findByRole('button', { name: /stop all automation/i });
    await waitFor(() => {
      expect(stop.getAttribute('aria-pressed')).toBe('false');
    });
    expect(screen.queryByRole('group', { name: 'Confirm resume' })).toBeNull();
    fireEvent.click(stop);
    expect(screen.queryByRole('group', { name: 'Confirm resume' })).toBeNull();
    await waitFor(() => {
      expect(m.sent.filter((s) => s.type === 'kill.set')).toEqual([{ type: 'kill.set', payload: { on: true } }]);
    });
    // kill.set is a ui message (content scripts are refused by the router).
    expect(MSG_SENDER['kill.set']).toBe('ui');
    expect(screen.getByTestId('kill-section').querySelectorAll('button')).toHaveLength(0);
  });

  it('kill on: resume asks first; Keep stopped sends nothing; Resume sends kill.set { on: false }', async () => {
    const { m } = setupPopup(true);
    const resume = await screen.findByRole('button', { name: /resume automation/i });
    await waitFor(() => {
      expect(resume.getAttribute('aria-pressed')).toBe('true');
    });
    expect(killPresses(/resume automation/i)).toHaveLength(1);

    fireEvent.click(resume);
    expect(m.sent.filter((s) => s.type === 'kill.set')).toEqual([]);
    expect(screen.getByRole('group', { name: 'Confirm resume' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Keep stopped' }));
    expect(screen.queryByRole('group', { name: 'Confirm resume' })).toBeNull();
    expect(m.sent.filter((s) => s.type === 'kill.set')).toEqual([]);
    expect(screen.getByTestId('kill-state').textContent).toMatch(/stopped/i);

    fireEvent.click(screen.getByRole('button', { name: /resume automation/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Resume' }));
    await waitFor(() => {
      expect(m.sent.filter((s) => s.type === 'kill.set')).toEqual([{ type: 'kill.set', payload: { on: false } }]);
    });
    expect(MSG_SENDER['kill.set']).toBe('ui');
    await waitFor(() => {
      expect(screen.getByTestId('kill-state').textContent).toMatch(/automation on/i);
    });
  });
});

describe('auto-kill reasons (text only)', () => {
  it('renders the last auto-kill reasons as text, including markup from the audit log', async () => {
    setupSection([markupReason, disarmKill, disarmAnomaly, sentRefusal, unrelated]);
    const box = await screen.findByTestId('kill-section-reasons');
    const text = box.textContent;
    // The list keeps the three newest lines (KILL_REASON_LIMIT). Markup stays text.
    expect(text).toContain('Kill switch x1: <img src=x onerror=alert(1)><script>bad()</script><a href="https://evil.example">go</a>');
    expect(text).toContain('Kill switch a1: stopped before it could bid');
    expect(text).toContain('Auto-stopped a2: three reads in a row failed');
    expect(text).not.toContain('already sent');
    expect(text).not.toContain('kill.on');
    // Parsed markup would create elements. Text nodes have no element children.
    const items = [...box.querySelectorAll('li')];
    expect(items.length).toBeGreaterThan(0);
    for (const li of items) expect(li.children).toHaveLength(0);
    expect(box.querySelector('script, img, a')).toBeNull();
  });

  it('lists a disarm the kill switch could not complete, so the user knows a snipe may still be armed', async () => {
    const failed: AuditEntry = { seq: 9, at: T0, actor: 'system', kind: 'kill.disarm-failed', ref: 's9', details: { why: 'storage write failed' } };
    setupSection([failed, unrelated]);
    const box = await screen.findByTestId('kill-section-reasons');
    await waitFor(() => {
      expect(box.textContent).toContain('Kill switch could not stop s9: storage write failed (retrying)');
    });
  });

  it('sends no kill.set, and reloads the list when the switch changes', async () => {
    const m = new FakeMessaging();
    let calls = 0;
    m.handle('audit.list', () => (calls++ === 0 ? [] : [sentRefusal]));
    render(h(KillSection, { messaging: m }));
    const box = await screen.findByTestId('kill-section-reasons');
    await waitFor(() => {
      expect(box.textContent).toMatch(/none yet/i);
    });
    expect(box.querySelectorAll('button')).toHaveLength(0);
    m.broadcast('switches.changed', { killSwitch: true, writesAllowed: {} });
    await waitFor(() => {
      expect(box.textContent).toContain('already sent; outcome pending');
    });
    expect(m.sent.filter((s) => s.type === 'kill.set')).toEqual([]);
    expect(m.sent.filter((s) => s.type === 'audit.list').length).toBeGreaterThanOrEqual(2);
  });
});
