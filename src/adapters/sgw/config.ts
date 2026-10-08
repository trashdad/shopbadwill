// SGW site adapter configuration, v1 (S-1 / T-07, captured 2026-10-07 PT).
//
// The ONLY place that names shopgoodwill.com (SGW) endpoints, request fields,
// URL patterns and DOM selectors. Read-only after T-07 (I-29): a missing or
// wrong entry is a T-07 follow-up that bumps SGW_CONFIG_VERSION, never an
// ad-hoc edit.
//
// Evidence levels (docs/spikes/S-1.md has the captures and request numbers):
//   'observed'  - seen on the wire during the S-1 capture (request + response)
//   'bundle'    - call site read in SGW's own JS bundle (method, path, body)
//   'community' - only from github.com/scottmconway/shopgoodwill-scripts (or a
//                 bare path string in the bundle); a USER STEP S-1 capture
//                 confirms it
//
// Data only: no logic, no imports.

export const SGW_CONFIG_VERSION = '2026-10-08.2';

export const SGW_ORIGIN = 'https://shopgoodwill.com';
/** Every endpoint path below is relative to this base (SGW's own `apiEndPoint`). */
export const SGW_API_BASE = 'https://buyerapi.shopgoodwill.com/api/';

/** robots.txt as read on 2026-10-07 (S-1 request #1). */
export const SGW_ROBOTS = {
  crawlDelayMs: 120_000,
  /** Path prefixes no automated (background) load may touch. The search page is disallowed only with `?st=`. */
  disallow: ['/shopgoodwill/', '/home-preview/', '/checkout/', '/categories/listing?st='],
} as const;

/**
 * Time formats (S-1 verdict). Every timestamp is Pacific WALL time with no
 * offset; parse with IANA `zone`, never `Date.parse`.
 */
export const SGW_TIME = {
  zone: 'America/Los_Angeles',
  /**
   * ItemDetail `serverTime`, `endTime`, `startTime`, bid times and search-row
   * `endTime`: "2026-10-07T20:21:29.213". The fraction is optional and 0-3+
   * digits ("…T18:40:11.35", "…T20:39:00"). `serverTime` always carried ms in
   * S-1 and matched the HTTP `Date` header to the second (PDT, UTC-7).
   */
  naiveIso: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(\\.\\d+)?$',
  /** Dashboard/GetCurrentTime `data`: "10/07/2026 20:09:15", 1 s resolution. */
  currentTime: 'MM/dd/yyyy HH:mm:ss',
  /** Search body `closedAuctionEndingDate` (the site sends Pacific "today"). */
  closedAuctionEndingDate: 'M/d/yyyy',
} as const;

export type SgwEndpointKey =
  | 'search'
  | 'itemDetail'
  | 'currentTime'
  | 'sellerInfo'
  | 'shippingQuote'
  | 'favorites'
  | 'addFavorite'
  | 'removeFavorite'
  | 'saveFavoriteNote'
  | 'savedSearches'
  | 'showBidModal'
  | 'placeBid'
  | 'refreshToken'
  | 'revokeToken';

export interface SgwEndpoint {
  readonly method: 'GET' | 'POST';
  /** Relative to SGW_API_BASE. `{itemId}` and `{sellerId}` are path placeholders. */
  readonly path: string;
  /** Query-string parameters, in the order the site sends them. */
  readonly query?: readonly string[];
  /** POST body: 'json' (application/json), 'none' (the site posts `null`, i.e. no body). */
  readonly body: 'json' | 'none';
  /** 'optional': anonymous works; the adapter adds the bearer only where its policy says (itemDetail: snipe lane, T-26 ruling C6). */
  readonly auth: 'none' | 'required' | 'optional';
  readonly write: boolean;
  readonly evidence: 'observed' | 'bundle' | 'community';
}

