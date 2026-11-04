// Contract v1 (T-02): PLAN §3.3 SgwHealth port. Implemented by T-30
// (src/adapters/sgw/health.ts).
import type { HealthReport } from '../domain/types';

export interface SgwHealth {
  run(mode: 'anonymous' | 'full'): Promise<HealthReport>;
  last(): Promise<HealthReport | null>;
}
