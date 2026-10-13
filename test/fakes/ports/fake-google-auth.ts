import type { AuthStatus, GoogleAuthErrorCode } from '../../../src/domain/calendar/types';
import { GoogleAuthError } from '../../../src/ports/errors';
import type { GoogleAuthProvider } from '../../../src/ports/google-auth';

export interface FakeGoogleAuthOptions {
  connected?: boolean;
  account?: string;
  scopes?: string[];
  provider?: 'pkce' | 'chrome-identity';
  configured?: boolean;
}

/** GoogleAuthProvider with no network. Tokens are "fake-token-N", a new one per call. */
export class FakeGoogleAuth implements GoogleAuthProvider {
  readonly calls: Array<{ method: 'getAccessToken' | 'connect' | 'disconnect' | 'status'; interactive?: boolean }> = [];
  /** Number of tokens minted. */
  tokensIssued = 0;
  /** Number of disconnect() calls (each one models a revoke). */
  revokes = 0;
  /** When set, the next getAccessToken/connect rejects with this code and clears it. */
  failNext: GoogleAuthErrorCode | undefined;
  /** When true, a non-interactive getAccessToken rejects with needs_interaction. */
  needsInteraction = false;
  private connected: boolean;
  private readonly provider: 'pkce' | 'chrome-identity';
  private readonly account: string;
  private readonly scopes: string[];
  private readonly configured: boolean;

  constructor(opts: FakeGoogleAuthOptions = {}) {
    this.connected = opts.connected ?? false;
    this.provider = opts.provider ?? 'pkce';
    this.account = opts.account ?? 'user@example.test';
    this.scopes = opts.scopes ?? ['https://www.googleapis.com/auth/calendar.app.created'];
    this.configured = opts.configured ?? true;
  }

  getAccessToken(opts: { interactive: boolean }): Promise<string> {
    this.calls.push({ method: 'getAccessToken', interactive: opts.interactive });
    const injected = this.takeFailure();
    if (injected !== undefined) return Promise.reject(injected);
    if (!this.configured) return Promise.reject(new GoogleAuthError('not_configured'));
    if (!this.connected) return Promise.reject(new GoogleAuthError('needs_interaction'));
    if (this.needsInteraction && !opts.interactive) return Promise.reject(new GoogleAuthError('needs_interaction'));
    this.needsInteraction = false;
    this.tokensIssued += 1;
    return Promise.resolve(`fake-token-${String(this.tokensIssued)}`);
  }

  connect(): Promise<AuthStatus> {
    this.calls.push({ method: 'connect' });
    const injected = this.takeFailure();
    if (injected !== undefined) return Promise.reject(injected);
    if (!this.configured) return Promise.reject(new GoogleAuthError('not_configured'));
    this.connected = true;
    return Promise.resolve(this.currentStatus());
  }

  disconnect(): Promise<void> {
    this.calls.push({ method: 'disconnect' });
    this.revokes += 1;
    this.connected = false;
    return Promise.resolve();
  }

  status(): Promise<AuthStatus> {
    this.calls.push({ method: 'status' });
    return Promise.resolve(this.currentStatus());
  }

  private currentStatus(): AuthStatus {
    return this.connected
      ? {
          connected: true,
          provider: this.provider,
          account: this.account,
          grantedScopes: [...this.scopes],
          needsInteraction: this.needsInteraction,
          configured: this.configured,
        }
      : { connected: false, provider: 'none', grantedScopes: [], needsInteraction: false, configured: this.configured };
  }

  private takeFailure(): GoogleAuthError | undefined {
    if (this.failNext === undefined) return undefined;
    const code = this.failNext;
    this.failNext = undefined;
    return new GoogleAuthError(code);
  }
}
