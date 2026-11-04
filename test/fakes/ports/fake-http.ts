import type { Http, HttpRequest, HttpResponse } from '../../../src/ports/http';
import { HttpNetworkError, HttpTimeoutError } from '../../../src/ports/errors';
import type { FakeClock } from './fake-clock';

export type Matcher = string | RegExp | ((req: HttpRequest) => boolean);

/** What a scripted request does. */
export type HttpStep =
  | { status: number; headers?: Record<string, string>; bodyText?: string; latencyMs?: number }
  /** Fails after `latencyMs` with this error (e.g. HttpNetworkError). */
  | { error: Error; latencyMs?: number }
  /** Never answers; the request times out after `timeoutMs`. */
  | { hang: true };

export type HttpScript = HttpStep | ((req: HttpRequest) => HttpStep);

interface Route {
  matcher: Matcher;
  steps: HttpScript[];
  used: number;
}

interface InFlight {
  reject: (e: Error) => void;
}

/**
 * Scripted Http. Routes are checked newest-first. Each route's steps are used
 * in order and the last one repeats. Latency and timeouts run on the FakeClock,
 * so tests advance time instead of waiting. A request with no matching route
 * rejects with a plain Error (a test bug, not a network condition).
 */
export class FakeHttp implements Http {
  readonly requests: HttpRequest[] = [];
  private readonly routes: Route[] = [];
  private readonly inFlight = new Set<InFlight>();

  constructor(private readonly clock: FakeClock) {}

  /** Scripts responses for requests matching `matcher` (string = URL prefix; RegExp tested on the URL). */
  on(matcher: Matcher, ...steps: HttpScript[]): this {
    if (steps.length === 0) throw new Error('FakeHttp.on: at least one step is required');
    this.routes.unshift({ matcher, steps, used: 0 });
    return this;
  }

  /** Rejects every in-flight request with an HttpNetworkError (a connection dropped mid-request). */
  abortAll(message = 'aborted'): void {
    for (const f of [...this.inFlight]) f.reject(new HttpNetworkError(message));
  }

  get pending(): number {
    return this.inFlight.size;
  }

  send(req: HttpRequest): Promise<HttpResponse> {
    this.requests.push(structuredClone(req));
    const route = this.routes.find((r) => matches(r.matcher, req));
    if (route === undefined) return Promise.reject(new Error(`FakeHttp: no scripted response for ${req.method} ${req.url}`));
    const script = route.steps[Math.min(route.used, route.steps.length - 1)];
    route.used += 1;
    if (script === undefined) return Promise.reject(new Error('FakeHttp: empty route'));
    const step = typeof script === 'function' ? script(req) : script;
    const startedAt = this.clock.now();

    return new Promise<HttpResponse>((resolve, reject) => {
      const timers: number[] = [];
      const flight: InFlight = {
        reject: (e) => {
          settle(() => {
            reject(e);
          });
        },
      };
      const settle = (fn: () => void): void => {
        if (!this.inFlight.delete(flight)) return;
        for (const t of timers) this.clock.clearTimeout(t);
        fn();
      };
      this.inFlight.add(flight);
      timers.push(
        this.clock.setTimeout(() => {
          flight.reject(new HttpTimeoutError(req.timeoutMs));
        }, req.timeoutMs),
      );
      if ('hang' in step) return;
      const complete = (): void => {
        settle(() => {
          if ('error' in step) reject(step.error);
          else resolve({ status: step.status, headers: { ...step.headers }, bodyText: step.bodyText ?? '', startedAt, endedAt: this.clock.now() });
        });
      };
      const latency = step.latencyMs ?? 0;
      if (latency <= 0) queueMicrotask(complete);
      else timers.push(this.clock.setTimeout(complete, latency));
    });
  }
}

function matches(m: Matcher, req: HttpRequest): boolean {
  if (typeof m === 'string') return req.url.startsWith(m);
  if (m instanceof RegExp) return m.test(req.url);
  return m(req);
}
