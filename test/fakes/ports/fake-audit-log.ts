import type { AuditEntry, AuditLog } from '../../../src/domain/audit/types';
import type { Clock } from '../../../src/ports/clock';

/** In-memory AuditLog. `seq` starts at 1; `at` comes from the injected clock. */
export class FakeAuditLog implements AuditLog {
  private readonly all: AuditEntry[] = [];

  constructor(private readonly clock: Clock) {}

  append(e: Omit<AuditEntry, 'seq' | 'at'>): Promise<AuditEntry> {
    const entry: AuditEntry = { ...structuredClone(e), seq: this.all.length + 1, at: this.clock.now() };
    this.all.push(entry);
    return Promise.resolve(structuredClone(entry));
  }

  /** Newest first. `before` keeps entries with `seq < before`. */
  list(q: { limit: number; before?: number; kinds?: string[] }): Promise<AuditEntry[]> {
    const { before, kinds } = q;
    const out = this.all
      .filter((e) => (before === undefined || e.seq < before) && (kinds === undefined || kinds.includes(e.kind)))
      .reverse()
      .slice(0, q.limit);
    return Promise.resolve(structuredClone(out));
  }

  exportJson(): Promise<string> {
    return Promise.resolve(JSON.stringify(this.all, null, 2));
  }

  /** Test helper: every entry, oldest first. */
  get entries(): readonly AuditEntry[] {
    return structuredClone(this.all);
  }

  /** Test helper: the kinds appended so far, oldest first. */
  get kinds(): string[] {
    return this.all.map((e) => e.kind);
  }
}
