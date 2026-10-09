// T-28: SessionAdapter (PLAN §3.3 SgwSession). FakeStorage, FakeClock and
// FakeAuditLog only; no network. Rulings: R1 72 h `expiring`, R2 reportRejected,
// R3 401 = expired (not cleared), R4 refresh off, R5 claims, R6 no leaks.
import { describe, expect, it, vi } from 'vitest';

import {
  SBW_SESSION_REFRESH,
  SESSION_EXPIRING_MS,
  SgwSessionAdapter,
} from '../../../../src/adapters/sgw/session-adapter';
import { Repo } from '../../../../src/domain/storage/repo';
import { STORAGE_KEYS } from '../../../../src/domain/storage/schema';
import { FakeAuditLog } from '../../../fakes/ports/fake-audit-log';
import { FakeClock } from '../../../fakes/ports/fake-clock';
import { FakeStorage } from '../../../fakes/ports/fake-storage';

const T0 = Date.UTC(2026, 9, 9, 12, 0, 0);
const H = 3_600_000;
const DAY = 24 * H;

const b64u = (o: unknown): string => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64url');

/** A fake JWT. The signature is filler; nothing here is a real secret. */
function jwt(claims: Record<string, unknown>, sig = 'Zm9vYmFyU0lHTkFUVVJFX0ZJTExFUl9YWVo'): string {
  return `${b64u({ alg: 'HS256', typ: 'JWT' })}.${b64u(claims)}.${sig}`;
}
const expSec = (ms: number): number => Math.floor(ms / 1000);

let tokenCounter = 0;
/** A distinct valid token for `buyerId` that expires `inMs` from T0. */
function mint(buyerId: string, inMs: number, extra: Record<string, unknown> = {}): string {
  tokenCounter += 1;
  return jwt({ jti: `jti-secret-${String(tokenCounter)}-abcdefghijklmnop`, BuyerId: buyerId, exp: expSec(T0 + inMs), ...extra });
}

// R6: spies live for the whole file and are checked by the last test.
const logSpies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) =>
  vi.spyOn(console, m).mockImplementation(() => undefined),
);
const seenBearers = new Set<string>();
const audits: FakeAuditLog[] = [];

function setup(opts: { refresh?: boolean; refresher?: () => Promise<string | null> } = {}) {
  const clock = new FakeClock(T0);
  const storage = new FakeStorage();
  const repo = new Repo({ local: storage, session: new FakeStorage() }, clock);
  const audit = new FakeAuditLog(clock);
  audits.push(audit);
  const session = new SgwSessionAdapter({
    repo,
    clock,
    audit,
    ...(opts.refresh === undefined ? {} : { refreshEnabled: opts.refresh }),
    ...(opts.refresher === undefined ? {} : { refresher: opts.refresher }),
  });
  const observe = (bearer: string, source: 'tap' | 'webRequest' = 'tap') => {
    seenBearers.add(bearer);
    return session.observe({ bearer, capturedAt: clock.now(), source });
  };
  /** SGW refused `bearer` (default: the token the session holds now). */
  const reject = async (bearer?: string) =>
    session.reportRejected(bearer ?? (await repo.find(STORAGE_KEYS.sgwSession))?.bearer ?? 'none');
  return { clock, storage, repo, audit, session, observe, reject };
}

describe('constants', () => {
  it('R1: expiring threshold is 72 h', () => {
    expect(SESSION_EXPIRING_MS).toBe(72 * 3_600_000);
  });
  it('R4: refresh is off per S-2', () => {
    expect(SBW_SESSION_REFRESH).toBe(false);
  });
});

