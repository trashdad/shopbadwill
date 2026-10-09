// Zod schemas for the raw SGW buyerapi responses, one per endpoint key in
// config.ts (SGW_ENDPOINTS). T-24 / S-1.
//
// Rules:
//  - Lenient on unknown extra keys (`looseObject`): SGW adds fields without
//    notice and we must not break on them.
//  - Strict on every field a normalizer consumes: a renamed or retyped field
//    fails with `SgwApiError('schema')` whose message names the path
//    (`parseSgw`).
//  - Money on the wire is dollars as JSON numbers; normalize.ts converts to
//    integer cents. Times are naive Pacific strings, kept raw here.
//  - Schemas for endpoints without a captured fixture are marked
//    `// provisional: evidence=<level>` (level as in config.ts). The contract
//    test (test/contract/sgw) validates them automatically once the fixture
//    lands in manifest.json; a mismatch is then a schema fix here.
//
// Adapters may import domain/types.ts but not domain schema.ts files
// (PLAN section 2.1), so scalars come from types.ts.
import { z } from 'zod';
import { PacificNaiveRawSchema } from '../../domain/types';
import { SgwApiError } from '../../ports/errors';
import type { SgwEndpointKey } from './config';

// ── Error helper ────────────────────────────────────────────────────────────

/** `searchResults.items[3].title`: a zod issue path as a readable string. */
export function formatPath(path: ReadonlyArray<PropertyKey>): string {
  let out = '';
  for (const seg of path) {
    if (typeof seg === 'number') out += `[${String(seg)}]`;
    else out += out === '' ? String(seg) : `.${String(seg)}`;
  }
  return out === '' ? '(root)' : out;
}

/**
 * Parses `raw` with `schema`. On failure throws `SgwApiError('schema')` whose
 * message is `<label>: <path>: <reason>` for the first (up to 3) issues, so a
 * renamed field is named in the error. `cause` holds the ZodError.
 */
export function parseSgw<S extends z.ZodType>(schema: S, raw: unknown, label: string): z.infer<S> {
  const r = schema.safeParse(raw);
  if (r.success) return r.data;
  const shown = r.error.issues
    .slice(0, 3)
    .map((i) => `${formatPath(i.path)}: ${i.message}`)
    .join('; ');
  const more = r.error.issues.length > 3 ? ` (+${String(r.error.issues.length - 3)} more)` : '';
  throw new SgwApiError('schema', `${label}: ${shown}${more}`, { cause: r.error });
}

// ── Building blocks ─────────────────────────────────────────────────────────

/** Dollars as SGW sends them: a non-negative JSON number (9.99, 26, 0). */
const Dollars = z.number().nonnegative();
const NullableDollars = Dollars.nullable();
const Id = z.number().int();
const Pacific = PacificNaiveRawSchema;

/** The wrapper around every buyerapi reply except ItemListing, ItemDetail, GetSellerInfo and HelpCenter. */
export const SgwEnvelopeHeadSchema = z.looseObject({
  status: z.boolean(),
  message: z.string().nullable().optional(),
  isUnauthorized: z.boolean().optional(),
});
export type SgwEnvelopeHead = z.infer<typeof SgwEnvelopeHeadSchema>;

export function envelope<D extends z.ZodType>(data: D) {
  return SgwEnvelopeHeadSchema.extend({ data });
}

/**
 * For replies whose wrapping is not confirmed: accepts the bare object or the
 * envelope (`{status, data}`) and validates the inner object either way.
 */
function flatOrEnvelope<D extends z.ZodType>(inner: D) {
  return z.preprocess((v) => {
    if (typeof v === 'object' && v !== null && !Array.isArray(v) && 'status' in v && 'data' in v) {
      return (v as { data: unknown }).data;
    }
    return v;
  }, inner);
}

// ── search: Search/ItemListing (evidence=observed) ──────────────────────────

export const SearchRowSchema = z.looseObject({
  itemId: Id.positive(),
  title: z.string(),
  currentPrice: Dollars,
  /** STARTING minimum (== startingPrice) on search rows, not the next acceptable bid. */
  minimumBid: Dollars,
  numBids: Id.nonnegative(),
  endTime: Pacific,
  sellerId: Id,
  categoryId: Id.optional(),
  catFullName: z.string().nullable().optional(),
  shippingPrice: NullableDollars.optional(),
  buyNowPrice: NullableDollars.optional(),
  imageURL: z.string().nullable().optional(),
  isFavorite: z.boolean().optional(),
  relistId: Id.nullable().optional(),
});
export type SearchRow = z.infer<typeof SearchRowSchema>;

export const SearchResponseSchema = z.looseObject({
  searchResults: z.looseObject({
    items: z.array(SearchRowSchema),
    itemCount: Id.nonnegative(),
  }),
  /** null on a 200 marks a server-side error (community issue #12); normalize.ts checks it. */
  categoryListModel: z.unknown().optional(),
  maxTotalRecords: Id.nonnegative().optional(),
});
export type SearchResponse = z.infer<typeof SearchResponseSchema>;

