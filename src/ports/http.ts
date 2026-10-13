// Contract v1 (T-02): PLAN §3.2 Http port. Implemented by T-34
// (src/adapters/browser/http.ts); FakeHttp by T-03.
import type { EpochMs } from '../domain/types';

export interface HttpRequest {
  url: string;
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  headers?: Record<string, string>;
  body?: string;
  timeoutMs: number;
  credentials: 'omit' | 'include';
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  bodyText: string;
  startedAt: EpochMs;
  endedAt: EpochMs;
}

export interface Http {
  /** Throws HttpTimeoutError / HttpNetworkError (./errors.ts). */
  send(req: HttpRequest): Promise<HttpResponse>;
}
