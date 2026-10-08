// Contract v1 (T-02): PLAN §3.2 KeepAlive port: keeps the background context
// from idling. Implemented by T-34.
export interface KeepAlive {
  /** Calls runtime.getPlatformInfo() every `intervalMs`; NEVER a network request. */
  start(intervalMs: number): void;
  stop(): void;
}
