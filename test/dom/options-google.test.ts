// T-70: the Google and Health options sections, driven through FakeMessaging.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/preact';
import { h } from 'preact';
import { afterEach, describe, expect, it } from 'vitest';

import type { AuthStatus } from '../../src/domain/calendar/types';
import { defaultSettings } from '../../src/domain/settings/defaults';
import { loadSections } from '../../src/entrypoints/options/registry';
import {
  createGoogleConfigStore,
  type ClientConfigInput,
  type ClientConfigView,
  type GoogleConfigStore,
  type LocalArea,
} from '../../src/entrypoints/options/sections/google/config-store';
import { GoogleSection, section as googleSection } from '../../src/entrypoints/options/sections/google';
import { HealthSection, section as healthSection } from '../../src/entrypoints/options/sections/health';
import type { MsgReply } from '../../src/messaging/protocol';
import { FakeMessaging } from '../fakes/ports/fake-messaging';

afterEach(cleanup);

const NOW = 1_800_000_000_000;
const DAY = 86_400_000;
const GOOD_ID = '123456789012-abc123def.apps.googleusercontent.com';
const SECRET = 'GOCSPX-supersecretvalue1234';
const SCOPE = 'https://www.googleapis.com/auth/calendar.app.created';

const status = (over: Partial<AuthStatus> = {}): AuthStatus => ({
  connected: false,
  provider: 'pkce',
  grantedScopes: [],
  needsInteraction: false,
  configured: true,
  ...over,
});

class MemStore implements GoogleConfigStore {
  saves: ClientConfigInput[] = [];
  constructor(private view: ClientConfigView = { clientId: '', secretTail: null }) {}
  load(): Promise<ClientConfigView> {
    return Promise.resolve(this.view);
  }
  save(input: ClientConfigInput): Promise<void> {
    this.saves.push(input);
    this.view = {
      clientId: input.clientId,
      secretTail: input.clientSecret ? input.clientSecret.slice(-4) : this.view.secretTail,
    };
    return Promise.resolve();
  }
}

function googleApp(opts: { auth?: AuthStatus; store?: MemStore; connectReply?: AuthStatus } = {}) {
  const fake = new FakeMessaging();
  let auth = opts.auth ?? status();
  fake.handle('calendar.status', () => auth);
  fake.handle('calendar.connect', () => {
    auth = opts.connectReply ?? status({ connected: true, grantedScopes: [SCOPE], account: 'me@example.com' });
    return auth;
  });
  fake.handle('calendar.disconnect', () => {
    auth = status();
    return undefined;
  });
  fake.handle('settings.get', () => defaultSettings());
  fake.handle('settings.set', () => undefined);
  const store = opts.store ?? new MemStore();
  render(h(GoogleSection, { client: fake, store, now: () => NOW }));
  return { fake, store };
}
const sent = (fake: FakeMessaging, type: string) => fake.sent.filter((m) => m.type === type);

