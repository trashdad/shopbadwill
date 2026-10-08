// Type-level mirror of PLAN §3 (v1.1). Each `Spec*` type below is copied from
// §3 as amended (I-07, I-08, I-21, I-33); the assertions prove the exported
// contract types (mostly `z.infer` of the zod schemas) are exactly those
// shapes. A mismatch is a `pnpm typecheck` error; the runtime test is a no-op.
import { describe, expectTypeOf, it } from 'vitest';

import type { AuditEntry, AuditLog } from '../../../src/domain/audit/types';
import type {
  AuthStatus,
  CalendarLink,
  DesiredEvent,
  EventIdFor,
  GcalEvent,
  GcalEventBody,
  GoogleAuthErrorCode,
} from '../../../src/domain/calendar/types';
import type {
  CompileKeyword,
  Condition,
  Evaluate,
  EvaluateBatch,
  MatchContext,
  MatchReason,
  MatchResult,
  Rule,
} from '../../../src/domain/rules/schema';
import type { Settings } from '../../../src/domain/settings/schema';
import type {
  CapsCheck,
  CapsResult,
  CheckCaps,
  ComputeFireAt,
  Effect,
  LeadMs,
  Reduce,
  Snipe,
  SnipeEvent,
  SnipeOutcome,
  SnipeState,
} from '../../../src/domain/snipe/types';
import type {
  BidResult,
  BidResultKind,
  Cents,
  ClockSample,
  EpochMs,
  Favorite,
  GoogleCredentials,
  HealthReport,
  IsoUtc,
  ItemDetail,
  ItemId,
  Lane,
  LaneConfig,
  Listing,
  PacificNaiveRaw,
  SearchQuery,
  SgwSessionRecord,
  TrackedItem,
} from '../../../src/domain/types';
import type {
  DailyJob,
  FavoritesReconciler,
  JobRun,
  JobStep,
  Scheduler,
  StepOutcome,
  Watch,
} from '../../../src/domain/watches/schema';
import type {
  MsgPayload,
  MsgReply,
  MsgType,
  PortName,
  PortTick,
  SnipeCountdownTick,
} from '../../../src/messaging/protocol';
import type { MessagingClient } from '../../../src/ports/messaging';
import type { RequestScheduler } from '../../../src/ports/request-scheduler';
import type { SearchQueryFromUrl, SearchQueryToUrl } from '../../../src/ports/sgw-api';

// ── §3.1 ────────────────────────────────────────────────────────────────────
interface SpecListing {
  itemId: ItemId;
  title: string;
  currentPrice: Cents;
  startingMinimumBid: Cents;
  numBids: number;
  endTime: IsoUtc;
  endTimeRaw: PacificNaiveRaw;
  sellerId: number;
  sellerName?: string;
  sellerState?: string;
  categoryId?: number;
  categoryPath?: string;
  shippingPrice?: Cents | null;
  pickupOnly: boolean;
  buyNowPrice?: Cents | null;
  imageUrl?: string;
  isFavorite?: boolean;
  relistId?: number | null;
  source: 'tap' | 'api' | 'dom';
  observedAt: EpochMs;
}
interface SpecItemDetail extends SpecListing {
  minimumBid: Cents;
  bidIncrement: Cents;
  serverTime: IsoUtc;
  serverTimeRaw: string;
  isClosed: boolean;
  isHighBidder: boolean | null;
  inWatchlist: boolean | null;
  handlingPrice?: Cents;
  bidHistory: Array<{ amount: Cents; time: IsoUtc; timeRaw: string; bidderMasked: string }>;
}
interface SpecFavorite {
  itemId: ItemId;
  watchlistId: number;
  notes: string;
  endTime: IsoUtc;
  sellerId: number;
  status: 'open' | 'closed';
}
type SpecBidResultKind =
  | 'accepted'
  | 'outbid'
  | 'below-minimum'
  | 'closed'
  | 'auth'
  | 'restricted'
  | 'rejected-unknown';
interface SpecBidResult {
  kind: SpecBidResultKind;
  rawStatus: number | null;
  rawResult: number | null;
  messageText: string;
  isHighBidder: boolean | null;
  observedAt: EpochMs;
}
interface SpecTrackedItem {
  itemId: ItemId;
  title: string;
  endTime: IsoUtc;
  sellerId: number;
  reasons: Array<{ kind: 'watch' | 'favorite' | 'snipe' | 'manual'; id?: string }>;
  favoriteState: 'none' | 'queued' | 'favorited' | 'failed';
  calendar: boolean;
  outcome?: 'won' | 'lost' | 'ended-early' | 'unknown';
  addedAt: EpochMs;
  updatedAt: EpochMs;
}

