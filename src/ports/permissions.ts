// Contract v1 (T-02): PLAN §3.2 Permissions port. Implemented by T-34
// (src/adapters/browser/permissions.ts).
//
// There is no `permissions.request` message (I-21): UI pages call
// browser.permissions.request in their click handlers through
// src/ui/permissions.ts (T-56). `request` here is for that UI context only.
export interface Permissions {
  contains(p: { permissions?: string[]; origins?: string[] }): Promise<boolean>;
  /** User gesture only. */
  request(p: { permissions?: string[]; origins?: string[] }): Promise<boolean>;
  /** Returns an unsubscribe function. */
  onRemoved(cb: () => void): () => void;
}
