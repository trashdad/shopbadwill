import { describe, expect, it } from 'vitest';

import type { HttpRequest, HttpResponse } from '../../../src/ports/http';
import { HttpNetworkError, HttpTimeoutError } from '../../../src/ports/errors';
import { FakeClock } from './fake-clock';
import { FakeHttp } from './fake-http';

const req = (over: Partial<HttpRequest> = {}): HttpRequest => ({
  url: 'https://example.test/a',
  method: 'GET',
  timeoutMs: 1000,
  credentials: 'omit',
  ...over,
});

function setup() {
  const clock = new FakeClock(5000);
  return { clock, http: new FakeHttp(clock) };
}

describe('FakeHttp', () => {
  it('returns a scripted response with timestamps from the clock', async () => {
    const { http } = setup();
    http.on('https://example.test/', { status: 200, headers: { 'x-a': '1' }, bodyText: 'hi' });
    expect(await http.send(req())).toEqual({ status: 200, headers: { 'x-a': '1' }, bodyText: 'hi', startedAt: 5000, endedAt: 5000 });
    expect(http.requests).toHaveLength(1);
  });

  it('applies latency on the fake clock', async () => {
    const { http, clock } = setup();
    http.on(/a$/, { status: 204, latencyMs: 300 });
    let done: HttpResponse | undefined;
    const p = http.send(req()).then((r) => (done = r));
    clock.advance(299);
    await Promise.resolve();
    expect(done).toBeUndefined();
    clock.advance(1);
    await p;
    expect(done).toMatchObject({ startedAt: 5000, endedAt: 5300 });
  });

  it('times out with HttpTimeoutError when latency exceeds timeoutMs', async () => {
    const { http, clock } = setup();
    http.on('https://', { status: 200, latencyMs: 5000 });
    const p = http.send(req({ timeoutMs: 1000 }));
    const assertion = expect(p).rejects.toMatchObject({ name: 'HttpTimeoutError', timeoutMs: 1000 });
    clock.advance(1000);
    await assertion;
    await expect(p).rejects.toBeInstanceOf(HttpTimeoutError);
    expect(clock.pendingTimers).toBe(0);
    expect(http.pending).toBe(0);
  });

  it('a hang step only ends by timeout', async () => {
    const { http, clock } = setup();
    http.on('https://', { hang: true });
    const p = http.send(req());
    const assertion = expect(p).rejects.toBeInstanceOf(HttpTimeoutError);
    clock.advance(1000);
    await assertion;
  });

  it('abortAll rejects in-flight requests with HttpNetworkError and cancels timers', async () => {
    const { http, clock } = setup();
    http.on('https://', { hang: true });
    const p = http.send(req());
    expect(http.pending).toBe(1);
    http.abortAll('connection reset');
    await expect(p).rejects.toBeInstanceOf(HttpNetworkError);
    await expect(p).rejects.toMatchObject({ message: 'connection reset', beforeSend: false });
    expect(clock.pendingTimers).toBe(0);
    expect(http.pending).toBe(0);
  });

  it('error steps reject with the given error', async () => {
    const { http } = setup();
    http.on('https://', { error: new HttpNetworkError('down', { beforeSend: true }) });
    await expect(http.send(req())).rejects.toMatchObject({ name: 'HttpNetworkError', beforeSend: true });
  });

  it('uses steps in order and repeats the last; the newest route wins', async () => {
    const { http } = setup();
    http.on('https://example.test/', { status: 500 }, { status: 200 });
    expect((await http.send(req())).status).toBe(500);
    expect((await http.send(req())).status).toBe(200);
    expect((await http.send(req())).status).toBe(200);
    http.on('https://example.test/a', { status: 418 });
    expect((await http.send(req())).status).toBe(418);
  });

  it('supports function matchers and function steps', async () => {
    const { http } = setup();
    http.on(
      (r) => r.method === 'POST',
      (r) => ({ status: 201, bodyText: r.body ?? '' }),
    );
    const res = await http.send(req({ method: 'POST', body: 'payload' }));
    expect(res).toMatchObject({ status: 201, bodyText: 'payload' });
  });

  it('rejects an unscripted request with a plain Error, and on() needs a step', async () => {
    const { http } = setup();
    await expect(http.send(req())).rejects.toThrow('no scripted response');
    expect(() => http.on('x')).toThrow('at least one step');
  });
});
