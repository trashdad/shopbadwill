// T-41: AuditLog over T-33's chunked storage. Everything is redacted BEFORE it
// reaches the repo, so secrets never touch disk. Ring wrap/eviction, seq
// derivation and the timestamp (the repo's injected Clock) are the repo's.
import type { Repo } from '../storage/repo';

import type { AuditEntry, AuditLog } from './types';

export const MAX_STRING_LENGTH = 2048;
export const MAX_DEPTH = 6;
const MAX_KEYS = 100;
const MAX_ITEMS = 100;
const TRUNCATED = '...[truncated]';
export const REDACTED = '[redacted]';

/** Normalised (lowercase, alphanumerics only) key substrings that mark a secret. */
const SECRET_KEY_PARTS = ['bearer', 'token', 'refresh', 'password', 'passwd', 'authorization', 'secret', 'cookie'];
// JWT-like: three base64url segments, the first two starting like JSON ("eyJ").
const JWT_RE = /eyJ[A-Za-z0-9_-]{5,}\.eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/g;
const BEARER_VALUE_RE = /\bBearer\s+[A-Za-z0-9._~+/=-]{6,}/gi;
// key=value / key: value / "key":"value" secrets embedded in text.
const KEYVAL_RE =
  /(["']?)((?:access_?token|refresh_?token|id_?token|token|password|passwd|secret|bearer|authorization|cookie|session)[\w-]*)(["']?)\s*[:=]\s*("[^"]*"|'[^']*'|[^\s,&;}]+)/gi;
const MAX_KEY_LENGTH = 100;

export function isSecretKey(key: string): boolean {
  const k = key.toLowerCase().replace(/[^a-z0-9]/g, '');
  return SECRET_KEY_PARTS.some((p) => k.includes(p));
}

const ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

function decodeEntities(s: string): string {
  return s.replace(/&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|(lt|gt|amp|quot|apos));/g, (_m, dec: string, hex: string, name: string) => {
    if (name) return ENTITIES[name] ?? '';
    const cp = dec ? parseInt(dec, 10) : parseInt(hex, 16);
    return cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : '';
  });
}

function stripTags(s: string): string {
  let out = s;
  for (let prev = ''; prev !== out; ) {
    prev = out;
    out = out
      .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
      .replace(/<(script|style)\b[\s\S]*$/i, '') // unclosed element: drop the rest
      .replace(/<[^<>]*>/g, '');
  }
  return out.replace(/<[^<>]*$/, '').replace(/[<>]/g, '');
}

/** HTML-strips (twice, around entity decoding), masks secrets, truncates to 2 kB. */
export function sanitizeString(s: string): string {
  let out = stripTags(s);
  for (let i = 0; i < 3; i++) {
    const decoded = stripTags(decodeEntities(out));
    if (decoded === out) break;
    out = decoded;
  }
  out = out
    .replace(BEARER_VALUE_RE, 'Bearer ' + REDACTED)
    .replace(JWT_RE, REDACTED)
    .replace(KEYVAL_RE, (_m, q1: string, k: string, q2: string) => `${q1}${k}${q2}: ${REDACTED}`);
  if (out.length <= MAX_STRING_LENGTH) return out;
  let end = MAX_STRING_LENGTH - TRUNCATED.length;
  const last = out.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return out.slice(0, end) + TRUNCATED;
}

/** Deep-redacts any value into plain JSON-safe data. Never throws. */
function scrub(value: unknown, depth: number, ancestors: WeakSet<object>): unknown {
  switch (typeof value) {
    case 'string':
      return sanitizeString(value);
    case 'number':
      return Number.isFinite(value) ? value : String(value);
    case 'boolean':
      return value;
    case 'bigint':
      return value.toString();
    case 'object':
      break;
    default:
      return undefined; // undefined, function, symbol
  }
  if (value === null) return null;
  if (depth >= MAX_DEPTH) return '[max depth]';
  if (ancestors.has(value)) return '[circular]';
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return value.slice(0, MAX_ITEMS).map((v) => scrub(v, depth + 1, ancestors) ?? null);
    }
    if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
    const out: Record<string, unknown> = {};
    let n = 0;
    for (const key of Object.keys(value)) {
      if (key === '__proto__' || isSecretKey(key)) continue;
      if (n++ >= MAX_KEYS) break;
      let v: unknown;
      try {
        v = (value as Record<string, unknown>)[key];
      } catch {
        continue; // throwing getter
      }
      const s = scrub(v, depth + 1, ancestors);
      if (s !== undefined) out[safeKey(key)] = s;
    }
    return out;
  } catch {
    return '[unserializable]';
  } finally {
    ancestors.delete(value);
  }
}

function safeKey(key: string): string {
  return sanitizeString(key.slice(0, MAX_KEY_LENGTH)).slice(0, MAX_KEY_LENGTH);
}

type Details = AuditEntry['details'];

/**
 * Redacts a `details` object. Secret-named keys are dropped at every depth.
 * The contract's details are flat primitives, so nested objects/arrays are kept
 * as their redacted JSON text (itself capped at 2 kB).
 */
export function redactDetails(details: unknown): Details {
  const out: Details = {};
  try {
    const clean = scrub(details, 0, new WeakSet());
    if (clean === null || typeof clean !== 'object' || Array.isArray(clean)) return out;
    for (const [k, v] of Object.entries(clean as Record<string, unknown>)) {
      if (k === '__proto__') continue;
      if (v === null || typeof v === 'number' || typeof v === 'boolean' || typeof v === 'string') out[k] = v;
      else out[k] = sanitizeString(JSON.stringify(v));
    }
  } catch {
    /* never throw on a weird details object */
  }
  return out;
}

type NewEntry = Omit<AuditEntry, 'seq' | 'at'>;

/** Builds the stored object from contract fields only; unknown fields are dropped. */
function redactEntry(e: NewEntry): NewEntry {
  const str = (v: unknown): string => (typeof v === 'string' ? sanitizeString(v) : '');
  const out: NewEntry = { actor: str(e.actor) as NewEntry['actor'], kind: str(e.kind), details: redactDetails(e.details) };
  if (typeof e.itemId === 'number') out.itemId = e.itemId;
  if (typeof e.ref === 'string') out.ref = sanitizeString(e.ref);
  if (typeof e.dryRun === 'boolean') out.dryRun = e.dryRun;
  if (e.undo && typeof e.undo === 'object') {
    out.undo = { kind: str(e.undo.kind) as NonNullable<NewEntry['undo']>['kind'], ref: str(e.undo.ref) };
    if (typeof e.undo.done === 'boolean') out.undo.done = e.undo.done;
  }
  return out;
}

export function createAuditLog(repo: Pick<Repo, 'appendAudit' | 'listAudit' | 'exportAuditJson'>): AuditLog {
  return {
    append: (e) => repo.appendAudit(redactEntry(e)),
    list: (q) => repo.listAudit(q),
    exportJson: () => repo.exportAuditJson(),
  };
}
