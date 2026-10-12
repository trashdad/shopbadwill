// T-69: the ntfy options section. The origin permission is requested from the
// click handler itself (R9); FakePermissions stands in for the browser.
import { announceSettingsSaved } from '../../src/entrypoints/options/settings-events';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { h } from 'preact';
import { afterEach, describe, expect, it } from 'vitest';

import { NTFY_SERVER, NTFY_ORIGIN } from '../../src/adapters/ntfy/ntfy-sink';
import { defaultSettings } from '../../src/domain/settings/defaults';
import type { Settings } from '../../src/domain/settings/schema';
import type { NtfyState } from '../../src/domain/storage/schema';
import { loadSections } from '../../src/entrypoints/options/registry';
import { NtfySection, section } from '../../src/entrypoints/options/sections/ntfy';
import type { Clock } from '../../src/ports/clock';
import type { Http, HttpResponse } from '../../src/ports/http';

interface NtfyScheduledStore {
  load(): Promise<NtfyState>;
  clear(): Promise<void>;
}
import { FakeClock } from '../fakes/ports/fake-clock';
import { FakeMessaging } from '../fakes/ports/fake-messaging';
import { FakePermissions } from '../fakes/ports/fake-permissions';

afterEach(cleanup);

const TOPIC = 'sbw-abcdefghijklmnopqrstuvwxyz';

const NEW_TOPIC = 'sbw-newtopicnewtopicnewtopic';

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
      8: {
        fingerprint: 'fp',
        entries: [{ seq: 'sbw-8-60-0', leadMin: 60, fireAt: 4, status: 'scheduled' }],
      },
    },
  };
}

function okResponse(): HttpResponse {
  return { status: 200, headers: {}, bodyText: '', startedAt: 0, endedAt: 0 };
}

/** Records DELETE order. `minIntervalMs: 0` so the click path does not need the clock. */
function recordingHttp(order: string[], status = 200): Http & { urls: string[] } {
  const urls: string[] = [];
  return {
    urls,
    send: (req) => {
      urls.push(req.url);
      order.push(`${req.method} ${req.url}`);
      return Promise.resolve({ ...okResponse(), status });
    },
  };
}

function memoryStore(seed: NtfyState | undefined, order: string[]): NtfyScheduledStore & { reads: number; clears: number } {
  let state: NtfyState = structuredClone(seed ?? { items: {} });
  const store = {
    reads: 0,
    clears: 0,
    load: () => {
      store.reads += 1;
      return Promise.resolve(structuredClone(state));
    },
    clear: () => {
      store.clears += 1;
      order.push('clear');
      state = { items: {} };
      return Promise.resolve();
    },
  };
  return store;
}

async function flush(clock: FakeClock, rounds = 30): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (clock.pendingTimers > 0) clock.advance(1000);
  }
}

function app(opts: {
  permissions?: FakePermissions;
  settings?: Settings;
  generate?: () => string;
  firefox?: boolean;
  clipboard?: { writeText(text: string): Promise<void> };
  scheduled?: NtfyScheduledStore;
  http?: Http;
  clock?: Clock;
  minIntervalMs?: number;
  order?: string[];
  /** settings.set fails (the background refused or is not responding). */
  saveFails?: boolean;
} = {}) {
  const fake = new FakeMessaging();
  const saved: unknown[] = [];
  const order = opts.order ?? [];
  let s = structuredClone(opts.settings ?? defaultSettings());
  fake.handle('settings.get', () => s);
  fake.handle('settings.set', (p) => {
    order.push('save');
    if (opts.saveFails === true) throw new Error('storage is full');
    saved.push(p);
    return undefined;
  });
  render(
    h(NtfySection, {
      client: fake,
      permissions: opts.permissions ?? new FakePermissions(),
      scheduled: opts.scheduled ?? memoryStore(undefined, order),
      ...(opts.http === undefined ? {} : { http: opts.http }),
      ...(opts.clock === undefined ? {} : { clock: opts.clock }),
      ...(opts.minIntervalMs === undefined ? {} : { minIntervalMs: opts.minIntervalMs }),
      ...(opts.generate === undefined ? {} : { generate: opts.generate }),
      ...(opts.firefox === undefined ? {} : { firefox: opts.firefox }),
      ...(opts.clipboard === undefined ? {} : { clipboard: opts.clipboard }),
    }),
  );
  /** Replaces what settings.get answers (a fresh object, as real messaging delivers). */
  const replySettings = (next: Settings): void => {
    s = next;
  };
  return { fake, saved, order, replySettings };
}

