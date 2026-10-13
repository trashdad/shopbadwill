// T-111: the CompanionPort adapter, the extension side of the T2 wake-and-launch
// companion (companion/windows/, protocol in companion/windows/PROTOCOL.md).
//
// One-shot native messages (`runtime.sendNativeMessage`) to the host
// `com.shopbadwill.companion`, which needs the optional `nativeMessaging`
// permission (requested in the options snipe section's click handler).
//
// Rules:
// - Only the protocol's fields leave: `schedule {snipeId, wakeAtUtc, browser,
//   profile}`, `cancel {snipeId}`, `list {}`. Each message is built field by
//   field from typed arguments, so no item title, bid amount, token or account
//   data can ride along. The host refuses unknown fields anyway.
// - Every request is checked against the host's own rules (ruling R2) first; a
//   request the host would refuse is never sent (`refused`, `bad-request`).
// - Every reply is validated with zod and must match its request (op, task
//   name, wake time). Anything else (no answer within COMPANION_TIMEOUT_MS, a
//   rejection, a missing API or permission, an unreadable reply) is
//   `unreachable`. A well-formed `{ok:false, error}` is `refused`.
// - Nothing here throws. The snipe runner's hooks call it.
import { browser } from 'wxt/browser';
import { z } from 'zod';

import type { EpochMs } from '../../domain/types';
import type { Clock } from '../../ports/clock';

/** The native-messaging host name (install.ps1 registers it). */
export const COMPANION_HOST = 'com.shopbadwill.companion';
/**
 * How long one request may take. The host is a fresh PowerShell per message
 * (start-up is about 1-3 s) plus one `schtasks` call per task; 10 s is a
 * short bound that still tolerates a slow start.
 */
export const COMPANION_TIMEOUT_MS = 10_000;

export type CompanionBrowser = 'chrome' | 'firefox';

/** The host's error codes (PROTOCOL.md). */
export const COMPANION_HOST_ERRORS = [
  'bad-request',
  'invalid-json',
  'wake-in-past',
  'wake-too-far-ahead',
  'browser-not-configured',
  'unknown-profile',
  'browser-not-found',
  'schtasks-failed',
  'internal',
] as const;
export type CompanionHostError = (typeof COMPANION_HOST_ERRORS)[number];

export interface CompanionTask {
  snipeId: string;
  taskName: string;
  wakeAtUtc: string;
  browser: CompanionBrowser;
  profile: string;
}

/**
 * - `ok`: the host did it.
 * - `refused`: the host (or the pre-send check) said no, with its code.
 * - `unreachable`: no usable answer. Whether a `schedule` took effect is unknown.
 */
export type CompanionReply<T> =
  | { status: 'ok'; value: T }
  | { status: 'refused'; error: CompanionHostError; detail: string }
  | { status: 'unreachable'; detail: string };

export interface CompanionScheduleRequest {
  snipeId: string;
  /** When to wake the computer (epoch ms; sent as RFC 3339 UTC). */
  wakeAt: EpochMs;
  browser: CompanionBrowser;
  /** The profile configured at install (from settings). */
  profile: string;
}

export interface CompanionPort {
  schedule(req: CompanionScheduleRequest): Promise<CompanionReply<{ taskName: string; wakeAtUtc: string }>>;
  cancel(snipeId: string): Promise<CompanionReply<{ taskName: string }>>;
  list(): Promise<CompanionReply<{ tasks: CompanionTask[] }>>;
}

/** The transport: `runtime.sendNativeMessage(host, message)`. Injectable for tests. */
export type NativeSend = (host: string, message: Record<string, unknown>) => Promise<unknown>;

export interface BrowserCompanionOptions {
  /** Timer for the timeout (the background's Clock; default: the global timers). */
  clock?: Pick<Clock, 'setTimeout' | 'clearTimeout'>;
  send?: NativeSend;
  /** Whether `nativeMessaging` is granted. Without it nothing is sent. */
  granted?: () => Promise<boolean>;
  timeoutMs?: number;
}

// ── Ruling R2: what the host accepts ────────────────────────────────────────

