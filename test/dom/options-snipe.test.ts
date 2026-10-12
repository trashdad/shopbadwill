// T-91: the snipe options section. R5: enable, tier (T0/T1/T2), spending caps
// in cents via the money module, the default lead clamped to 6–15 s, the
// default fallback, and the OS power guidance link. The `background` and
// `power` permissions are requested ONLY inside the click handler through
// src/ui/permissions.ts (I-21), and Firefox hides the T1 controls. R6: this
// section never touches the bidding dry-run switch or the dry-run counters,
// and says so plainly. R7: text only, no innerHTML.
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { h } from 'preact';
import { afterEach, describe, expect, it } from 'vitest';

import { defaultSettings } from '../../src/domain/settings/defaults';
import type { Settings } from '../../src/domain/settings/schema';
import { loadSections } from '../../src/entrypoints/options/registry';
import { section, SnipeSection } from '../../src/entrypoints/options/sections/snipe';
import { FakeMessaging } from '../fakes/ports/fake-messaging';
import { FakePermissions } from '../fakes/ports/fake-permissions';

afterEach(cleanup);

function app(opts: { settings?: Settings; firefox?: boolean; permissions?: FakePermissions } = {}) {
  const fake = new FakeMessaging();
  const saved: Array<Record<string, unknown>> = [];
  fake.handle('settings.get', () => opts.settings ?? defaultSettings());
  fake.handle('settings.set', (p) => {
    saved.push(p);
    return undefined;
  });
  const permissions = opts.permissions ?? new FakePermissions();
  render(h(SnipeSection, { client: fake, permissions, firefox: opts.firefox }));
  return { saved, permissions };
}

