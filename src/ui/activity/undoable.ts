import type { AuditEntry } from '../../domain/audit/types';

/**
 * Undo kinds the background can execute today (the keys of wiredUndoExecutors in
 * src/background/handlers/audit.ts; a unit test keeps the two in step). The other kind
 * (disarm) shows a disabled "Undo not available yet" button.
 */
export const UNDOABLE_KINDS: ReadonlySet<NonNullable<AuditEntry['undo']>['kind']> = new Set(['unfavorite', 'disableRule', 'deleteEvent']);