const SNIPE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const PROFILE_FORBIDDEN = /["&|<>^%!\r\n`]/;
const PROFILE_SUBEXPR = /\$[({]/;
const PROFILE_TRAVERSAL = /(^|[\\/])\.\.([\\/]|$)/;

export function validCompanionSnipeId(id: string): boolean {
  return SNIPE_ID.test(id);
}

/** A profile name or path the host accepts (1-260 chars, no shell metacharacters, no `..`, no leading `-`). */
export function validCompanionProfile(profile: string): boolean {
  return (
    profile.length >= 1 &&
    profile.length <= 260 &&
    !profile.startsWith('-') &&
    !PROFILE_FORBIDDEN.test(profile) &&
    !PROFILE_SUBEXPR.test(profile) &&
    !PROFILE_TRAVERSAL.test(profile)
  );
}

const taskNameOf = (snipeId: string): string => `ShopBadwill-${snipeId}`;

/** RFC 3339 UTC as the host writes it; parsed to epoch ms. */
const WakeIsoSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,7})?(Z|[+-]00:?00)$/)
  .refine((s) => Number.isFinite(new Date(s).getTime()));

const TaskSchema = z.object({
  snipeId: z.string().regex(SNIPE_ID),
  taskName: z.string(),
  wakeAtUtc: WakeIsoSchema,
  browser: z.enum(['chrome', 'firefox']),
  profile: z.string(),
});

const failureSchema = (op: string) =>
  z.object({ ok: z.literal(false), op: z.union([z.literal(op), z.null()]), error: z.enum(COMPANION_HOST_ERRORS) });

const ScheduleOkSchema = z.object({ ok: z.literal(true), op: z.literal('schedule'), taskName: z.string(), wakeAtUtc: WakeIsoSchema });
const CancelOkSchema = z.object({ ok: z.literal(true), op: z.literal('cancel'), taskName: z.string() });
const ListOkSchema = z.object({ ok: z.literal(true), op: z.literal('list'), tasks: z.array(TaskSchema) });

/** User-facing copy for a host error code. */
export function describeCompanionError(error: CompanionHostError): string {
  switch (error) {
    case 'bad-request':
      return 'the companion refused the request as malformed';
    case 'invalid-json':
      return 'the companion could not read the request';
    case 'wake-in-past':
      return 'the wake time had already passed';
    case 'wake-too-far-ahead':
      return 'the wake time is more than 30 days ahead';
    case 'browser-not-configured':
      return 'the companion was not installed for this browser (re-run install.ps1 with this browser)';
    case 'unknown-profile':
      return 'the browser profile in the snipe settings is not the one the companion was installed with';
    case 'browser-not-found':
      return 'the companion cannot find the browser program (re-run install.ps1)';
    case 'schtasks-failed':
      return 'Windows Task Scheduler refused the wake task';
    case 'internal':
      return 'the companion failed unexpectedly';
  }
}

function errorText(e: unknown): string {
  const text = e instanceof Error ? e.message : String(e);
  return text.length <= 160 ? text : `${text.slice(0, 159)}…`;
}

const defaultSend: NativeSend = (host, message) => {
  const runtime = browser.runtime as unknown as { sendNativeMessage?: (h: string, m: object) => Promise<unknown> };
  const fn = runtime.sendNativeMessage;
  if (typeof fn !== 'function') return Promise.reject(new Error('runtime.sendNativeMessage is not available'));
  return fn.call(runtime, host, message);
};

const globalTimers: Pick<Clock, 'setTimeout' | 'clearTimeout'> = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms) as unknown as number,
  clearTimeout: (id) => {
    globalThis.clearTimeout(id);
  },
};

type Raw = { kind: 'reply'; value: unknown } | { kind: 'unreachable'; detail: string };

export class BrowserCompanion implements CompanionPort {
  private readonly clock: Pick<Clock, 'setTimeout' | 'clearTimeout'>;
  private readonly send: NativeSend;
  private readonly granted: () => Promise<boolean>;
  private readonly timeoutMs: number;

  constructor(opts: BrowserCompanionOptions = {}) {
    this.clock = opts.clock ?? globalTimers;
    this.send = opts.send ?? defaultSend;
    this.granted = opts.granted ?? (() => Promise.resolve(true));
    this.timeoutMs = opts.timeoutMs ?? COMPANION_TIMEOUT_MS;
  }