describe('observe: stores, validates', () => {
  it('stores the token, exposes it via current() and takes expiresAt from exp', async () => {
    const t = setup();
    const bearer = mint('B-1', 30 * DAY);
    await t.observe(bearer);
    const cur = await t.session.current();
    expect(cur).toEqual({ bearer, expiresAt: expSec(T0 + 30 * DAY) * 1000, buyerId: 'B-1' });
    const stored = await t.storage.get<Record<string, unknown>>(STORAGE_KEYS.sgwSession);
    expect(stored).toMatchObject({ bearer, buyerId: 'B-1', source: 'tap', capturedAt: T0 });
    expect(stored?.refreshToken).toBeUndefined();
  });

  it('does not require iat and stores no other claims', async () => {
    const t = setup();
    await t.observe(mint('B-1', 10 * DAY, { IpAddress: '1.2.3.4', BuyerSession: 'sess-secret-value-1234567890' }));
    expect(await t.session.state()).toBe('ok');
    const text = JSON.stringify(t.storage.dump()) + (await t.audit.exportJson());
    expect(text).not.toContain('sess-secret-value');
    expect(text).not.toContain('1.2.3.4');
  });

  it('accepts a numeric BuyerId and a "Bearer " prefix', async () => {
    const t = setup();
    const raw = jwt({ BuyerId: 987654, exp: expSec(T0 + 10 * DAY) });
    await t.observe(`Bearer ${raw}`);
    expect(await t.session.current()).toMatchObject({ bearer: raw, buyerId: '987654' });
  });

  const goodPayload = b64u({ BuyerId: 'B', exp: expSec(T0 + DAY) });
  it.each([
    ['two parts', 'abc.def', 'not-three-parts'],
    ['four parts', 'a.b.c.d', 'not-three-parts'],
    ['empty string', '', 'empty'],
    ['non-base64url chars', 'a b.c$d.e!f', 'not-base64url'],
    ['valid payload, bad header characters', `he$der.${goodPayload}.sig`, 'not-base64url'],
    ['valid payload, bad signature characters', `${b64u({ alg: 'x' })}.${goodPayload}.si+g=`, 'not-base64url'],
    ['valid payload, empty signature', `${b64u({ alg: 'x' })}.${goodPayload}.`, 'not-base64url'],
    ['payload not JSON', `${b64u({ alg: 'x' })}.${b64u('not json')}.sig`, 'payload-not-json-object'],
    ['payload is an array', `${b64u({})}.${b64u('[1,2]')}.sig`, 'payload-not-json-object'],
    ['missing exp', jwt({ BuyerId: 'B' }), 'bad-exp'],
    ['string exp', jwt({ BuyerId: 'B', exp: '1999999999' }), 'bad-exp'],
    ['null exp', jwt({ BuyerId: 'B', exp: null }), 'bad-exp'],
    ['exp in ms units', jwt({ BuyerId: 'B', exp: T0 + 30 * DAY }), 'bad-exp'],
    ['missing BuyerId', jwt({ exp: expSec(T0 + DAY) }), 'bad-buyer-id'],
    ['blank BuyerId', jwt({ BuyerId: '  ', exp: expSec(T0 + DAY) }), 'bad-buyer-id'],
    ['already expired', jwt({ BuyerId: 'B', exp: expSec(T0 - 1000) }), 'already-expired'],
    ['oversized', `${'a'.repeat(9000)}.b.c`, 'too-long'],
  ])('rejects %s silently, with a non-secret audit reason', async (_n, bearer, reason) => {
    const t = setup();
    await expect(t.observe(bearer)).resolves.toBeUndefined();
    expect(await t.session.current()).toBeNull();
    expect(await t.session.state()).toBe('logged-out');
    expect(await t.storage.get(STORAGE_KEYS.sgwSession)).toBeUndefined();
    const e = t.audit.entries.filter((x) => x.kind === 'session.token-rejected');
    expect(e).toHaveLength(1);
    expect(e[0]?.details.reason).toBe(reason);
  });

  it('a bad token never displaces a good stored one', async () => {
    const t = setup();
    const good = mint('B-1', 10 * DAY);
    await t.observe(good);
    await t.observe('garbage');
    expect((await t.session.current())?.bearer).toBe(good);
  });

  it('re-observing the same bearer writes nothing and audits nothing more', async () => {
    const t = setup();
    const b = mint('B-1', 10 * DAY);
    await t.observe(b);
    const n = t.audit.entries.length;
    const set = vi.spyOn(t.storage, 'set');
    await t.observe(b);
    await t.observe(b);
    expect(set).not.toHaveBeenCalled();
    expect(t.audit.entries).toHaveLength(n);
  });

  it('a newer token for the same BuyerId replaces the old one', async () => {
    const t = setup();
    await t.observe(mint('B-1', 5 * DAY));
    const newer = mint('B-1', 30 * DAY);
    await t.observe(newer, 'webRequest');
    expect((await t.session.current())?.bearer).toBe(newer);
    expect(await t.storage.get(STORAGE_KEYS.sgwSession)).toMatchObject({ source: 'webRequest' });
  });

  it('survives a restart: a new adapter over the same storage sees the session', async () => {
    const t = setup();
    const b = mint('B-1', 10 * DAY);
    await t.observe(b);
    const again = new SgwSessionAdapter({ repo: t.repo, clock: t.clock, audit: t.audit });
    expect((await again.current())?.bearer).toBe(b);
    expect(await again.state()).toBe('ok');
  });

  it('treats a corrupt stored record as no session', async () => {
    const t = setup();
    t.storage.seed({ [STORAGE_KEYS.sgwSession]: { bearer: 5 } });
    expect(await t.session.current()).toBeNull();
    expect(await t.session.state()).toBe('logged-out');
    expect(Object.keys(t.storage.dump()).some((k) => k.startsWith('sbw:quarantine:'))).toBe(true); // via the repo
  });
});

