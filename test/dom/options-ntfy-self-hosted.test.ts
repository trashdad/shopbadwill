// T-123: the Phone push section with a self-hosted ntfy server and an access
// token. Fakes only: no request leaves the test (the Http port is a recorder),
// and every host is a placeholder.
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { h } from 'preact';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { NTFY_ORIGIN, NTFY_SERVER } from '../../src/adapters/ntfy/ntfy-sink';
import { defaultSettings } from '../../src/domain/settings/defaults';
import type { Settings } from '../../src/domain/settings/schema';
import type { NtfyState } from '../../src/domain/storage/schema';
import { NtfySection } from '../../src/entrypoints/options/sections/ntfy';
import type { NtfyAuthStore } from '../../src/entrypoints/options/sections/ntfy/auth-store';
import { HttpNetworkError } from '../../src/ports/errors';
import type { Http } from '../../src/ports/http';
import { FakeMessaging } from '../fakes/ports/fake-messaging';
import { FakePermissions } from '../fakes/ports/fake-permissions';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const TOPIC = 'sbw-abcdefghijklmnopqrstuvwxyz';
const SELF = 'https://ntfy.example.com';
const SELF_PATTERN = 'https://ntfy.example.com/*';
const OLD_TOKEN = 'tk_placeholderoldtoken0000aaaa';
const NEW_TOKEN = 'tk_placeholdernewtoken0000zzzz';

interface Sent {
  method: string;
  url: string;
  headers: Record<string, string>;
}

function storedSeqs(): NtfyState {
  return {
    items: {
      7: {
        fingerprint: 'fp',
        entries: [
          { seq: 'sbw-7-60-0', leadMin: 60, fireAt: 1, status: 'scheduled' },
          { seq: 'sbw-7-15-0', leadMin: 15, fireAt: 2, status: 'deferred' },
          { seq: 'sbw-7-5-0', leadMin: 5, fireAt: 3, status: 'scheduled' },
        ],
      },
      8: { fingerprint: 'fp', entries: [{ seq: 'sbw-8-60-0', leadMin: 60, fireAt: 4, status: 'scheduled' }] },
    },
  };
}

/** Records each request in full; `answer` gives the status, or an error to reject with. */
function fullHttp(order: string[], answer: (req: Sent) => number | Error = () => 200): Http & { sent: Sent[] } {
  const sent: Sent[] = [];
  return {
    sent,
    send: (req) => {
      const s = { method: req.method, url: req.url, headers: { ...(req.headers ?? {}) } };
      sent.push(s);
      order.push(`${req.method} ${req.url}`);
      const a = answer(s);
      if (a instanceof Error) return Promise.reject(a);
      return Promise.resolve({ status: a, headers: {}, bodyText: '', startedAt: 0, endedAt: 0 });
    },
  };
}

function memoryAuth(token: string | undefined, order: string[]): NtfyAuthStore & { value: string | undefined } {
  const store = {
    value: token,
    load: () => Promise.resolve({ tokenTail: store.value === undefined ? null : store.value.slice(-4) }),
    token: () => Promise.resolve(store.value),
    save: (t: string) => {
      order.push('save-token');
      store.value = t;
      return Promise.resolve();
    },
    remove: () => {
      order.push('remove-token');
      store.value = undefined;
      return Promise.resolve();
    },
  };
  return store;
}

function memoryScheduled(seed: NtfyState | undefined, order: string[]) {
  let state: NtfyState = structuredClone(seed ?? { items: {} });
  const store = {
    clears: 0,
    load: () => Promise.resolve(structuredClone(state)),
    clear: () => {
      store.clears += 1;
      order.push('clear');
      state = { items: {} };
      return Promise.resolve();
    },
  };
  return store;
}

const ntfyOnAt = (server: string, topic = TOPIC): Settings => {
  const s = defaultSettings();
  return { ...s, calendar: { ...s.calendar, enabled: true }, ntfy: { enabled: true, server, topic } };
};
const ntfyOffAt = (server: string): Settings => ({ ...defaultSettings(), ntfy: { enabled: false, server, topic: '' } });