  async schedule(req: CompanionScheduleRequest): Promise<CompanionReply<{ taskName: string; wakeAtUtc: string }>> {
    if (!validCompanionSnipeId(req.snipeId)) return refusedLocally('the snipe id is not one the companion accepts');
    if (!Number.isFinite(req.wakeAt)) return refusedLocally('the wake time is not a valid time');
    // A runtime check too: callers outside TypeScript's reach must not widen it.
    const browserName: string = req.browser;
    if (browserName !== 'chrome' && browserName !== 'firefox') return refusedLocally('the browser is not chrome or firefox');
    if (!validCompanionProfile(req.profile)) return refusedLocally('the browser profile in the snipe settings is not a valid name or folder');
    const wakeAtUtc = new Date(req.wakeAt).toISOString();
    // Field by field: nothing but the protocol's five fields can leave.
    const raw = await this.exchange({ op: 'schedule', snipeId: req.snipeId, wakeAtUtc, browser: req.browser, profile: req.profile });
    return this.interpret(raw, 'schedule', ScheduleOkSchema, (v) =>
      v.taskName === taskNameOf(req.snipeId) && Math.abs(new Date(v.wakeAtUtc).getTime() - req.wakeAt) < 1000
        ? { taskName: v.taskName, wakeAtUtc: v.wakeAtUtc }
        : undefined,
    );
  }

  async cancel(snipeId: string): Promise<CompanionReply<{ taskName: string }>> {
    if (!validCompanionSnipeId(snipeId)) return refusedLocally('the snipe id is not one the companion accepts');
    const raw = await this.exchange({ op: 'cancel', snipeId });
    return this.interpret(raw, 'cancel', CancelOkSchema, (v) => (v.taskName === taskNameOf(snipeId) ? { taskName: v.taskName } : undefined));
  }

  async list(): Promise<CompanionReply<{ tasks: CompanionTask[] }>> {
    const raw = await this.exchange({ op: 'list' });
    return this.interpret(raw, 'list', ListOkSchema, (v) =>
      v.tasks.every((t) => t.taskName === taskNameOf(t.snipeId)) ? { tasks: v.tasks } : undefined,
    );
  }

  /** Sends one message and waits at most `timeoutMs`. Never throws. */
  private async exchange(message: Record<string, unknown>): Promise<Raw> {
    try {
      let allowed: boolean;
      try {
        allowed = await this.granted();
      } catch {
        allowed = false;
      }
      if (!allowed) {
        return { kind: 'unreachable', detail: 'the browser has not granted the native messaging permission (Options, Sniping: Connect the companion)' };
      }
      let timer: number | undefined;
      const timeout = new Promise<Raw>((resolve) => {
        timer = this.clock.setTimeout(() => {
          resolve({ kind: 'unreachable', detail: `the companion did not answer within ${String(Math.round(this.timeoutMs / 1000))} s` });
        }, this.timeoutMs);
      });
      let sent: Promise<Raw>;
      try {
        sent = this.send(COMPANION_HOST, message).then(
          (value): Raw => ({ kind: 'reply', value }),
          (e: unknown): Raw => ({ kind: 'unreachable', detail: errorText(e) }),
        );
      } catch (e) {
        sent = Promise.resolve({ kind: 'unreachable', detail: errorText(e) });
      }
      const r = await Promise.race([sent, timeout]);
      if (timer !== undefined) this.clock.clearTimeout(timer);
      return r;
    } catch (e) {
      return { kind: 'unreachable', detail: errorText(e) };
    }
  }

  private interpret<S extends z.ZodType, T>(raw: Raw, op: string, okSchema: S, accept: (v: z.infer<S>) => T | undefined): CompanionReply<T> {
    if (raw.kind === 'unreachable') return { status: 'unreachable', detail: raw.detail };
    const ok = okSchema.safeParse(raw.value);
    if (ok.success) {
      const value = accept(ok.data);
      if (value !== undefined) return { status: 'ok', value };
      return unreadable();
    }
    const failed = failureSchema(op).safeParse(raw.value);
    if (failed.success) return { status: 'refused', error: failed.data.error, detail: describeCompanionError(failed.data.error) };
    return unreadable();
  }
}

function refusedLocally<T>(why: string): CompanionReply<T> {
  return { status: 'refused', error: 'bad-request', detail: `not sent: ${why}` };
}

function unreadable<T>(): CompanionReply<T> {
  return { status: 'unreachable', detail: 'the companion sent an unreadable reply (is the companion up to date?)' };
}