// ── §3.3 / §3.4 data ────────────────────────────────────────────────────────
interface SpecSearchQuery {
  searchText: string;
  categoryIds: number[];
  sellerIds: number[];
  lowPrice?: Cents;
  highPrice?: Cents;
  pickupOnly?: boolean;
  excludePickupOnly?: boolean;
  oneCentShippingOnly?: boolean;
  searchDescriptions?: boolean;
  closedAuctions?: boolean;
  sortColumn?: number;
  sortDescending?: boolean;
  page: number;
  layout?: 'grid' | 'list';
  extra?: Record<string, string>;
}
interface SpecClockSample {
  serverMs: EpochMs;
  sentAt: EpochMs;
  receivedAt: EpochMs;
  rttMs: number;
  source: 'itemDetail' | 'getCurrentTime' | 'dateHeader';
}
interface SpecHealthReport {
  ok: boolean;
  checkedAt: EpochMs;
  configVersion: string;
  checks: Array<{
    name: 'search-schema' | 'detail-schema' | 'card-selectors' | 'clock' | 'session';
    ok: boolean;
    detail?: string;
  }>;
}
type SpecLane = 'interactive' | 'background' | 'snipe' | 'canary';
interface SpecLaneConfig {
  minIntervalMs: number;
  jitterMs: number;
  maxConcurrent: 1;
  dailyBudget: number;
}
interface SpecSchedulerStats {
  lanes: Record<SpecLane, { usedToday: number; budget: number; nextAllowedAt: EpochMs; backoffUntil?: EpochMs }>;
  cacheHits: number;
}

// ── §3.5 ────────────────────────────────────────────────────────────────────
type SpecCondition =
  | {
      kind: 'keyword';
      mode: 'any' | 'all' | 'none';
      terms: string[];
      wholeWord: boolean;
      regex: boolean;
      fields: Array<'title' | 'category' | 'seller'>;
    }
  | { kind: 'price'; min?: Cents; max?: Cents }
  | { kind: 'landedCost'; min?: Cents; max?: Cents }
  | { kind: 'seller'; mode: 'include' | 'exclude'; sellerIds: number[]; sellerNames: string[] }
  | { kind: 'location'; mode: 'include' | 'exclude'; states: string[] }
  | { kind: 'category'; categoryIds: number[]; includeChildren: boolean }
  | { kind: 'endsWithin'; minMinutes?: number; maxMinutes?: number }
  | { kind: 'bidCount'; min?: number; max?: number }
  | { kind: 'pickupOnly'; value: boolean };
interface SpecRule {
  id: string;
  name: string;
  enabled: boolean;
  action: 'highlight' | 'hide' | 'watch';
  tone?: 'green' | 'amber' | 'blue';
  all: SpecCondition[];
  any?: SpecCondition[];
  createdAt: EpochMs;
  updatedAt: EpochMs;
}
interface SpecMatchContext {
  now: EpochMs;
  landedCost?: (id: ItemId) => Cents | null | undefined;
}
interface SpecMatchReason {
  ruleId: string;
  conditionIndex: number;
  field: string;
  detail: string;
}
interface SpecMatchResult {
  itemId: ItemId;
  decision: 'hide' | 'highlight' | 'watch' | 'none';
  matched: Array<{ ruleId: string; action: SpecRule['action']; reasons: SpecMatchReason[] }>;
  unknownConditions: number;
}

// ── §3.6 / §3.7 ─────────────────────────────────────────────────────────────
interface SpecWatch {
  id: string;
  name: string;
  enabled: boolean;
  query: SpecSearchQuery;
  ruleIds: string[];
  maxPages: 1 | 2 | 3;
  favoriteMode: 'sgw' | 'sgw-late' | 'local';
  favoriteWithinHours?: number;
  calendar: boolean;
  notify: boolean;
  lastRunAt?: EpochMs;
  nextRunAt: EpochMs;
  lastError?: string;
  seenItemIds: ItemId[];
}
type SpecJobStep =
  | { kind: 'search'; watchId: string; page: number }
  | { kind: 'favoritesList' }
  | { kind: 'detail'; itemId: ItemId; reason: 'new-match' | 'calendar' }
  | { kind: 'favorite'; itemId: ItemId; watchId: string; notBefore?: EpochMs }
  | { kind: 'quote'; itemId: ItemId }
  | { kind: 'calendarUpsert'; itemId: ItemId }
  | { kind: 'notifyDigest' }
  | { kind: 'postEnd'; itemId: ItemId };
