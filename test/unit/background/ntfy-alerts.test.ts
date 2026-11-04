// R-3: priority-2 notifications are mirrored to ntfy at once. Fakes only: the
// FakeHttp answers only what a test scripts, so nothing leaves the process.
// Placeholders only: never a real server, topic or token.
import { describe, expect, it } from 'vitest';

import { mirroredNotify, NotifyMirrorList } from '../../../src/background/context';
import { createNtfyAlertMirror, type NtfyAlertSettings } from '../../../src/background/jobs/ntfy-alerts';
import { HttpNetworkError } from '../../../src/ports/errors';
import type { HttpRequest } from '../../../src/ports/http';
import type { Notification } from '../../../src/ports/notifier';
import { FakeAuditLog } from '../../fakes/ports/fake-audit-log';
import { FakeClock } from '../../fakes/ports/fake-clock';
import { FakeHttp } from '../../fakes/ports/fake-http';
import { FakeNotifier } from '../../fakes/ports/fake-notifier';
import { FakePermissions } from '../../fakes/ports/fake-permissions';

const SERVER = 'https://ntfy.example.com';
const TOPIC = 'sbw-abcdefghijklmnopqrstuvwxyz';
const TOKEN = 'tk_placeholdertokenplaceholder0';
const PATTERN = `${SERVER}/*`;

const ALERT: Notification = {
  id: 'sbw:snipe:s1:unconfirmed',
  title: 'Unconfirmed: Pyrex bowl',
  message: 'Check the item on ShopGoodwill.',
  priority: 2,
  openUrlOnClick: 'https://shopgoodwill.com/item/7',
};

/** Drains pending promise callbacks (no fake time passes). */
const flush = async (rounds = 10): Promise<void> => {
  for (let i = 0; i < rounds; i++) await Promise.resolve();
};

function setup(over: { view?: Partial<NtfyAlertSettings>; ntfy?: Partial<NonNullable<NtfyAlertSettings['ntfy']>>; granted?: boolean } = {}) {
  const clock = new FakeClock();
  const http = new FakeHttp(clock);
  const sentAt: number[] = [];
  const recording = {
    send: (req: HttpRequest) => {
      sentAt.push(clock.monotonic());
      return http.send(req);
    },
  };
  http.on(SERVER, { status: 200 });
  const audit = new FakeAuditLog(clock);
  const permissions = new FakePermissions(over.granted === false ? {} : { origins: [PATTERN] });
  const view: NtfyAlertSettings = {
    ntfy: { enabled: true, server: SERVER, topic: TOPIC, ...over.ntfy },
    ...over.view,
  };
  const mirror = createNtfyAlertMirror({
    http: recording,
    clock,
    permissions,
    audit,
    settings: () => Promise.resolve(structuredClone(view)),
  });
  return { clock, http, audit, permissions, mirror, sentAt };
}

