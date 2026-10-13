// Contract v1 (T-02): the error classes PLAN §3 declares (`export class …`,
// plus the two §3.2 names Http throws). They are the only runtime code under
// src/ports: one class per error, so every thrower (adapters, test fakes) and
// every catcher shares it and `instanceof` works across cards.
import type { GoogleAuthErrorCode } from '../domain/calendar/types';

/** Thrown by Http.send when `timeoutMs` elapses. A timeout is ambiguous for a bid (§3.9). */
export class HttpTimeoutError extends Error {
  override readonly name = 'HttpTimeoutError';
  readonly timeoutMs: number;

  constructor(timeoutMs: number, options?: { cause?: unknown }) {
    super(
      `HTTP request timed out after ${String(timeoutMs)} ms`,
      options?.cause === undefined ? undefined : { cause: options.cause },
    );
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Thrown by Http.send on a network failure. `beforeSend` is true only when the
 * implementation can prove no request bytes left (§3.9: only then is a bid
 * proven not to have arrived); it defaults to false (ambiguous).
 *
 * T-34's fetch adapter may set `beforeSend: true` only when it throws without
 * having called fetch(): the request could not be built (bad URL, headers or
 * body), or `navigator.onLine` was false when it checked just before the call.
 * Any rejection from fetch() itself (TypeError "Failed to fetch", DNS, TLS,
 * connection reset, abort) is `false`: fetch does not report whether bytes left.
 */
export class HttpNetworkError extends Error {
  override readonly name = 'HttpNetworkError';
  readonly beforeSend: boolean;

  constructor(message: string, options?: { beforeSend?: boolean; cause?: unknown }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.beforeSend = options?.beforeSend ?? false;
  }
}

export type SgwApiErrorKind =
  | 'auth'
  | 'rate-limited'
  | 'blocked'
  | 'server'
  | 'network'
  | 'timeout'
  | 'schema'
  | 'budget'
  | 'paused';

/** §3.3. Constructed as `new SgwApiError('schema')`; the message defaults to the kind. */
export class SgwApiError extends Error {
  override readonly name = 'SgwApiError';
  kind: SgwApiErrorKind;
  status?: number;
  retryAfterMs?: number;

  constructor(
    kind: SgwApiErrorKind,
    message?: string,
    options?: { status?: number; retryAfterMs?: number; cause?: unknown },
  ) {
    super(message ?? kind, options?.cause === undefined ? undefined : { cause: options.cause });
    this.kind = kind;
    if (options?.status !== undefined) this.status = options.status;
    if (options?.retryAfterMs !== undefined) this.retryAfterMs = options.retryAfterMs;
  }
}

export type CalendarApiErrorCode =
  | 'conflict'
  | 'not-found'
  | 'auth'
  | 'insufficient-scope'
  | 'rate-limited'
  | 'offline'
  | 'schema'
  | 'other';

/** §3.8. Constructed as `new CalendarApiError('conflict')`; the message defaults to the code. */
export class CalendarApiError extends Error {
  override readonly name = 'CalendarApiError';
  code: CalendarApiErrorCode;
  status?: number;

  constructor(code: CalendarApiErrorCode, message?: string, options?: { status?: number; cause?: unknown }) {
    super(message ?? code, options?.cause === undefined ? undefined : { cause: options.cause });
    this.code = code;
    if (options?.status !== undefined) this.status = options.status;
  }
}

/** §3.8. Constructed as `new GoogleAuthError('invalid_grant')`; the message defaults to the code. */
export class GoogleAuthError extends Error {
  override readonly name = 'GoogleAuthError';
  code: GoogleAuthErrorCode;

  constructor(code: GoogleAuthErrorCode, message?: string, options?: { cause?: unknown }) {
    super(message ?? code, options?.cause === undefined ? undefined : { cause: options.cause });
    this.code = code;
  }
}
