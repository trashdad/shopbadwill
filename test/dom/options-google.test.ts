// T-70: the Google and Health options sections, driven through FakeMessaging.
import { onSettingsSaved } from '../../src/entrypoints/options/settings-events';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/preact';
import { h } from 'preact';
import { afterEach, describe, expect, it } from 'vitest';

import type { AuthStatus } from '../../src/domain/calendar/types';
import { defaultSettings } from '../../src/domain/settings/defaults';
import type { Settings } from '../../src/domain/settings/schema';
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
import { FakePermissions } from '../fakes/ports/fake-permissions';

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

function googleApp(
  opts: { auth?: AuthStatus; store?: MemStore; connectReply?: AuthStatus; permissions?: FakePermissions; firefox?: boolean } = {},
) {
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
  const permissions = opts.permissions ?? new FakePermissions();
  render(h(GoogleSection, { client: fake, store, now: () => NOW, permissions, firefox: opts.firefox ?? false }));
  return { fake, store, permissions };
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
    render(h(GoogleSection, { client: fake, store: new MemStore(), now: () => NOW, permissions: new FakePermissions() }));
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
    render(h(GoogleSection, { client: fake, store: new MemStore(), now: () => NOW, permissions: new FakePermissions() }));
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

describe('calendar enabled toggle and connect prompt (T-70b)', () => {
  function toggleApp(opts: { auth?: AuthStatus; enabled?: boolean; settings?: Settings; holdSet?: Promise<void> } = {}) {
    const fake = new FakeMessaging();
    let auth = opts.auth ?? status({ connected: true, grantedScopes: [SCOPE] });
    let settings = opts.settings ?? defaultSettings();
    if (opts.settings === undefined) settings.calendar.enabled = opts.enabled ?? false;
    fake.handle('calendar.status', () => auth);
    fake.handle('calendar.connect', () => {
      auth = status({ connected: true, grantedScopes: [SCOPE], account: 'me@example.com' });
      return auth;
    });
    fake.handle('calendar.disconnect', () => {
      auth = status();
      return undefined;
    });
    fake.handle('settings.get', () => settings);
    fake.handle('settings.set', async (p) => {
      if (opts.holdSet !== undefined) await opts.holdSet;
      settings = { ...settings, ...(p as Partial<Settings>) };
      return undefined;
    });
    fake.handle('calendar.syncNow', () => undefined);
    render(
      h(GoogleSection, {
        client: fake,
        permissions: new FakePermissions(),
        store: new MemStore({ clientId: GOOD_ID, secretTail: 'abcd' }),
        now: () => NOW,
      }),
    );
    return { fake };
  }

  const toggle = async (): Promise<HTMLInputElement> =>
    screen.findByRole<HTMLInputElement>('switch', { name: 'Add auction ends to Google Calendar' });

  it('T-70c: a reminders save made while the toggle save is in flight keeps both changes, and each save is announced', async () => {
    let release!: () => void;
    const holdSet = new Promise<void>((r) => {
      release = r;
    });
    const { fake } = toggleApp({ enabled: false, holdSet });
    let announced = 0;
    const off = onSettingsSaved(() => {
      announced++;
    });
    const t = await toggle();
    await waitFor(() => {
      expect(t.disabled).toBe(false);
    });
    fireEvent.click(t); // calendar on: its settings.set is held
    const reminder = screen.getAllByLabelText<HTMLInputElement>(/^Reminder \d \(minutes\)$/)[0];
    if (reminder === undefined) throw new Error('no reminder input');
    fireEvent.input(reminder, { target: { value: '30' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save reminders' }));
    release();
    await waitFor(() => {
      expect(sent(fake, 'settings.set')).toHaveLength(2);
    });
    await waitFor(() => {
      expect(announced).toBe(2);
    });
    off();
    const last = sent(fake, 'settings.set')[1]?.payload as Partial<Settings>;
    expect(last.calendar?.enabled).toBe(true);
    expect(last.calendar?.reminders[0]).toBe(30);
  });

  it('keeps the toggle disabled with "Connect Google first" while Google is not connected', async () => {
    toggleApp({ auth: status({ connected: false }) });
    const t = await toggle();
    expect(t.disabled).toBe(true);
    expect(t.checked).toBe(false);
    expect(screen.getByText('Connect Google first')).toBeTruthy();
  });

  it('turning the toggle on saves calendar.enabled = true and then sends calendar.syncNow', async () => {
    const { fake } = toggleApp({ enabled: false });
    const t = await toggle();
    await waitFor(() => {
      expect(t.disabled).toBe(false);
    });
    fireEvent.click(t);
    await waitFor(() => {
      expect(sent(fake, 'calendar.syncNow')).toHaveLength(1);
    });
    const setI = fake.sent.findIndex((m) => m.type === 'settings.set');
    const syncI = fake.sent.findIndex((m) => m.type === 'calendar.syncNow');
    expect(setI).toBeGreaterThan(-1);
    expect(setI).toBeLessThan(syncI);
    expect(fake.sent[setI]?.payload).toMatchObject({ calendar: { enabled: true } });
    expect(t.checked).toBe(true);
  });

  it('turning the toggle off sends no delete, no sync, and says existing events stay', async () => {
    const { fake } = toggleApp({ enabled: true });
    const t = await toggle();
    await waitFor(() => {
      expect(t.disabled).toBe(false);
    });
    fireEvent.click(t);
    await waitFor(() => {
      expect(sent(fake, 'settings.set')).toHaveLength(1);
    });
    expect(sent(fake, 'settings.set')[0]?.payload).toMatchObject({ calendar: { enabled: false } });
    const types = fake.sent.map((m) => m.type);
    expect(types).not.toContain('audit.undo');
    expect(types).not.toContain('calendar.disconnect');
    expect(types).not.toContain('calendar.syncNow');
    expect(screen.getByText(/stay on your calendar/)).toBeTruthy();
  });

  it('turning the toggle off says where to delete events, and that scheduled phone pushes still arrive', async () => {
    const { fake } = toggleApp({ enabled: true });
    const t = await toggle();
    await waitFor(() => {
      expect(t.disabled).toBe(false);
    });
    fireEvent.click(t);
    const note = await screen.findByText(/stay on your calendar/);
    // The off path sends no DELETE (ntfy's included), so pushes ntfy.sh already holds still fire.
    expect(note.textContent).toMatch(/Undo in Activity/);
    expect(note.textContent).toMatch(/phone pushes already scheduled still arrive unless you turn off Phone push/i);
    expect(sent(fake, 'settings.set')).toHaveLength(1);
    expect(fake.sent.map((m) => m.type)).toEqual(expect.not.arrayContaining(['audit.undo', 'calendar.syncNow', 'calendar.disconnect']));
  });

  it('offers "Turn on calendar events now?" after connecting while the setting is off, and does nothing until clicked', async () => {
    const { fake } = toggleApp({ auth: status({ connected: false }), enabled: false });
    const connect = await screen.findByRole<HTMLButtonElement>('button', { name: 'Connect to Google Calendar' });
    await waitFor(() => {
      expect(connect.disabled).toBe(false);
    });
    fireEvent.click(connect);
    const prompt = await screen.findByRole('button', { name: 'Turn on calendar events now?' });
    // Never on silently: the prompt is a click, not a side effect of connecting.
    expect(sent(fake, 'settings.set')).toHaveLength(0);
    expect(sent(fake, 'calendar.syncNow')).toHaveLength(0);
    fireEvent.click(prompt);
    await waitFor(() => {
      expect(sent(fake, 'calendar.syncNow')).toHaveLength(1);
    });
    const setI = fake.sent.findIndex((m) => m.type === 'settings.set');
    const syncI = fake.sent.findIndex((m) => m.type === 'calendar.syncNow');
    expect(setI).toBeGreaterThan(-1);
    expect(setI).toBeLessThan(syncI);
    expect(fake.sent[setI]?.payload).toMatchObject({ calendar: { enabled: true } });
    expect(screen.queryByRole('button', { name: 'Turn on calendar events now?' })).toBeNull();
  });

  it('does not offer the prompt when calendar events are already on', async () => {
    const { fake } = toggleApp({ auth: status({ connected: false }), enabled: true });
    const connect = await screen.findByRole<HTMLButtonElement>('button', { name: 'Connect to Google Calendar' });
    await waitFor(() => {
      expect(connect.disabled).toBe(false);
    });
    fireEvent.click(connect);
    await screen.findByText('Connected to Google Calendar.');
    expect(screen.queryByRole('button', { name: 'Turn on calendar events now?' })).toBeNull();
    expect(sent(fake, 'settings.set')).toHaveLength(0);
    expect(sent(fake, 'calendar.syncNow')).toHaveLength(0);
  });

  /** A stored calendar group with nothing left at the defaults, plus other sections the write must not touch. */
  function richSettings(enabled: boolean): Settings {
    const settings = defaultSettings();
    settings.calendar = { enabled, mode: 'primary', reminders: [9, 30], icsFallback: false };
    settings.notifications = { enabled: false, digest: false };
    settings.overlay = { ...settings.overlay, hideStyle: 'dim' };
    settings.homeZip = '10001';
    settings.ntfy = { enabled: true, server: 'https://ntfy.sh', topic: 'abc123topic' };
    settings.snipe = { ...settings.snipe, enabled: true };
    settings.dryRun = { favorites: false, calendar: false, bidding: true };
    settings.killSwitch = true;
    return settings;
  }

  /** Same merge as settings.set: whole top-level groups, and killSwitch is never taken from the patch. */
  function applied(before: Settings, payload: unknown): Settings {
    const patch = payload as Partial<Settings>;
    const groups: Partial<Settings> = { ...patch };
    delete groups.killSwitch;
    return { ...before, ...groups, killSwitch: before.killSwitch };
  }

  it('does not turn calendar events on just because Google is already connected', async () => {
    const { fake } = toggleApp({ enabled: false });
    const t = await toggle();
    await waitFor(() => {
      expect(t.disabled).toBe(false);
    });
    expect(t.checked).toBe(false);
    expect(sent(fake, 'settings.set')).toHaveLength(0);
    expect(sent(fake, 'calendar.syncNow')).toHaveLength(0);
  });

  it('writes enabled only after the save resolves, then sends calendar.syncNow once', async () => {
    let release: () => void = () => undefined;
    const hold = new Promise<void>((resolveHold) => {
      release = resolveHold;
    });
    const { fake } = toggleApp({ enabled: false, holdSet: hold });
    const t = await toggle();
    await waitFor(() => {
      expect(t.disabled).toBe(false);
    });
    fireEvent.click(t);
    await waitFor(() => {
      expect(sent(fake, 'settings.set')).toHaveLength(1);
    });
    // The sync waits for the write to resolve. The checkbox may already look on; the setting is not saved yet.
    expect(sent(fake, 'calendar.syncNow')).toHaveLength(0);
    release();
    await waitFor(() => {
      expect(sent(fake, 'calendar.syncNow')).toHaveLength(1);
    });
    expect(sent(fake, 'settings.set')).toHaveLength(1);
    expect(sent(fake, 'calendar.syncNow')).toHaveLength(1);
    expect(t.checked).toBe(true);
  });

  it('keeps calendar.mode, reminders and icsFallback, and does not send any other section', async () => {
    const before = richSettings(false);
    const { fake } = toggleApp({ settings: structuredClone(before) });
    const t = await toggle();
    await waitFor(() => {
      expect(t.disabled).toBe(false);
    });
    fireEvent.click(t);
    await waitFor(() => {
      expect(sent(fake, 'calendar.syncNow')).toHaveLength(1);
    });
    const payload = sent(fake, 'settings.set')[0]?.payload;
    expect(payload).toEqual({
      calendar: { enabled: true, mode: 'primary', reminders: [9, 30], icsFallback: false },
    });
    expect(applied(before, payload)).toEqual({ ...before, calendar: { ...before.calendar, enabled: true } });
  });

  it('turning the toggle off keeps the rest of the calendar group and still deletes nothing', async () => {
    const before = richSettings(true);
    const { fake } = toggleApp({ settings: structuredClone(before) });
    const t = await toggle();
    await waitFor(() => {
      expect(t.disabled).toBe(false);
    });
    fireEvent.click(t);
    await waitFor(() => {
      expect(sent(fake, 'settings.set')).toHaveLength(1);
    });
    const payload = sent(fake, 'settings.set')[0]?.payload;
    expect(payload).toEqual({
      calendar: { enabled: false, mode: 'primary', reminders: [9, 30], icsFallback: false },
    });
    expect(applied(before, payload)).toEqual({ ...before, calendar: { ...before.calendar, enabled: false } });
    const types = fake.sent.map((m) => m.type);
    expect(types).not.toContain('audit.undo');
    expect(types).not.toContain('calendar.disconnect');
    expect(types).not.toContain('calendar.syncNow');
    expect(types).not.toContain('calendar.ics');
    const note = screen.getByText(
      'Calendar sync is off. Existing events stay on your calendar; delete them with Undo in Activity. Phone pushes already scheduled still arrive unless you turn off Phone push.',
    );
    expect(note.children.length).toBe(0);
  });

  it('offers the prompt when settings arrive as off after Google connects, and still does nothing until clicked', async () => {
    const fake = new FakeMessaging();
    let release: (s: Settings) => void = () => undefined;
    const gate = new Promise<Settings>((resolveGate) => {
      release = resolveGate;
    });
    const stored = defaultSettings();
    stored.calendar.enabled = false;
    fake.handle('calendar.status', () => status({ connected: false }));
    fake.handle('calendar.connect', () => status({ connected: true, grantedScopes: [SCOPE], account: 'me@example.com' }));
    fake.handle('settings.get', () => gate);
    fake.handle('settings.set', () => undefined);
    fake.handle('calendar.syncNow', () => undefined);
    render(
      h(GoogleSection, {
        client: fake,
        permissions: new FakePermissions(),
        store: new MemStore({ clientId: GOOD_ID, secretTail: 'abcd' }),
        now: () => NOW,
      }),
    );
    const connect = await screen.findByRole<HTMLButtonElement>('button', { name: 'Connect to Google Calendar' });
    await waitFor(() => {
      expect(connect.disabled).toBe(false);
    });
    fireEvent.click(connect);
    await screen.findByText('Connected to Google Calendar.');
    expect(screen.queryByRole('button', { name: 'Turn on calendar events now?' })).toBeNull();
    expect(sent(fake, 'settings.set')).toHaveLength(0);
    expect(sent(fake, 'calendar.syncNow')).toHaveLength(0);
    release(stored);
    await screen.findByRole('button', { name: 'Turn on calendar events now?' });
    expect(sent(fake, 'settings.set')).toHaveLength(0);
    expect(sent(fake, 'calendar.syncNow')).toHaveLength(0);
    expect((await toggle()).checked).toBe(false);
  });

  it('skips the prompt when settings cannot be read, and the toggle turns calendar on after a reload', async () => {
    const fake = new FakeMessaging();
    let auth = status({ connected: false });
    let settings = defaultSettings();
    settings.calendar.enabled = false;
    let fail = true;
    fake.handle('calendar.status', () => auth);
    fake.handle('calendar.connect', () => {
      auth = status({ connected: true, grantedScopes: [SCOPE], account: 'me@example.com' });
      return auth;
    });
    fake.handle('settings.get', () => {
      if (fail) throw new Error('could not read settings');
      return settings;
    });
    fake.handle('settings.set', (p) => {
      settings = { ...settings, ...(p as Partial<Settings>) };
      return undefined;
    });
    fake.handle('calendar.syncNow', () => undefined);
    const store = new MemStore({ clientId: GOOD_ID, secretTail: 'abcd' });
    const mount = (): void => {
      render(h(GoogleSection, { client: fake, store, now: () => NOW, permissions: new FakePermissions() }));
    };
    mount();
    const connect = await screen.findByRole<HTMLButtonElement>('button', { name: 'Connect to Google Calendar' });
    await waitFor(() => {
      expect(connect.disabled).toBe(false);
    });
    fireEvent.click(connect);
    await screen.findByText('Connected to Google Calendar.');
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByRole('button', { name: 'Turn on calendar events now?' })).toBeNull();
    expect(sent(fake, 'settings.set')).toHaveLength(0);
    expect(sent(fake, 'calendar.syncNow')).toHaveLength(0);
    const stuck = await screen.findByRole<HTMLInputElement>('switch', { name: 'Add auction ends to Google Calendar' });
    expect(stuck.disabled).toBe(true);
    expect(stuck.checked).toBe(false);
    expect(screen.getByText('Could not read your settings, so this stays off. Reload the page to try again.')).toBeTruthy();

    cleanup();
    fail = false;
    mount();
    const t = await screen.findByRole<HTMLInputElement>('switch', { name: 'Add auction ends to Google Calendar' });
    await waitFor(() => {
      expect(t.disabled).toBe(false);
    });
    expect(t.checked).toBe(false);
    fireEvent.click(t);
    await waitFor(() => {
      expect(sent(fake, 'calendar.syncNow')).toHaveLength(1);
    });
    expect(sent(fake, 'settings.set')).toHaveLength(1);
    expect(sent(fake, 'settings.set')[0]?.payload).toMatchObject({ calendar: { enabled: true } });
    expect(t.checked).toBe(true);
  });

  it('drops the prompt once the toggle turns calendar on, and does not bring it back when turned off', async () => {
    const { fake } = toggleApp({ auth: status({ connected: false }), enabled: false });
    const connect = await screen.findByRole<HTMLButtonElement>('button', { name: 'Connect to Google Calendar' });
    await waitFor(() => {
      expect(connect.disabled).toBe(false);
    });
    fireEvent.click(connect);
    await screen.findByRole('button', { name: 'Turn on calendar events now?' });
    fireEvent.click(await toggle());
    await waitFor(() => {
      expect(sent(fake, 'calendar.syncNow')).toHaveLength(1);
    });
    expect(screen.queryByRole('button', { name: 'Turn on calendar events now?' })).toBeNull();
    fireEvent.click(await toggle());
    await waitFor(() => {
      expect(sent(fake, 'settings.set')).toHaveLength(2);
    });
    expect(screen.queryByRole('button', { name: 'Turn on calendar events now?' })).toBeNull();
    expect(sent(fake, 'calendar.syncNow')).toHaveLength(1);
    expect(sent(fake, 'settings.set')[1]?.payload).toMatchObject({ calendar: { enabled: false } });
  });

  it('sends calendar.syncNow once when the toggle and the prompt are both clicked before the save finishes', async () => {
    let release: () => void = () => undefined;
    const hold = new Promise<void>((resolveHold) => {
      release = resolveHold;
    });
    const before = richSettings(false);
    const { fake } = toggleApp({ auth: status({ connected: false }), settings: structuredClone(before), holdSet: hold });
    const connect = await screen.findByRole<HTMLButtonElement>('button', { name: 'Connect to Google Calendar' });
    await waitFor(() => {
      expect(connect.disabled).toBe(false);
    });
    fireEvent.click(connect);
    const prompt = await screen.findByRole('button', { name: 'Turn on calendar events now?' });
    const t = await toggle();
    await waitFor(() => {
      expect(t.disabled).toBe(false);
    });
    fireEvent.click(t);
    fireEvent.click(prompt);
    await waitFor(() => {
      expect(sent(fake, 'settings.set').length).toBeGreaterThan(0);
    });
    expect(sent(fake, 'calendar.syncNow')).toHaveLength(0);
    release();
    await waitFor(() => {
      expect(sent(fake, 'calendar.syncNow')).toHaveLength(1);
    });
    expect(sent(fake, 'calendar.syncNow')).toHaveLength(1);
    for (const message of sent(fake, 'settings.set')) {
      expect(message.payload).toEqual({
        calendar: { enabled: true, mode: 'primary', reminders: [9, 30], icsFallback: false },
      });
    }
    expect(screen.queryByRole('button', { name: 'Turn on calendar events now?' })).toBeNull();
  });

  it('names the toggle with a text label and the section source has no HTML sink', async () => {
    toggleApp({ auth: status({ connected: false }) });
    const t = await toggle();
    const label = document.querySelector('label[for="g-calendar-enabled"]');
    expect(t.getAttribute('aria-label')).toBeNull();
    expect(label?.textContent).toBe('Add auction ends to Google Calendar');
    expect(label?.children.length).toBe(0);
    expect(label?.childNodes[0]?.nodeType).toBe(Node.TEXT_NODE);
    const hint = document.getElementById('g-calendar-enabled-hint');
    expect(hint?.textContent).toBe('Connect Google first');
    expect(hint?.children.length).toBe(0);
    const source = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../src/entrypoints/options/sections/google/index.tsx'), 'utf8');
    const withoutComments = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(withoutComments).not.toMatch(/\b(innerHTML|outerHTML|insertAdjacentHTML|dangerouslySetInnerHTML|createContextualFragment)\b|document\.write/);
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

describe('T-70d: Connect asks for the optional Google permissions first', () => {
  const ORIGINS = ['https://oauth2.googleapis.com/*', 'https://www.googleapis.com/*'];
  const DENIED = 'Google Calendar needs permission to sign in and add events. Nothing was changed.';

  /** Records what had been sent when request() ran; the grant waits for `answer`. */
  class OrderedPermissions extends FakePermissions {
    answer!: (granted: boolean) => void;
    sentAtRequest: string[] | null = null;
    sentSoFar: () => string[] = () => [];
    override request(p: { permissions?: string[]; origins?: string[] }): Promise<boolean> {
      this.requested.push(structuredClone(p));
      this.sentAtRequest = this.sentSoFar();
      return new Promise((resolve) => {
        this.answer = resolve;
      });
    }
  }

  async function ready(): Promise<HTMLButtonElement> {
    // Let the saved client load first, so it does not overwrite what is typed next.
    await screen.findByText('Not connected');
    fireEvent.input(screen.getByLabelText('Client ID'), { target: { value: GOOD_ID } });
    fireEvent.input(screen.getByLabelText('Client secret'), { target: { value: SECRET } });
    const btn = screen.getByRole<HTMLButtonElement>('button', { name: 'Connect to Google Calendar' });
    await waitFor(() => {
      expect(btn.disabled).toBe(false);
    });
    return btn;
  }

  it('Chrome: requests identity and both Google origins inside the click, before any await or send', async () => {
    const permissions = new OrderedPermissions();
    const { fake, store } = googleApp({ permissions, firefox: false });
    permissions.sentSoFar = () => fake.sent.map((m) => m.type);
    const btn = await ready();
    const sentBeforeClick = fake.sent.length;
    fireEvent.click(btn);
    // Synchronously, still inside the click's user gesture: no await has run yet.
    expect(permissions.requested).toEqual([{ permissions: ['identity'], origins: ORIGINS }]);
    expect(permissions.sentAtRequest).toHaveLength(sentBeforeClick);
    expect(permissions.sentAtRequest).not.toContain('calendar.connect');
    expect(store.saves).toHaveLength(0);
    // Nothing is saved or sent until the browser answers.
    await Promise.resolve();
    await Promise.resolve();
    expect(fake.sent).toHaveLength(sentBeforeClick);
    expect(store.saves).toHaveLength(0);
    permissions.answer(true);
    await screen.findByText('Connected to Google Calendar.');
    expect(sent(fake, 'calendar.connect')).toHaveLength(1);
    expect(store.saves).toEqual([{ clientId: GOOD_ID, clientSecret: SECRET }]);
  });

  it('Firefox: requests only the two origins, never identity', async () => {
    const { fake, permissions } = googleApp({ firefox: true });
    fireEvent.click(await ready());
    expect(permissions.requested).toEqual([{ origins: ORIGINS }]);
    expect(JSON.stringify(permissions.requested)).not.toContain('identity');
    await screen.findByText('Connected to Google Calendar.');
    expect(sent(fake, 'calendar.connect')).toHaveLength(1);
  });

  it('granted: sends calendar.connect once', async () => {
    const { fake, permissions } = googleApp();
    fireEvent.click(await ready());
    await screen.findByText('Connected to Google Calendar.');
    expect(permissions.requested).toHaveLength(1);
    expect(sent(fake, 'calendar.connect')).toHaveLength(1);
  });

  it('refused: sends nothing, saves nothing, and says why', async () => {
    const permissions = new FakePermissions();
    permissions.grantRequests = false;
    const { fake, store } = googleApp({ permissions });
    const before = fake.sent.length;
    fireEvent.click(await ready());
    expect(permissions.requested).toHaveLength(1);
    await screen.findByText(DENIED);
    expect(fake.sent.slice(before)).toEqual([]);
    expect(sent(fake, 'calendar.connect')).toHaveLength(0);
    expect(store.saves).toHaveLength(0);
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Connect to Google Calendar' }).disabled).toBe(false);
  });

  it('a request that throws connects nothing and shows the refusal message', async () => {
    const permissions = new FakePermissions();
    permissions.request = () => {
      throw new Error('permissions API missing');
    };
    const { fake, store } = googleApp({ permissions });
    fireEvent.click(await ready());
    await screen.findByText(/Google Calendar needs permission to sign in and add events\. Nothing was changed\./);
    expect(sent(fake, 'calendar.connect')).toHaveLength(0);
    expect(store.saves).toHaveLength(0);
  });

  it('Reconnect goes through the same request', async () => {
    const { fake, permissions } = googleApp({
      auth: status({ needsInteraction: true, lastError: 'invalid_grant' }),
      store: new MemStore({ clientId: GOOD_ID, secretTail: 'abcd' }),
    });
    const btn = await screen.findByRole<HTMLButtonElement>('button', { name: 'Reconnect Google' });
    await waitFor(() => {
      expect(btn.disabled).toBe(false);
    });
    fireEvent.click(btn);
    expect(permissions.requested).toEqual([{ permissions: ['identity'], origins: ORIGINS }]);
    await waitFor(() => {
      expect(sent(fake, 'calendar.connect')).toHaveLength(1);
    });
  });

  it('a malformed client id asks for nothing', async () => {
    const { permissions } = googleApp();
    fireEvent.input(screen.getByLabelText('Client ID'), { target: { value: 'not-an-id' } });
    fireEvent.input(screen.getByLabelText('Client secret'), { target: { value: SECRET } });
    fireEvent.click(screen.getByRole('button', { name: 'Connect to Google Calendar' }));
    await screen.findByRole('alert');
    expect(permissions.requested).toHaveLength(0);
  });

  it('Disconnect asks for no permission (the port has no remove, and nothing else is called)', async () => {
    const permissions = new FakePermissions();
    const { fake } = googleApp({ auth: status({ connected: true, grantedScopes: [SCOPE] }), permissions });
    fireEvent.click(await screen.findByRole('button', { name: 'Disconnect' }));
    fireEvent.click(screen.getByRole('button', { name: 'Yes, disconnect' }));
    await waitFor(() => {
      expect(sent(fake, 'calendar.disconnect')).toHaveLength(1);
    });
    expect(permissions.requested).toHaveLength(0);
  });
});

// ── T-119: setup aids ───────────────────────────────────────────────────────

describe('T-119: redirect URI with a Copy button', () => {
  const CHROME_URI = 'https://gjbekijbmjlkdildfknfbcfnhjhohmlh.chromiumapp.org/';
  const FF_URI = 'http://127.0.0.1/mozoauth2/3f855aad165e9bf088575dff75668afa3e901fb1';

  class Clip {
    readonly written: string[] = [];
    fail = false;
    writeText(text: string): Promise<void> {
      if (this.fail) return Promise.reject(new Error('denied'));
      this.written.push(text);
      return Promise.resolve();
    }
  }

  function app(opts: { uri: () => string | undefined; firefox?: boolean; permissions?: FakePermissions }) {
    const fake = new FakeMessaging();
    fake.handle('calendar.status', () => status());
    fake.handle('settings.get', () => defaultSettings());
    const clipboard = new Clip();
    const permissions = opts.permissions ?? new FakePermissions();
    render(
      h(GoogleSection, {
        client: fake,
        store: new MemStore(),
        now: () => NOW,
        permissions,
        firefox: opts.firefox ?? false,
        redirectUri: opts.uri,
        clipboard,
      }),
    );
    return { fake, clipboard, permissions };
  }

  it('shows the exact redirect URI read-only, and Copy puts it on the clipboard', async () => {
    const { clipboard, permissions } = app({ uri: () => CHROME_URI });
    const field = screen.getByLabelText<HTMLInputElement>('Authorized redirect URI');
    expect(field.value).toBe(CHROME_URI);
    expect(field.readOnly).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Copy redirect URI' }));
    await screen.findByText('Redirect URI copied. Paste it under Authorized redirect URIs in your Google client.');
    expect(clipboard.written).toEqual([CHROME_URI]);
    expect(permissions.requested).toEqual([]);
  });

  it('Chrome without identity: explains, and the click asks for identity first, then shows and copies the URI', async () => {
    const permissions = new FakePermissions();
    const { clipboard } = app({ permissions, uri: () => (permissions.requested.length > 0 ? CHROME_URI : undefined) });
    expect(screen.queryByLabelText('Authorized redirect URI')).toBeNull();
    expect(screen.getByText(/appears once ShopBadwill may use the browser's sign-in/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Show and copy redirect URI' }));
    // Inside the click, before any await.
    expect(permissions.requested).toEqual([{ permissions: ['identity'] }]);
    await waitFor(() => {
      expect(screen.getByLabelText<HTMLInputElement>('Authorized redirect URI').value).toBe(CHROME_URI);
    });
    expect(clipboard.written).toEqual([CHROME_URI]);
  });

  it('Chrome: a refused identity prompt shows nothing and says why', async () => {
    const permissions = new FakePermissions();
    permissions.grantRequests = false;
    const { clipboard } = app({ permissions, uri: () => undefined });
    fireEvent.click(screen.getByRole('button', { name: 'Show and copy redirect URI' }));
    await screen.findByText(/The redirect URI needs the browser's sign-in permission/);
    expect(clipboard.written).toEqual([]);
  });

  it('a clipboard failure says to copy by hand', async () => {
    const { clipboard } = app({ uri: () => CHROME_URI });
    clipboard.fail = true;
    fireEvent.click(screen.getByRole('button', { name: 'Copy redirect URI' }));
    await screen.findByText(/Could not copy automatically/);
  });

  it('Firefox: shows the loopback address and says the Desktop app client needs none', () => {
    app({ uri: () => FF_URI, firefox: true });
    expect(screen.getByLabelText<HTMLInputElement>('Authorized redirect URI').value).toBe(FF_URI);
    expect(screen.getByText(/Desktop app client needs no redirect URI/)).toBeTruthy();
  });
});

describe('T-119: Send a test event', () => {
  function app(opts: { auth?: AuthStatus; settings?: Settings; reply?: () => MsgReply<'calendar.testEvent'> }) {
    const fake = new FakeMessaging();
    fake.handle('calendar.status', () => opts.auth ?? status({ connected: true, grantedScopes: [SCOPE] }));
    fake.handle('settings.get', () => opts.settings ?? on());
    fake.handle('calendar.testEvent', () => (opts.reply ?? (() => ({ result: 'created-and-deleted' as const })))());
    render(h(GoogleSection, { client: fake, store: new MemStore(), now: () => NOW, permissions: new FakePermissions(), redirectUri: () => undefined }));
    return { fake };
  }
  function on(dryRun = false): Settings {
    const s = defaultSettings();
    return { ...s, calendar: { ...s.calendar, enabled: true }, dryRun: { ...s.dryRun, calendar: dryRun } };
  }
  const button = () => screen.getByRole<HTMLButtonElement>('button', { name: 'Send a test event' });

  it('is disabled until Google is connected', async () => {
    const { fake } = app({ auth: status() });
    await screen.findByText('Not connected');
    expect(button().disabled).toBe(true);
    expect(screen.getByText(/Connect Google and turn on calendar events to send a test event/)).toBeTruthy();
    fireEvent.click(button());
    expect(sent(fake, 'calendar.testEvent')).toHaveLength(0);
  });

  it('is disabled while calendar events are off', async () => {
    app({ settings: defaultSettings() });
    await screen.findByText('Connected');
    await waitFor(() => {
      expect(screen.getByLabelText<HTMLInputElement>('Add auction ends to Google Calendar').disabled).toBe(false);
    });
    expect(button().disabled).toBe(true);
  });

  it('connected with calendar on: sends calendar.testEvent once and reports success', async () => {
    const { fake } = app({});
    await waitFor(() => {
      expect(button().disabled).toBe(false);
    });
    fireEvent.click(button());
    await screen.findByText(/A test event was added to ShopGoodwill Auctions and deleted again/);
    expect(sent(fake, 'calendar.testEvent')).toHaveLength(1);
  });

  it('in calendar dry run, says beforehand and afterwards that nothing is written', async () => {
    app({ settings: on(true), reply: () => ({ result: 'dry-run' }) });
    await screen.findByText(/Calendar dry run is on, so the test writes nothing to Google/);
    await waitFor(() => {
      expect(button().disabled).toBe(false);
    });
    fireEvent.click(button());
    await screen.findByText(/Dry run: nothing was written to Google/);
  });

  it('shows a refusal as an error', async () => {
    app({
      reply: () => {
        throw new Error('calendar writes are off: kill switch is on');
      },
    });
    await waitFor(() => {
      expect(button().disabled).toBe(false);
    });
    fireEvent.click(button());
    await screen.findByText(/Could not send the test event\. .*kill switch/);
  });
});
