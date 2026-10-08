// Contract v1 (T-02): PLAN §3.12 message types and the §2.4 envelope.
//
// Every runtime message is `{ v: 1, type, payload?, reqId }`, validated with
// MsgEnvelopeSchema before dispatch (T-35's router also checks the sender per
// §2.4). §3.12's `reply` is not part of the request: the reply type of each
// message is `MsgReply<type>`, validated by `MsgReplySchemas[type]`. Messages
// without a `reply` answer `undefined`.
//
// There is no 'permissions.request' (I-21): UI pages call
// browser.permissions.request in their click handlers via src/ui/permissions.ts.
import { z } from 'zod';

import { AuditEntrySchema } from '../domain/audit/types';
import { AuthStatusSchema } from '../domain/calendar/types';
import { MatchResultSchema, RuleSchema } from '../domain/rules/schema';
import { SettingsSchema } from '../domain/settings/schema';
import { CapsResultSchema, SnipeIdSchema, SnipeSchema, SnipeStateSchema } from '../domain/snipe/types';
import {
  CentsSchema,
  EpochMsSchema,
  HealthReportSchema,
  ItemDetailSchema,
  ItemIdSchema,
  ListingSchema,
  RequestSchedulerStatsSchema,
  SgwSessionStateSchema,
  TrackedItemSchema,
} from '../domain/types';
import { JobRunSchema, WatchSchema } from '../domain/watches/schema';

/** §2.4 envelope version. */
export const MSG_VERSION = 1;

const msg = <T extends string, P extends z.ZodType>(type: T, payload: P) =>
  z.object({ type: z.literal(type), payload });
const signal = <T extends string>(type: T) => z.object({ type: z.literal(type) });

const ItemIdPayload = z.object({ itemId: ItemIdSchema });
const IdPayload = z.object({ id: z.string().min(1) });
/** Tap data is untrusted (I-27): a relayed token must at least be JWT-shaped. */
const JwtSchema = z.string().regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/);

export const MsgSchema = z.discriminatedUnion('type', [
  // ── content → background (§2.4 rule 3: the only types content may send) ──
  msg('page.listings', z.object({ url: z.string(), listings: z.array(ListingSchema), capturedAt: EpochMsSchema })),
  msg('page.detail', z.object({ detail: ItemDetailSchema })),
  msg('page.token', z.object({ bearer: JwtSchema, capturedAt: EpochMsSchema })),
  /** Card-selector report for health (I-08). */
  msg(
    'page.domHealth',
    z.object({
      url: z.string(),
      configVersion: z.string(),
      pageKind: z.string(),
      cardsFound: z.number().int().nonnegative(),
      fallbackUsed: z.boolean(),
    }),
  ),
  /** "Snipe…" deep link: opens the dashboard prefilled, never arms (I-08). */
  msg('ui.openSnipe', ItemIdPayload),
  msg('rules.evaluate', z.object({ listings: z.array(ListingSchema) })),
  msg('landedCost.get', z.object({ itemIds: z.array(ItemIdSchema) })),
  msg('quick.hideSeller', z.object({ sellerId: z.number().int(), sellerName: z.string() })),
  /** A non-empty term: an empty one would hide every listing. */
  msg('quick.hideKeyword', z.object({ term: z.string().min(1) })),
  msg('quick.favorite', ItemIdPayload),
  msg('quick.track', ItemIdPayload),

  // ── UI → background ──
  signal('settings.get'),
  msg('settings.set', SettingsSchema.partial()),
  signal('rules.list'),
  msg('rules.save', RuleSchema),
  msg('rules.delete', IdPayload),
  /** The background uses the last page.listings from tabId, else the most recent SGW tab (I-08). */
  msg('rules.preview', z.object({ rule: RuleSchema, tabId: z.number().int().nonnegative().optional() })),
  signal('watches.list'),
  msg('watches.save', WatchSchema),
  msg('watches.delete', IdPayload),
  /** SGW saved searches → watches (I-33). */
  signal('watches.importSaved'),
  msg('job.runNow', z.object({ watchIds: z.array(z.string().min(1)).optional() })),
  signal('job.status'),
  signal('tracked.list'),
  msg('tracked.remove', ItemIdPayload),
  signal('favorites.sync'),
  /** User gesture. */
  signal('calendar.connect'),
  signal('calendar.disconnect'),
  signal('calendar.status'),
  signal('calendar.syncNow'),
  msg('calendar.ics', z.object({ itemIds: z.array(ItemIdSchema) })),
  msg('snipe.prepare', ItemIdPayload),
  msg(
    'snipe.arm',
    z.object({
      snipe: SnipeSchema.omit({ state: true, history: true, armedAt: true }),
      typedConfirmation: z.string().optional(),
    }),
  ),
  msg('snipe.disarm', z.object({ id: SnipeIdSchema })),
  signal('snipe.list'),
  msg('kill.set', z.object({ on: z.boolean() })),
  signal('health.get'),
  msg('audit.list', z.object({ limit: z.number().int().positive(), before: z.number().int().nonnegative().optional() })),
  msg('audit.undo', z.object({ seq: z.number().int().nonnegative() })),

  // ── background → content/UI broadcasts ──
  signal('rules.changed'),
  msg('switches.changed', z.object({ killSwitch: z.boolean(), writesAllowed: z.record(z.string(), z.boolean()) })),
]);
export type Msg = z.infer<typeof MsgSchema>;
export type MsgType = Msg['type'];
export type MsgOf<K extends MsgType> = Extract<Msg, { type: K }>;
/** The payload of `K`, or `undefined` for a message without one. */
export type MsgPayload<K extends MsgType> = MsgOf<K> extends { payload: infer P } ? P : undefined;

