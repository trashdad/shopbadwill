// Raw-shape zod schemas for the Google wire formats the fake speaks. These
// mirror Google's JSON field names, not ShopBadwill's domain types.
import { z } from 'zod';

export const EVENT_ID_RE = /^[a-v0-9]{5,1024}$/;

export const RawReminderOverrideSchema = z.object({
  method: z.enum(['popup', 'email']),
  minutes: z.number().int().min(0).max(40320),
});

const RawDateTimeSchema = z.object({
  dateTime: z.string(),
  timeZone: z.string().optional(),
});

/** Body accepted by events.insert / events.patch (all fields optional; insert enforces more). */
export const RawEventBodySchema = z
  .object({
    id: z.string().optional(),
    status: z.enum(['confirmed', 'tentative', 'cancelled']).optional(),
    summary: z.string().optional(),
    description: z.string().optional(),
    start: RawDateTimeSchema.optional(),
    end: RawDateTimeSchema.optional(),
    reminders: z
      .object({
        useDefault: z.boolean().optional(),
        overrides: z.array(RawReminderOverrideSchema).optional(),
      })
      .optional(),
    extendedProperties: z
      .object({
        private: z.record(z.string(), z.string()).optional(),
        shared: z.record(z.string(), z.string()).optional(),
      })
      .optional(),
    source: z.object({ title: z.string().optional(), url: z.string() }).optional(),
  })
  .loose();

export const RawEventSchema = z.object({
  kind: z.literal('calendar#event'),
  etag: z.string(),
  id: z.string(),
  status: z.enum(['confirmed', 'tentative', 'cancelled']),
  htmlLink: z.string(),
  created: z.string(),
  updated: z.string(),
  summary: z.string().optional(),
  description: z.string().optional(),
  start: RawDateTimeSchema.optional(),
  end: RawDateTimeSchema.optional(),
  iCalUID: z.string(),
  sequence: z.number(),
  reminders: z
    .object({ useDefault: z.boolean(), overrides: z.array(RawReminderOverrideSchema).optional() })
    .optional(),
  extendedProperties: z
    .object({ private: z.record(z.string(), z.string()).optional(), shared: z.record(z.string(), z.string()).optional() })
    .optional(),
  source: z.object({ title: z.string().optional(), url: z.string() }).optional(),
});

export const RawEventsListSchema = z.object({
  kind: z.literal('calendar#events'),
  etag: z.string(),
  summary: z.string(),
  timeZone: z.string(),
  items: z.array(RawEventSchema),
  nextPageToken: z.string().optional(),
});

export const RawCalendarInsertBodySchema = z.object({
  summary: z.string().min(1),
  timeZone: z.string().optional(),
  description: z.string().optional(),
});

export const RawCalendarSchema = z.object({
  kind: z.literal('calendar#calendar'),
  etag: z.string(),
  id: z.string(),
  summary: z.string(),
  timeZone: z.string(),
});

export const RawCalendarListEntrySchema = z.object({
  kind: z.literal('calendar#calendarListEntry'),
  etag: z.string(),
  id: z.string(),
  summary: z.string(),
  timeZone: z.string(),
  accessRole: z.string(),
});

export const RawTokenResponseSchema = z.object({
  access_token: z.string(),
  expires_in: z.number(),
  scope: z.string(),
  token_type: z.literal('Bearer'),
  refresh_token: z.string().optional(),
});

export const RawOAuthErrorSchema = z.object({ error: z.string(), error_description: z.string().optional() });

export const RawGoogleErrorSchema = z.object({
  error: z.object({
    code: z.number(),
    message: z.string(),
    errors: z.array(z.object({ message: z.string(), domain: z.string(), reason: z.string() })),
    status: z.string().optional(),
  }),
});
