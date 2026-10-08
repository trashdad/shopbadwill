// Contract v1 (T-02): PLAN §3.1 domain types, plus the data shapes of §3.3,
// §3.4 and §3.11 that adapters must read. Adapters may import this file and
// the snipe, calendar and audit `types.ts` files, but not the domain `schema.ts`
// files (PLAN §2.1, eslint.config.js), so these shapes live here.
//
// Each type is derived from its zod schema (`<Name>Schema`), which validates
// it at every boundary: storage reads, messages, the tap. Changing anything
// here is a contract change (.github/PULL_REQUEST_TEMPLATE/contract-change.md).
//
// Conventions (§3): money is `Cents` (integer); instants are `EpochMs` or
// `IsoUtc` (RFC 3339 with `Z`); raw site strings keep a `Raw` suffix.
import { z } from 'zod';

// ── Scalars ─────────────────────────────────────────────────────────────────

/** SGW numeric item id, e.g. 279250057. */
export const ItemIdSchema = z.number().int().positive();
export type ItemId = z.infer<typeof ItemIdSchema>;

/** Integer cents: 1299 = $12.99. */
export const CentsSchema = z.number().int().nonnegative();
export type Cents = z.infer<typeof CentsSchema>;

/** Milliseconds since the Unix epoch. Not necessarily an integer (fireAt subtracts rtt/2). */
export const EpochMsSchema = z.number().nonnegative();
export type EpochMs = z.infer<typeof EpochMsSchema>;

/** RFC 3339 in UTC with `Z`, e.g. "2026-10-08T02:18:30.000Z". */
export const IsoUtcSchema = z.iso.datetime();
export type IsoUtc = z.infer<typeof IsoUtcSchema>;

/** Naive Pacific time exactly as SGW sends it: "2026-10-07T19:18:30" or "…:17.45". */
export const PacificNaiveRawSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?$/);
export type PacificNaiveRaw = z.infer<typeof PacificNaiveRawSchema>;

/** Two-letter US state code, for `Listing.sellerState` and the `location` condition. */
export const UsStateSchema = z.string().regex(/^[A-Z]{2}$/);
export type UsState = z.infer<typeof UsStateSchema>;

// ── §3.1 ────────────────────────────────────────────────────────────────────

export const ListingSchema = z.object({
  itemId: ItemIdSchema,
  /** Untrusted text; render as text only. */
  title: z.string(),
  currentPrice: CentsSchema,
  /** Search-row minimumBid; NOT the next acceptable bid. */
  startingMinimumBid: CentsSchema,
  numBids: z.number().int().nonnegative(),
  /** Parsed from endTimeRaw with America/Los_Angeles. */
  endTime: IsoUtcSchema,
  endTimeRaw: PacificNaiveRawSchema,
  sellerId: z.number().int(),
  sellerName: z.string().optional(),
  /** 2-letter US state, for the 'location' condition (I-08; source field per S-1). */
  sellerState: UsStateSchema.optional(),
  categoryId: z.number().int().optional(),
  /** "Collectibles > Glass" */
  categoryPath: z.string().optional(),
  /** null = calculated, unknown until quoted. */
  shippingPrice: CentsSchema.nullable().optional(),
  pickupOnly: z.boolean(),
  buyNowPrice: CentsSchema.nullable().optional(),
  imageUrl: z.string().optional(),
  /** Only meaningful when the request was authenticated. */
  isFavorite: z.boolean().optional(),
  relistId: z.number().int().nullable().optional(),
  source: z.enum(['tap', 'api', 'dom']),
  observedAt: EpochMsSchema,
});
export type Listing = z.infer<typeof ListingSchema>;