/** 400 body (problem+json), e.g. non-numeric lowPrice (S-1 #7). */
export const SgwProblemDetailsSchema = z.looseObject({
  status: Id,
  title: z.string(),
  errors: z.record(z.string(), z.array(z.string())).optional(),
  type: z.string().optional(),
  traceId: z.string().optional(),
});
export type SgwProblemDetails = z.infer<typeof SgwProblemDetailsSchema>;

// ── itemDetail: ItemDetail/GetItemDetailModelByItemId/{itemId} (observed) ───

const BidLogRowSchema = z.looseObject({
  bidAmount: Dollars,
  bidTime: Pacific,
  bidderName: z.string(),
  retracted: z.boolean().optional(),
});

export const ItemDetailResponseSchema = z.looseObject({
  itemId: Id.positive(),
  title: z.string(),
  currentPrice: Dollars,
  /** The NEXT acceptable bid. */
  minimumBid: Dollars,
  startingPrice: Dollars,
  bidIncrement: Dollars,
  numberOfBids: Id.nonnegative(),
  endTime: Pacific,
  serverTime: Pacific,
  sellerId: Id,
  sellerCompanyName: z.string().nullable().optional(),
  /** The seller's state ("IL"); Listing.sellerState. The key is required, the value may be null. */
  pickupState: z.string().nullable(),
  pickupOnly: z.boolean(),
  categoryId: Id.optional(),
  /** "427|Travel/Luggage|428|Suitcases" */
  categoryParentList: z.string().nullable().optional(),
  shippingPrice: NullableDollars,
  handlingPrice: NullableDollars.optional(),
  /** true with shippingPrice 0: the price is calculated, not free. */
  allowShippingCalculation: z.boolean().optional(),
  buyNowPrice: NullableDollars.optional(),
  inWatchlist: z.boolean(),
  imageServer: z.string().nullable().optional(),
  imageUrlString: z.string().nullable().optional(),
  remainingTime: z.string().optional(),
  isItemEndTimeExpire: z.boolean(),
  bidHistory: z.looseObject({
    auctionClosed: z.boolean(),
    isHighBidderLogIn: z.boolean(),
    bidComplete: z.array(BidLogRowSchema),
  }),
});
export type ItemDetailResponse = z.infer<typeof ItemDetailResponseSchema>;

// ── currentTime: Dashboard/GetCurrentTime (observed) ────────────────────────

/** "10/07/2026 20:09:15" Pacific wall time, 1 s resolution. */
export const CurrentTimeStringSchema = z.string().regex(/^\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}:\d{2}$/);
export const CurrentTimeResponseSchema = envelope(CurrentTimeStringSchema);
export type CurrentTimeResponse = z.infer<typeof CurrentTimeResponseSchema>;

// ── sellerInfo: Seller/GetSellerInfo/{sellerId} (observed) ──────────────────

export const SellerInfoResponseSchema = z.looseObject({
  sellerId: Id,
  companyName: z.string(),
  state: z.string().nullable().optional(),
  city: z.string().nullable().optional(),
});
export type SellerInfoResponse = z.infer<typeof SellerInfoResponseSchema>;

// ── Endpoints without a captured fixture ────────────────────────────────────

// Observed (USER STEP S-1, T-24b): the reply is a JSON STRING holding an HTML
// fragment (SGW_FIELDS.shippingQuote); normalizeShippingQuote parses it. The
// object forms T-04/T-24 guessed ({shippingPrice, handlingPrice}, bare or
// enveloped) are still accepted, but SGW has not been seen to send them.
// TEMPORARY: remove the object forms once the fake server and the api-adapter
// unit tests use the real HTML-string shape.
export const ShippingQuoteResponseSchema = z.union([
  z.string(),
  flatOrEnvelope(
    z.looseObject({
      shippingPrice: NullableDollars.optional(),
      handlingPrice: NullableDollars.optional(),
    }),
  ),
]);
export type ShippingQuoteResponse = z.infer<typeof ShippingQuoteResponseSchema>;

// provisional: evidence=community
// Auth. Enveloped; `data` is the list. Row fields are guessed from ItemDetail
// naming plus what Favorite needs; the stage-2 fixture settles them.
export const FavoriteRowSchema = z.looseObject({
  itemId: Id.positive(),
  watchlistId: Id,
  notes: z.string().nullable().optional(),
  endTime: Pacific,
  sellerId: Id,
});
export type FavoriteRow = z.infer<typeof FavoriteRowSchema>;
export const FavoritesResponseSchema = envelope(z.array(FavoriteRowSchema));
export type FavoritesResponse = z.infer<typeof FavoritesResponseSchema>;

// provisional: evidence=bundle
// Add/remove/note/revoke: the site ignores the body; only `status` matters.
const AckResponseSchema = SgwEnvelopeHeadSchema;
export const AddFavoriteResponseSchema = AckResponseSchema;
export const RemoveFavoriteResponseSchema = AckResponseSchema;
// provisional: evidence=community
export const SaveFavoriteNoteResponseSchema = AckResponseSchema;
// provisional: evidence=bundle
export const RevokeTokenResponseSchema = AckResponseSchema;
export type AckResponse = z.infer<typeof AckResponseSchema>;

