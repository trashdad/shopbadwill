// @vitest-environment happy-dom
// T-86 (R5): the popup kill section component (src/entrypoints/popup/sections/kill/**):
// the Kill / Resume toggle that sends `kill.set`, the confirm step before
// resuming, and the last auto-kill reasons rendered as text only.
//
// This file runs under happy-dom for the DOM renderer; it imports no `node:*`
// module (the background half of T-86 lives in kill.test.ts, node environment).
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { h } from 'preact';
import { afterEach, describe, expect, it } from 'vitest';

import type { AuditEntry } from '../../src/domain/audit/types';
import { defaultSettings } from '../../src/domain/settings/defaults';
import type { Settings } from '../../src/domain/settings/schema';
import { KILL_SNIPE_SENT_KIND } from '../../src/background/jobs/kill-disarm';
import { KillSection } from '../../src/entrypoints/popup/sections/kill/index';
import { FakeMessaging } from '../fakes/ports/fake-messaging';

const T0 = Date.UTC(2026, 9, 10, 15, 0, 0);

function settingsWith(killSwitch: boolean): Settings {
  return { ...defaultSettings(), killSwitch };
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
  kind: KILL_SNIPE_SENT_KIND,
  ref: 's1',
  details: { note: 'kill: snipe s1 already sent; outcome pending' },
};
const unrelated: AuditEntry = { seq: 1, at: T0 - 180_000, actor: 'user', kind: 'kill.on', details: { source: 'kill.set' } };

function setupSection(opts: { killSwitch?: boolean; audit?: AuditEntry[] } = {}) {
  const m = new FakeMessaging();
  m.handle('settings.get', () => settingsWith(opts.killSwitch ?? false));
  m.handle('kill.set', () => undefined);
  m.handle('audit.list', () => opts.audit ?? []);
  render(h(KillSection, { messaging: m }));
  return { m };
}

afterEach(cleanup);

describe('popup kill section (R5)', () => {
  it('kill off: one click sends kill.set on', async () => {
    const { m } = setupSection();
    const btn = await screen.findByRole('button', { name: /stop all automation/i });
    expect(btn.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(btn);
    await waitFor(() => {
      expect(m.sent.filter((s) => s.type === 'kill.set')).toEqual([{ type: 'kill.set', payload: { on: true } }]);
    });
    await waitFor(() => {
      expect(screen.getByTestId('kill-section-state').textContent).toMatch(/on/i);
    });
  });

  it('kill on: resume needs the confirm step; Keep stopped sends nothing', async () => {
    const { m } = setupSection({ killSwitch: true });
    const btn = await screen.findByRole('button', { name: /resume automation/i });
    expect(btn.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(btn);
    expect(m.sent.filter((s) => s.type === 'kill.set')).toEqual([]);
    expect(screen.getByText(/resume automation\?/i)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Keep stopped' }));
    expect(screen.queryByText(/resume automation\?/i)).toBeNull();
    expect(m.sent.filter((s) => s.type === 'kill.set')).toEqual([]);
  });

  it('kill on: the confirmed resume sends kill.set off', async () => {
    const { m } = setupSection({ killSwitch: true });
    fireEvent.click(await screen.findByRole('button', { name: /resume automation/i }));
    fireEvent.click(await screen.findByRole('button', { name: 'Resume' }));
    await waitFor(() => {
      expect(m.sent.filter((s) => s.type === 'kill.set')).toEqual([{ type: 'kill.set', payload: { on: false } }]);
    });
    await waitFor(() => {
      expect(screen.getByTestId('kill-section-state').textContent).toMatch(/off/i);
    });
  });

  it('a broadcast that turns kill off closes the confirm', async () => {
    const { m } = setupSection({ killSwitch: true });
    fireEvent.click(await screen.findByRole('button', { name: /resume automation/i }));
    expect(screen.getByText(/resume automation\?/i)).toBeTruthy();
    m.broadcast('switches.changed', { killSwitch: false, writesAllowed: {} });
    await waitFor(() => {
      expect(screen.queryByText(/resume automation\?/i)).toBeNull();
    });
    await waitFor(() => {
      expect(screen.getByTestId('kill-section-state').textContent).toMatch(/off/i);
    });
  });

  it('renders the last auto-kill reasons as text only', async () => {
    setupSection({ audit: [disarmKill, disarmAnomaly, sentRefusal, unrelated] });
    const box = await screen.findByTestId('kill-section-reasons');
    const text = box.textContent;
    expect(text).toContain('Kill switch a1: stopped before it could bid');
    expect(text).toContain('Auto-stopped a2: three reads in a row failed');
    expect(text).toContain('kill: snipe s1 already sent; outcome pending');
    expect(text).not.toContain('kill.on');
    // Text only: no markup came from the audit data.
    expect(box.querySelectorAll('script, img, a').length).toBe(0);
  });

  it('reloads the reasons after a successful kill.set', async () => {
    const m = new FakeMessaging();
    m.handle('settings.get', () => settingsWith(false));
    m.handle('kill.set', () => undefined);
    let calls = 0;
    m.handle('audit.list', () => (calls++ === 0 ? [] : [sentRefusal]));
    render(h(KillSection, { messaging: m }));
    fireEvent.click(await screen.findByRole('button', { name: /stop all automation/i }));
    await waitFor(() => {
      expect(screen.getByTestId('kill-section-reasons').textContent).toContain('already sent; outcome pending');
    });
    expect(m.sent.filter((s) => s.type === 'audit.list').length).toBeGreaterThanOrEqual(2);
  });

  it('shows an error when kill.set fails and keeps the state', async () => {
    const m = new FakeMessaging();
    m.handle('settings.get', () => settingsWith(false));
    m.handle('kill.set', () => {
      throw new Error('boom');
    });
    m.handle('audit.list', () => []);
    render(h(KillSection, { messaging: m }));
    fireEvent.click(await screen.findByRole('button', { name: /stop all automation/i }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/boom/);
    await waitFor(() => {
      expect(screen.getByTestId('kill-section-state').textContent).toMatch(/off/i);
    });
  });
});