function selfApp(
  opts: {
    settings?: Settings;
    token?: string;
    granted?: string[];
    scheduled?: NtfyState;
    answer?: (req: Sent) => number | Error;
  } = {},
) {
  const order: string[] = [];
  const http = fullHttp(order, opts.answer);
  const auth = memoryAuth(opts.token, order);
  const permissions = new FakePermissions({ origins: opts.granted ?? [SELF_PATTERN] });
  const fake = new FakeMessaging();
  const saved: unknown[] = [];
  const s = structuredClone(opts.settings ?? ntfyOnAt(SELF));
  fake.handle('settings.get', () => s);
  fake.handle('settings.set', (p) => {
    order.push('save');
    saved.push(p);
    return undefined;
  });
  const scheduled = memoryScheduled(opts.scheduled, order);
  render(h(NtfySection, { client: fake, permissions, scheduled, http, auth, minIntervalMs: 0 }));
  return { order, http, auth, permissions, saved, scheduled };
}

async function typeServer(value: string): Promise<void> {
  fireEvent.input(await screen.findByLabelText<HTMLInputElement>('Server'), { target: { value } });
  fireEvent.click(screen.getByRole('button', { name: 'Save server' }));
}

async function typeToken(value: string): Promise<void> {
  fireEvent.input(await screen.findByLabelText<HTMLInputElement>('Access token (optional)'), { target: { value } });
  fireEvent.click(screen.getByRole('button', { name: 'Save token' }));
}

