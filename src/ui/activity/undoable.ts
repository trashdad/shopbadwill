import type { AuditEntry } from '../../domain/audit/types';

/**
 * Undo kinds the background can execute today (the keys of createUndoExecutors in
 * src/background/handlers/audit.ts; a unit test keeps the two in step). The other kinds
 * (deleteEvent: Phase 3; disarm) show a disabled "Undo not available yet" button.
 */
export const UNDOABLE_KINDS: ReadonlySet<NonNullable<AuditEntry['undo']>['kind']> = new Set(['unfavorite', 'disableRule']);