export const ItemDetailSchema = ListingSchema.extend({
  /** Next acceptable bid (detail value; use THIS for caps and snipes). */
  minimumBid: CentsSchema,
  bidIncrement: CentsSchema,
  /** Parsed per the S-1 verdict (naive PT assumed). */
  serverTime: IsoUtcSchema,
  serverTimeRaw: z.string(),
  isClosed: z.boolean(),
  /** null = unknown (anonymous read). */
  isHighBidder: z.boolean().nullable(),
  inWatchlist: z.boolean().nullable(),
  handlingPrice: CentsSchema.optional(),
  bidHistory: z.array(
    z.object({ amount: CentsSchema, time: IsoUtcSchema, timeRaw: z.string(), bidderMasked: z.string() }),
  ),
});
export type ItemDetail = z.infer<typeof ItemDetailSchema>;

export const FavoriteSchema = z.object({
  itemId: ItemIdSchema,
  watchlistId: z.number().int(),
  notes: z.string(),
  endTime: IsoUtcSchema,
  sellerId: z.number().int(),
  status: z.enum(['open', 'closed']),
});
export type Favorite = z.infer<typeof FavoriteSchema>;

export const BidResultKindSchema = z.enum([
  'accepted', // bid registered; may or may not be high bidder
  'outbid', // registered but below a rival's proxy max
  'below-minimum',
  'closed',
  'auth',
  'restricted',
  'rejected-unknown',
]);
export type BidResultKind = z.infer<typeof BidResultKindSchema>;

export const BidResultSchema = z.object({
  kind: BidResultKindSchema,
  rawStatus: z.number().int().nullable(),
  rawResult: z.number().int().nullable(),
  /** HTML stripped to text at the adapter edge. */
  messageText: z.string(),
  isHighBidder: z.boolean().nullable(),
  observedAt: EpochMsSchema,
});
export type BidResult = z.infer<typeof BidResultSchema>;

export const TrackedItemSchema = z.object({
  itemId: ItemIdSchema,
  title: z.string(),
  endTime: IsoUtcSchema,
  sellerId: z.number().int(),
  reasons: z.array(z.object({ kind: z.enum(['watch', 'favorite', 'snipe', 'manual']), id: z.string().optional() })),
  favoriteState: z.enum(['none', 'queued', 'favorited', 'failed']),
  /** Desired on the calendar? */
  calendar: z.boolean(),
  outcome: z.enum(['won', 'lost', 'ended-early', 'unknown']).optional(),
  addedAt: EpochMsSchema,
  updatedAt: EpochMsSchema,
});
export type TrackedItem = z.infer<typeof TrackedItemSchema>;

// ── §3.3 data: search query, clock samples, health, session ────────────────

/** Typed subset of the ItemListing body; booleans become "true"/"false" at the edge. */
export const SearchQuerySchema = z.object({
  /** Double quotes are stripped at the edge (403 otherwise); exact-phrase is a local rule. */
  searchText: z.string(),
  categoryIds: z.array(z.number().int()),
  sellerIds: z.array(z.number().int()),
  lowPrice: CentsSchema.optional(),
  highPrice: CentsSchema.optional(),
  pickupOnly: z.boolean().optional(),
  excludePickupOnly: z.boolean().optional(),
  oneCentShippingOnly: z.boolean().optional(),
  searchDescriptions: z.boolean().optional(),
  closedAuctions: z.boolean().optional(),
  sortColumn: z.number().int().optional(),
  sortDescending: z.boolean().optional(),
  /** 1-based; always 40 rows per page. */
  page: z.number().int().positive(),
  layout: z.enum(['grid', 'list']).optional(),
  /** Unknown URL params, preserved for the round-trip (I-08). */
  extra: z.record(z.string(), z.string()).optional(),
});
export type SearchQuery = z.infer<typeof SearchQuerySchema>;

export const ClockSampleSchema = z.object({
  serverMs: EpochMsSchema,
  sentAt: EpochMsSchema,
  receivedAt: EpochMsSchema,
  rttMs: z.number().nonnegative(),
  source: z.enum(['itemDetail', 'getCurrentTime', 'dateHeader']),
});
export type ClockSample = z.infer<typeof ClockSampleSchema>;

