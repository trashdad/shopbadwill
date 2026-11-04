// Contract v1 (T-02): PLAN §3.2 KeepAwake port. Chrome only; a no-op
// implementation elsewhere (T-34).
export interface KeepAwake {
  readonly available: boolean;
  /** power.requestKeepAwake('system') */
  hold(reason: string): Promise<void>;
  release(): Promise<void>;
}