describe('T-123: the server field', () => {
  it('shows the server (default https://ntfy.sh) and the optional token field, even while phone push is off', async () => {
    selfApp({ settings: defaultSettings() });
    expect((await screen.findByLabelText<HTMLInputElement>('Server')).value).toBe(NTFY_SERVER);
    const token = screen.getByLabelText<HTMLInputElement>('Access token (optional)');
    expect(token.type).toBe('password');
    expect(token.value).toBe('');
  });

  it.each([
    ['http://ntfy.example.com', /plain http is not allowed/i],
    ['https://ntfy.example.com/sbw-topic', /no path/i],
    ['https://user:pw@ntfy.example.com', /user name and password/i],
    ['', /enter the server address/i],
  ])('refuses %j with a validation message and saves nothing', async (value, message) => {
    const { saved, order } = selfApp({ settings: ntfyOffAt(NTFY_SERVER) });
    await typeServer(value);
    expect((await screen.findByText(message)).textContent).not.toContain('pw@');
    expect(saved).toHaveLength(0);
    expect(order).toEqual([]);
  });

  it('saves a new server while phone push is off: normalized, no request', async () => {
    const { saved, order } = selfApp({ settings: ntfyOffAt(NTFY_SERVER) });
    await typeServer('  HTTPS://NTFY.Example.com/ ');
    await waitFor(() => {
      expect(saved).toEqual([{ ntfy: { enabled: false, server: SELF, topic: '' } }]);
    });
    expect(order).toEqual(['save']);
  });

  it('says so when the server is unchanged, and sends nothing', async () => {
    const { saved, order } = selfApp();
    await typeServer(`${SELF}/`);
    expect(await screen.findByText(/already the server/i)).toBeTruthy();
    expect(saved).toHaveLength(0);
    expect(order).toEqual([]);
  });

  it('a server change cancels the scheduled seqs on the OLD server with the OLD token, clears, then saves', async () => {
    const { saved, order, http, scheduled } = selfApp({
      settings: ntfyOnAt(NTFY_SERVER),
      token: OLD_TOKEN,
      granted: [NTFY_ORIGIN],
      scheduled: storedSeqs(),
    });
    await typeServer(SELF);
    await waitFor(() => {
      expect(saved).toHaveLength(1);
    });
    expect(order).toEqual([
      `DELETE ${NTFY_SERVER}/${TOPIC}/sbw-7-60-0`,
      `DELETE ${NTFY_SERVER}/${TOPIC}/sbw-7-5-0`,
      `DELETE ${NTFY_SERVER}/${TOPIC}/sbw-8-60-0`,
      'clear',
      'save',
    ]);
    expect(http.sent.every((x) => x.headers.Authorization === `Bearer ${OLD_TOKEN}`)).toBe(true);
    expect(saved[0]).toEqual({ ntfy: { enabled: true, server: SELF, topic: TOPIC } });
    expect(scheduled.clears).toBe(1);
  });

  it('keeps the old server when its scheduled pushes cannot be cancelled', async () => {
    const { saved, order } = selfApp({
      settings: ntfyOnAt(NTFY_SERVER),
      granted: [NTFY_ORIGIN],
      scheduled: storedSeqs(),
      answer: () => 503,
    });
    await typeServer(SELF);
    const status = await screen.findByText(/the server was not changed/i);
    expect(status.textContent).toMatch(/could not be cancelled/i);
    expect(saved).toHaveLength(0);
    expect(order).not.toContain('clear');
    expect(screen.getByLabelText<HTMLInputElement>('Server').value).toBe(SELF); // the draft stays for a retry
  });

  it('asks for exactly the configured origin, and names its host', async () => {
    const { permissions } = selfApp({ granted: [] });
    fireEvent.click(await screen.findByRole('button', { name: 'Allow ntfy.example.com' }));
    expect(permissions.requested).toEqual([{ origins: [SELF_PATTERN] }]);
    expect(await screen.findByText('ShopBadwill may reach ntfy.example.com.')).toBeTruthy();
    expect(screen.getByText('Auction titles and end times are sent to ntfy.example.com.')).toBeTruthy();
  });

  it('after a server change the permission card follows the new host', async () => {
    selfApp({ settings: ntfyOnAt(NTFY_SERVER), granted: [NTFY_ORIGIN] });
    await screen.findByText('ShopBadwill may reach ntfy.sh.');
    await typeServer(SELF);
    expect(await screen.findByRole('button', { name: 'Allow ntfy.example.com' })).toBeTruthy();
  });

  it('a saved server that is not a valid https origin is flagged, and phone push stays off for it', async () => {
    selfApp({ settings: ntfyOnAt('http://ntfy.example.com') });
    expect(await screen.findByText(/saved server is not a valid https address/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Send a test push' })).toBeNull();
  });
});

describe('T-123: the access token', () => {
  it('saves a pasted token, clears the field and shows only its last 4 characters', async () => {
    const { auth, order } = selfApp({ settings: ntfyOffAt(SELF) });
    await typeToken(`  ${NEW_TOKEN}  `);
    await waitFor(() => {
      expect(auth.value).toBe(NEW_TOKEN);
    });
    expect(order).toEqual(['save-token']);
    const field = await screen.findByLabelText<HTMLInputElement>('Access token (optional)');
    await waitFor(() => {
      expect(field.value).toBe('');
    });
    expect(await screen.findByText('Saved token: ••••zzzz')).toBeTruthy();
    expect(field.placeholder).toBe('Saved: ••••zzzz');
    expect(document.body.textContent).not.toContain(NEW_TOKEN);
    expect(document.body.innerHTML).not.toContain(NEW_TOKEN);
  });

  it('shows a saved token masked on load, and can remove it', async () => {
    const { auth } = selfApp({ settings: ntfyOffAt(SELF), token: OLD_TOKEN });
    expect(await screen.findByText('Saved token: ••••aaaa')).toBeTruthy();
    expect(document.body.innerHTML).not.toContain(OLD_TOKEN);
    fireEvent.click(screen.getByRole('button', { name: 'Remove token' }));
    await waitFor(() => {
      expect(auth.value).toBeUndefined();
    });
    await waitFor(() => {
      expect(screen.queryByText(/Saved token:/)).toBeNull();
    });
  });

  it('refuses a token with spaces, without echoing it', async () => {
    const { auth } = selfApp({ settings: ntfyOffAt(SELF) });
    await typeToken('tk_has a space');
    const status = await screen.findByText(/does not look like an access token/i);
    expect(status.textContent).not.toContain('tk_has');
    expect(auth.value).toBeUndefined();
  });

  it('a token change while on cancels with the OLD token, clears, then saves the new token', async () => {
    const { order, http, auth } = selfApp({ token: OLD_TOKEN, scheduled: storedSeqs() });
    await typeToken(NEW_TOKEN);
    await waitFor(() => {
      expect(auth.value).toBe(NEW_TOKEN);
    });
    expect(order).toEqual([
      `DELETE ${SELF}/${TOPIC}/sbw-7-60-0`,
      `DELETE ${SELF}/${TOPIC}/sbw-7-5-0`,
      `DELETE ${SELF}/${TOPIC}/sbw-8-60-0`,
      'clear',
      'save-token',
    ]);
    expect(http.sent.map((x) => x.headers.Authorization)).toEqual(Array(3).fill(`Bearer ${OLD_TOKEN}`));
  });

  it('removing the token while on cancels with it first', async () => {
    const { order } = selfApp({ token: OLD_TOKEN, scheduled: storedSeqs() });
    fireEvent.click(await screen.findByRole('button', { name: 'Remove token' }));
    await waitFor(() => {
      expect(order.at(-1)).toBe('remove-token');
    });
    expect(order.filter((x) => x.startsWith('DELETE'))).toHaveLength(3);
    expect(order.at(-2)).toBe('clear');
  });

  it('a token change still saves when the old token cannot cancel (the new one replaces them), and says so', async () => {
    const { order, auth } = selfApp({ token: OLD_TOKEN, scheduled: storedSeqs(), answer: () => 401 });
    await typeToken(NEW_TOKEN);
    const status = await screen.findByText(/could not be cancelled with the old token/i);
    expect(auth.value).toBe(NEW_TOKEN);
    expect(order.slice(-2)).toEqual(['clear', 'save-token']);
    expect(status.textContent).not.toContain(OLD_TOKEN);
    expect(status.textContent).not.toContain(NEW_TOKEN);
  });
});

describe('T-123: Send a test push', () => {
  async function sendTest(): Promise<HTMLElement> {
    fireEvent.click(await screen.findByRole('button', { name: 'Send a test push' }));
    return waitFor(() => {
      const el = screen.getByRole('status');
      if (el.textContent === '') throw new Error('no status yet');
      return el;
    });
  }

  it('200: publishes one immediate message to the configured server and topic, with the token', async () => {
    const { http } = selfApp({ token: NEW_TOKEN });
    const status = await sendTest();
    expect(status.textContent).toMatch(/test push sent/i);
    expect(http.sent).toHaveLength(1);
    const [req] = http.sent;
    expect(req?.method).toBe('POST');
    expect(req?.url).toBe(`${SELF}/${TOPIC}`);
    expect(req?.headers.Authorization).toBe(`Bearer ${NEW_TOKEN}`);
    expect(req?.headers).not.toHaveProperty('X-Delay');
  });

  it('without a token sends no Authorization header', async () => {
    const { http } = selfApp();
    await sendTest();
    expect(http.sent[0]?.headers).not.toHaveProperty('Authorization');
  });

  it.each([401, 403])('%i: says the server refused the token', async (code) => {
    selfApp({ token: NEW_TOKEN, answer: () => code });
    const status = await sendTest();
    expect(status.textContent).toBe('Problem: The server refused the token. Check the token and that it may write to this topic.');
  });

  it('401 without a token: says the server needs one', async () => {
    selfApp({ answer: () => 401 });
    const status = await sendTest();
    expect(status.textContent).toMatch(/needs an access token/i);
  });

  it('a network error: says the server could not be reached, without the topic or token', async () => {
    selfApp({ token: NEW_TOKEN, answer: () => new HttpNetworkError(`Failed to fetch ${SELF}/${TOPIC}`) });
    const status = await sendTest();
    expect(status.textContent).toMatch(/could not reach ntfy\.example\.com/i);
    expect(status.textContent).not.toContain(TOPIC);
    expect(status.textContent).not.toContain(NEW_TOKEN);
  });

  it.each([
    [429, /limiting requests/i],
    [502, /had a problem \(HTTP 502\)/i],
    [404, /HTTP 404/],
  ] as const)('%i in plain words', async (code, text) => {
    selfApp({ answer: () => code });
    expect((await sendTest()).textContent).toMatch(text);
  });

  it('makes no request until the host is allowed, and says what to do', async () => {
    const { http } = selfApp({ granted: [] });
    const status = await sendTest();
    expect(status.textContent).toMatch(/allow ntfy\.example\.com first/i);
    expect(http.sent).toHaveLength(0);
  });

  it('sends nothing while the kill switch is on', async () => {
    const { http } = selfApp({ settings: { ...ntfyOnAt(SELF), killSwitch: true } });
    const status = await sendTest();
    expect(status.textContent).toMatch(/kill switch/i);
    expect(http.sent).toHaveLength(0);
  });

  it('the token never reaches the console on any test-push path', async () => {
    const spies = (['log', 'warn', 'error', 'info', 'debug'] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(() => undefined),
    );
    for (const answer of [() => 200, () => 401, () => 500, () => new HttpNetworkError('boom')]) {
      cleanup();
      selfApp({ token: NEW_TOKEN, answer });
      await sendTest();
    }
    for (const s of spies) expect(s.mock.calls.flat().map(String).join('\n')).not.toContain(NEW_TOKEN);
  });
});