type SpecStepOutcome =
  | { kind: 'search'; items: SpecListing[]; total: number }
  | { kind: 'favoritesList'; items: SpecFavorite[] }
  | { kind: 'detail' | 'postEnd'; detail: SpecItemDetail }
  | { kind: 'quote'; quote: { shipping: Cents; handling: Cents } | null }
  | { kind: 'favorite' | 'calendarUpsert' | 'notifyDigest'; done: true }
  | { kind: 'deferred'; until: EpochMs }
  | { kind: 'error'; message: string; retryable: boolean };
interface SpecJobRun {
  id: string;
  trigger: 'scheduled' | 'catch-up' | 'manual';
  startedAt: EpochMs;
  finishedAt?: EpochMs;
  status: 'running' | 'done' | 'failed' | 'paused';
  steps: SpecJobStep[];
  cursor: number;
  results: {
    newMatches: ItemId[];
    favorited: ItemId[];
    calendarUpserts: ItemId[];
    errors: Array<{ step: number; message: string }>;
  };
}

// ── §3.8 ────────────────────────────────────────────────────────────────────
interface SpecDesiredEvent {
  itemId: ItemId;
  generation: number;
  title: string;
  description: string;
  startUtc: IsoUtc;
  durationMin: 15;
  sourceUrl: string;
  reminders: Array<{ method: 'popup' | 'email'; minutes: number }>;
  privateProps: { sbwItemId: string; sbwGen: string; sbwState: 'open' | 'won' | 'lost' | 'ended-early' };
}
interface SpecCalendarLink {
  itemId: ItemId;
  eventId: string;
  generation: number;
  calendarId: string;
  lastSyncedHash: string;
  status: 'synced' | 'pending' | 'error' | 'deleted';
  lastError?: string;
}
interface SpecGcalEventBody {
  summary: string;
  description: string;
  start: { dateTime: IsoUtc; timeZone: 'UTC' };
  end: { dateTime: IsoUtc; timeZone: 'UTC' };
  reminders: { useDefault: false; overrides: SpecDesiredEvent['reminders'] };
  extendedProperties: { private: SpecDesiredEvent['privateProps'] };
  source?: { title: string; url: string };
  status?: 'confirmed' | 'cancelled';
}
// §3.8 writes `interface GcalEvent extends GcalEventBody` with a wider
// `status`, which TypeScript rejects; the intended shape is this override.
interface SpecGcalEvent extends Omit<SpecGcalEventBody, 'status'> {
  id: string;
  status: 'confirmed' | 'tentative' | 'cancelled';
  etag?: string;
}
type SpecGoogleAuthErrorCode =
  | 'invalid_grant'
  | 'unauthorized'
  | 'insufficient_scope'
  | 'rate_limited'
  | 'offline'
  | 'needs_interaction'
  | 'not_configured'
  | 'user_cancelled';
interface SpecAuthStatus {
  connected: boolean;
  provider: 'pkce' | 'chrome-identity' | 'none';
  account?: string;
  grantedScopes: string[];
  refreshTokenAgeDays?: number;
  lastError?: SpecGoogleAuthErrorCode;
  needsInteraction: boolean;
  configured: boolean;
}

// ── §3.9 ────────────────────────────────────────────────────────────────────
type SpecSnipeState =
  | 'draft'
  | 'armed'
  | 'fallback-applied'
  | 'waking'
  | 'verified'
  | 'firing'
  | 'sent'
  | 'resolved'
  | 'killed';
type SpecSnipeOutcome =
  | 'won'
  | 'outbid'
  | 'below-minimum'
  | 'auth'
  | 'network'
  | 'late'
  | 'ended'
  | 'extended'
  | 'cap-blocked'
  | 'killed'
  | 'dry-run'
  | 'fallback-proxy-placed'
  | 'skipped';