describe('BuyerId rule (tap data is untrusted)', () => {
  it('rejects a token for a different BuyerId while a session is held', async () => {
    const t = setup();
    const mine = mint('B-1', 10 * DAY);
    await t.observe(mine);
    await t.observe(mint('B-2', 30 * DAY));
    expect(await t.session.current()).toMatchObject({ buyerId: 'B-1', bearer: mine });
    expect(t.audit.entries.some((e) => e.kind === 'session.token-rejected' && e.details.reason === 'buyer-mismatch')).toBe(true);
  });

  it('still rejects a different BuyerId when the held session is rejected or expired', async () => {
    const t = setup();
    await t.observe(mint('B-1', 10 * DAY));
    await t.reject();
    await t.observe(mint('B-2', 30 * DAY));
    expect(await t.session.state()).toBe('expired');
    t.clock.advance(11 * DAY);
    await t.observe(mint('B-2', 40 * DAY));
    expect((await t.storage.get<{ buyerId: string }>(STORAGE_KEYS.sgwSession))?.buyerId).toBe('B-1');
  });

  it('accepts a different BuyerId once logged-out', async () => {
    const t = setup();
    await t.observe(mint('B-1', 10 * DAY));
    await t.session.clear();
    await t.observe(mint('B-2', 30 * DAY));
    expect(await t.session.current()).toMatchObject({ buyerId: 'B-2' });
    expect(await t.session.state()).toBe('ok');
  });
});

describe('state() by fake clock', () => {
  it('ok -> expiring (< 72 h) -> expired (exp) with exact boundaries', async () => {
    const t = setup();
    await t.observe(mint('B-1', 10 * DAY));
    const expiresAt = expSec(T0 + 10 * DAY) * 1000;
    expect(await t.session.state()).toBe('ok');
    t.clock.set(expiresAt - SESSION_EXPIRING_MS);
    expect(await t.session.state()).toBe('ok'); // exactly 72 h left is not "less than"
    t.clock.set(expiresAt - SESSION_EXPIRING_MS + 1);
    expect(await t.session.state()).toBe('expiring');
    expect(await t.session.current()).not.toBeNull(); // expiring is still usable
    t.clock.set(expiresAt - 1);
    expect(await t.session.state()).toBe('expiring');
    t.clock.set(expiresAt);
    expect(await t.session.state()).toBe('expired');
    expect(await t.session.current()).toBeNull();
  });

  it('is logged-out with no session', async () => {
    expect(await setup().session.state()).toBe('logged-out');
  });

  it('24 h left is expiring (R1: the old 12 h threshold is gone)', async () => {
    const t = setup();
    await t.observe(mint('B-1', 24 * H));
    expect(await t.session.state()).toBe('expiring');
  });

  it('an expired session keeps its BuyerId; a new token for it restores ok', async () => {
    const t = setup();
    await t.observe(mint('B-1', 2 * DAY));
    t.clock.advance(3 * DAY);
    expect(await t.session.state()).toBe('expired');
    await t.observe(jwt({ jti: 'fresh-j', BuyerId: 'B-1', exp: expSec(t.clock.now() + 30 * DAY) }));
    expect(await t.session.state()).toBe('ok');
  });
});

