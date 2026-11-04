// Contract v1 (T-02): PLAN §3.3 SgwSession port. Implemented by T-28
// (src/adapters/sgw/session-adapter.ts). The stored record is
// SgwSessionRecord (src/domain/types.ts, I-08).
import type { EpochMs, SgwSessionState } from '../domain/types';

export interface SgwSession {
  /**
   * Validates the JWT shape and stores it. Tap data is untrusted (I-27): a
   * token whose buyerId differs from the stored session's is rejected unless
   * the session is 'logged-out'. `expiresAt` comes from the JWT `exp` claim
   * (SGW tokens have no `iat`); only `BuyerId`, `exp` and (hashed, for token
   * identity) `jti` are read from the payload. A token SGW already rejected
   * (see reportRejected) is never accepted again, and a token with an earlier
   * `exp` does not replace a newer valid one.
   */
  observe(token: { bearer: string; capturedAt: EpochMs; source: 'tap' | 'webRequest' }): Promise<void>;
  current(): Promise<{ bearer: string; expiresAt: EpochMs; buyerId: string } | null>;
  /** 'expiring' = less than 72 h left. */
  state(): Promise<SgwSessionState>;
  /** Only if S-2 enabled refresh; otherwise resolves false. */
  refresh(): Promise<boolean>;
  /** Explicit logout or disconnect: forgets the token; state becomes 'logged-out'. */
  clear(): Promise<void>;
  /**
   * SGW answered 401 / isUnauthorized to a request that was sent carrying
   * `bearer` (T-28 contract change). Ignored unless `bearer` is the held
   * token (same identity: jti, else exp + hash), so a late 401 for an older
   * token cannot poison a newer one. Otherwise sets state 'expired' with no
   * network call and keeps the record (so the BuyerId rule still applies). The
   * rejected identity is remembered (the last 8, hashed), so that token never
   * comes back as 'ok'; a different valid token for the same BuyerId does.
   */
  reportRejected(bearer: string): Promise<void>;
}