interface SpecSnipe {
  id: string;
  itemId: ItemId;
  title: string;
  endTime: IsoUtc;
  endTimeAtArm: IsoUtc;
  sellerId?: number;
  maxBid: Cents;
  allInMax?: Cents;
  estShipping?: Cents;
  estHandling?: Cents;
  leadMs: number;
  fallback: 'early-proxy' | 'skip';
  dryRun: boolean;
  state: SpecSnipeState;
  outcome?: SpecSnipeOutcome;
  outcomeDetail?: string;
  armedAt: EpochMs;
  fireAt?: EpochMs;
  wakeAlarm?: string;
  attempt: { sentAt?: EpochMs; idempotencyKey?: string; ambiguous?: boolean };
  measured?: { offsetMs?: number; rttMs?: number; firedAt?: EpochMs; responseAt?: EpochMs };
  groupId?: string;
  history: Array<{ at: EpochMs; from: SpecSnipeState; to: SpecSnipeState; why: string }>;
}
type SpecSnipeEvent =
  | { type: 'arm'; now: EpochMs }
  | { type: 'disarm'; now: EpochMs; by: 'user' | 'kill' | 'anomaly'; why: string }
  | { type: 'wake'; now: EpochMs }
  | { type: 'verified'; now: EpochMs; detail: SpecItemDetail; offsetMs: number; rttMs: number }
  | {
      type: 'verify-failed';
      now: EpochMs;
      reason: 'ended' | 'extended' | 'price-over-max' | 'already-high' | 'auth' | 'network' | 'clock' | 'cap';
    }
  | { type: 'fire'; now: EpochMs }
  | { type: 'sent'; now: EpochMs; key: string }
  | { type: 'result'; now: EpochMs; result: SpecBidResult }
  | { type: 'ambiguous'; now: EpochMs }
  | { type: 'post-read'; now: EpochMs; detail: SpecItemDetail }
  | { type: 'preflight-failed'; now: EpochMs; reason: string }
  | { type: 'apply-fallback'; now: EpochMs; mode: 'early-proxy' | 'skip' };
// §3.9 fixes the Effect kinds and `snipeId`; T-02 adds the per-kind payloads.
type SpecEffectKind =
  | 'scheduleWake'
  | 'holdKeepAwake'
  | 'sampleClock'
  | 'readDetail'
  | 'placeBid'
  | 'notify'
  | 'stampCalendar'
  | 'audit'
  | 'applyFallbackProxy'
  | 'proposeRearm';
interface SpecCapsCheck {
  perItemMax: Cents;
  perDayMax: Cents;
  openExposureMax: Cents;
  typoMultiplier: 3;
  typoAbsolute: Cents;
}
interface SpecCapsResult {
  ok: boolean;
  violations: string[];
}

// ── §3.10 / §3.11 ───────────────────────────────────────────────────────────
interface SpecAuditEntry {
  seq: number;
  at: EpochMs;
  actor: 'user' | 'daily-job' | 'snipe' | 'calendar' | 'health' | 'system';
  kind: string;
  itemId?: ItemId;
  ref?: string;
  details: Record<string, string | number | boolean | null>;
  undo?: { kind: 'unfavorite' | 'deleteEvent' | 'disableRule' | 'disarm'; ref: string; done?: boolean };
  dryRun?: boolean;
}
interface SpecSettings {
  schemaVersion: 1;
  homeZip?: string;
  locale: { timeZone: string };
  dailyRun: { enabled: boolean; localTime: string; catchUp: boolean };
  overlay: {
    enabled: boolean;
    hideStyle: 'collapse' | 'dim';
    quickFavorite: boolean;
    landedCostBadges: boolean;
    countdown: boolean;
  };
  dryRun: { favorites: boolean; calendar: boolean; bidding: boolean };
  considerateMode: 'normal' | 'tight';
  features: { landedCost: boolean; comps: boolean; countdownRefresh: boolean; relistDetector: boolean };
  calendar: { enabled: boolean; mode: 'dedicated' | 'primary'; reminders: number[]; icsFallback: boolean };
  notifications: { enabled: boolean; digest: boolean; quietHours?: { from: string; to: string } };
  ntfy?: { enabled: boolean; server: string; topic: string };
  snipe: {
    enabled: boolean;
    defaultLeadMs: number;
    defaultFallback: 'early-proxy' | 'skip';
    caps: SpecCapsCheck;
    keepAlive: boolean;
    requiredDryRuns: number;
    completedDryRuns: number;
    tier: 'T0' | 'T1' | 'T2';
  };
  killSwitch: boolean;
}
interface SpecSgwSessionRecord {
  bearer: string;
  capturedAt: EpochMs;
  expiresAt: EpochMs;
  buyerId: string;
  source: 'tap' | 'webRequest';
  refreshToken?: string;
}
interface SpecGoogleCredentials {
  provider: 'pkce' | 'chrome-identity';
  clientId: string;
  clientSecret?: string;
  refreshToken?: string;
  grantedScopes: string[];
  connectedAt: EpochMs;
  account?: string;
}