export const SGW_ENDPOINTS = {
  /** Anonymous. Body: SGW_SEARCH_BODY_DEFAULTS + overrides. Always 40 rows per page. S-1 #3, #4, #6, #7, #8, #10. */
  search: { method: 'POST', path: 'Search/ItemListing', body: 'json', auth: 'none', write: false, evidence: 'observed' },
  /** Anonymous or with the bearer (`isHighBidderLogIn`/`inWatchlist` are real only then). serverTime, bidIncrement, the NEXT acceptable minimumBid, bidHistory. Open, closed and pickup items: S-1 #5, #11, #12 (anonymous). */
  itemDetail: { method: 'GET', path: 'ItemDetail/GetItemDetailModelByItemId/{itemId}', body: 'none', auth: 'optional', write: false, evidence: 'observed' },
  /** Anonymous. The site POSTs with a null body; `data` is SGW_TIME.currentTime. S-1 #2, #5, #9 (page calls). */
  currentTime: { method: 'POST', path: 'Dashboard/GetCurrentTime', body: 'none', auth: 'none', write: false, evidence: 'observed' },
  /** Anonymous. The item page's own call; `state` is the seller's 2-letter state (Listing.sellerState for search rows). S-1 #5. */
  sellerInfo: { method: 'GET', path: 'Seller/GetSellerInfo/{sellerId}', body: 'none', auth: 'none', write: false, evidence: 'observed' },
  /** Shipping quote. Body SGW_SHIPPING_QUOTE_BODY_FIELDS (bundle chunk 813, `getShippingRate`); response shape: USER STEP S-1. */
  shippingQuote: { method: 'POST', path: 'ItemDetail/CalculateShipping', body: 'json', auth: 'none', write: false, evidence: 'bundle' },
  /** Auth. `Type` is open | close | all; the body is `{}`. The path is in the bundle's loader list; the call site is in an uncaptured lazy chunk. */
  favorites: { method: 'POST', path: 'Favorite/GetAllFavoriteItemsByType', query: ['Type'], body: 'json', auth: 'required', write: false, evidence: 'community' },
  addFavorite: { method: 'GET', path: 'Favorite/AddToFavorite', query: ['itemId'], body: 'none', auth: 'required', write: true, evidence: 'bundle' },
  removeFavorite: { method: 'GET', path: 'Favorite/RemoveItemFromFavoriteList', query: ['itemId'], body: 'none', auth: 'required', write: true, evidence: 'bundle' },
  /** Body {notes, watchlistId}. Not in any captured chunk. Note length limit: USER STEP S-1. */
  saveFavoriteNote: { method: 'POST', path: 'Favorite/Save', body: 'json', auth: 'required', write: true, evidence: 'community' },
  /** Auth. Response `data` is the list. The path is in the bundle's loader list only. */
  savedSearches: { method: 'POST', path: 'SaveSearches/GetSaveSearches', body: 'none', auth: 'required', write: false, evidence: 'community' },
  /** Auth. Returns sellerId and minimumBid for the bid modal (bundle chunk 540, `getItemById`). */
  showBidModal: { method: 'GET', path: 'ItemBid/ShowBidModal', query: ['itemId'], body: 'none', auth: 'required', write: false, evidence: 'bundle' },
  /** Auth, MONEY. Body {itemId, bidAmount: "12.00", sellerId, quantity: 1} (bundle chunk 540, `placeBid`). */
  placeBid: { method: 'POST', path: 'ItemBid/PlaceBid', body: 'json', auth: 'required', write: true, evidence: 'bundle' },
  /** Body {refreshToken, clientIpAddress}: values from the site's own session cookie (main bundle). S-2 decides use. */
  refreshToken: { method: 'POST', path: 'SignIn/RefreshToken', body: 'json', auth: 'none', write: true, evidence: 'bundle' },
  revokeToken: { method: 'POST', path: 'SignIn/RevokeToken', body: 'json', auth: 'required', write: true, evidence: 'bundle' },
} as const satisfies Record<SgwEndpointKey, SgwEndpoint>;

/**
 * Search/ItemListing request body as the site and community clients send it.
 * Booleans are the STRINGS "true"/"false" (except the four real booleans the
 * site sends as JSON booleans). Prices and paging are strings.
 * - Double quotes in `searchText` make buyerapi answer 403: strip them at the edge.
 * - Non-numeric `lowPrice`/`highPrice` answer 400 problem+json (S-1 #7).
 * - An unparseable `selectedCategoryIds` is silently ignored: 200 with
 *   unfiltered rows (S-1 #10). Validate filters before sending.
 */