describe('SnipeSection', () => {
  it('registers as a valid section', () => {
    expect(loadSections({ './snipe/index.tsx': { section } })).toHaveLength(1);
  });

  it('asks for the background and power permissions only from the click handler, never on load (I-21)', async () => {
    const { permissions } = app();
    await screen.findByRole('button', { name: 'Turn on Keep awake' });
    expect(permissions.requested).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'Turn on Keep awake' }));
    await screen.findByText('Keep awake is on: Chrome may keep the computer awake and start at login.');
    expect(permissions.requested).toEqual([{ permissions: ['background', 'power'] }]);
  });

  it('requests the permissions synchronously in the click, before any await', async () => {
    const permissions = new FakePermissions();
    const orig = permissions.request.bind(permissions);
    let duringClick = false;
    permissions.request = (p) => {
      expect(duringClick).toBe(true);
      return orig(p);
    };
    app({ permissions });
    await screen.findByRole('button', { name: 'Turn on Keep awake' });
    expect(permissions.requested).toEqual([]);
    duringClick = true;
    fireEvent.click(screen.getByRole('button', { name: 'Turn on Keep awake' }));
    duringClick = false;
    expect(permissions.requested).toEqual([{ permissions: ['background', 'power'] }]);
  });

  it('says so when the browser declines, and keeps the button', async () => {
    const permissions = new FakePermissions();
    permissions.grantRequests = false;
    app({ permissions });
    fireEvent.click(await screen.findByRole('button', { name: 'Turn on Keep awake' }));
    await screen.findByText(/did not allow/);
    expect(screen.queryByRole('button', { name: 'Turn on Keep awake' })).not.toBeNull();
  });

  it('shows keep-awake as on when the permissions are already granted', async () => {
    app({ permissions: new FakePermissions({ permissions: ['power', 'background'] }) });
    await screen.findByText(/Keep awake is on/);
    expect(screen.queryByRole('button', { name: 'Turn on Keep awake' })).toBeNull();
  });

  it('Firefox hides the T1 controls', async () => {
    const { permissions } = app({ firefox: true });
    await screen.findByRole('radio', { name: /T0 · Extension only/ });
    expect(screen.queryByRole('radio', { name: /T1/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Turn on Keep awake' })).toBeNull();
    expect(screen.getByRole('radio', { name: /T2 · Wake the computer/ })).not.toBeNull();
    expect(permissions.requested).toEqual([]);
  });

  it('shows the T1 controls on Chrome', async () => {
    app({ firefox: false });
    await screen.findByRole('button', { name: 'Turn on Keep awake' });
    expect(screen.getByRole('radio', { name: /T1/ })).not.toBeNull();
  });

  it('saves the spending caps as cents through the money module, keeping the other cap fields', async () => {
    const { saved } = app({ settings: defaultSettings() });
    fireEvent.input(await screen.findByLabelText('Per item (USD)'), { target: { value: '50' } });
    fireEvent.input(screen.getByLabelText('Per day (USD)'), { target: { value: '100' } });
    fireEvent.input(screen.getByLabelText('Open exposure (USD)'), { target: { value: '200' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save caps' }));
    await waitFor(() => {
      expect(saved).toHaveLength(1);
    });
    expect(saved[0]).toMatchObject({
      snipe: {
        caps: { perItemMax: 5000, perDayMax: 10000, openExposureMax: 20000, typoMultiplier: 3, typoAbsolute: 2500 },
      },
    });
  });

  it('parses caps through the money module, including grouped dollars and a single decimal', async () => {
    const { saved } = app({ settings: defaultSettings() });
    fireEvent.input(await screen.findByLabelText('Per item (USD)'), { target: { value: '$1,299.50' } });
    fireEvent.input(screen.getByLabelText('Per day (USD)'), { target: { value: '12.5' } });
    fireEvent.input(screen.getByLabelText('Open exposure (USD)'), { target: { value: '0' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save caps' }));
    await waitFor(() => {
      expect(saved).toHaveLength(1);
    });
    expect(saved[0]).toMatchObject({
      snipe: {
        caps: { perItemMax: 129950, perDayMax: 1250, openExposureMax: 0, typoMultiplier: 3, typoAbsolute: 2500 },
      },
    });
  });

  it('rejects a three-decimal cap without saving', async () => {
    const { saved } = app({ settings: defaultSettings() });
    fireEvent.input(await screen.findByLabelText('Per item (USD)'), { target: { value: '12.999' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save caps' }));
    await screen.findByText(/Enter each cap in dollars/);
    expect(saved).toHaveLength(0);
  });

  it('rejects a malformed cap amount without saving', async () => {
    const { saved } = app({ settings: defaultSettings() });
    fireEvent.input(await screen.findByLabelText('Per item (USD)'), { target: { value: 'abc' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save caps' }));
    await screen.findByText(/Enter each cap in dollars/);
    expect(saved).toHaveLength(0);
  });

  it('clamps the default lead to 6–15 s and rejects non-numbers', async () => {
    const { saved } = app({ settings: defaultSettings() });
    const lead = await screen.findByLabelText('Default lead (seconds)');
    fireEvent.input(lead, { target: { value: '20' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save timing' }));
    await waitFor(() => {
      expect(saved).toHaveLength(1);
    });
    expect(saved[0]).toMatchObject({ snipe: { defaultLeadMs: 15000 } });
    expect(lead).toHaveProperty('value', '15');

    fireEvent.input(lead, { target: { value: '3' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save timing' }));
    await waitFor(() => {
      expect(saved).toHaveLength(2);
    });
    expect(saved[1]).toMatchObject({ snipe: { defaultLeadMs: 6000 } });

    fireEvent.input(lead, { target: { value: 'abc' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save timing' }));
    await screen.findByText(/whole number of seconds/);
    expect(saved).toHaveLength(2);

    fireEvent.input(lead, { target: { value: '6' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save timing' }));
    await waitFor(() => {
      expect(saved).toHaveLength(3);
    });
    expect(saved[2]).toMatchObject({ snipe: { defaultLeadMs: 6000 } });

    fireEvent.input(lead, { target: { value: '15' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save timing' }));
    await waitFor(() => {
      expect(saved).toHaveLength(4);
    });
    expect(saved[3]).toMatchObject({ snipe: { defaultLeadMs: 15000 } });
  });

  it('saves the default fallback', async () => {
    const { saved } = app({ settings: defaultSettings() });
    fireEvent.change(await screen.findByLabelText('Default fallback'), { target: { value: 'skip' } });
    await waitFor(() => {
      expect(saved).toHaveLength(1);
    });
    expect(saved[0]).toMatchObject({ snipe: { defaultFallback: 'skip' } });
  });

  it('saves the tier from the radio group', async () => {
    const { saved } = app({ settings: defaultSettings() });
    fireEvent.click(await screen.findByRole('radio', { name: /T2 · Wake the computer/ }));
    await waitFor(() => {
      expect(saved).toHaveLength(1);
    });
    expect(saved[0]).toMatchObject({ snipe: { tier: 'T2' } });
  });

  it('enables sniping and keeps the dry-run fields untouched (R6)', async () => {
    const { saved } = app({ settings: defaultSettings() });
    fireEvent.click(await screen.findByLabelText('Sniping'));
    await waitFor(() => {
      expect(saved).toHaveLength(1);
    });
    const snipeGroup = saved[0]?.['snipe'] as Record<string, unknown>;
    expect(snipeGroup['enabled']).toBe(true);
    expect(snipeGroup['requiredDryRuns']).toBe(5);
    expect(snipeGroup['completedDryRuns']).toBe(0);
    expect(saved[0]).not.toHaveProperty('dryRun');
  });

  it('sends the current dry-run counts, never a stale copy, and cannot roll completedDryRuns back (T-90)', async () => {
    const loaded = defaultSettings();
    loaded.snipe.completedDryRuns = 2;
    loaded.snipe.requiredDryRuns = 9;
    loaded.dryRun.bidding = true;
    let stored = structuredClone(loaded);
    const fake = new FakeMessaging();
    const saved: Array<Record<string, unknown>> = [];
    fake.handle('settings.get', () => structuredClone(stored));
    fake.handle('settings.set', (p) => {
      saved.push(p);
      if (p.snipe !== undefined) {
        // settings.set (T-90) keeps the counter the dry-run job owns.
        stored = { ...stored, snipe: { ...p.snipe, completedDryRuns: stored.snipe.completedDryRuns } };
      }
      return undefined;
    });
    render(h(SnipeSection, { client: fake, permissions: new FakePermissions(), firefox: false }));
    await screen.findByLabelText('Sniping');
    stored = { ...stored, snipe: { ...stored.snipe, completedDryRuns: 6 } };
    fireEvent.click(screen.getByLabelText('Sniping'));
    await waitFor(() => {
      expect(saved).toHaveLength(1);
    });
    const group = saved[0]?.['snipe'] as Record<string, unknown>;
    expect(group['enabled']).toBe(true);
    expect(group['completedDryRuns']).toBe(6); // read fresh at save time, not the 2 this page loaded
    expect(group['requiredDryRuns']).toBe(9);
    expect(saved[0]).not.toHaveProperty('dryRun');
    expect(stored.snipe.completedDryRuns).toBe(6);
    expect(stored.snipe.enabled).toBe(true);
    expect(stored.dryRun.bidding).toBe(true);
  });

  it('builds each save on a fresh read: a change made elsewhere after load is never rolled back', async () => {
    let stored = defaultSettings();
    const fake = new FakeMessaging();
    const saved: Array<Partial<Settings>> = [];
    fake.handle('settings.get', () => structuredClone(stored));
    fake.handle('settings.set', (p) => {
      saved.push(p);
      if (p.snipe !== undefined) stored = { ...stored, snipe: { ...p.snipe, completedDryRuns: stored.snipe.completedDryRuns } };
      return undefined;
    });
    render(h(SnipeSection, { client: fake, permissions: new FakePermissions(), firefox: false }));
    await screen.findByRole('radio', { name: /T2 · Wake the computer/ });

    // After this page loaded: the dashboard applied a lead, the dry-run gate
    // changed, a typo-cap field moved. This page shows none of them.
    stored = {
      ...stored,
      snipe: {
        ...stored.snipe,
        defaultLeadMs: 12000,
        requiredDryRuns: 7,
        caps: { ...stored.snipe.caps, typoAbsolute: 9999 },
      },
    };

    fireEvent.click(screen.getByRole('radio', { name: /T2 · Wake the computer/ }));
    await waitFor(() => {
      expect(saved).toHaveLength(1);
    });
    expect(saved[0]?.snipe).toMatchObject({ tier: 'T2', defaultLeadMs: 12000, requiredDryRuns: 7 });
    expect(saved[0]?.snipe?.caps.typoAbsolute).toBe(9999);

    fireEvent.input(screen.getByLabelText('Per item (USD)'), { target: { value: '60' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save caps' }));
    await waitFor(() => {
      expect(saved).toHaveLength(2);
    });
    expect(saved[1]?.snipe).toMatchObject({ tier: 'T2', defaultLeadMs: 12000, requiredDryRuns: 7 });
    expect(saved[1]?.snipe?.caps).toMatchObject({ perItemMax: 6000, typoAbsolute: 9999 });
    expect(saved.every((p) => Object.keys(p).join() === 'snipe')).toBe(true);
  });

  it('puts the change back and says so when the save fails', async () => {
    const fake = new FakeMessaging();
    fake.handle('settings.get', () => defaultSettings());
    fake.handle('settings.set', () => {
      throw new Error('storage full');
    });
    render(h(SnipeSection, { client: fake, permissions: new FakePermissions(), firefox: false }));
    const t2 = await screen.findByRole('radio', { name: /T2 · Wake the computer/ });
    fireEvent.click(t2);
    await screen.findByText(/Could not save tier T2/);
    expect(screen.getByRole('radio', { name: /T0 · Extension only/ })).toHaveProperty('checked', true);
  });

  it('says plainly that sniping stays in dry-run mode while bidding is in dry-run (R6)', async () => {
    const s = defaultSettings();
    const { saved } = app({
      settings: { ...s, snipe: { ...s.snipe, enabled: true } },
    });
    await screen.findByText(/dry-run mode: snipes do not place real bids/);
    fireEvent.click(screen.getByLabelText('Sniping'));
    await waitFor(() => {
      expect(saved).toHaveLength(1);
    });
    const snipeGroup = saved[0]?.['snipe'] as Record<string, unknown>;
    expect(snipeGroup['enabled']).toBe(false);
    expect(snipeGroup['requiredDryRuns']).toBe(5);
  });

  it('does not say snipes stay dry-run when bidding dry-run is off, or when sniping is off', async () => {
    const live = defaultSettings();
    live.snipe.enabled = true;
    live.dryRun.bidding = false;
    app({ settings: live });
    await screen.findByLabelText('Sniping');
    expect(screen.queryByText(/dry-run mode/)).toBeNull();
    cleanup();

    app({ settings: defaultSettings() });
    await screen.findByLabelText('Sniping');
    expect(screen.queryByText(/do not place real bids/)).toBeNull();
  });

  it('links the OS power guidance to docs/COMPANION.md', async () => {
    app({ settings: defaultSettings() });
    const link = await screen.findByRole('link', { name: /OS power guidance/ });
    expect(link.getAttribute('href')).toBe('https://github.com/trashdad/shopbadwill/blob/dev/docs/COMPANION.md');
  });

  it('builds the section from text, with no HTML sink', () => {
    const source = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), '../../src/entrypoints/options/sections/snipe/index.tsx'),
      'utf8',
    );
    const withoutComments = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(withoutComments).not.toMatch(
      /\b(innerHTML|outerHTML|insertAdjacentHTML|dangerouslySetInnerHTML|createContextualFragment)\b|document\.write/,
    );
  });
});
