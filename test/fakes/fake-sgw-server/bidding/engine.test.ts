import { describe, expect, it } from "vitest";
import { minimumC, resolveBid, type AuctionState, type Bidder } from "./engine";

const state = (over: Partial<AuctionState> = {}): AuctionState => ({
  priceC: 1000,
  numBids: 3,
  holder: "other",
  holderMaxC: 1500,
  incC: 100,
  startMinC: 500,
  seededMinC: null,
  ...over,
});

describe("proxy resolution table (cents; leader holds 15.00, price 10.00, inc 1.00)", () => {
  const table: Array<{
    name: string;
    bidder: Bidder;
    amount: number;
    outcome: string;
    price: number;
    holder: Bidder | null;
    numBids: number;
    max: number;
  }> = [
    {
      name: "below minimum",
      bidder: "me",
      amount: 1050,
      outcome: "too-low",
      price: 1000,
      holder: "other",
      numBids: 3,
      max: 1500,
    },
    {
      name: "exact minimum, still outbid",
      bidder: "me",
      amount: 1100,
      outcome: "outbid",
      price: 1200,
      holder: "other",
      numBids: 4,
      max: 1500,
    },
    {
      name: "under leader max: price = bid + inc",
      bidder: "me",
      amount: 1400,
      outcome: "outbid",
      price: 1500,
      holder: "other",
      numBids: 4,
      max: 1500,
    },
    {
      name: "tie goes to the earlier bidder",
      bidder: "me",
      amount: 1500,
      outcome: "outbid",
      price: 1500,
      holder: "other",
      numBids: 4,
      max: 1500,
    },
    {
      name: "beats leader by less than an increment",
      bidder: "me",
      amount: 1550,
      outcome: "high",
      price: 1550,
      holder: "me",
      numBids: 4,
      max: 1550,
    },
    {
      name: "beats leader by more than an increment",
      bidder: "me",
      amount: 4000,
      outcome: "high",
      price: 1600,
      holder: "me",
      numBids: 4,
      max: 4000,
    },
  ];
  for (const t of table) {
    it(t.name, () => {
      const r = resolveBid(state(), t.bidder, t.amount);
      expect(r.outcome).toBe(t.outcome);
      expect(r.state.priceC).toBe(t.price);
      expect(r.state.holder).toBe(t.holder);
      expect(r.state.numBids).toBe(t.numBids);
      expect(r.state.holderMaxC).toBe(t.max);
    });
  }
  it("raising your own max keeps price and bid count; a non-raise is rejected", () => {
    const mine = state({ holder: "me", holderMaxC: 2000 });
    const up = resolveBid(mine, "me", 3000);
    expect(up.outcome).toBe("raised");
    expect(up.state).toMatchObject({
      priceC: 1000,
      numBids: 3,
      holderMaxC: 3000,
    });
    expect(resolveBid(mine, "me", 2000).outcome).toBe("not-above-own-max");
  });
  it("first bid on an unbid item lands at the starting minimum, not the max", () => {
    const r = resolveBid(
      state({ numBids: 0, holder: null, priceC: 500 }),
      "me",
      9000,
    );
    expect(r.state).toMatchObject({
      priceC: 500,
      holder: "me",
      holderMaxC: 9000,
      numBids: 1,
    });
  });
  it("minimum is price + increment once bids exist, honouring a seed override until the first change", () => {
    expect(minimumC(state())).toBe(1100);
    expect(minimumC(state({ numBids: 0 }))).toBe(500);
    expect(minimumC(state({ seededMinC: 1700 }))).toBe(1700);
    expect(
      resolveBid(state({ seededMinC: 1700 }), "me", 1700).state.seededMinC,
    ).toBeNull();
  });
});