// Observed (USER STEP S-1, T-24b). Auth. Enveloped, `data` is the list. The real
// id key is `savedSearchId`; there is NO name field (the normalizer derives one).
// The old guessed keys (`saveSearchId`, `searchName`) are still accepted.
// TEMPORARY: remove them (and the refine) once the fake server and the
// api-adapter unit tests use the real `savedSearchId` rows.
export const SavedSearchRowSchema = z
  .looseObject({
    savedSearchId: Id.optional(),
    saveSearchId: Id.optional(),
    searchName: z.string().nullable().optional(),
    searchText: z.string().nullable().optional(),
    selectedCategoryIds: z.string().nullable().optional(),
    selectedSellerIds: z.string().nullable().optional(),
    lowPrice: z.union([z.number(), z.string()]).nullable().optional(),
    highPrice: z.union([z.number(), z.string()]).nullable().optional(),
    searchPickupOnly: z.boolean().nullable().optional(),
    searchNoPickupOnly: z.boolean().nullable().optional(),
    searchOneCentShippingOnly: z.boolean().nullable().optional(),
    searchClosedAuctions: z.boolean().nullable().optional(),
    sortColumn: z.number().int().nullable().optional(),
    sortDescending: z.boolean().nullable().optional(),
    layout: z.string().nullable().optional(),
  })
  .refine((r) => r.savedSearchId !== undefined || r.saveSearchId !== undefined, {
    message: 'savedSearchId: required',
    path: ['savedSearchId'],
  });
export type SavedSearchRow = z.infer<typeof SavedSearchRowSchema>;
export const SavedSearchesResponseSchema = envelope(z.array(SavedSearchRowSchema));
export type SavedSearchesResponse = z.infer<typeof SavedSearchesResponseSchema>;

// provisional: evidence=bundle
// Returns sellerId and minimumBid for the bid modal (chunk 540 `getItemById`).
// Wrapping unconfirmed: bare or enveloped.
export const ShowBidModalResponseSchema = flatOrEnvelope(
  z.looseObject({
    sellerId: Id,
    minimumBid: Dollars,
  }),
);
export type ShowBidModalResponse = z.infer<typeof ShowBidModalResponseSchema>;

// provisional: evidence=bundle
// MONEY. Never captured. `status` and `result` are SGW's own codes
// (BidResult.rawStatus / rawResult). PLAN lists -3 = closed as a placeholder, not a verified code;
// `message` is HTML. T-100 maps these to BidResult.kind. Both `status` shapes
// are accepted because the real type is unknown.
export const PlaceBidResponseSchema = z.looseObject({
  status: z.union([z.boolean(), z.number().int()]),
  result: z.number().int().nullable().optional(),
  message: z.string().nullable().optional(),
  isHighBidder: z.boolean().nullable().optional(),
  isUnauthorized: z.boolean().optional(),
  /**
   * If the reply is enveloped, `result` and `isHighBidder` live here. Any shape is accepted
   * (a failure may send `[]` or text); normalize.ts reads it only when it is a plain object.
   */
  data: z.unknown().optional(),
});
export type PlaceBidResponse = z.infer<typeof PlaceBidResponseSchema>;

// provisional: evidence=bundle
// Token pair. Wrapping unconfirmed; S-2 decides whether this is used at all.
export const RefreshTokenResponseSchema = flatOrEnvelope(
  z.looseObject({
    accessToken: z.string().min(1),
    refreshToken: z.string().min(1).optional(),
  }),
);
export type RefreshTokenResponse = z.infer<typeof RefreshTokenResponseSchema>;

// ── Registry ────────────────────────────────────────────────────────────────

/** One schema per config.ts endpoint key. T-30's health check and T-26 look schemas up here. */
export const SGW_ENDPOINT_SCHEMAS = {
  search: SearchResponseSchema,
  itemDetail: ItemDetailResponseSchema,
  currentTime: CurrentTimeResponseSchema,
  sellerInfo: SellerInfoResponseSchema,
  shippingQuote: ShippingQuoteResponseSchema,
  favorites: FavoritesResponseSchema,
  addFavorite: AddFavoriteResponseSchema,
  removeFavorite: RemoveFavoriteResponseSchema,
  saveFavoriteNote: SaveFavoriteNoteResponseSchema,
  savedSearches: SavedSearchesResponseSchema,
  showBidModal: ShowBidModalResponseSchema,
  placeBid: PlaceBidResponseSchema,
  refreshToken: RefreshTokenResponseSchema,
  revokeToken: RevokeTokenResponseSchema,
} as const satisfies Record<SgwEndpointKey, z.ZodType>;

/** Validates a raw response for `endpoint`; throws `SgwApiError('schema')` naming the failing path. */
export function parseEndpoint<K extends SgwEndpointKey>(
  endpoint: K,
  raw: unknown,
): z.infer<(typeof SGW_ENDPOINT_SCHEMAS)[K]> {
  return parseSgw(SGW_ENDPOINT_SCHEMAS[endpoint], raw, endpoint) as z.infer<(typeof SGW_ENDPOINT_SCHEMAS)[K]>;
}
