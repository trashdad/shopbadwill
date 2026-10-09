// T-28: SessionAdapter (PLAN §3.3 SgwSession). Holds the user's SGW login
// bearer, captured from the page by the api-tap (T-31). No network, ever.
//
// Rules (S-2, controller rulings):
//   - Tap data is untrusted. observe() accepts only a well-formed JWT (three
//     base64url parts, JSON-object payload, numeric `exp` in seconds, non-empty
//     `BuyerId`) and reads nothing else from it. `expiresAt` comes from `exp`
//     alone; SGW tokens have no `iat`.
//   - A token for a different BuyerId than the held session is refused unless
//     the session is logged-out (no record).
//   - `expiring` = less than SESSION_EXPIRING_MS left. Writes stay allowed.
//   - reportRejected() (SGW answered 401/isUnauthorized to a call that carried
//     the bearer) sets `expired` and KEEPS the record, so the BuyerId rule still
//     applies. It remembers a SHA-256 of the rejected token's identity (never
//     the token), so observing that same token again cannot flip back to `ok`;
//     a different valid token for the same BuyerId does. clear() is the
//     explicit logout path and sets `logged-out`.
//   - S-2 found no refresh: refresh() resolves false without calling anything
//     unless SBW_SESSION_REFRESH is switched on and a refresher is injected.
//   - The bearer is a secret: never logged, audited or put in an error. Audit
//     entries carry fixed, non-secret reason codes only.
import type { AuditLog } from '../../domain/audit/types';
import { STORAGE_KEYS, type StorageValue } from '../../domain/storage/schema';
import type { EpochMs, SgwSessionRecord, SgwSessionState } from '../../domain/types';
import type { Clock } from '../../ports/clock';
import type { SgwSession } from '../../ports/sgw-session';

/** `expiring` = less than this much time left (S-2 recommendation 2). */
export const SESSION_EXPIRING_MS = 72 * 3_600_000;

/** S-2 verdict: no unattended refresh was observed or proven, so this is false. */
export const SBW_SESSION_REFRESH = false;

/** A JWT longer than this is not an SGW bearer. */
const MAX_TOKEN_CHARS = 8192;
/** `exp` is in seconds; anything at or above this is a milliseconds mistake. */
const MAX_EXP_SECONDS = 100_000_000_000;
/** One audit entry per reason in this window, so a noisy tap cannot flood the log. */
const INVALID_AUDIT_WINDOW_MS = 10 * 60_000;

const B64URL = /^[A-Za-z0-9_-]+$/;

type Parsed = { ok: true; token: string; buyerId: string; expiresAt: EpochMs; jti: string | undefined } | { ok: false; reason: string };

type SessionKey = typeof STORAGE_KEYS.sgwSession | typeof STORAGE_KEYS.sgwSessionRejection;

/** The slice of the domain Repo used here (adapters may not import the Repo class, PLAN §2.1). */
export interface SessionRepo {
  find<K extends SessionKey>(key: K): Promise<StorageValue<K> | undefined>;
  set<K extends SessionKey>(key: K, value: StorageValue<K>): Promise<void>;
  remove(key: SessionKey): Promise<void>;
}

export interface SessionAdapterDeps {
  /** Validated storage (records `sbw:sgwSession` and `sbw:sgwSessionRejection`). */
  repo: SessionRepo;
  clock: Pick<Clock, 'now'>;
  audit?: Pick<AuditLog, 'append'>;
  /** Defaults to SBW_SESSION_REFRESH. Tests flip it to cover both S-2 verdicts. */
  refreshEnabled?: boolean;
  /** Only used when refresh is enabled: resolves a fresh bearer, or null. */
  refresher?: () => Promise<string | null>;
}