export const SGW_SEARCH_BODY_DEFAULTS = {
  isSize: false,
  isWeddingCatagory: 'false',
  isMultipleCategoryIds: false,
  isFromHeaderMenuTab: false,
  layout: 'grid',
  searchText: '',
  selectedGroup: '',
  selectedCategoryIds: '',
  selectedSellerIds: '',
  lowPrice: '0',
  highPrice: '999999',
  searchBuyNowOnly: '',
  searchPickupOnly: 'false',
  searchNoPickupOnly: 'false',
  searchOneCentShippingOnly: 'false',
  searchDescriptions: 'false',
  searchClosedAuctions: 'false',
  /** SGW_TIME.closedAuctionEndingDate (Pacific "today" in the site); ignored unless searchClosedAuctions. */
  closedAuctionEndingDate: '',
  closedAuctionDaysBack: '7',
  searchCanadaShipping: 'false',
  searchInternationalShippingOnly: 'false',
  sortColumn: '1',
  page: '1',
  pageSize: '40',
  sortDescending: 'false',
  savedSearchId: 0,
  useBuyerPrefs: 'true',
  searchUSOnlyShipping: 'false',
  categoryLevelNo: '1',
  categoryLevel: 1,
  categoryId: 0,
  partNumber: '',
  catIds: '',
} as const;

/** CalculateShipping body fields, in the site's order (bundle chunk 813). `clientIP` defaults to "". */
export const SGW_SHIPPING_QUOTE_BODY_FIELDS = ['itemId', 'country', 'province', 'zipCode', 'quantity', 'clientIP'] as const;

/**
 * Search page URL query parameter -> ItemListing body field, verbatim from the
 * site's own `buildSearchQueryString` (main bundle). The search page itself is
 * robots-disallowed for automation; this map serves query-url.ts (T-50) and
 * the api-tap, which only read URLs the user opened.
 */
export const SGW_SEARCH_URL_PARAMS = {
  st: 'searchText',
  sg: 'selectedGroup',
  c: 'selectedCategoryIds',
  s: 'selectedSellerIds',
  lp: 'lowPrice',
  hp: 'highPrice',
  sbn: 'searchBuyNowOnly',
  spo: 'searchPickupOnly',
  snpo: 'searchNoPickupOnly',
  socs: 'searchOneCentShippingOnly',
  sd: 'searchDescriptions',
  sca: 'searchClosedAuctions',
  caed: 'closedAuctionEndingDate',
  cadb: 'closedAuctionDaysBack',
  scs: 'searchCanadaShipping',
  sis: 'searchInternationalShippingOnly',
  col: 'sortColumn',
  p: 'page',
  ps: 'pageSize',
  desc: 'sortDescending',
  ss: 'savedSearchId',
  UseBuyerPrefs: 'useBuyerPrefs',
  sus: 'searchUSOnlyShipping',
  cln: 'categoryLevelNo',
  catIds: 'catIds',
  pn: 'partNumber',
  wc: 'isWeddingCatagory',
  mci: 'isMultipleCategoryIds',
  hmt: 'isFromHeaderMenuTab',
  layout: 'layout',
  ihp: 'isFromHomePage',
} as const;

