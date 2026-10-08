// Contract v1 (T-02): PLAN §3.3 SgwSession port. Implemented by T-28
// (src/adapters/sgw/session-adapter.ts). The stored record is
// SgwSessionRecord (src/domain/types.ts, I-08).
import type { EpochMs, SgwSessionState } from '../domain/types';

export interface SgwSession {
  /**
   * Validates the JWT shape and stores it. Tap data is untrusted (I-27): a
   * token whose buyerId differs from the stored session's is rejected unless
   * the session is 'logged-out'.
   */
  observe(token: { bearer: string; capturedAt: EpochMs; source: 'tap' | 'webRequest' }): Promise<void>;
  current(): Promise<{ bearer: string; expiresAt: EpochMs; buyerId: string } | null>;
  /** 'expiring' = less than 12 h left. */
  state(): Promise<SgwSessionState>;
  /** Only if S-2 enabled refresh; otherwise resolves false. */
  refresh(): Promise<boolean>;
  clear(): Promise<void>;
}
