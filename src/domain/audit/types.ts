// Contract v1 (T-02): PLAN §3.10 audit log. The log itself is T-41's
// (src/domain/audit/log.ts); chunked storage is T-33's.
import { z } from 'zod';

import { EpochMsSchema, ItemIdSchema } from '../types';

export const AuditEntrySchema = z.object({
  seq: z.number().int().nonnegative(),
  at: EpochMsSchema,
  actor: z.enum(['user', 'daily-job', 'snipe', 'calendar', 'health', 'system']),
  /** 'favorite.add' | 'calendar.insert' | 'snipe.arm' | 'bid.sent' | 'bid.result' | 'kill.on' | 'health.fail' | ... */
  kind: z.string().min(1),
  itemId: ItemIdSchema.optional(),
  ref: z.string().optional(),
  /** Redacted: no tokens, no HTML. */
  details: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
  undo: z
    .object({
      kind: z.enum(['unfavorite', 'deleteEvent', 'disableRule', 'disarm']),
      ref: z.string(),
      done: z.boolean().optional(),
    })
    .optional(),
  dryRun: z.boolean().optional(),
});
export type AuditEntry = z.infer<typeof AuditEntrySchema>;

export interface AuditLog {
  append(e: Omit<AuditEntry, 'seq' | 'at'>): Promise<AuditEntry>;
  list(q: { limit: number; before?: number; kinds?: string[] }): Promise<AuditEntry[]>;
  exportJson(): Promise<string>;
}
