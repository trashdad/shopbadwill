// Contract v1 (T-02): PLAN §3.10 GlobalSwitches, implemented by T-36
// (src/background/switches.ts) and injected into the adapters.
//
// Fail-closed rule (§3.3): writesAllowed(feature) is false whenever the kill
// switch is on, dryRun[feature] is on, the last HealthReport within 24 h has
// ok === false, or SgwSession.state() is neither 'ok' nor 'expiring' (I-08).
// Every write path checks it; the adapter checks it again.
export interface GlobalSwitches {
  writesAllowed(feature: 'favorites' | 'calendar' | 'bidding'): Promise<{ ok: boolean; why?: string }>;
}
