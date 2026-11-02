// PlaceBid `result` codes for the fake server.
//
// PLACEHOLDERS: -3 (closed) and, since T-132, (true, 1) "Bid Received! You are currently
// the high bidder" are verified against the real site (src/adapters/sgw/bid.ts catalogue,
// test/fixtures/sgw/json/placebid-accepted-high-bidder.json). Every other value marked
// UNVERIFIED is a guess so the snipe engine has distinct branches to test. Keep the export
// names stable.

export interface BidResultCode {
  /** The `status` boolean in the PlaceBid response. */
  status: boolean;
  /** The numeric `result` in the PlaceBid response. */
  result: number;
  /** True while the code has not been observed on the real site. */
  unverified: boolean;
}

export const BID_RESULT = {
  /**
   * Bid accepted and you are the high bidder. VERIFIED (T-132): the first live bid's reply was
   * result 1 with "Bid Received! You are currently the high bidder". Its boolean status was not
   * logged; true is inferred from "Bid Received!" (orchestrator ruling).
   */
  ACCEPTED_HIGH: { status: true, result: 1, unverified: false },
  /**
   * Bid accepted but a higher hidden max already held the lead (you were outbid at once).
   * UNVERIFIED: assumed to share result 1 with ACCEPTED_HIGH, so the extension classifies it
   * 'accepted' ("received") and only the outcome read says won or lost. Only the message differs.
   */
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
