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
const BEARER_VALUE_RE = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi;

export function isSecretKey(key: string): boolean {
  const k = key.toLowerCase().replace(/[^a-z0-9]/g, '');
  return SECRET_KEY_PARTS.some((p) => k.includes(p));
}

/** Masks JWTs and `Bearer x` values, strips HTML tags, truncates to 2 kB. */
export function sanitizeString(s: string): string {
  let out = s.replace(JWT_RE, REDACTED).replace(BEARER_VALUE_RE, 'Bearer ' + REDACTED);
  for (let prev = ''; prev !== out; ) {
    prev = out;
    out = out.replace(/<[^<>]*>/g, '');
  }
  out = out.replace(/[<>]/g, '');
  return out.length > MAX_STRING_LENGTH ? out.slice(0, MAX_STRING_LENGTH - TRUNCATED.length) + TRUNCATED : out;
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
      if (isSecretKey(key)) continue;
      if (n++ >= MAX_KEYS) break;
      let v: unknown;
      try {
        v = (value as Record<string, unknown>)[key];
      } catch {
        continue; // throwing getter
      }
      const s = scrub(v, depth + 1, ancestors);
      if (s !== undefined) out[key] = s;
    }
    return out;
  } catch {
    return '[unserializable]';
  } finally {
    ancestors.delete(value);
  }
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
      if (v === null || typeof v === 'number' || typeof v === 'boolean' || typeof v === 'string') out[k] = v;
      else out[k] = sanitizeString(JSON.stringify(v));
    }
  } catch {
    /* never throw on a weird details object */
  }
  return out;
}

function redactEntry(e: Omit<AuditEntry, 'seq' | 'at'>): Omit<AuditEntry, 'seq' | 'at'> {
  const out: Omit<AuditEntry, 'seq' | 'at'> = { ...e, details: redactDetails(e.details) };
  if (e.ref !== undefined) out.ref = sanitizeString(e.ref);
  if (e.undo) out.undo = { ...e.undo, ref: sanitizeString(e.undo.ref) };
  return out;
}

export function createAuditLog(repo: Pick<Repo, 'appendAudit' | 'listAudit' | 'exportAuditJson'>): AuditLog {
  return {
    append: (e) => repo.appendAudit(redactEntry(e)),
    list: (q) => repo.listAudit(q),
    exportJson: () => repo.exportAuditJson(),
  };
}
