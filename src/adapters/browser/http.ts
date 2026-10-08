import type { Http, HttpRequest, HttpResponse } from '../../ports/http';
import { HttpNetworkError, HttpTimeoutError } from '../../ports/errors';

export interface BrowserHttpOptions {
  fetch?: typeof fetch;
  now?: () => number;
  /** Defaults to `navigator.onLine`; undefined when unknown. */
  isOnline?: () => boolean | undefined;
}

/** fetch with an AbortController timeout, header capture and timing. */
export class BrowserHttp implements Http {
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;
  private readonly isOnline: () => boolean | undefined;

  constructor(opts: BrowserHttpOptions = {}) {
    this.fetchFn = opts.fetch ?? ((input, init) => fetch(input, init));
    this.now = opts.now ?? (() => Date.now());
    this.isOnline = opts.isOnline ?? (() => (typeof navigator === 'undefined' ? undefined : navigator.onLine));
  }

  async send(req: HttpRequest): Promise<HttpResponse> {
    // beforeSend: true is only legal while fetch() has not been called.
    let headers: Headers;
    let url: URL;
    try {
      url = new URL(req.url);
      headers = new Headers(req.headers);
    } catch (cause) {
      throw new HttpNetworkError('request could not be built', { beforeSend: true, cause });
    }
    if (this.isOnline() === false) {
      throw new HttpNetworkError('offline', { beforeSend: true });
    }

    const controller = new AbortController();
    const state = { timedOut: false };
    const timer = setTimeout(() => {
      state.timedOut = true;
      controller.abort();
    }, req.timeoutMs);
    const startedAt = this.now();
    try {
      const init: RequestInit = {
        method: req.method,
        headers,
        credentials: req.credentials,
        signal: controller.signal,
      };
      if (req.body !== undefined) init.body = req.body;
      const res = await this.fetchFn(url, init);
      const bodyText = await res.text();
      const endedAt = this.now();
      const out: Record<string, string> = {};
      res.headers.forEach((value, key) => {
        out[key.toLowerCase()] = value;
      });
      return { status: res.status, headers: out, bodyText, startedAt, endedAt };
    } catch (cause) {
      if (state.timedOut) throw new HttpTimeoutError(req.timeoutMs, { cause });
      throw new HttpNetworkError(cause instanceof Error ? cause.message : 'network error', { cause });
    } finally {
      clearTimeout(timer);
    }
  }
}
