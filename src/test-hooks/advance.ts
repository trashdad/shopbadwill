// `sbw:test:advance` (T-59, PLAN §7.5): the test build's time travel. One
// call fast-forwards the Clock port (the shared offset in
// src/adapters/browser/clock.ts) and fires every alarm that became due (the
// registry in src/adapters/browser/alarms.ts). Payload: `{ ms }` to advance
// by that many milliseconds and/or `{ to }` to set the fake now to an
// absolute instant (a restart loses the offset; the harness re-anchors with
// `to` instead of re-adding), or `{ until }` (T-89) to move it forward to an
// instant and never back: the fake clock ticks with real time, so a target the
// harness computed a moment ago may already have passed. It also fires the Clock timers whose fake
// deadline passed (e.g. a RequestScheduler gap wait). The reply is
// `{ now, fired, timers }`: the new fake now, the alarm names fired (in
// order), and the fake deadlines of the Clock timers still pending.
//
// It also stamps every background fetch with `x-sbw-fake-now` (the fake now
// at send time): the fake SGW server records the header in `/__log`, which is
// how the E2E proves the ≥ 120 s request spacing (T-59 R4). Test builds only;
// see ./index.ts for how hooks are loaded and called. The prod bundle
// contains none of this (`pnpm check:prod-bundle`).
import { z } from 'zod';

import {
  advanceTestClock,
  fireDueTestTimers,
  pendingTestTimers,
  setTestClockTo,
  testClockNow,
} from '../adapters/browser/clock';
import { fireDueTestAlarms } from '../adapters/browser/alarms';
import type { TestHookContext } from './index';

export const ADVANCE_HOOK = 'sbw:test:advance';
export const FAKE_NOW_HEADER = 'x-sbw-fake-now';

const AdvanceSchema = z
  .strictObject({
    /** Advance the fake clock by this many milliseconds (forward only). */
    ms: z.number().nonnegative().optional(),
    /** Set the fake clock to this absolute instant. */
    to: z.number().optional(),
    /** Move the fake clock forward to this instant; a no-op when it is already there or past it. */
    until: z.number().optional(),
  })
  .refine((v) => v.ms !== undefined || v.to !== undefined || v.until !== undefined, {
    message: 'send ms and/or to, or until',
  })
  .refine((v) => v.until === undefined || (v.ms === undefined && v.to === undefined), {
    message: 'send only one of until / ms+to',
  });

const WRAP_MARK = Symbol.for('sbw.testHooks.advance.fetch');

/**
 * Wraps `realFetch` so every request the background sends carries
 * `x-sbw-fake-now: <fake now at send time>`. Idempotent; composes with
 * base-url.ts's rewrite wrapper whichever installs first (each wrapper only
 * changes its own concern).
 */
function installFakeNowHeader(realFetch: typeof fetch): typeof fetch {
  if ((realFetch as unknown as Record<symbol, unknown>)[WRAP_MARK] === true) return realFetch;
  const wrapped = function (this: unknown, input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    // A one-argument call has no init to extend: pass it through untouched.
    if (init === undefined) return realFetch.call(globalThis, input);
    const headers = new Headers(init.headers);
    headers.set(FAKE_NOW_HEADER, String(testClockNow()));
    return realFetch.call(globalThis, input, { ...init, headers });
  } as typeof fetch;
  Object.defineProperty(wrapped, WRAP_MARK, { value: true });
  return wrapped;
}

export function install(ctx: TestHookContext): void {
  const real = globalThis.fetch;
  if (typeof real === 'function') globalThis.fetch = installFakeNowHeader(real);

  ctx.serve(ADVANCE_HOOK, (payload) => {
    const parsed = AdvanceSchema.safeParse(payload);
    if (!parsed.success) {
      const why = parsed.error.issues.some((i) => i.message.includes('only one of')) ? 'send only one of until / ms+to' : 'at least one of them';
      throw new Error(`expected { ms?: number, to?: number } or { until: number }, ${why}; got ${JSON.stringify(payload)}`);
    }
    const { ms, to, until } = parsed.data;
    const now =
      until !== undefined
        ? setTestClockTo(Math.max(until, testClockNow()))
        : to !== undefined
          ? setTestClockTo(to)
          : advanceTestClock(ms ?? 0);
    const fired = fireDueTestAlarms(now).map((a) => a.name);
    fireDueTestTimers(now);
    return { now, fired, timers: pendingTestTimers() };
  });
}