function decodePayload(part: string): Record<string, unknown> | undefined {
  try {
    const padded = part.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(part.length / 4) * 4, '=');
    const bin = atob(padded);
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** Never throws and never echoes the input; the reason is a fixed code. */
function parseToken(input: unknown, now: EpochMs): Parsed {
  if (typeof input !== 'string') return { ok: false, reason: 'not-a-string' };
  const token = input.trim().replace(/^Bearer\s+/i, '');
  if (token === '') return { ok: false, reason: 'empty' };
  if (token.length > MAX_TOKEN_CHARS) return { ok: false, reason: 'too-long' };
  const parts = token.split('.');
  if (parts.length !== 3) return { ok: false, reason: 'not-three-parts' };
  if (!parts.every((p) => B64URL.test(p))) return { ok: false, reason: 'not-base64url' };
  const claims = decodePayload(parts[1] ?? '');
  if (claims === undefined) return { ok: false, reason: 'payload-not-json-object' };
  const exp = claims.exp;
  if (typeof exp !== 'number' || !Number.isFinite(exp) || exp <= 0 || exp >= MAX_EXP_SECONDS) {
    return { ok: false, reason: 'bad-exp' };
  }
  const raw = claims.BuyerId;
  const buyerId = typeof raw === 'string' ? raw.trim() : typeof raw === 'number' && Number.isSafeInteger(raw) ? String(raw) : '';
  if (buyerId === '') return { ok: false, reason: 'bad-buyer-id' };
  const expiresAt = Math.floor(exp) * 1000;
  if (expiresAt <= now) return { ok: false, reason: 'already-expired' };
  const jti = typeof claims.jti === 'string' && claims.jti !== '' ? claims.jti : undefined;
  return { ok: true, token, buyerId, expiresAt, jti };
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Identity of a token for the rejection memory: a hash of the jti, else exp plus a hash of the token. */
async function identityOf(p: { token: string; expiresAt: EpochMs; jti: string | undefined }): Promise<string> {
  return p.jti === undefined ? `exp:${String(p.expiresAt)}:${await sha256Hex(p.token)}` : `jti:${await sha256Hex(p.jti)}`;
}

export class SgwSessionAdapter implements SgwSession {
  private readonly refreshEnabled: boolean;
  private tail: Promise<unknown> = Promise.resolve();
  private readonly lastInvalidAudit = new Map<string, number>();

  constructor(private readonly deps: SessionAdapterDeps) {
    this.refreshEnabled = deps.refreshEnabled ?? SBW_SESSION_REFRESH;
  }

  observe(token: { bearer: string; capturedAt: EpochMs; source: 'tap' | 'webRequest' }): Promise<void> {
    return this.serial(() => this.doObserve(token));
  }

  async current(): Promise<{ bearer: string; expiresAt: EpochMs; buyerId: string } | null> {
    return this.serial(async () => {
      const rec = await this.load();
      if (rec === undefined) return null;
      const state = await this.stateOf(rec);
      if (state === 'expired' || state === 'logged-out') return null;
      return { bearer: rec.bearer, expiresAt: rec.expiresAt, buyerId: rec.buyerId };
    });
  }

  state(): Promise<SgwSessionState> {
    return this.serial(async () => this.stateOf(await this.load()));
  }

  async refresh(): Promise<boolean> {
    if (!this.refreshEnabled || this.deps.refresher === undefined) return false;
    let bearer: string | null;
    try {
      bearer = await this.deps.refresher();
    } catch {
      await this.record('session.refresh-failed', { reason: 'refresher-threw' });
      return false;
    }
    if (bearer === null) return false;
    const before = (await this.current())?.bearer;
    await this.observe({ bearer, capturedAt: this.deps.clock.now(), source: 'webRequest' });
    const after = (await this.current())?.bearer;
    return after !== undefined && after !== before; // true only if a new, usable token is now held
  }

  clear(): Promise<void> {
    return this.serial(async () => {
      const had = await this.load();
      await this.deps.repo.remove(STORAGE_KEYS.sgwSession);
      await this.deps.repo.remove(STORAGE_KEYS.sgwSessionRejection);
      if (had !== undefined) await this.record('session.cleared', {});
    });
  }

  reportRejected(): Promise<void> {
    return this.serial(async () => {
      const rec = await this.load();
      if (rec === undefined) return;
      if ((await this.rejectedIdentity()) !== undefined) return; // already rejected: one report, no churn
      const parsed = parseToken(rec.bearer, 0);
      const id = parsed.ok
        ? await identityOf(parsed)
        : `exp:${String(rec.expiresAt)}:${await sha256Hex(rec.bearer)}`;
      await this.deps.repo.set(STORAGE_KEYS.sgwSessionRejection, { id, at: this.deps.clock.now() });
      await this.record('session.rejected', { expiresAt: rec.expiresAt });
    });
  }

  // ── internals ───────────────────────────────────────────────────────

  /** Runs `fn` after every earlier call has settled, so reads never see a half-done write. */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.tail.then(fn, fn);
    this.tail = run.catch(() => undefined);
    return run;
  }

  private async doObserve(token: { bearer: string; capturedAt: EpochMs; source: 'tap' | 'webRequest' }): Promise<void> {
    const now = this.deps.clock.now();
    const parsed = parseToken(token.bearer, now);
    if (!parsed.ok) {
      await this.recordInvalid(parsed.reason, now);
      return;
    }
    const held = await this.load();
    if (held !== undefined) {
      if (held.buyerId !== parsed.buyerId) {
        await this.recordInvalid('buyer-mismatch', now);
        return;
      }
      if (held.bearer === parsed.token) {
        // The page re-sends the same bearer on every request. Nothing changes,
        // and a rejected token stays rejected.
        return;
      }
      const rejected = await this.rejectedIdentity();
      if (rejected !== undefined && rejected === (await identityOf(parsed))) return;
    }
    const record: SgwSessionRecord = {
      bearer: parsed.token,
      capturedAt: Number.isFinite(token.capturedAt) ? token.capturedAt : now,
      expiresAt: parsed.expiresAt,
      buyerId: parsed.buyerId,
      source: token.source,
    };
    await this.deps.repo.set(STORAGE_KEYS.sgwSession, record);
    await this.deps.repo.remove(STORAGE_KEYS.sgwSessionRejection);
    await this.record('session.captured', { source: token.source, expiresAt: parsed.expiresAt, replaced: held !== undefined });
  }

  private async load(): Promise<SgwSessionRecord | undefined> {
    return this.deps.repo.find(STORAGE_KEYS.sgwSession); // invalid is quarantined by the repo
  }

  private async rejectedIdentity(): Promise<string | undefined> {
    return (await this.deps.repo.find(STORAGE_KEYS.sgwSessionRejection))?.id;
  }

  private async stateOf(rec: SgwSessionRecord | undefined): Promise<SgwSessionState> {
    if (rec === undefined) return 'logged-out';
    if ((await this.rejectedIdentity()) !== undefined) return 'expired';
    const left = rec.expiresAt - this.deps.clock.now();
    if (left <= 0) return 'expired';
    return left < SESSION_EXPIRING_MS ? 'expiring' : 'ok';
  }

  private async recordInvalid(reason: string, now: EpochMs): Promise<void> {
    const last = this.lastInvalidAudit.get(reason);
    if (last !== undefined && now - last < INVALID_AUDIT_WINDOW_MS) return;
    this.lastInvalidAudit.set(reason, now);
    await this.record('session.token-rejected', { reason });
  }

  /** Audit is best effort; a failing log must not break the session. Details are non-secret codes and numbers. */
  private async record(kind: string, details: Record<string, string | number | boolean | null>): Promise<void> {
    try {
      await this.deps.audit?.append({ actor: 'system', kind, details });
    } catch {
      // ignored on purpose
    }
  }
}