/** The §2.4 wire format: `{ v: 1, type, payload?, reqId }`. */
export const MsgEnvelopeSchema = z.intersection(
  z.object({ v: z.literal(MSG_VERSION), reqId: z.string().min(1) }),
  MsgSchema,
);
export type MsgEnvelope = z.infer<typeof MsgEnvelopeSchema>;

/** Who sends each type, per the §3.12 grouping. §2.4 rule 3: content may send only the 'content' types. */
export type MsgSender = 'content' | 'ui' | 'background';
export const MSG_SENDER = Object.freeze({
  'page.listings': 'content',
  'page.detail': 'content',
  'page.token': 'content',
  'page.domHealth': 'content',
  'ui.openSnipe': 'content',
  'rules.evaluate': 'content',
  'landedCost.get': 'content',
  'quick.hideSeller': 'content',
  'quick.hideKeyword': 'content',
  'quick.favorite': 'content',
  'quick.track': 'content',
  'settings.get': 'ui',
  'settings.set': 'ui',
  'rules.list': 'ui',
  'rules.save': 'ui',
  'rules.delete': 'ui',
  'rules.preview': 'ui',
  'watches.list': 'ui',
  'watches.save': 'ui',
  'watches.delete': 'ui',
  'watches.importSaved': 'ui',
  'job.runNow': 'ui',
  'job.status': 'ui',
  'tracked.list': 'ui',
  'tracked.remove': 'ui',
  'favorites.sync': 'ui',
  'calendar.connect': 'ui',
  'calendar.disconnect': 'ui',
  'calendar.status': 'ui',
  'calendar.syncNow': 'ui',
  'calendar.ics': 'ui',
  'snipe.prepare': 'ui',
  'snipe.arm': 'ui',
  'snipe.disarm': 'ui',
  'snipe.list': 'ui',
  'kill.set': 'ui',
  'health.get': 'ui',
  'audit.list': 'ui',
  'audit.undo': 'ui',
  'rules.changed': 'background',
  'switches.changed': 'background',
} as const satisfies Record<MsgType, MsgSender>);

/** Every message type, in §3.12 order. */
export const MSG_TYPES = Object.freeze(Object.keys(MSG_SENDER) as MsgType[]);

/** Reply schemas for the §3.12 types that declare a `reply`. */
export const MsgReplySchemas = Object.freeze({
  'rules.evaluate': z.array(MatchResultSchema),
  'landedCost.get': z.record(ItemIdSchema, CentsSchema.nullable()),
  'settings.get': SettingsSchema,
  'rules.list': z.array(RuleSchema),
  'rules.preview': z.object({
    matched: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
    ids: z.array(ItemIdSchema),
  }),
  'watches.list': z.array(WatchSchema),
  /** SGW saved searches → watches (I-33). */
  'watches.importSaved': z.object({
    imported: z.number().int().nonnegative(),
    skipped: z.number().int().nonnegative(),
  }),
  'job.status': JobRunSchema.nullable(),
  'tracked.list': z.array(TrackedItemSchema),
  'calendar.connect': AuthStatusSchema,
  'calendar.status': AuthStatusSchema,
  'calendar.ics': z.object({ ics: z.string() }),
  'snipe.prepare': z.object({ detail: ItemDetailSchema, estAllIn: CentsSchema.nullable(), caps: CapsResultSchema }),
  'snipe.arm': SnipeSchema,
  'snipe.list': z.array(SnipeSchema),
  /** `session` is SgwSessionRecord['expiresAt']; `sessionState` and `budget` per I-08. */
  'health.get': z.object({
    sgw: HealthReportSchema.nullable(),
    session: EpochMsSchema.nullable(),
    sessionState: SgwSessionStateSchema,
    google: AuthStatusSchema,
    budget: RequestSchedulerStatsSchema,
  }),
  'audit.list': z.array(AuditEntrySchema),
} as const satisfies Partial<Record<MsgType, z.ZodType>>);

/** The reply type of `K`; `undefined` when §3.12 declares no reply. */
export type MsgReply<K extends MsgType> = K extends keyof typeof MsgReplySchemas
  ? z.infer<(typeof MsgReplySchemas)[K]>
  : undefined;

// ── Ports (streams over runtime.connect) ───────────────────────────────────

export const PORT_NAMES = Object.freeze({
  snipeCountdown: 'sbw:snipe-countdown',
  jobProgress: 'sbw:job-progress',
} as const);
export type PortName = (typeof PORT_NAMES)[keyof typeof PORT_NAMES];

/**
 * Background → UI every 1 s while the dashboard is open. `serverNow` is null
 * until the clock has a sample; `fireAt` is null until it is computed.
 */
export const SnipeCountdownTickSchema = z.object({
  snipeId: SnipeIdSchema,
  serverNow: EpochMsSchema.nullable(),
  fireAt: EpochMsSchema.nullable(),
  state: SnipeStateSchema,
});
export type SnipeCountdownTick = z.infer<typeof SnipeCountdownTickSchema>;

/** What each port streams: countdown ticks, and the active JobRun after each step. */
export const PortTickSchemas = Object.freeze({
  [PORT_NAMES.snipeCountdown]: SnipeCountdownTickSchema,
  [PORT_NAMES.jobProgress]: JobRunSchema,
} as const satisfies Record<PortName, z.ZodType>);
export type PortTick<P extends PortName> = z.infer<(typeof PortTickSchemas)[P]>;
