// PlaceBid `result` codes for the fake server.
//
// PLACEHOLDERS: only -3 (closed) is verified against the real site. Every other value
// marked UNVERIFIED is a guess so the snipe engine has distinct branches to test. T-100
// replaces this file with the real Phase 5 catalogue (I-19); keep the export names stable.

export interface BidResultCode {
  /** The `status` boolean in the PlaceBid response. */
  status: boolean;
  /** The numeric `result` in the PlaceBid response. */
  result: number;
  /** True while the code has not been observed on the real site. */
  unverified: boolean;
}

export const BID_RESULT = {
  /** Bid accepted and you are the high bidder. UNVERIFIED. */
  ACCEPTED_HIGH: { status: true, result: 0, unverified: true },
  /** Bid accepted but a higher hidden max already held the lead (you were outbid at once). UNVERIFIED. */
  ACCEPTED_OUTBID: { status: true, result: 1, unverified: true },
  /** Auction closed. VERIFIED. */
  CLOSED: { status: false, result: -3, unverified: false },
  /** Bid below the minimum acceptable bid. UNVERIFIED (-4/-5 are both "too low"). */
  TOO_LOW: { status: false, result: -4, unverified: true },
  /** Bid not above your own existing max while you already lead. UNVERIFIED. */
  NOT_ABOVE_OWN_MAX: { status: false, result: -5, unverified: true },
  /** Authentication failure reported in the body. UNVERIFIED. */
  AUTH: { status: false, result: -110, unverified: true },
} as const satisfies Record<string, BidResultCode>;

export type BidResultName = keyof typeof BID_RESULT;