/** Field names the normalizers read (T-24). Raw responses keep SGW's own casing. Dotted names are paths. */
export const SGW_FIELDS = {
  /** Every buyerapi JSON reply except ItemListing, ItemDetail, GetSellerInfo and HelpCenter is wrapped in this envelope. */
  envelope: { status: 'status', message: 'message', data: 'data', isUnauthorized: 'isUnauthorized' },
  search: {
    results: 'searchResults',
    rows: 'items',
    total: 'itemCount',
    /** null `categoryListModel` on a 200 marks a server-side error, not an empty result (community issue #12; not reproduced in S-1). */
    errorMarker: 'categoryListModel',
    maxTotalRecords: 'maxTotalRecords',
  },
  /** Search rows carry no seller name, no seller state and no pickup flag: those come from ItemDetail / GetSellerInfo. */
  row: {
    itemId: 'itemId',
    title: 'title',
    currentPrice: 'currentPrice',
    /** STARTING minimum on search rows (== startingPrice), not the next acceptable bid. */
    startingMinimumBid: 'minimumBid',
    numBids: 'numBids',
    endTime: 'endTime',
    sellerId: 'sellerId',
    categoryId: 'categoryId',
    categoryPath: 'catFullName',
    shippingPrice: 'shippingPrice',
    buyNowPrice: 'buyNowPrice',
    imageUrl: 'imageURL',
    isFavorite: 'isFavorite',
    relistId: 'relistId',
    listingType: 'listingType',
  },
  detail: {
    itemId: 'itemId',
    title: 'title',
    currentPrice: 'currentPrice',
    /** The NEXT acceptable bid (use this for caps and snipes). */
    minimumBid: 'minimumBid',
    startingPrice: 'startingPrice',
    bidIncrement: 'bidIncrement',
    numBids: 'numberOfBids',
    endTime: 'endTime',
    serverTime: 'serverTime',
    sellerId: 'sellerId',
    sellerName: 'sellerCompanyName',
    /** Seller location state ("IL"): Listing.sellerState. Present on every sampled item (2 items from 2 sellers, one pickup-only). */
    sellerState: 'pickupState',
    pickupOnly: 'pickupOnly',
    categoryId: 'categoryId',
    /** "427|Travel/Luggage|428|Suitcases" (id|name pairs). */
    categoryParentList: 'categoryParentList',
    shippingPrice: 'shippingPrice',
    handlingPrice: 'handlingPrice',
    /** true with shippingPrice 0: the price is calculated (CalculateShipping), not free. */
    allowShippingCalculation: 'allowShippingCalculation',
    buyNowPrice: 'buyNowPrice',
    inWatchlist: 'inWatchlist',
    /** Images: `imageServer` + each `;`-separated relative path of `imageUrlString` (backslash separators). */
    imageServer: 'imageServer',
    imageUrlString: 'imageUrlString',
    /** Closed markers (S-1 #12): both booleans turn true together, and `remainingTime` becomes "Auction Ended" (remainingTimeEnded). */
    closed: ['bidHistory.auctionClosed', 'isItemEndTimeExpire'],
    remainingTime: 'remainingTime',
    remainingTimeEnded: 'Auction Ended',
    /** Only meaningful when the request was authenticated (false when anonymous). */
    isHighBidder: 'bidHistory.isHighBidderLogIn',
    /** One row per bidder: bidderName (masked), amount, time. */
    bidSummary: { list: 'bidHistory.bidSummary', bidder: 'bidderName', amount: 'amount', time: 'time' },
    /** One row per bid: bidAmount, bidTime, bidderName, highBidderName, retracted. */
    bidLog: { list: 'bidHistory.bidComplete', bidder: 'bidderName', amount: 'bidAmount', time: 'bidTime', retracted: 'retracted' },
  },
  sellerInfo: { sellerId: 'sellerId', name: 'companyName', state: 'state' },
  currentTime: { data: 'data' },
} as const;

/** URL paths -> SgwDom.pageKind (regex source strings, tested against `location.pathname`). From the router config in chunk 540. */
export const SGW_PAGE_PATTERNS = {
  item: '^/item/(\\d+)$',
  /** Search results; the query string carries SGW_SEARCH_URL_PARAMS. */
  search: '^/categories/listing$',
  category: '^/categories/(?!listing$|landing$)[^/]+$',
  favorites: '^/shopgoodwill/favorites$',
} as const;

/**
 * DOM selectors, ranked: index 0 is the most stable. Ranking rule: Angular
 * component tags > ids and aria attributes the site sets for its own a11y >
 * BEM-style `feat-item_*` classes > Bootstrap utility and grid classes
 * (`text-danger`, `row`, `col-*`, `btn-*`), used only where nothing better
 * exists and marked KNOWN-FRAGILE (any restyle breaks them; prefer the API
 * value, these are DOM fallbacks). Never select on `_ngcontent-*` /
 * `_nghost-*` (build-specific).
 *
 * Evidence: `card` is OBSERVED on the 5 seller cards of the rendered item page
 * (same `app-home-product-items` component as search grid); `cardList` is
 * BUNDLE-only (the component's list template). The search page itself (grid
 * and list) and the favorites page are USER STEP S-1 DOM captures.
 */
