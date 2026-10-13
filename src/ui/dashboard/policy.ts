// Copy of FAVORITE_SKIP_PREFIX from src/background/jobs/steps/favorite.ts (T-53).
// Kept here, not imported, so the UI bundle does not pull in the background's
// job code for one string. Keep the two in sync: a job error that starts with
// this prefix is a policy skip (dry-run, paused, local mode, ...), not a failure.
export const FAVORITE_SKIP_PREFIX = 'favorite skipped: ';

export const isPolicySkip = (message: string): boolean => message.startsWith(FAVORITE_SKIP_PREFIX);

/** The reason after the prefix. */
export const policySkipReason = (message: string): string => message.slice(FAVORITE_SKIP_PREFIX.length);
