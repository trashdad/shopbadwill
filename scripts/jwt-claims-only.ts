// S-2 (T-08): decode a JWT you paste locally and print ONLY claim names and
// timing. No signature check, no network, no file writes.
//
// Prints: claim NAMES (top level), `iat` and `exp` as ISO dates, `exp - iat`
// in hours and days, and whether IpAddress-like / Browser(UA)-like claims
// exist. It never prints any other claim value, never echoes the token, and
// its refusal messages never quote the input.
//
// Usage (the token is read from stdin, never from argv, so it stays out of
// shell history):
//   pnpm exec tsx scripts/jwt-claims-only.ts
//   ...paste the token (without "Bearer "), press Enter. Windows: if it waits, press Ctrl+Z then Enter.
// or pipe it:  Get-Clipboard | pnpm exec tsx scripts/jwt-claims-only.ts
import { pathToFileURL } from 'node:url';

export class JwtRefusal extends Error {
  constructor(reason: string) {
    super(`Refused: ${reason}`);
    this.name = 'JwtRefusal';
  }
}

export interface ClaimsReport {
  claimNames: string[];
  /** ISO string, or null when absent or not a finite number. */
  iat: string | null;
  exp: string | null;
  iatState: 'ok' | 'absent' | 'not-a-number';
  expState: 'ok' | 'absent' | 'not-a-number';
  lifetimeHours: number | null;
  lifetimeDays: number | null;
  hasIpClaim: boolean;
  hasBrowserClaim: boolean;
}

const B64URL = /^[A-Za-z0-9_-]+$/;

function decodeJsonPart(part: string, what: string): unknown {
  if (!B64URL.test(part)) throw new JwtRefusal(`${what} is not base64url`);
  try {
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as unknown;
  } catch {
    throw new JwtRefusal(`${what} is not JSON`);
  }
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const IP_NAME = /(^|[^a-z])ip([^a-z]|$)|ipaddress|clientip|remoteip/i;
const IP_CAMEL = /(^|[a-z])Ip([A-Z]|$)/;
const UA_NAME = /browser|useragent|user_agent|user-agent|^ua$/i;

function timeState(v: unknown): { state: 'ok' | 'absent' | 'not-a-number'; ms: number | null } {
  if (v === undefined) return { state: 'absent', ms: null };
  if (typeof v !== 'number' || !Number.isFinite(v)) return { state: 'not-a-number', ms: null };
  const ms = v * 1000;
  if (!Number.isFinite(new Date(ms).getTime())) return { state: 'not-a-number', ms: null };
  return { state: 'ok', ms };
}

export function analyzeJwt(input: string): ClaimsReport {
  const token = input.trim().replace(/^bearer\s+/i, '');
  if (token === '') throw new JwtRefusal('input is empty');
  const parts = token.split('.');
  if (parts.length !== 3) throw new JwtRefusal('input does not have the three dot-separated parts of a JWT');
  const [h, p] = parts as [string, string, string];
  const header = decodeJsonPart(h, 'header');
  if (!isPlainObject(header) || typeof header.alg !== 'string') throw new JwtRefusal('header has no "alg"');
  const payload = decodeJsonPart(p, 'payload');
  if (!isPlainObject(payload)) throw new JwtRefusal('payload is not a JSON object');

  const claimNames = Object.keys(payload);
  const iat = timeState(payload.iat);
  const exp = timeState(payload.exp);
  const lifetimeMs = iat.ms !== null && exp.ms !== null ? exp.ms - iat.ms : null;
  return {
    claimNames,
    iat: iat.ms === null ? null : new Date(iat.ms).toISOString(),
    exp: exp.ms === null ? null : new Date(exp.ms).toISOString(),
    iatState: iat.state,
    expState: exp.state,
    lifetimeHours: lifetimeMs === null ? null : lifetimeMs / 3_600_000,
    lifetimeDays: lifetimeMs === null ? null : lifetimeMs / 86_400_000,
    hasIpClaim: claimNames.some((n) => IP_NAME.test(n) || IP_CAMEL.test(n)),
    hasBrowserClaim: claimNames.some((n) => UA_NAME.test(n)),
  };
}

function timeLine(label: string, iso: string | null, state: ClaimsReport['iatState']): string {
  if (iso !== null) return `${label}: ${iso}`;
  return `${label}: ${state === 'absent' ? 'absent' : 'present but not a number'}`;
}

export function formatReport(r: ClaimsReport): string {
  const lines = [
    `claims: ${r.claimNames.join(', ')}`,
    timeLine('iat', r.iat, r.iatState),
    timeLine('exp', r.exp, r.expState),
    r.lifetimeHours === null || r.lifetimeDays === null
      ? 'exp - iat: unknown (iat or exp missing)'
      : `exp - iat: ${r.lifetimeHours.toFixed(1)} hours = ${r.lifetimeDays.toFixed(2)} days`,
    `IpAddress-like claim present: ${r.hasIpClaim ? 'yes' : 'no'}`,
    `Browser/UA-like claim present: ${r.hasBrowserClaim ? 'yes' : 'no'}`,
  ];
  return `${lines.join('\n')}\n`;
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) process.stderr.write('Paste the token (no "Bearer "), then press Enter. It is not stored or printed.\n');
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) {
    chunks.push(c as Buffer);
    // A pasted token is one line: stop at the first newline instead of waiting for EOF.
    if (process.stdin.isTTY && Buffer.concat(chunks).includes(0x0a)) break;
  }
  return Buffer.concat(chunks).toString('utf8').split(/\r?\n/)[0] ?? '';
}

async function main(): Promise<void> {
  try {
    process.stdout.write(formatReport(analyzeJwt(await readStdin())));
  } catch (e) {
    if (e instanceof JwtRefusal) {
      process.stderr.write(`${e.message}\n`);
      process.exitCode = 2;
      return;
    }
    process.stderr.write('Unexpected error while reading input.\n');
    process.exitCode = 1;
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