export const HealthReportSchema = z.object({
  ok: z.boolean(),
  checkedAt: EpochMsSchema,
  configVersion: z.string(),
  checks: z.array(
    z.object({
      name: z.enum(['search-schema', 'detail-schema', 'card-selectors', 'clock', 'session']),
      ok: z.boolean(),
      detail: z.string().optional(),
    }),
  ),
});
export type HealthReport = z.infer<typeof HealthReportSchema>;

/** `SgwSession.state()`; `expiring` = less than 12 h left (and still allowed to write, I-08). */
export const SgwSessionStateSchema = z.enum(['ok', 'expiring', 'expired', 'logged-out']);
export type SgwSessionState = z.infer<typeof SgwSessionStateSchema>;

// ── §3.4 data: lanes ────────────────────────────────────────────────────────

export const LaneSchema = z.enum(['interactive', 'background', 'snipe', 'canary']);
export type Lane = z.infer<typeof LaneSchema>;

export const LaneConfigSchema = z.object({
  minIntervalMs: z.number().int().nonnegative(),
  jitterMs: z.number().int().nonnegative(),
  maxConcurrent: z.literal(1),
  dailyBudget: z.number().int().nonnegative(),
});
export type LaneConfig = z.infer<typeof LaneConfigSchema>;

/** §3.4 lane table. The snipe lane's 1 s interval is the exception justified in §9. */
export const DEFAULT_LANES: Readonly<Record<Lane, Readonly<LaneConfig>>> = Object.freeze({
  interactive: Object.freeze({ minIntervalMs: 1000, jitterMs: 300, maxConcurrent: 1, dailyBudget: 300 }),
  background: Object.freeze({ minIntervalMs: 120000, jitterMs: 15000, maxConcurrent: 1, dailyBudget: 120 }),
  snipe: Object.freeze({ minIntervalMs: 1000, jitterMs: 0, maxConcurrent: 1, dailyBudget: 80 }),
  canary: Object.freeze({ minIntervalMs: 120000, jitterMs: 0, maxConcurrent: 1, dailyBudget: 4 }),
});

/** `RequestScheduler.stats()`; also the `health.get` reply's `budget` (I-08). */
export const RequestSchedulerStatsSchema = z.object({
  lanes: z.record(
    LaneSchema,
    z.object({
      usedToday: z.number().int().nonnegative(),
      budget: z.number().int().nonnegative(),
      nextAllowedAt: EpochMsSchema,
      backoffUntil: EpochMsSchema.optional(),
    }),
  ),
  cacheHits: z.number().int().nonnegative(),
});
export type RequestSchedulerStats = z.infer<typeof RequestSchedulerStatsSchema>;

// ── §3.11 session and credentials records ──────────────────────────────────

/** Stored at `sbw:sgwSession`. Renamed from SgwSession to avoid the §3.3 port name (I-08). */
export const SgwSessionRecordSchema = z.object({
  bearer: z.string().min(1),
  capturedAt: EpochMsSchema,
  expiresAt: EpochMsSchema,
  buyerId: z.string().min(1),
  source: z.enum(['tap', 'webRequest']),
  /** Only if S-2 approves unattended refresh. */
  refreshToken: z.string().optional(),
});
export type SgwSessionRecord = z.infer<typeof SgwSessionRecordSchema>;

/** Stored at `sbw:google`. */
export const GoogleCredentialsSchema = z.object({
  provider: z.enum(['pkce', 'chrome-identity']),
  clientId: z.string().min(1),
  clientSecret: z.string().optional(),
  refreshToken: z.string().optional(),
  grantedScopes: z.array(z.string()),
  connectedAt: EpochMsSchema,
  account: z.string().optional(),
  calendarId: z.string().optional(),
});
export type GoogleCredentials = z.infer<typeof GoogleCredentialsSchema>;
