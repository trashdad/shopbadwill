// Contract v1 (T-02): PLAN §3.10 Settings, stored at `sbw:settings`. Defaults
// are in ./defaults.ts. GlobalSwitches is a port (src/ports/global-switches.ts).
import { z } from 'zod';

import { CapsCheckSchema, LeadMsSchema } from '../snipe/types';

/** "HH:MM", 24-hour local time, e.g. "07:00". */
const LocalTimeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

export const SettingsSchema = z.object({
  schemaVersion: z.literal(1),
  homeZip: z.string().optional(),
  /** The user's IANA time zone, detected. */
  locale: z.object({ timeZone: z.string().min(1) }),
  dailyRun: z.object({ enabled: z.boolean(), localTime: LocalTimeSchema, catchUp: z.boolean() }),
  overlay: z.object({
    enabled: z.boolean(),
    hideStyle: z.enum(['collapse', 'dim']),
    quickFavorite: z.boolean(),
    landedCostBadges: z.boolean(),
    countdown: z.boolean(),
  }),
  /** All true by default. */
  dryRun: z.object({ favorites: z.boolean(), calendar: z.boolean(), bidding: z.boolean() }),
  considerateMode: z.enum(['normal', 'tight']),
  features: z.object({
    landedCost: z.boolean(),
    comps: z.boolean(),
    countdownRefresh: z.boolean(),
    relistDetector: z.boolean(),
  }),
  calendar: z.object({
    enabled: z.boolean(),
    mode: z.enum(['dedicated', 'primary']),
    /** Minutes before the end; at most 5 (Calendar's override limit). */
    reminders: z.array(z.number().int().nonnegative()).max(5),
    icsFallback: z.boolean(),
  }),
  notifications: z.object({
    enabled: z.boolean(),
    digest: z.boolean(),
    quietHours: z.object({ from: LocalTimeSchema, to: LocalTimeSchema }).optional(),
  }),
  ntfy: z.object({ enabled: z.boolean(), server: z.string(), topic: z.string() }).optional(),
  snipe: z.object({
    enabled: z.boolean(),
    defaultLeadMs: LeadMsSchema,
    defaultFallback: z.enum(['early-proxy', 'skip']),
    caps: CapsCheckSchema,
    keepAlive: z.boolean(),
    requiredDryRuns: z.number().int().nonnegative(),
    completedDryRuns: z.number().int().nonnegative(),
    tier: z.enum(['T0', 'T1', 'T2']),
  }),
  killSwitch: z.boolean(),
});
export type Settings = z.infer<typeof SettingsSchema>;
