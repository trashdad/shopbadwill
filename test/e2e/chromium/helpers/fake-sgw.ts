// The fake SGW buyerapi's control plane, seen from a Chromium spec (Node side).
// T-59 wrote these in daily-job.spec.ts; snipe.spec.ts (T-89) needs the same
// pieces, so they live here once instead of being copied:
//
//   - `setScenario()`: POST /__scenario (reset, clock, latency, skew, bidding);
//   - `clearFakeLog()` / `fakeLog()` / `backgroundLog()`: the request log, and
//     the part of it the background sent (every background request carries
//     `x-sbw-fake-now`, stamped by the test build's fetch wrapper);
//   - `mintSession()`: a signed-in SGW session record for `sbw:sgwSession`.
import { expect } from '@playwright/test';

import type { EpochMs, SgwSessionRecord } from '../../../../src/domain/types';
import { FAKE_BUYERAPI } from '../network';

export interface FakeLogEntry {
  seq: number;
  method: string;
  path: string;
  query: string;
  endpoint: string;
  status: number;
  receivedAtMs: number;
  fakeNowMs: number | null;
  requestTimeMs: number;
  hasBearer: boolean;
  /** The Cookie header exactly as the fake received it, else null (T-104). */
  cookie: string | null;
  body: string;
}

/** POST /__scenario (test/fakes/fake-sgw-server/README.md); returns the server's reply. */
export async function setScenario(patch: Record<string, unknown>): Promise<unknown> {
  const res = await fetch(`${FAKE_BUYERAPI}/__scenario`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  });
  const body: unknown = await res.json();
  expect(res.status, JSON.stringify(body)).toBe(200);
  return body;
}

export async function clearFakeLog(): Promise<void> {
  const res = await fetch(`${FAKE_BUYERAPI}/__log`, { method: 'DELETE' });
  expect(res.status).toBe(200);
}

/** Every logged request (control routes are never logged). */
export async function fakeLog(): Promise<FakeLogEntry[]> {
  const res = await fetch(`${FAKE_BUYERAPI}/__log`);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { entries: FakeLogEntry[] };
  return body.entries;
}

/** The log entries the background produced: the ones carrying `x-sbw-fake-now` (every background request does). */
export async function backgroundLog(): Promise<FakeLogEntry[]> {
  return (await fakeLog()).filter((e) => e.fakeNowMs !== null);
}

/** A signed-in session: a bearer the fake accepts, as the api-tap would have captured it at `capturedAt`. */
export async function mintSession(capturedAt: EpochMs): Promise<SgwSessionRecord> {
  const res = await fetch(`${FAKE_BUYERAPI}/__token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
  expect(res.status).toBe(200);
  const token = (await res.json()) as { accessToken: string; expiresAtMs: number };
  return { bearer: token.accessToken, capturedAt, expiresAt: token.expiresAtMs, buyerId: '1234567', source: 'tap' };
}