describe('the ntfy alert mirror', () => {
  it('priority 2 → one POST <server>/<topic>, priority 5, no delay; audits ntfy.alert with id and title only', async () => {
    const t = setup();
    await t.mirror(ALERT);
    expect(t.http.requests).toHaveLength(1);
    const req = t.http.requests[0];
    expect(req?.method).toBe('POST');
    expect(req?.url).toBe(`${SERVER}/${TOPIC}`);
    expect(req?.headers?.['X-Title']).toBe(ALERT.title);
    expect(req?.headers?.['X-Priority']).toBe('5');
    expect(req?.headers?.['X-Click']).toBe(ALERT.openUrlOnClick);
    expect(req?.headers).not.toHaveProperty('X-Delay');
    expect(req?.headers).not.toHaveProperty('Authorization');
    expect(req?.body).toBe(ALERT.message);
    expect(t.audit.entries).toHaveLength(1);
    const row = t.audit.entries[0];
    expect(row?.kind).toBe('ntfy.alert');
    expect(row?.details).toEqual({ id: ALERT.id, title: ALERT.title });
    expect(JSON.stringify(t.audit.entries)).not.toContain(TOPIC);
  });

  it('sends the bearer header when a token is saved, and never audits it', async () => {
    const t = setup({ view: { token: TOKEN } });
    await t.mirror(ALERT);
    expect(t.http.requests[0]?.headers?.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(JSON.stringify(t.audit.entries)).not.toContain(TOKEN);
  });

  it('priority 1 or none → no request, no audit', async () => {
    const t = setup();
    await t.mirror({ ...ALERT, priority: 1 });
    await t.mirror({ id: ALERT.id, title: ALERT.title, message: ALERT.message });
    expect(t.http.requests).toHaveLength(0);
    expect(t.audit.entries).toHaveLength(0);
  });

  it('a closed gate → no request, no audit', async () => {
    const cases = [
      setup({ ntfy: { alerts: false } }),
      setup({ ntfy: { enabled: false } }),
      setup({ granted: false }),
      setup({ ntfy: { server: 'http://ntfy.example.com' } }),
      setup({ ntfy: { topic: '' } }),
      setup({ view: { ntfy: undefined } }),
    ];
    for (const t of cases) {
      await t.mirror(ALERT);
      expect(t.http.requests).toHaveLength(0);
      expect(t.audit.entries).toHaveLength(0);
    }
  });

  it('alerts absent (a record saved before R-3) counts as on', async () => {
    const t = setup();
    await t.mirror(ALERT);
    expect(t.http.requests).toHaveLength(1);
  });

  it('a rejected send: the browser notification resolved first, ntfy.alert.failed audited with the error kind, nothing thrown', async () => {
    const t = setup();
    t.http.on(SERVER, { error: new HttpNetworkError(`failed ${SERVER}/${TOPIC}`) });
    const order: string[] = [];
    const notifier = new FakeNotifier();
    const base = {
      notify: async (n: Notification) => {
        const id = await notifier.notify(n);
        order.push('browser');
        return id;
      },
    };
    const mirrors = new NotifyMirrorList();
    mirrors.add(async (n) => {
      order.push('mirror');
      await t.mirror(n);
    });
    await expect(mirroredNotify(base, mirrors, () => undefined)(ALERT)).resolves.toBe(ALERT.id);
    await flush();
    expect(order).toEqual(['browser', 'mirror']);
    expect(t.audit.kinds).toEqual(['ntfy.alert.failed']);
    expect(t.audit.entries[0]?.details).toEqual({ id: ALERT.id, error: 'network' });
    expect(JSON.stringify(t.audit.entries)).not.toContain(TOPIC);
  });

  it('a non-2xx answer is audited as ntfy.alert.failed with the status, and is not retried', async () => {
    const t = setup();
    t.http.on(SERVER, { status: 401 });
    await t.mirror(ALERT);
    expect(t.http.requests).toHaveLength(1);
    expect(t.audit.kinds).toEqual(['ntfy.alert.failed']);
    expect(t.audit.entries[0]?.details).toEqual({ id: ALERT.id, error: 'http 401' });
  });

  it('a settings read that throws is swallowed (no request, nothing thrown)', async () => {
    const clock = new FakeClock();
    const http = new FakeHttp(clock);
    const audit = new FakeAuditLog(clock);
    const mirror = createNtfyAlertMirror({
      http,
      clock,
      permissions: new FakePermissions({ origins: [PATTERN] }),
      audit,
      settings: () => Promise.reject(new Error('storage down')),
    });
    await expect(mirror(ALERT)).resolves.toBeUndefined();
    expect(http.requests).toHaveLength(0);
  });

  it('two alerts in a row are at least 1 s apart (pacer)', async () => {
    const t = setup();
    const first = t.mirror(ALERT);
    const second = t.mirror({ ...ALERT, id: 'sbw:snipe:s2:unconfirmed' });
    await first;
    await flush();
    expect(t.sentAt).toHaveLength(1);
    t.clock.advance(999);
    await flush();
    expect(t.sentAt).toHaveLength(1);
    t.clock.advance(1);
    await second;
    expect(t.sentAt).toHaveLength(2);
    expect((t.sentAt[1] ?? 0) - (t.sentAt[0] ?? 0)).toBeGreaterThanOrEqual(1000);
  });
});
