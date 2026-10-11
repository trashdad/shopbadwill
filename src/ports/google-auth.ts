// Contract v1 (T-02): PLAN §3.8 GoogleAuthProvider port. Implemented by T-62
// (PKCE) and, if S-4 selects it, T-63 (chrome.identity). Failures throw
// GoogleAuthError (./errors.ts).
import type { AuthStatus } from '../domain/calendar/types';

export interface GoogleAuthProvider {
  /** interactive:true only from a user gesture; the background always passes false. */
  getAccessToken(opts: { interactive: boolean }): Promise<string>;
  /** User gesture; PKCE S256; access_type=offline; prompt=consent; stores the refresh token in storage.local. */
  connect(): Promise<AuthStatus>;
  /** REVOKES (oauth2.googleapis.com/revoke, or identity.clearAllCachedAuthTokens), then clears storage. */
  disconnect(): Promise<void>;
  status(): Promise<AuthStatus>;
}
