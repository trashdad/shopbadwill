// T-69: the ntfy options section. The origin permission is requested from the
// click handler itself (R9); FakePermissions stands in for the browser.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { h } from 'preact';
import { afterEach, describe, expect, it } from 'vitest';

import { NTFY_SERVER, NTFY_ORIGIN } from '../../src/adapters/ntfy/ntfy-sink';
import { defaultSettings } from '../../src/domain/settings/defaults';
import type { Settings } from '../../src/domain/settings/schema';
import { loadSections } from '../../src/entrypoints/options/registry';
import { NtfySection, section } from '../../src/entrypoints/options/sections/ntfy';
import { FakeMessaging } from '../fakes/ports/fake-messaging';
import { FakePermissions } from '../fakes/ports/fake-permissions';

afterEach(cleanup);

const TOPIC = 'sbw-abcdefghijklmnopqrstuvwxyz';

function app(opts: {
  permissions?: FakePermissions;
  settings?: Settings;
  generate?: () => string;
  firefox?: boolean;
  clipboard?: { writeText(text: string): Promise<void> };
} = {}) {
  const fake = new FakeMessaging();
  const saved: unknown[] = [];
  const s = structuredClone(opts.settings ?? defaultSettings());
  fake.handle('settings.get', () => s);
  fake.handle('settings.set', (p) => {
    saved.push(p);
    return undefined;
  });
  render(
    h(NtfySection, {
      client: fake,
      permissions: opts.permissions ?? new FakePermissions(),
      ...(opts.generate === undefined ? {} : { generate: opts.generate }),
      ...(opts.firefox === undefined ? {} : { firefox: opts.firefox }),
      ...(opts.clipboard === undefined ? {} : { clipboard: opts.clipboard }),
    }),
  );
  return { fake, saved };
}

const ntfyOn = (topic = TOPIC): Settings => ({ ...defaultSettings(), ntfy: { enabled: true, server: NTFY_SERVER, topic } });

describe('NtfySection', () => {
  it('registers as a valid section', () => {
    expect(loadSections({ './ntfy/index.tsx': { section } })).toHaveLength(1);
  });

  it('turns phone push on and sends the whole ntfy group (server stays for later)', async () => {
    const { saved } = app();
    fireEvent.click(await screen.findByLabelText('Phone push (ntfy.sh)'));
    await waitFor(() => {
      expect(saved).toHaveLength(1);
    });
    expect(saved[0]).toEqual({ ntfy: { enabled: true, server: NTFY_SERVER, topic: '' } });
  });

  it('generates a topic on click, saves it, shows it in the field and only its last 4 characters elsewhere', async () => {
    const { saved } = app({ settings: ntfyOn(''), generate: () => TOPIC });
    fireEvent.click(await screen.findByRole('button', { name: 'Generate topic' }));
    await waitFor(() => {
      expect(saved).toHaveLength(1);
    });
    expect(saved[0]).toEqual({ ntfy: { enabled: true, server: NTFY_SERVER, topic: TOPIC } });
    expect((await screen.findByLabelText<HTMLInputElement>('Topic')).value).toBe(TOPIC);
    const status = await screen.findByRole('status');
    expect(status.textContent).toContain('…wxyz');
    expect(status.textContent).not.toContain(TOPIC);
  });

  it('copies the topic for subscribing in the ntfy app', async () => {
    const copied: string[] = [];
    app({ settings: ntfyOn(), clipboard: { writeText: (t) => Promise.resolve(void copied.push(t)) } });
    fireEvent.click(await screen.findByRole('button', { name: 'Copy topic' }));
    await waitFor(() => {
      expect(copied).toEqual([TOPIC]);
    });
    expect(await screen.findByText('Copied to the clipboard.')).toBeTruthy();
  });

  it('asks for the https://ntfy.sh/* origin permission from the click handler, then shows it granted', async () => {
    const permissions = new FakePermissions();
    app({ permissions, settings: ntfyOn() });
    fireEvent.click(await screen.findByRole('button', { name: 'Allow ntfy.sh' }));
    expect(permissions.requested).toEqual([{ origins: [NTFY_ORIGIN] }]);
    expect(await screen.findByText('ShopBadwill may reach ntfy.sh.')).toBeTruthy();
  });

  it('says so when the browser declines the permission', async () => {
    const permissions = new FakePermissions();
    permissions.grantRequests = false;
    app({ permissions, settings: ntfyOn() });
    fireEvent.click(await screen.findByRole('button', { name: 'Allow ntfy.sh' }));
    await screen.findByText(/did not allow ntfy\.sh/);
    expect(screen.queryByRole('button', { name: 'Allow ntfy.sh' })).not.toBeNull();
  });

  it('hides the permission button when already granted', async () => {
    app({ permissions: new FakePermissions({ origins: [NTFY_ORIGIN] }), settings: ntfyOn() });
    await screen.findByText('ShopBadwill may reach ntfy.sh.');
    expect(screen.queryByRole('button', { name: 'Allow ntfy.sh' })).toBeNull();
  });

  it('shows the third-party privacy note', async () => {
    app({ settings: ntfyOn() });
    expect(await screen.findByText('Auction titles and end times are sent to ntfy.sh.')).toBeTruthy();
  });

  it('shows the Firefox technicalAndInteraction note only on Firefox', async () => {
    app({ settings: ntfyOn(), firefox: false });
    await screen.findByText('Auction titles and end times are sent to ntfy.sh.');
    expect(screen.queryByText(/technicalAndInteraction/)).toBeNull();
    cleanup();

    app({ settings: ntfyOn(), firefox: true });
    expect(await screen.findByText(/technicalAndInteraction/)).toBeTruthy();
  });

  it('refuses a server other than https://ntfy.sh with a short explanation', async () => {
    app({ settings: { ...defaultSettings(), ntfy: { enabled: true, server: 'https://evil.example', topic: TOPIC } } });
    expect(await screen.findByText(/only https:\/\/ntfy\.sh/)).toBeTruthy();
  });
});