describe('reportRejected (R2, R3)', () => {
  it('401 -> reportRejected -> expired, not cleared: record and BuyerId kept, current() null', async () => {
    const t = setup();
    await t.observe(mint('B-1', 20 * DAY));
    await t.reject();
    expect(await t.session.state()).toBe('expired');
    expect(await t.session.current()).toBeNull();
    expect(await t.storage.get<{ buyerId: string }>(STORAGE_KEYS.sgwSession)).toMatchObject({ buyerId: 'B-1' });
    expect(t.audit.kinds).toContain('session.rejected');
  });

  it('re-observing the identical bearer does not restore ok (with jti)', async () => {
    const t = setup();
    const b = mint('B-1', 20 * DAY);
    await t.observe(b);
    await t.reject();
    await t.observe(b);
    expect(await t.session.state()).toBe('expired');
  });

  it('re-observing the identical bearer does not restore ok (no jti: exp + hash)', async () => {
    const t = setup();
    const b = jwt({ BuyerId: 'B-1', exp: expSec(T0 + 20 * DAY) });
    await t.observe(b);
    await t.reject();
    await t.observe(b);
    expect(await t.session.state()).toBe('expired');
    // same exp, different signature = a different token
    await t.observe(jwt({ BuyerId: 'B-1', exp: expSec(T0 + 20 * DAY) }, 'ZGlmZmVyZW50U2lnbmF0dXJlX19fX19fX19fX19fXw'));
    expect(await t.session.state()).toBe('ok');
  });

  it('a different valid token for the same BuyerId restores ok; a later rejection is tracked afresh', async () => {
    const t = setup();
    await t.observe(mint('B-1', 20 * DAY));
    await t.reject();
    const fresh = mint('B-1', 30 * DAY);
    await t.observe(fresh);
    expect(await t.session.state()).toBe('ok');
    expect((await t.session.current())?.bearer).toBe(fresh);
    await t.reject();
    await t.observe(fresh);
    expect(await t.session.state()).toBe('expired');
  });

  it('the rejection survives a restart', async () => {
    const t = setup();
    const b = mint('B-1', 20 * DAY);
    await t.observe(b);
    await t.reject();
    const again = new SgwSessionAdapter({ repo: t.repo, clock: t.clock, audit: t.audit });
    expect(await again.state()).toBe('expired');
    await again.observe({ bearer: b, capturedAt: T0, source: 'tap' });
    expect(await again.state()).toBe('expired');
  });

  it('stores the rejection under the schema key, validated, as {ids, at}', async () => {
    const t = setup();
    await t.observe(mint('B-1', 20 * DAY));
    await t.reject();
    const rec = await t.repo.find(STORAGE_KEYS.sgwSessionRejection);
    expect(rec?.ids).toHaveLength(1);
    expect(rec?.ids[0]).toMatch(/^jti:[0-9a-f]{64}$/);
    expect(rec?.at).toBe(T0);
  });

  it('F1: a late 401 for an older token does not poison the newer one', async () => {
    const t = setup();
    const a = mint('B-1', 20 * DAY);
    const b = mint('B-1', 30 * DAY);
    await t.observe(a);
    await t.observe(b);
    await t.session.reportRejected(a); // the 401 for A arrives after B was captured
    expect(await t.session.state()).toBe('ok');
    expect((await t.session.current())?.bearer).toBe(b);
    expect(await t.repo.find(STORAGE_KEYS.sgwSessionRejection)).toBeUndefined();
  });

  it('F1: reportRejected ignores a bearer that is unknown, malformed or empty', async () => {
    const t = setup();
    await t.observe(mint('B-1', 20 * DAY));
    for (const junk of ['', 'garbage', mint('B-1', 20 * DAY), mint('B-2', 20 * DAY)]) await t.session.reportRejected(junk);
    expect(await t.session.state()).toBe('ok');
  });

  it('F1: matches by identity, so a "Bearer " prefix on the reported value is fine', async () => {
    const t = setup();
    const a = mint('B-1', 20 * DAY);
    await t.observe(a);
    await t.session.reportRejected(`Bearer ${a}`);
    expect(await t.session.state()).toBe('expired');
  });

  it('F3: a rejected token never comes back: A rejected, B accepted, stale A re-observed -> B stays ok', async () => {
    const t = setup();
    const a = mint('B-1', 20 * DAY);
    const b = mint('B-1', 30 * DAY);
    await t.observe(a);
    await t.reject(a);
    await t.observe(b);
    expect(await t.session.state()).toBe('ok');
    await t.observe(a);
    expect(await t.session.state()).toBe('ok');
    expect((await t.session.current())?.bearer).toBe(b);
    expect(t.audit.entries.some((e) => e.details.reason === 'previously-rejected')).toBe(true);
  });

  it('F3: the rejection history is kept (bounded to 8) when a token is accepted', async () => {
    const t = setup();
    const tokens: string[] = [];
    for (let i = 0; i < 10; i += 1) {
      const tok = mint('B-1', (20 + i) * DAY);
      tokens.push(tok);
      await t.observe(tok);
      await t.reject(tok);
    }
    const rec = await t.repo.find(STORAGE_KEYS.sgwSessionRejection);
    expect(rec?.ids).toHaveLength(8);
    const latest = mint('B-1', 40 * DAY);
    await t.observe(latest);
    expect((await t.repo.find(STORAGE_KEYS.sgwSessionRejection))?.ids).toHaveLength(8); // not erased
    await t.observe(tokens[9] as string); // a recent rejected one is still refused
    expect((await t.session.current())?.bearer).toBe(latest);
  });

  it('F3: an older-exp token never replaces a newer valid one', async () => {
    const t = setup();
    const newer = mint('B-1', 30 * DAY);
    await t.observe(newer);
    await t.observe(mint('B-1', 20 * DAY));
    expect((await t.session.current())?.bearer).toBe(newer);
    expect(t.audit.entries.some((e) => e.details.reason === 'older-exp')).toBe(true);
  });

  it('F3: an older-exp token may replace a held token that is rejected or expired', async () => {
    const t = setup();
    await t.observe(mint('B-1', 30 * DAY));
    await t.reject();
    const older = mint('B-1', 20 * DAY);
    await t.observe(older);
    expect((await t.session.current())?.bearer).toBe(older);

    const u = setup();
    await u.observe(mint('B-1', 1 * DAY));
    u.clock.advance(2 * DAY);
    const fresh = jwt({ jti: 'j-x', BuyerId: 'B-1', exp: expSec(u.clock.now() + 3 * H) });
    await u.observe(fresh);
    expect((await u.session.current())?.bearer).toBe(fresh);
  });

  it('F-minor: capturedAt must be a non-negative integer; otherwise dropped silently, never a ZodError', async () => {
    const t = setup();
    const tok = mint('B-1', 20 * DAY);
    seenBearers.add(tok);
    for (const capturedAt of [-1, Number.NaN, 1.5, Number.POSITIVE_INFINITY]) {
      await expect(t.session.observe({ bearer: tok, capturedAt, source: 'tap' })).resolves.toBeUndefined();
    }
    expect(await t.session.current()).toBeNull();
    expect(t.audit.entries.some((e) => e.details.reason === 'bad-captured-at')).toBe(true);
  });

  it('a corrupt rejection record is quarantined by the repo and read as not rejected', async () => {
    const t = setup();
    await t.observe(mint('B-1', 20 * DAY));
    t.storage.seed({ [STORAGE_KEYS.sgwSessionRejection]: { id: 7 } });
    expect(await t.session.state()).toBe('ok');
    expect(Object.keys(t.storage.dump()).some((k) => k.startsWith('sbw:quarantine:'))).toBe(true);
  });

  it('never stores the raw rejected token or its jti outside the session record', async () => {
    const t = setup();
    const b = mint('B-1', 20 * DAY);
    await t.observe(b);
    await t.reject();
    const others = Object.entries(t.storage.dump()).filter(([k]) => k !== STORAGE_KEYS.sgwSession);
    expect(others.length).toBeGreaterThan(0);
    const text = JSON.stringify(others);
    expect(text).not.toContain(b);
    expect(text).not.toContain('jti-secret');
  });

  it('is a no-op without a session, and idempotent', async () => {
    const t = setup();
    await t.reject();
    expect(await t.session.state()).toBe('logged-out');
    await t.observe(mint('B-1', 20 * DAY));
    await t.reject();
    await t.reject();
    expect(t.audit.kinds.filter((k) => k === 'session.rejected')).toHaveLength(1);
  });

  it('makes no network call (the adapter has no http dependency)', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const t = setup();
    await t.observe(mint('B-1', 20 * DAY));
    await t.reject();
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});

describe('clear()', () => {
  it('is the explicit logout: logged-out, record removed; rejected-token history is kept', async () => {
    const t = setup();
    const b = mint('B-1', 20 * DAY);
    await t.observe(b);
    await t.reject();
    await t.session.clear();
    expect(await t.session.state()).toBe('logged-out');
    expect(await t.session.current()).toBeNull();
    expect(await t.repo.find(STORAGE_KEYS.sgwSession)).toBeUndefined();
    await t.observe(b); // the rejected token is still refused
    expect(await t.session.state()).toBe('logged-out');
    await t.observe(mint('B-2', 20 * DAY)); // logged-out admits another account
    expect(await t.session.state()).toBe('ok');
    expect(t.audit.kinds).toContain('session.cleared');
  });
});

describe('concurrency', () => {
  it('serializes overlapping observe/reportRejected calls', async () => {
    const t = setup();
    const a = mint('B-1', 20 * DAY);
    await Promise.all([t.observe(a), t.session.reportRejected(a), t.observe(a)]);
    expect(await t.session.state()).toBe('expired');
  });
});

describe('refresh (R4): both verdict configurations', () => {
  it('SBW_SESSION_REFRESH=false (default): resolves false, calls nothing', async () => {
    const refresher = vi.fn(() => Promise.resolve(mint('B-1', 30 * DAY)));
    const t = setup({ refresher });
    await t.observe(mint('B-1', 2 * DAY));
    await expect(t.session.refresh()).resolves.toBe(false);
    expect(refresher).not.toHaveBeenCalled();
  });

  it('enabled but no refresher: false', async () => {
    const t = setup({ refresh: true });
    await t.observe(mint('B-1', 2 * DAY));
    await expect(t.session.refresh()).resolves.toBe(false);
  });

  it('enabled with a refresher: observes the new token and resolves true', async () => {
    const fresh = mint('B-1', 30 * DAY);
    seenBearers.add(fresh);
    const t = setup({ refresh: true, refresher: () => Promise.resolve(fresh) });
    await t.observe(mint('B-1', 2 * DAY));
    await expect(t.session.refresh()).resolves.toBe(true);
    expect((await t.session.current())?.bearer).toBe(fresh);
    expect(await t.session.state()).toBe('ok');
  });

  it('enabled: a refresher that fails, returns null, or returns junk resolves false', async () => {
    for (const refresher of [
      () => Promise.reject(new Error('boom')),
      () => Promise.resolve(null),
      () => Promise.resolve('junk'),
    ]) {
      const t = setup({ refresh: true, refresher });
      await t.observe(mint('B-1', 2 * DAY));
      await expect(t.session.refresh()).resolves.toBe(false);
    }
  });
});

// Keep this test last: it checks everything the file logged and audited.
describe('R6: the bearer never leaks', () => {
  it('no 16+ character bearer substring appears in console output or any audit log', async () => {
    const t = setup({ refresh: true, refresher: () => Promise.reject(new Error('refresh failed')) });
    const good = mint('B-1', 20 * DAY);
    await t.observe(good);
    await t.observe(good);
    await t.observe(mint('B-2', 20 * DAY));
    await t.observe('x.y.z');
    await t.observe(jwt({ BuyerId: '', exp: 1 }));
    await t.session.refresh();
    await t.reject();
    await t.observe(good);
    await t.observe(mint('B-1', 30 * DAY));
    await t.session.clear();

    const consoleText = logSpies
      .flatMap((s) => s.mock.calls.map((c) => c.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')))
      .join('\n');
    const auditText = (await Promise.all(audits.map((a) => a.exportJson()))).join('\n');
    const haystack = `${consoleText}\n${auditText}`;

    expect(seenBearers.size).toBeGreaterThan(20);
    for (const bearer of seenBearers) {
      const raw = bearer.replace(/^Bearer /i, '');
      // Every window of 16 characters; the shared JWT header is not a secret but must not be logged either.
      for (let i = 0; i + 16 <= raw.length; i += 1) {
        const piece = raw.slice(i, i + 16);
        if (haystack.includes(piece)) throw new Error(`a bearer substring leaked (token offset ${String(i)})`);
      }
    }
  });
});