export const SGW_SELECTORS = {
  /** Every `card` selector except `root` and `gridCell` is RELATIVE to a card root (`a[href^="/item/"]` alone also hits the page's skip link). */
  card: {
    /** A listing card root. Each card holds TWO `a[href^="/item/"]` (image and title): dedupe by item id. */
    root: ['app-home-product-items', '.feat-item'],
    /** Grid wrapper around one card (search grid, item-page carousels). */
    gridCell: ['.item-col'],
    /** The anchor carrying the item id: `href="/item/{id}"` (itemIdFromHref), its `id` attribute as fallback. */
    itemLink: ['a.feat-item_name[href^="/item/"]', 'a[href^="/item/"]'],
    itemIdFromHref: '^/item/(\\d+)',
    /** Elements whose attribute equals the item id, in rank order. */
    itemIdAttrs: [
      ['a.feat-item_name', 'id'],
      ['a.btn-heart', 'aria-describedby'],
    ],
    title: ['a.feat-item_name'],
    price: ['p.feat-item_price', '.feat-item_price'],
    favoriteButton: ['a.btn-heart[aria-label]', 'a.btn-heart'],
    /** Bids, time left (li.text-danger), Quick Bid (a[aria-label="Quick Bid"]). */
    bottom: ['ul.feat-item_bottom'],
    quickBid: ['ul.feat-item_bottom a[aria-label="Quick Bid"]'],
    /** Where badges mount. */
    anchor: ['.feat-item_info', '.feat-item'],
  },
  /** List-layout card (bundle only, USER STEP S-1 confirms): same component, root `div.feat-item.feat-item-list`. */
  cardList: {
    root: ['.feat-item.feat-item-list'],
    price: ['.feat-item_price'],
    favoriteButton: ['a.btn-heart'],
    bottom: ['.feat-item_bottom'],
    anchor: ['.feat-item_info'],
  },
  /** Item page (`/item/{id}`), observed logged out (S-1 #5). The id comes from the URL first. */
  item: {
    root: ['app-detail'],
    /** Desktop title; its `id` attribute is the item id. */
    title: ['app-detail h1[id]', '#itemblock h1'],
    biddingControl: ['app-bidding-control'],
    /** Text like "29m 43s" (or "Auction Ended" once closed). KNOWN-FRAGILE: Bootstrap `text-danger`. */
    timeLeft: ['app-bidding-control strong + span.text-danger', 'app-bidding-control span.text-danger'],
    /** aria-label "22 bids – See all bids". */
    bidCount: ['app-bidding-control a[aria-label$="See all bids"]'],
    /** Label/value rows inside the bidding control: match the label text, read the value cell. KNOWN-FRAGILE: Bootstrap grid classes. */
    priceRows: { row: 'app-bidding-control .row', label: '.col-8', value: '.col-4', currentPrice: 'Current Price:', minimumBid: 'Minimum Bid:' },
    maxBidInput: ['input#currentBid', 'app-bidding-control input[name="currentBid"]'],
    /** Text "Place My Bid"; opens `p-dialog#placeMyBid`. KNOWN-FRAGILE: `btn-purple` is a theme class; the fallback relies on it being the only button. */
    placeBidButton: ['app-bidding-control button.btn-purple', 'app-bidding-control button'],
    placeBidDialog: ['p-dialog#placeMyBid'],
    /** On the main image; `aria-describedby` is the item id. A bare `app-detail a.btn-heart` also hits the seller cards below. */
    favoriteButton: ['app-image-gallery a.btn-heart', '.image-gallery a.btn-heart'],
    tabs: ['#tabs-detail'],
    shippingTab: ['app-shipping-tab'],
    shippingZip: ['app-shipping-tab input[placeholder="Zip/Postal Code"]'],
    shippingCountry: ['app-shipping-tab select#country'],
    shippingSubmit: ['app-shipping-tab button[type="submit"]'],
    sellerTab: ['app-seller-info-tab'],
    /** Rendered twice (desktop and mobile tab sets): take the first. */
    description: ['#item-description'],
  },
} as const;
