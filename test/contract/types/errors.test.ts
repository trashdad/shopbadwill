// The error classes §3 declares (`export class …`) and §3.2 names. They are
// shared values, so every thrower (adapters, fakes) and every catcher uses the
// same class and `instanceof` works across cards.
import { describe, expect, it } from 'vitest';

import {
  CalendarApiError,
  GoogleAuthError,
  HttpNetworkError,
  HttpTimeoutError,
  SgwApiError,
} from '../../../src/ports/errors';

describe('HttpTimeoutError', () => {
  it('records the timeout', () => {
    const err = new HttpTimeoutError(20000);
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(HttpTimeoutError);
    expect(err.name).toBe('HttpTimeoutError');
    expect(err.timeoutMs).toBe(20000);
    expect(err.message).toContain('20000');
  });
});

describe('HttpNetworkError', () => {
  it('is ambiguous (not proven unsent) unless the thrower says so (§3.9 idempotency rule)', () => {
    const cause = new TypeError('Failed to fetch');
    const err = new HttpNetworkError('network down', { cause });
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('HttpNetworkError');
    expect(err.beforeSend).toBe(false);
    expect(err.cause).toBe(cause);
    expect(new HttpNetworkError('offline', { beforeSend: true }).beforeSend).toBe(true);
  });
});

describe('SgwApiError', () => {
  it("is constructed as SgwApiError('kind') with optional status and retry-after", () => {
    const err = new SgwApiError('schema');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(SgwApiError);
    expect(err.name).toBe('SgwApiError');
    expect(err.kind).toBe('schema');
    expect(err.message).toBe('schema');
    expect(err.status).toBeUndefined();
    expect(err.retryAfterMs).toBeUndefined();

    const limited = new SgwApiError('rate-limited', 'HTTP 429', { status: 429, retryAfterMs: 30000 });
    expect(limited.message).toBe('HTTP 429');
    expect(limited.status).toBe(429);
    expect(limited.retryAfterMs).toBe(30000);
  });

  it('keeps the cause', () => {
    const cause = new HttpTimeoutError(20000);
    expect(new SgwApiError('timeout', undefined, { cause }).cause).toBe(cause);
  });
});

describe('CalendarApiError', () => {
  it("is constructed as CalendarApiError('code') with an optional status", () => {
    const err = new CalendarApiError('conflict', 'duplicate event id', { status: 409 });
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('CalendarApiError');
    expect(err.code).toBe('conflict');
    expect(err.status).toBe(409);
    expect(new CalendarApiError('offline').message).toBe('offline');
  });
});

describe('GoogleAuthError', () => {
  it('carries a GoogleAuthErrorCode', () => {
    const err = new GoogleAuthError('invalid_grant');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('GoogleAuthError');
    expect(err.code).toBe('invalid_grant');
    expect(err.message).toBe('invalid_grant');
  });
});
