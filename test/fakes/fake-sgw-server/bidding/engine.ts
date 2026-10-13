// Pure proxy-bidding resolution. Amounts are integer cents.
// A bid is a hidden max. The leader's displayed price is the lowest amount that still beats
// the runner-up: min(leaderMax, runnerUpMax + increment). Ties go to the earlier bidder.

export type Bidder = "me" | "other";

export interface AuctionState {
  priceC: number;
  numBids: number;
  holder: Bidder | null;
  holderMaxC: number;
  incC: number;
  /** The first-bid minimum (used while numBids is 0). */
  startMinC: number;
  /** Seed override for the minimum, valid until the first state change. */
  seededMinC: number | null;
}

export type Outcome =
  "too-low" | "not-above-own-max" | "high" | "outbid" | "raised";

export function minimumC(s: AuctionState): number {
  if (s.seededMinC !== null) return s.seededMinC;
  return s.numBids > 0 ? s.priceC + s.incC : s.startMinC;
}

export function resolveBid(
  s: AuctionState,
  bidder: Bidder,
  amountC: number,
): { outcome: Outcome; state: AuctionState } {
  if (amountC < minimumC(s)) return { outcome: "too-low", state: s };
  const base = { ...s, seededMinC: null };
  if (s.holder === null) {
    return {
      outcome: "high",
      state: {
        ...base,
        priceC: s.startMinC,
        numBids: s.numBids + 1,
        holder: bidder,
        holderMaxC: amountC,
      },
    };
  }
  if (s.holder === bidder) {
    if (amountC <= s.holderMaxC)
      return { outcome: "not-above-own-max", state: s };
    // Raising your own hidden max does not move the price or count as a new bid.
    return { outcome: "raised", state: { ...base, holderMaxC: amountC } };
  }
  if (amountC > s.holderMaxC) {
    return {
      outcome: "high",
      state: {
        ...base,
        priceC: Math.min(amountC, s.holderMaxC + s.incC),
        numBids: s.numBids + 1,
        holder: bidder,
        holderMaxC: amountC,
      },
    };
  }
  return {
    outcome: "outbid",
    state: {
      ...base,
      priceC: Math.min(s.holderMaxC, amountC + s.incC),
      numBids: s.numBids + 1,
    },
  };
}