describe('google section', () => {
  it('registers as a valid section, and health too', () => {
    expect(loadSections({ './g': { section: googleSection }, './h': { section: healthSection } })).toHaveLength(2);
  });

  it('keeps Connect disabled until a client id AND a secret are present', async () => {
    googleApp();
    const connect = screen.getByRole<HTMLButtonElement>('button', { name: 'Connect to Google Calendar' });
    expect(connect.disabled).toBe(true);
    fireEvent.input(screen.getByLabelText('Client ID'), { target: { value: GOOD_ID } });
    expect(connect.disabled).toBe(true);
    fireEvent.input(screen.getByLabelText('Client secret'), { target: { value: SECRET } });
    await waitFor(() => {
      expect(connect.disabled).toBe(false);
    });
  });

  it('rejects a malformed client id with an alert, and does not connect', async () => {
    const { fake, store } = googleApp();
    fireEvent.input(screen.getByLabelText('Client ID'), { target: { value: 'not-an-id' } });
    fireEvent.input(screen.getByLabelText('Client secret'), { target: { value: SECRET } });
    fireEvent.click(screen.getByRole('button', { name: 'Connect to Google Calendar' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/client ID/);
    expect(sent(fake, 'calendar.connect')).toHaveLength(0);
    expect(store.saves).toHaveLength(0);
  });

  it('saves the client then connects, and never shows the secret back', async () => {
    const { fake, store } = googleApp();
    fireEvent.input(screen.getByLabelText('Client ID'), { target: { value: GOOD_ID } });
    fireEvent.input(screen.getByLabelText('Client secret'), { target: { value: SECRET } });
    fireEvent.click(screen.getByRole('button', { name: 'Connect to Google Calendar' }));
    await screen.findByText('Connected to Google Calendar.');
    expect(store.saves).toEqual([{ clientId: GOOD_ID, clientSecret: SECRET }]);
    expect(sent(fake, 'calendar.connect')).toHaveLength(1);
    const input = screen.getByLabelText<HTMLInputElement>('Client secret');
    expect(input.value).toBe('');
    expect(input.placeholder).toBe('Saved: ••••1234');
    expect(document.body.innerHTML).not.toContain(SECRET);
    expect(document.body.textContent).toContain('me@example.com');
  });

  it('marks the secret input for privacy and explains why it is required', () => {
    googleApp();
    const input = screen.getByLabelText<HTMLInputElement>('Client secret');
    expect(input.getAttribute('autocomplete')).toBe('off');
    expect(input.getAttribute('spellcheck')).toBe('false');
    expect(input.type).toBe('password');
    expect(screen.getByText("Required for Chrome's Web client (Google rejects the sign-in without it).")).toBeTruthy();
  });

  it('lets a saved secret satisfy the gate, without retyping', async () => {
    googleApp({ store: new MemStore({ clientId: GOOD_ID, secretTail: 'abcd' }) });
    const connect = screen.getByRole<HTMLButtonElement>('button', { name: 'Connect to Google Calendar' });
    await waitFor(() => {
      expect(connect.disabled).toBe(false);
    });
  });

  it('renders the reconnect call to action when needsInteraction, and reconnects', async () => {
    const { fake } = googleApp({
      auth: status({ needsInteraction: true, lastError: 'invalid_grant' }),
      store: new MemStore({ clientId: GOOD_ID, secretTail: 'abcd' }),
    });
    const btn = await screen.findByRole<HTMLButtonElement>('button', { name: 'Reconnect Google' });
    await waitFor(() => {
      expect(btn.disabled).toBe(false);
    });
    expect(screen.getByText(/no longer accepts your sign-in/)).toBeTruthy();
    fireEvent.click(btn);
    await waitFor(() => {
      expect(sent(fake, 'calendar.connect')).toHaveLength(1);
    });
  });

  it('confirms before disconnecting, and Cancel sends nothing', async () => {
    const { fake } = googleApp({ auth: status({ connected: true, grantedScopes: [SCOPE] }) });
    fireEvent.click(await screen.findByRole('button', { name: 'Disconnect' }));
    expect(sent(fake, 'calendar.disconnect')).toHaveLength(0);
    const group = screen.getByRole('group', { name: 'Confirm disconnect' });
    fireEvent.click(within(group).getByRole('button', { name: 'Cancel' }));
    expect(sent(fake, 'calendar.disconnect')).toHaveLength(0);
    fireEvent.click(await screen.findByRole('button', { name: 'Disconnect' }));
    fireEvent.click(screen.getByRole('button', { name: 'Yes, disconnect' }));
    await waitFor(() => {
      expect(sent(fake, 'calendar.disconnect')).toHaveLength(1);
    });
    await screen.findByText(/Not connected/);
  });

  it('warns about the 7-day Testing mode when the refresh token has an expiry in that window', async () => {
    googleApp({ auth: status({ connected: true, refreshTokenExpiresAt: NOW + 6 * DAY }) });
    const warn = await screen.findByRole('note');
    expect(warn.textContent).toContain(
      'Your Google app is in Testing mode, so Google signs you out every 7 days. Open Google Cloud console → OAuth consent screen → Publish app.',
    );
  });

  it('shows no Testing warning without an expiry', async () => {
    googleApp({ auth: status({ connected: true }) });
    await screen.findByText('Connected');
    expect(screen.queryByRole('note')).toBeNull();
  });

  it('handles an unavailable status', async () => {
    const fake = new FakeMessaging(); // no handlers at all
    render(h(GoogleSection, { client: fake, store: new MemStore(), now: () => NOW }));
    await screen.findByText('Google status is unavailable right now.');
  });

  it('shows a connect failure as an error without leaking the secret', async () => {
    googleApp({ connectReply: status({ lastError: 'unauthorized' }) });
    fireEvent.input(screen.getByLabelText('Client ID'), { target: { value: GOOD_ID } });
    fireEvent.input(screen.getByLabelText('Client secret'), { target: { value: SECRET } });
    fireEvent.click(screen.getByRole('button', { name: 'Connect to Google Calendar' }));
    await screen.findByText(/Problem:/);
    expect(document.body.innerHTML).not.toContain(SECRET);
  });

  it('offers only the dedicated calendar: primary is disabled with a note, and nothing saves it', async () => {
    const { fake } = googleApp();
    const primary = await screen.findByLabelText<HTMLInputElement>(/My primary calendar/);
    expect(primary.disabled).toBe(true);
    expect(screen.getByLabelText<HTMLInputElement>(/separate ShopBadwill calendar/).checked).toBe(true);
    expect(
      screen.getByText('Not available: uses a narrower Google permission (only calendars this extension creates).'),
    ).toBeTruthy();
    fireEvent.click(primary);
    await new Promise((r) => setTimeout(r, 0));
    expect(sent(fake, 'settings.set')).toHaveLength(0);
  });

  it('never sends primary even when stored settings say primary', async () => {
    const fake = new FakeMessaging();
    fake.handle('calendar.status', () => status());
    fake.handle('settings.get', () => ({ ...defaultSettings(), calendar: { ...defaultSettings().calendar, mode: 'primary' as const } }));
    fake.handle('settings.set', () => undefined);
    render(h(GoogleSection, { client: fake, store: new MemStore(), now: () => NOW }));
    await waitFor(() => {
      expect(sent(fake, 'settings.get')).toHaveLength(1);
    });
    await new Promise((r) => setTimeout(r, 0));
    fireEvent.click(screen.getByRole('button', { name: 'Save reminders' }));
    await waitFor(() => {
      expect(sent(fake, 'settings.set')).toHaveLength(1);
    });
    expect(sent(fake, 'settings.set')[0]?.payload).toMatchObject({ calendar: { mode: 'dedicated' } });
  });
});

describe('reminders editor', () => {
  const inputs = () => screen.getAllByLabelText<HTMLInputElement>(/^Reminder \d \(minutes\)$/);

  it('defaults to 60/15/5 and saves them', async () => {
    const { fake } = googleApp();
    await waitFor(() => {
      expect(sent(fake, 'settings.get')).toHaveLength(1);
    });
    expect(inputs().map((i) => i.value)).toEqual(['60', '15', '5']);
    await new Promise((r) => setTimeout(r, 0));
    fireEvent.click(screen.getByRole('button', { name: 'Save reminders' }));
    await waitFor(() => {
      expect(sent(fake, 'settings.set')).toHaveLength(1);
    });
    expect(sent(fake, 'settings.set')[0]?.payload).toMatchObject({ calendar: { reminders: [60, 15, 5] } });
  });

  it('caps at 5 reminders', () => {
    googleApp();
    const add = screen.getByRole<HTMLButtonElement>('button', { name: 'Add reminder' });
    fireEvent.click(add);
    fireEvent.click(add);
    expect(inputs()).toHaveLength(5);
    expect(add.disabled).toBe(true);
  });

  it.each(['0', '-5', '1.5', 'abc', ''])('rejects %j with an alert and saves nothing', async (bad) => {
    const { fake } = googleApp();
    await waitFor(() => {
      expect(sent(fake, 'settings.get')).toHaveLength(1);
    });
    fireEvent.input(inputs()[0] as HTMLInputElement, { target: { value: bad } });
    fireEvent.click(screen.getByRole('button', { name: 'Save reminders' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/whole minutes/);
    expect(sent(fake, 'settings.set')).toHaveLength(0);
  });

  it('removes and resets', () => {
    googleApp();
    fireEvent.click(screen.getByRole('button', { name: 'Remove reminder 1' }));
    expect(inputs().map((i) => i.value)).toEqual(['15', '5']);
    fireEvent.click(screen.getByRole('button', { name: /Reset to 60, 15, 5/ }));
    expect(inputs().map((i) => i.value)).toEqual(['60', '15', '5']);
  });
});

describe('google config store', () => {
  function area(initial: Record<string, unknown> = {}): LocalArea & { data: Record<string, unknown>; writes: string[] } {
    const data = { ...initial };
    const writes: string[] = [];
    return {
      data,
      writes,
      get: (k) => Promise.resolve(k in data ? { [k]: data[k] } : {}),
      set: (items) => {
        writes.push(...Object.keys(items));
        Object.assign(data, items);
        return Promise.resolve();
      },
    };
  }

  it('writes only sbw:googleClient, and load reveals only the last 4', async () => {
    const a = area();
    const store = createGoogleConfigStore(() => a, () => 42);
    await store.save({ clientId: GOOD_ID, clientSecret: SECRET });
    expect(a.data['sbw:googleClient']).toEqual({ clientId: GOOD_ID, clientSecret: SECRET, updatedAt: 42 });
    expect(a.writes).toEqual(['sbw:googleClient']);
    expect(await store.load()).toEqual({ clientId: GOOD_ID, secretTail: '1234' });
  });

  it('leaves a live sbw:google token record byte-identical', async () => {
    const tokens = { provider: 'pkce', clientId: 'x', refreshToken: 'r', grantedScopes: [SCOPE], connectedAt: 1 };
    const a = area({ 'sbw:google': tokens });
    const before = JSON.stringify(a.data['sbw:google']);
    const store = createGoogleConfigStore(() => a);
    await store.save({ clientId: GOOD_ID, clientSecret: SECRET });
    expect(JSON.stringify(a.data['sbw:google'])).toBe(before);
    expect(a.writes).not.toContain('sbw:google');
  });

  it('keeps the saved secret when only the id changes', async () => {
    const a = area({ 'sbw:googleClient': { clientId: 'x', clientSecret: SECRET, updatedAt: 1 } });
    const store = createGoogleConfigStore(() => a, () => 2);
    await store.save({ clientId: GOOD_ID });
    expect(a.data['sbw:googleClient']).toEqual({ clientId: GOOD_ID, clientSecret: SECRET, updatedAt: 2 });
  });
});

describe('health section', () => {
  const report = (over: Partial<MsgReply<'health.get'>> = {}): MsgReply<'health.get'> => ({
    sgw: null,
    session: NOW + 2 * DAY,
    sessionState: 'ok',
    google: status({ connected: true, account: 'me@example.com' }),
    budget: {
      lanes: {
        interactive: { usedToday: 3, budget: 50, nextAllowedAt: 0 },
        background: { usedToday: 12, budget: 100, nextAllowedAt: 0 },
        snipe: { usedToday: 0, budget: 20, nextAllowedAt: 0 },
        canary: { usedToday: 1, budget: 4, nextAllowedAt: 0 },
      },
      cacheHits: 0,
    },
    ...over,
  });

  function healthApp(reply?: MsgReply<'health.get'>, tight = false) {
    const fake = new FakeMessaging();
    if (reply !== undefined) fake.handle('health.get', () => reply);
    fake.handle('settings.get', () => ({ ...defaultSettings(), considerateMode: tight ? 'tight' : 'normal' }));
    render(h(HealthSection, { client: fake }));
    return fake;
  }

  it('shows session, Google, budget and considerate mode', async () => {
    healthApp(report(), true);
    await screen.findByText(/Signed in to ShopGoodwill/);
    expect(screen.getByText(/Connected/)).toBeTruthy();
    expect(screen.getByText('12 of 100 requests')).toBeTruthy();
    await waitFor(() => {
      expect(screen.getByText('Tight')).toBeTruthy();
    });
    expect(screen.getByText(/different ShopGoodwill account\? Disconnect first/)).toBeTruthy();
  });

  it('warns when the session is expiring, with a dual time', async () => {
    healthApp(report({ sessionState: 'expiring', session: NOW + DAY }));
    const p = await screen.findByText(/Your ShopGoodwill sign-in expires/);
    expect(p.textContent).toMatch(/PT/);
    expect(p.textContent).toContain('Sign in on shopgoodwill.com to renew it.');
  });

  it('says so when ShopGoodwill rejected the sign-in', async () => {
    healthApp(report({ sessionState: 'expired' }));
    await screen.findByText(
      'ShopGoodwill rejected your sign-in. Sign in again on shopgoodwill.com; armed snipes are at risk until you do.',
    );
  });

  it('reports selector drift', async () => {
    healthApp(
      report({
        sgw: {
          ok: false,
          checkedAt: NOW,
          configVersion: '2026.1',
          checks: [{ name: 'card-selectors', ok: false, detail: '0 cards found' }],
        },
      }),
    );
    await screen.findByText(/may have changed its pages/);
    expect(screen.getByText('card-selectors: 0 cards found')).toBeTruthy();
  });

  describe('sticky failures (T-30b)', () => {
    const sticky = (): NonNullable<MsgReply<'health.get'>['sticky']> => [
      { endpoint: 'placeBid', at: NOW - 3_600_000, detail: 'unexpected reply shape', features: ['bidding'] },
      { endpoint: 'search', at: NOW - 60_000, detail: 'items missing', features: ['favorites', 'calendar', 'bidding'] },
    ];

    it('lists each sticky failure with endpoint, time and detail', async () => {
      healthApp(report({ sticky: sticky() }));
      const item = (await screen.findByText(/placeBid/)).closest('li');
      expect(item?.textContent).toContain('unexpected reply shape');
      expect(item?.textContent).toMatch(/PT/);
      expect(screen.getByText(/items missing/)).toBeTruthy();
      expect(screen.getByRole('button', { name: "I've checked; resume bidding" })).toBeTruthy();
      expect(screen.getByRole('button', { name: "I've checked; resume all features" })).toBeTruthy();
    });

    it('shows no sticky list when there is none', async () => {
      healthApp(report({ sticky: [] }));
      await screen.findByText(/Signed in to ShopGoodwill/);
      expect(screen.queryByRole('button', { name: /resume/ })).toBeNull();
    });

    it('asks for confirmation first, sends health.clearSticky only after it, then reloads', async () => {
      let current = sticky();
      const fake = new FakeMessaging();
      fake.handle('health.get', () => report({ sticky: current }));
      fake.handle('settings.get', () => defaultSettings());
      fake.handle('health.clearSticky', ({ endpoint }) => {
        current = current.filter((x) => x.endpoint !== endpoint);
        return undefined;
      });
      render(h(HealthSection, { client: fake }));
      fireEvent.click(await screen.findByRole('button', { name: "I've checked; resume bidding" }));
      const dialog = screen.getByRole('alertdialog');
      expect(fake.sent.some((m) => m.type === 'health.clearSticky')).toBe(false);
      // Cancel sends nothing.
      fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
      expect(screen.queryByRole('alertdialog')).toBeNull();
      expect(fake.sent.some((m) => m.type === 'health.clearSticky')).toBe(false);
      fireEvent.click(screen.getByRole('button', { name: "I've checked; resume bidding" }));
      fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Yes, resume bidding' }));
      await waitFor(() => {
        expect(fake.sent.filter((m) => m.type === 'health.clearSticky')).toEqual([
          { type: 'health.clearSticky', payload: { endpoint: 'placeBid' } },
        ]);
      });
      await waitFor(() => {
        expect(screen.queryByText(/unexpected reply shape/)).toBeNull();
      });
      expect(screen.getByText(/items missing/)).toBeTruthy();
    });

    it('moves focus to the Refresh button after a successful resume', async () => {
      let current = sticky();
      const fake = new FakeMessaging();
      fake.handle('health.get', () => report({ sticky: current }));
      fake.handle('settings.get', () => defaultSettings());
      fake.handle('health.clearSticky', () => {
        current = [];
        return undefined;
      });
      render(h(HealthSection, { client: fake }));
      fireEvent.click(await screen.findByRole('button', { name: "I've checked; resume bidding" }));
      fireEvent.click(screen.getByRole('button', { name: 'Yes, resume bidding' }));
      await waitFor(() => {
        expect(screen.queryByText(/unexpected reply shape/)).toBeNull();
      });
      await waitFor(() => {
        expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Refresh health' }));
      });
    });

    it('shows a failed resume in an alert and keeps the failure listed', async () => {
      const fake = new FakeMessaging();
      fake.handle('health.get', () => report({ sticky: sticky() }));
      fake.handle('settings.get', () => defaultSettings());
      fake.handle('health.clearSticky', () => {
        throw new Error('storage is busy');
      });
      render(h(HealthSection, { client: fake }));
      fireEvent.click(await screen.findByRole('button', { name: "I've checked; resume bidding" }));
      fireEvent.click(screen.getByRole('button', { name: 'Yes, resume bidding' }));
      const alert = await screen.findByRole('alert');
      expect(alert.textContent).toContain('storage is busy');
      expect(screen.getByText(/unexpected reply shape/)).toBeTruthy();
    });
  });

  it('shows "unavailable" without crashing when health.get has no handler', async () => {
    healthApp(undefined);
    await waitFor(() => {
      expect(screen.getAllByText('Unavailable right now.').length).toBeGreaterThan(0);
    });
    expect(screen.getByText(/different ShopGoodwill account\? Disconnect first/)).toBeTruthy();
  });
});