// ── §2.1 Messaging port (fix round 1) ───────────────────────────────────────
interface SpecMessagingClient {
  send<K extends MsgType>(type: K, payload: MsgPayload<K>): Promise<MsgReply<K>>;
  connect<P extends PortName>(name: P, onTick: (t: PortTick<P>) => void): () => void;
  onBroadcast<K extends 'rules.changed' | 'switches.changed'>(type: K, cb: (payload: MsgPayload<K>) => void): () => void;
}

describe('§3 shapes (type level)', () => {
  it('§3.1 domain types', () => {
    expectTypeOf<Listing>().toEqualTypeOf<SpecListing>();
    expectTypeOf<ItemDetail>().toEqualTypeOf<SpecItemDetail>();
    expectTypeOf<Favorite>().toEqualTypeOf<SpecFavorite>();
    expectTypeOf<BidResultKind>().toEqualTypeOf<SpecBidResultKind>();
    expectTypeOf<BidResult>().toEqualTypeOf<SpecBidResult>();
    expectTypeOf<TrackedItem>().toEqualTypeOf<SpecTrackedItem>();
    expectTypeOf<ItemId>().toEqualTypeOf<number>();
    expectTypeOf<Cents>().toEqualTypeOf<number>();
    expectTypeOf<EpochMs>().toEqualTypeOf<number>();
    expectTypeOf<IsoUtc>().toEqualTypeOf<string>();
    expectTypeOf<PacificNaiveRaw>().toEqualTypeOf<string>();
  });

  it('§3.3 / §3.4 data shapes', () => {
    expectTypeOf<SearchQuery>().toEqualTypeOf<SpecSearchQuery>();
    expectTypeOf<ClockSample>().toEqualTypeOf<SpecClockSample>();
    expectTypeOf<HealthReport>().toEqualTypeOf<SpecHealthReport>();
    expectTypeOf<Lane>().toEqualTypeOf<SpecLane>();
    expectTypeOf<LaneConfig>().toEqualTypeOf<SpecLaneConfig>();
    expectTypeOf<ReturnType<RequestScheduler['stats']>>().toEqualTypeOf<SpecSchedulerStats>();
    expectTypeOf<SearchQueryFromUrl>().toEqualTypeOf<(url: string) => SpecSearchQuery | null>();
    expectTypeOf<SearchQueryToUrl>().toEqualTypeOf<(q: SpecSearchQuery) => string>();
  });

  it('§3.5 rule engine', () => {
    expectTypeOf<Condition>().toEqualTypeOf<SpecCondition>();
    expectTypeOf<Rule>().toEqualTypeOf<SpecRule>();
    expectTypeOf<MatchContext>().toEqualTypeOf<SpecMatchContext>();
    expectTypeOf<MatchReason>().toEqualTypeOf<SpecMatchReason>();
    expectTypeOf<MatchResult>().toEqualTypeOf<SpecMatchResult>();
    expectTypeOf<Evaluate>().toEqualTypeOf<
      (listing: SpecListing, rules: SpecRule[], ctx: SpecMatchContext) => SpecMatchResult
    >();
    expectTypeOf<EvaluateBatch>().toEqualTypeOf<
      (listings: SpecListing[], rules: SpecRule[], ctx: SpecMatchContext) => SpecMatchResult[]
    >();
    expectTypeOf<CompileKeyword>().toEqualTypeOf<
      (c: Extract<SpecCondition, { kind: 'keyword' }>) => { test(text: string): boolean }
    >();
  });

  it('§3.6 / §3.7 watches, daily job, favorites', () => {
    expectTypeOf<Watch>().toEqualTypeOf<SpecWatch>();
    expectTypeOf<JobStep>().toEqualTypeOf<SpecJobStep>();
    expectTypeOf<StepOutcome>().toEqualTypeOf<SpecStepOutcome>();
    expectTypeOf<JobRun>().toEqualTypeOf<SpecJobRun>();
    expectTypeOf<DailyJob['plan']>().toEqualTypeOf<(watches: SpecWatch[], now: EpochMs) => SpecJobRun>();
    expectTypeOf<DailyJob['next']>().toEqualTypeOf<(run: SpecJobRun) => SpecJobStep | null>();
    expectTypeOf<DailyJob['apply']>().toEqualTypeOf<
      (run: SpecJobRun, step: SpecJobStep, outcome: SpecStepOutcome) => SpecJobRun
    >();
    expectTypeOf<Scheduler['dueWatches']>().toEqualTypeOf<(now: EpochMs) => Promise<SpecWatch[]>>();
    expectTypeOf<FavoritesReconciler['desired']>().toEqualTypeOf<
      (
        tracked: SpecTrackedItem[],
        watches: SpecWatch[],
        now: EpochMs,
      ) => Array<{ itemId: ItemId; action: 'add' | 'none'; reason: string }>
    >();
  });

  it('§3.8 calendar and Google auth', () => {
    expectTypeOf<DesiredEvent>().toEqualTypeOf<SpecDesiredEvent>();
    expectTypeOf<CalendarLink>().toEqualTypeOf<SpecCalendarLink>();
    expectTypeOf<GcalEventBody>().toEqualTypeOf<SpecGcalEventBody>();
    expectTypeOf<GcalEvent>().toEqualTypeOf<SpecGcalEvent>();
    expectTypeOf<GoogleAuthErrorCode>().toEqualTypeOf<SpecGoogleAuthErrorCode>();
    expectTypeOf<AuthStatus>().toEqualTypeOf<SpecAuthStatus>();
    expectTypeOf<EventIdFor>().toEqualTypeOf<(itemId: ItemId, generation: number) => string>();
  });

  it('§3.9 snipe engine', () => {
    expectTypeOf<SnipeState>().toEqualTypeOf<SpecSnipeState>();
    expectTypeOf<SnipeOutcome>().toEqualTypeOf<SpecSnipeOutcome>();
    expectTypeOf<Snipe>().toEqualTypeOf<SpecSnipe>();
    expectTypeOf<SnipeEvent>().toEqualTypeOf<SpecSnipeEvent>();
    expectTypeOf<Effect['kind']>().toEqualTypeOf<SpecEffectKind>();
    expectTypeOf<Effect['snipeId']>().toEqualTypeOf<string>();
    expectTypeOf<LeadMs>().toEqualTypeOf<number>();
    expectTypeOf<CapsCheck>().toEqualTypeOf<SpecCapsCheck>();
    expectTypeOf<CapsResult>().toEqualTypeOf<SpecCapsResult>();
    expectTypeOf<Reduce>().toEqualTypeOf<
      (s: SpecSnipe, e: SpecSnipeEvent, capsResult: SpecCapsResult) => { next: SpecSnipe; effects: Effect[] }
    >();
    expectTypeOf<ComputeFireAt>().toEqualTypeOf<(endMs: EpochMs, leadMs: number, oneWayLatencyMs: number) => EpochMs>();
    expectTypeOf<CheckCaps>().toEqualTypeOf<
      (s: SpecSnipe, others: SpecSnipe[], spentToday: Cents, caps: SpecCapsCheck) => SpecCapsResult
    >();
  });

  it('§3.10 / §3.11 audit, settings, records', () => {
    expectTypeOf<AuditEntry>().toEqualTypeOf<SpecAuditEntry>();
    expectTypeOf<AuditLog['append']>().toEqualTypeOf<(e: Omit<SpecAuditEntry, 'seq' | 'at'>) => Promise<SpecAuditEntry>>();
    expectTypeOf<Settings>().toEqualTypeOf<SpecSettings>();
    expectTypeOf<SgwSessionRecord>().toEqualTypeOf<SpecSgwSessionRecord>();
    expectTypeOf<GoogleCredentials>().toEqualTypeOf<SpecGoogleCredentials>();
  });

  it('§2.1 / §3.12 Messaging port', () => {
    expectTypeOf<MessagingClient>().toEqualTypeOf<SpecMessagingClient>();
    expectTypeOf<PortName>().toEqualTypeOf<'sbw:snipe-countdown' | 'sbw:job-progress'>();
    expectTypeOf<PortTick<'sbw:snipe-countdown'>>().toEqualTypeOf<SnipeCountdownTick>();
    expectTypeOf<PortTick<'sbw:job-progress'>>().toEqualTypeOf<SpecJobRun>();
  });
});
