// Contract v1 (T-02): PLAN §3.8 calendar data and Google auth status. The
// CalendarSink, CalendarApi and GoogleAuthProvider ports are in src/ports.
import { z } from 'zod';

import { EpochMsSchema, IsoUtcSchema, ItemIdSchema, type ItemId } from '../types';

const ReminderSchema = z.object({ method: z.enum(['popup', 'email']), minutes: z.number().int().nonnegative() });

/** Event ids are base32hex: /^[a-v0-9]{5,1024}$/ (Calendar v3). */
const EventIdSchema = z.string().regex(/^[a-v0-9]{5,1024}$/);

const PrivatePropsSchema = z.object({
  sbwItemId: z.string(),
  sbwGen: z.string(),
  sbwState: z.enum(['open', 'won', 'lost', 'ended-early']),
});

export const DesiredEventSchema = z.object({
  itemId: ItemIdSchema,
  generation: z.number().int().nonnegative(),
  title: z.string(),
  description: z.string(),
  /** = auction end. */
  startUtc: IsoUtcSchema,
  durationMin: z.literal(15),
  sourceUrl: z.string(),
  /** Default [popup 60, popup 15, popup 5]; max 5. */
  reminders: z.array(ReminderSchema).max(5),
  privateProps: PrivatePropsSchema,
});
export type DesiredEvent = z.infer<typeof DesiredEventSchema>;

/** `"sbv" + itemId + "g" + gen`, matching /^[a-v0-9]{5,1024}$/. Implemented by T-65. */
export type EventIdFor = (itemId: ItemId, generation: number) => string;

export const CalendarLinkSchema = z.object({
  itemId: ItemIdSchema,
  eventId: EventIdSchema,
  generation: z.number().int().nonnegative(),
  calendarId: z.string().min(1),
  lastSyncedHash: z.string(),
  status: z.enum(['synced', 'pending', 'error', 'deleted']),
  lastError: z.string().optional(),
});
export type CalendarLink = z.infer<typeof CalendarLinkSchema>;

const UtcDateTimeSchema = z.object({ dateTime: IsoUtcSchema, timeZone: z.literal('UTC') });

/** The Calendar v3 fields a DesiredEvent maps to (I-08). */
export const GcalEventBodySchema = z.object({
  summary: z.string(),
  description: z.string(),
  start: UtcDateTimeSchema,
  end: UtcDateTimeSchema,
  reminders: z.object({ useDefault: z.literal(false), overrides: DesiredEventSchema.shape.reminders }),
  extendedProperties: z.object({ private: PrivatePropsSchema }),
  source: z.object({ title: z.string(), url: z.string() }).optional(),
  status: z.enum(['confirmed', 'cancelled']).optional(),
});
export type GcalEventBody = z.infer<typeof GcalEventBodySchema>;

/**
 * An event as `CalendarApi` returns it: the NORMALIZED form, with `status`
 * required (it may be 'tentative'). Google's raw responses can omit fields
 * (a cancelled event may carry little more than id and status) or carry
 * extras; T-64 parses them with its own lenient schemas
 * (src/adapters/google/schemas.ts) and normalizes them to this shape.
 */
export const GcalEventSchema = GcalEventBodySchema.extend({
  id: z.string().min(1),
  status: z.enum(['confirmed', 'tentative', 'cancelled']),
  etag: z.string().optional(),
});
export type GcalEvent = z.infer<typeof GcalEventSchema>;

export const GoogleAuthErrorCodeSchema = z.enum([
  'invalid_grant',
  'unauthorized', // 401
  'insufficient_scope',
  'rate_limited', // 429 / quota
  'offline',
  'needs_interaction',
  'not_configured',
  'user_cancelled',
]);
export type GoogleAuthErrorCode = z.infer<typeof GoogleAuthErrorCodeSchema>;

export const AuthStatusSchema = z.object({
  connected: z.boolean(),
  provider: z.enum(['pkce', 'chrome-identity', 'none']),
  account: z.string().optional(),
  grantedScopes: z.array(z.string()),
  refreshTokenAgeDays: z.number().nonnegative().optional(),
  /** When Google states one (`refresh_token_expires_in`): an app in "Testing" mode signs out after 7 days (T-70, S-4). */
  refreshTokenExpiresAt: EpochMsSchema.optional(),
  lastError: GoogleAuthErrorCodeSchema.optional(),
  needsInteraction: z.boolean(),
  configured: z.boolean(),
});
export type AuthStatus = z.infer<typeof AuthStatusSchema>;