/** Phone push on, with calendar events on (the sink is fed by calendar sync). */
const ntfyOn = (topic = TOPIC): Settings => {
  const s = defaultSettings();
  return { ...s, calendar: { ...s.calendar, enabled: true }, ntfy: { enabled: true, server: NTFY_SERVER, topic } };
};

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

  it('turning phone push off DELETEs each stored scheduled seq, then clears sbw:ntfy, then saves off', async () => {
    const order: string[] = [];
    const http = recordingHttp(order);
    const scheduled = memoryStore(storedSeqs(), order);
    const permissions = new FakePermissions({ origins: [NTFY_ORIGIN] });
    const { saved } = app({
      permissions,
      settings: ntfyOn(),
      http,
      scheduled,
      minIntervalMs: 0,
      order,
    });
    fireEvent.click(await screen.findByLabelText('Phone push (ntfy.sh)'));
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
    expect(saved[0]).toEqual({ ntfy: { enabled: false, server: NTFY_SERVER, topic: TOPIC } });
    expect(scheduled.clears).toBe(1);
    expect(order.join('\n')).not.toContain('sbw-7-15-0');
  });

  it('paces those DELETEs at one per second from the click path', async () => {
    const clock = new FakeClock(1_750_000_000_000);
    const times: number[] = [];
    const http: Http = {
      send: (req) => {
        times.push(clock.monotonic());
        expect(req.method).toBe('DELETE');
        expect(req.url.startsWith(`${NTFY_SERVER}/${TOPIC}/`)).toBe(true);
        return Promise.resolve(okResponse());
      },
    };
    const { saved } = app({
      permissions: new FakePermissions({ origins: [NTFY_ORIGIN] }),
      settings: ntfyOn(),
      http,
      clock,
      scheduled: memoryStore(storedSeqs(), []),
      minIntervalMs: 1000,
    });
    fireEvent.click(await screen.findByLabelText('Phone push (ntfy.sh)'));
    await flush(clock);
    await waitFor(() => {
      expect(saved).toHaveLength(1);
    });
    expect(times).toHaveLength(3);
    for (let i = 1; i < times.length; i++) {
      expect((times[i] ?? 0) - (times[i - 1] ?? 0)).toBeGreaterThanOrEqual(1000);
    }
  });

  it('regenerating the topic DELETEs on the old topic, then saves the new one', async () => {
    const order: string[] = [];
    const { saved } = app({
      permissions: new FakePermissions({ origins: [NTFY_ORIGIN] }),
      settings: ntfyOn(),
      generate: () => NEW_TOPIC,
      http: recordingHttp(order),
      scheduled: memoryStore(storedSeqs(), order),
      minIntervalMs: 0,
      order,
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Generate topic' }));
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
    expect(saved[0]).toEqual({ ntfy: { enabled: true, server: NTFY_SERVER, topic: NEW_TOPIC } });
    expect((await screen.findByLabelText<HTMLInputElement>('Topic')).value).toBe(NEW_TOPIC);
    const status = await screen.findByRole('status');
    expect(status.textContent).not.toContain(TOPIC);
    expect(status.textContent).not.toContain(NEW_TOPIC);
    expect(status.textContent).toContain('…opic');
  });

  it('still turns phone push off when a DELETE fails, and says scheduled pushes may still arrive', async () => {
    const order: string[] = [];
    const scheduled = memoryStore(storedSeqs(), order);
    const { saved } = app({
      permissions: new FakePermissions({ origins: [NTFY_ORIGIN] }),
      settings: ntfyOn(),
      http: recordingHttp(order, 503),
      scheduled,
      minIntervalMs: 0,
      order,
    });
    fireEvent.click(await screen.findByLabelText('Phone push (ntfy.sh)'));
    const status = await screen.findByText(/already-scheduled pushes may still arrive/i);
    expect(saved).toHaveLength(1);
    expect(saved[0]).toEqual({ ntfy: { enabled: false, server: NTFY_SERVER, topic: TOPIC } });
    expect(order.filter((x) => x.startsWith('DELETE'))).toHaveLength(1);
    expect(order).not.toContain('clear');
    expect(scheduled.clears).toBe(0);
    expect(status.textContent).not.toContain(TOPIC);
  });

  it('keeps the old topic when regenerating cannot cancel, and does not clear stored seqs', async () => {
    const order: string[] = [];
    const { saved } = app({
      permissions: new FakePermissions({ origins: [NTFY_ORIGIN] }),
      settings: ntfyOn(),
      generate: () => NEW_TOPIC,
      http: recordingHttp(order, 500),
      scheduled: memoryStore(storedSeqs(), order),
      minIntervalMs: 0,
      order,
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Generate topic' }));
    const status = await screen.findByText(/the topic was not changed/i);
    expect(status.textContent).toMatch(/could not be cancelled/i);
    expect(saved).toHaveLength(0);
    expect((await screen.findByLabelText<HTMLInputElement>('Topic')).value).toBe(TOPIC);
    expect(order).not.toContain('clear');
    expect(order.filter((x) => x.startsWith('DELETE'))).toHaveLength(1);
    expect(status.textContent).not.toContain(TOPIC);
    expect(status.textContent).not.toContain(NEW_TOPIC);
  });

  it('makes no request when the gate is closed, still turns off, and warns if seqs were stored', async () => {
    const closed = [
      { permissions: new FakePermissions(), server: NTFY_SERVER },
      { permissions: new FakePermissions({ origins: [NTFY_ORIGIN] }), server: 'https://evil.example' },
    ];
    for (const c of closed) {
      cleanup();
      const order: string[] = [];
      const { saved } = app({
        permissions: c.permissions,
        settings: { ...defaultSettings(), ntfy: { enabled: true, server: c.server, topic: TOPIC } },
        http: recordingHttp(order),
        scheduled: memoryStore(storedSeqs(), order),
        minIntervalMs: 0,
        order,
      });
      fireEvent.click(await screen.findByLabelText('Phone push (ntfy.sh)'));
      await screen.findByText(/already-scheduled pushes may still arrive/i);
      expect(order.filter((x) => x.startsWith('DELETE'))).toHaveLength(0);
      expect(saved).toHaveLength(1);
      expect((saved[0] as { ntfy: { enabled: boolean } }).ntfy.enabled).toBe(false);
    }
  });

  it('says phone push is now off when a DELETE fails, not only that pushes may arrive', async () => {
    const { saved } = app({
      permissions: new FakePermissions({ origins: [NTFY_ORIGIN] }),
      settings: ntfyOn(),
      http: recordingHttp([], 503),
      scheduled: memoryStore(storedSeqs(), []),
      minIntervalMs: 0,
    });
    fireEvent.click(await screen.findByLabelText('Phone push (ntfy.sh)'));
    const status = await screen.findByText(/already-scheduled pushes may still arrive/i);
    expect(saved).toHaveLength(1);
    expect(status.textContent).toMatch(/phone push is off/i);
  });

  it('keeps the save error when turning off cannot cancel and cannot save either', async () => {
    app({
      permissions: new FakePermissions({ origins: [NTFY_ORIGIN] }),
      settings: ntfyOn(),
      http: recordingHttp([], 503),
      scheduled: memoryStore(storedSeqs(), []),
      minIntervalMs: 0,
      saveFails: true,
    });
    const toggle = await screen.findByLabelText<HTMLInputElement>('Phone push (ntfy.sh)');
    fireEvent.click(toggle);
    // Settled: the button is usable again and the toggle went back on.
    await waitFor(() => {
      expect(toggle.disabled).toBe(false);
      expect(screen.getByRole('status').textContent).toMatch(/may still arrive/i);
    });
    const text = screen.getByRole('status').textContent;
    expect(text).toMatch(/could not save phone push/i);
    expect(text).not.toMatch(/phone push is off/i);
    expect(toggle.checked).toBe(true);
  });

  it('the Firefox note does not claim the browser asks for anything', async () => {
    app({ settings: ntfyOn(), firefox: true });
    const note = (await screen.findByText(/technicalAndInteraction/)).closest('p');
    expect(note?.textContent).not.toMatch(/\basks?\b/i);
    expect(note?.textContent).toMatch(/titles and end times/i);
  });

  it('warns that no new pushes are scheduled while calendar events are off, and points at the toggle (T-70b)', async () => {
    const off = defaultSettings();
    app({ settings: { ...off, calendar: { ...off.calendar, enabled: false }, ntfy: { enabled: true, server: NTFY_SERVER, topic: TOPIC } } });
    const note = (await screen.findByText(/calendar events are off/i)).textContent;
    // Pushes ntfy.sh already holds still fire, so the note does not claim nothing is sent.
    expect(note).toMatch(/no new pushes are scheduled/i);
    expect(note).not.toMatch(/nothing is sent/i);
    expect(note).toMatch(/Turn them on in the Google Calendar section\./);
    cleanup();

    app({ settings: ntfyOn() });
    await screen.findByText('Auction titles and end times are sent to ntfy.sh.');
    expect(screen.queryByText(/calendar events are off/i)).toBeNull();
  });

  it('turning phone push on, or off with nothing scheduled, makes no request', async () => {
    const order: string[] = [];
    const { saved } = app({ http: recordingHttp(order), minIntervalMs: 0, order, scheduled: memoryStore(undefined, order) });
    fireEvent.click(await screen.findByLabelText('Phone push (ntfy.sh)'));
    await waitFor(() => {
      expect(saved).toHaveLength(1);
    });
    expect(order).toEqual(['save']);

    cleanup();
    const offOrder: string[] = [];
    const second = app({
      permissions: new FakePermissions({ origins: [NTFY_ORIGIN] }),
      settings: ntfyOn(),
      http: recordingHttp(offOrder),
      scheduled: memoryStore(
        { items: { 7: { fingerprint: 'fp', entries: [{ seq: 'sbw-7-60-0', leadMin: 60, fireAt: 1, status: 'deferred' }] } } },
        offOrder,
      ),
      minIntervalMs: 0,
      order: offOrder,
    });
    fireEvent.click(await screen.findByLabelText('Phone push (ntfy.sh)'));
    await waitFor(() => {
      expect(second.saved).toHaveLength(1);
    });
    expect(offOrder.filter((x) => x.startsWith('DELETE'))).toHaveLength(0);
    expect(offOrder).toContain('clear');
    expect(offOrder.at(-1)).toBe('save');
  });
});

describe('T-70c: live settings', () => {
  it('the calendar-off note clears when calendar events are turned on elsewhere on the page', async () => {
    const off = defaultSettings();
    const { replySettings } = app({ settings: { ...off, calendar: { ...off.calendar, enabled: false }, ntfy: { enabled: true, server: NTFY_SERVER, topic: TOPIC } } });
    await screen.findByText(/calendar events are off/i);
    replySettings({ ...off, calendar: { ...off.calendar, enabled: true }, ntfy: { enabled: true, server: NTFY_SERVER, topic: TOPIC } });
    announceSettingsSaved();
    await waitFor(() => {
      expect(screen.queryByText(/calendar events are off/i)).toBeNull();
    });
  });
});
