// T-56: the Notifications options section. The permission is requested from the
// click handler through src/ui/permissions.ts; FakePermissions stands in for the browser.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { h } from 'preact';
import { afterEach, describe, expect, it } from 'vitest';

import { defaultSettings } from '../../src/domain/settings/defaults';
import { loadSections } from '../../src/entrypoints/options/registry';
import { NotificationsSection, section } from '../../src/entrypoints/options/sections/notifications';
import { FakeMessaging } from '../fakes/ports/fake-messaging';
import { FakePermissions } from '../fakes/ports/fake-permissions';

afterEach(cleanup);

function app(permissions: FakePermissions) {
  const fake = new FakeMessaging();
  const saved: unknown[] = [];
  fake.handle('settings.get', () => defaultSettings());
  fake.handle('settings.set', (p) => {
    saved.push(p);
    return undefined;
  });
  render(h(NotificationsSection, { client: fake, permissions }));
  return { saved };
}

describe('NotificationsSection', () => {
  it('registers as a valid section', () => {
    expect(loadSections({ './notifications/index.tsx': { section } })).toHaveLength(1);
  });

  it('asks for the permission from the button click and then shows it granted', async () => {
    const permissions = new FakePermissions();
    app(permissions);
    fireEvent.click(await screen.findByRole('button', { name: 'Allow notifications' }));
    await screen.findByText('ShopBadwill may show notifications.');
    expect(permissions.requested).toEqual([{ permissions: ['notifications'] }]);
  });

  it('says so when the browser declines', async () => {
    const permissions = new FakePermissions();
    permissions.grantRequests = false;
    app(permissions);
    fireEvent.click(await screen.findByRole('button', { name: 'Allow notifications' }));
    await screen.findByText(/did not allow notifications/);
    expect(screen.queryByRole('button', { name: 'Allow notifications' })).not.toBeNull();
  });

  it('hides the button when already granted', async () => {
    app(new FakePermissions({ permissions: ['notifications'] }));
    await screen.findByText('ShopBadwill may show notifications.');
    expect(screen.queryByRole('button', { name: 'Allow notifications' })).toBeNull();
  });

  it('saves quiet hours and validates them', async () => {
    const { saved } = app(new FakePermissions({ permissions: ['notifications'] }));
    const from = await screen.findByLabelText('From');
    fireEvent.input(from, { target: { value: '22:00' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save quiet hours' }));
    await screen.findByText(/Enter both times/);
    expect(saved).toHaveLength(0);
    fireEvent.input(screen.getByLabelText('Until'), { target: { value: '07:00' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save quiet hours' }));
    await waitFor(() => {
      expect(saved).toHaveLength(1);
    });
    expect(saved[0]).toMatchObject({ notifications: { quietHours: { from: '22:00', to: '07:00' } } });
  });

  it('toggles the digest', async () => {
    const { saved } = app(new FakePermissions({ permissions: ['notifications'] }));
    fireEvent.click(await screen.findByLabelText('One digest after each run'));
    await waitFor(() => {
      expect(saved).toHaveLength(1);
    });
    expect(saved[0]).toMatchObject({ notifications: { enabled: true, digest: false } });
  });
});
