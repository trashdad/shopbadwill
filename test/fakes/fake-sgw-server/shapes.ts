// Raw SGW buyerapi shapes as the FAKE server speaks them (zod). Hand-derived from
// contracts section 3.3 and the fable-prompt recon; T-24 owns the real adapter schemas and
// will later validate this server against them. Dollars are JSON numbers (as on the
// real site); times are naive Pacific strings.
import { z } from 'zod';

export const NaivePacificSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?$/);
/** SGW takes booleans in request bodies as the strings "true"/"false". */
export const StringBoolSchema = z.enum(['true', 'false']);

const IntOrNumericString = z.union([z.number().int(), z.string().regex(/^\d+$/)]);

export const ItemListingRequestSchema = z.looseObject({
  searchText: z.string(),
  selectedCategoryIds: z.string().optional(),
  selectedSellerIds: z.string().optional(),
  lowPrice: z.union([z.string(), z.number()]).optional(),
  highPrice: z.union([z.string(), z.number()]).optional(),
  page: IntOrNumericString.optional(),
  pageSize: IntOrNumericString.optional(),
  sortColumn: z.union([z.number().int(), z.string()]).optional(),
  sortDescending: StringBoolSchema.optional(),
  closedAuctions: StringBoolSchema.optional(),
  pickupOnly: StringBoolSchema.optional(),
  searchDescriptions: StringBoolSchema.optional(),
  isAllExceptPickupOnly: StringBoolSchema.optional(),
  oneCentShippingOnly: StringBoolSchema.optional(),
});

export const SearchRowSchema = z.object({
  itemId: z.number().int().positive(),
  title: z.string(),
  currentPrice: z.number(),
  /** The STARTING minimum, not the next acceptable bid. */
  minimumBid: z.number(),
  numBids: z.number().int(),
  endTime: NaivePacificSchema,
  sellerId: z.number().int(),
  sellerName: z.string(),
  categoryId: z.number().int(),
  isFavorite: z.boolean(),
  shippingPrice: z.number().nullable(),
  imageURL: z.string(),
});
export const ItemListingResponseSchema = z.object({
  searchResults: z.object({ items: z.array(SearchRowSchema).max(40), itemCount: z.number().int() }),
  maxTotalRecords: z.literal(10000),
  page: z.number().int(),
});

export const ItemDetailResponseSchema = z.object({
  itemId: z.number().int().positive(),
  title: z.string(),
  description: z.string(),
  currentPrice: z.number(),
  /** The NEXT acceptable bid. */
  minimumBid: z.number(),
  bidIncrement: z.number(),
  numBids: z.number().int(),
  endTime: NaivePacificSchema,
  /** Naive Pacific WITH milliseconds. */
  serverTime: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}$/),
  sellerId: z.number().int(),
  sellerName: z.string(),
  categoryId: z.number().int(),
  pickupOnly: z.boolean(),
  shippingPrice: z.number().nullable(),
  isClosed: z.boolean(),
  inWatchlist: z.boolean(),
  bidHistory: z.object({
    auctionClosed: z.boolean(),
    isHighBidderLogIn: z.boolean(),
    bidComplete: z.array(z.object({ bidAmount: z.number(), bidTime: NaivePacificSchema, bidderName: z.string() })),
  }),
});

/** POST Dashboard/GetCurrentTime: the SGW envelope; data is "MM/dd/yyyy HH:mm:ss" Pacific (S-1). */
export const GetCurrentTimeResponseSchema = z.object({ status: z.boolean(), data: z.string().regex(/^\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}:\d{2}$/) });

/** Shape unverified on the real site (fable-prompt flags it). */
export const CalculateShippingRequestSchema = z.looseObject({ itemId: z.number().int(), zipCode: z.string() });
export const CalculateShippingResponseSchema = z.object({ shippingPrice: z.number(), handlingPrice: z.number() });

export const AckResponseSchema = z.object({ status: z.boolean(), message: z.string() });

export const FavoriteRowSchema = z.object({
  itemId: z.number().int().positive(),
  watchlistId: z.number().int(),
  notes: z.string(),
  endTime: NaivePacificSchema,
  sellerId: z.number().int(),
  title: z.string(),
  currentPrice: z.number(),
});
export const FavoritesResponseSchema = z.object({ status: z.boolean(), data: z.array(FavoriteRowSchema) });

export const FavoriteSaveRequestSchema = z.object({ notes: z.string(), watchlistId: z.number().int() });

export const SavedSearchRowSchema = z.object({
  saveSearchId: z.number().int(),
  searchName: z.string(),
  searchText: z.string(),
  selectedCategoryIds: z.string(),
  selectedSellerIds: z.string(),
  lowPrice: z.number(),
  highPrice: z.number(),
});
export const SavedSearchesResponseSchema = z.object({ status: z.boolean(), data: z.array(SavedSearchRowSchema) });

export const ShowBidModalResponseSchema = z.object({ sellerId: z.number().int(), minimumBid: z.number() });
export const PlaceBidRequestSchema = z.object({
  itemId: z.number().int(),
  bidAmount: z.string(),
  sellerId: z.number().int(),
  quantity: z.number().int(),
});
export const PlaceBidResponseSchema = z.object({ status: z.boolean(), result: z.number().int(), message: z.string() });

export const RefreshTokenRequestSchema = z.object({ refreshToken: z.string(), clientIpAddress: z.string().optional() });
export const TokenResponseSchema = z.object({ accessToken: z.string(), refreshToken: z.string() });

export const ErrorBodySchema = z.object({ message: z.string() });

// Control plane.
export const LogEntrySchema = z.object({
  seq: z.number().int(),
  method: z.string(),
  path: z.string(),
  query: z.string(),
  endpoint: z.string(),
  status: z.number().int(),
  receivedAtMs: z.number(),
  /** Client-declared fake time from `x-sbw-fake-now` (epoch ms), else null. */
  fakeNowMs: z.number().nullable(),
  /** The time to treat as the request time: fakeNowMs when declared, else receivedAtMs. */
  requestTimeMs: z.number(),
  hasBearer: z.boolean(),
  body: z.string(),
});
export const LogResponseSchema = z.object({ entries: z.array(LogEntrySchema) });
export const MintedTokenSchema = z.object({ accessToken: z.string(), expiresAtMs: z.number() });
