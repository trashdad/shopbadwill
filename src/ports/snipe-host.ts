// Contract v1 (T-02): PLAN §3.9 SnipeHost port: where the final timer runs.
// The background by default (T-84, src/adapters/browser/snipe-host.ts); the
// runner page on Firefox if S-7 says so (T-116).
export interface SnipeHost {
  acquire(snipeId: string): Promise<void>;
  release(snipeId: string): Promise<void>;
}
