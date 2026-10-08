import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { pacificNaiveToEpoch } from "../clock";
import { startFakeSgw, type FakeSgw } from "../server";
import {
  ItemDetailResponseSchema,
  PlaceBidResponseSchema,
  ShowBidModalResponseSchema,
} from "../shapes";
import { BID_RESULT } from "./result-codes";

let sgw: FakeSgw;
let bearer = "";
const PIN = Date.parse("2026-10-08T00:00:00.000Z");
const NO_BIDS = 279250102; // $4.00, inc 1, ends 2026-10-08T19:18:30 PT
const BIDDEN = 279250311; // $22.50, 9 bids, inc 1
const NO_BIDS_END = pacificNaiveToEpoch("2026-10-08T19:18:30");
const SELLER_OF: Record<number, number> = { [279250102]: 31, [279250311]: 58 };

beforeAll(async () => {
  sgw = await startFakeSgw({ port: 0 });
});
afterAll(async () => {
  await sgw.close();
});
beforeEach(async () => {
  await scenario({ reset: true, serverNowMs: PIN });
  bearer = sgw.mintToken().accessToken;
});

const hdr = (): Record<string, string> => ({
  authorization: `Bearer ${bearer}`,
  "content-type": "application/json",
});
async function scenario(body: unknown): Promise<Record<string, unknown>> {
  const r = await fetch(`${sgw.url}/__scenario`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(r.status).toBe(200);
  return (await r.json()) as Record<string, unknown>;
}
const rawBid = (
  itemId: number,
  amount: string,
  extra: Record<string, string> = {},
): Promise<Response> =>
  fetch(`${sgw.url}/api/ItemBid/PlaceBid`, {
    method: "POST",
    headers: { ...hdr(), ...extra },
    body: JSON.stringify({
      itemId,
      bidAmount: amount,
      sellerId: SELLER_OF[itemId] ?? 31,
      quantity: 1,
    }),
  });
async function bid(itemId: number, amount: string) {
  return PlaceBidResponseSchema.parse(
    await (await rawBid(itemId, amount)).json(),
  );
}
async function detail(itemId: number, authed = true) {
  const r = await fetch(
    `${sgw.url}/api/ItemDetail/GetItemDetailModelByItemId/${String(itemId)}`,
    { headers: authed ? hdr() : {} },
  );
  const json = (await r.json()) as { isHighBidder: boolean | null };
  return {
    ...ItemDetailResponseSchema.parse(json),
    isHighBidder: json.isHighBidder,
  };
}
const modal = async (itemId: number) =>
  ShowBidModalResponseSchema.parse(
    await (
      await fetch(
        `${sgw.url}/api/ItemBid/ShowBidModal?itemId=${String(itemId)}`,
        { headers: hdr() },
      )
    ).json(),
  );

describe("PlaceBid proxy semantics over HTTP", () => {
  it("first bid on an unbid item takes the lead at the starting minimum", async () => {
    const r = await bid(NO_BIDS, "50.00");
    expect(r).toMatchObject({
      status: true,
      result: BID_RESULT.ACCEPTED_HIGH.result,
    });
    expect(r.message).toContain("$4.00");
    const d = await detail(NO_BIDS);
    expect(d).toMatchObject({
      currentPrice: 4,
      numBids: 1,
      minimumBid: 5,
      isHighBidder: true,
    });
    expect(d.bidHistory.bidComplete[0]).toMatchObject({ bidAmount: 4, bidderName: "you" });
  });
  it("beats a hidden competitor max: price = competitor max + increment", async () => {
    await scenario({ bidding: { items: { [BIDDEN]: { competitorMax: 30 } } } });
    expect((await bid(BIDDEN, "40.00")).result).toBe(
      BID_RESULT.ACCEPTED_HIGH.result,
    );
    expect(await detail(BIDDEN)).toMatchObject({
      currentPrice: 31,
      isHighBidder: true,
      minimumBid: 32,
    });
  });
  it("loses to a higher hidden max: accepted-but-outbid, price = my bid + increment", async () => {
    await scenario({ bidding: { items: { [BIDDEN]: { competitorMax: 30 } } } });
    const r = await bid(BIDDEN, "25.00");
    expect(r).toMatchObject({
      status: true,
      result: BID_RESULT.ACCEPTED_OUTBID.result,
    });
    expect(await detail(BIDDEN)).toMatchObject({
      currentPrice: 26,
      isHighBidder: false,
      numBids: 10,
    });
  });
  it("a competitor bid placed later outbids me and flips the flag", async () => {
    await bid(NO_BIDS, "10.00");
    expect((await detail(NO_BIDS)).isHighBidder).toBe(true);
    await scenario({
      bidding: { competitorBids: [{ itemId: NO_BIDS, maxBid: 20 }] },
    });
    expect(await detail(NO_BIDS)).toMatchObject({
      currentPrice: 11,
      isHighBidder: false,
    });
  });
  it("high-bidder flag is null when anonymous and false before any bid", async () => {
    expect((await detail(NO_BIDS, false)).isHighBidder).toBeNull();
    expect((await detail(NO_BIDS)).isHighBidder).toBe(false);
  });
  it("below minimum is rejected without changing the price", async () => {
    const r = await bid(BIDDEN, "23.00"); // minimum is 23.50
    expect(r).toMatchObject({
      status: false,
      result: BID_RESULT.TOO_LOW.result,
    });
    expect(r.message).toContain("$23.50");
    expect(await detail(BIDDEN)).toMatchObject({
      currentPrice: 22.5,
      numBids: 9,
    });
  });
  it("re-bidding at or under my own max is rejected; raising it keeps the price", async () => {
    await bid(NO_BIDS, "10.00");
    expect((await bid(NO_BIDS, "10.00")).result).toBe(
      BID_RESULT.NOT_ABOVE_OWN_MAX.result,
    );
    expect((await bid(NO_BIDS, "12.00")).result).toBe(
      BID_RESULT.ACCEPTED_HIGH.result,
    );
    expect(await detail(NO_BIDS)).toMatchObject({
      currentPrice: 4,
      numBids: 1,
    });
  });
  it("ShowBidModal minimumBid tracks bidding state", async () => {
    expect(await modal(BIDDEN)).toEqual({ sellerId: 58, minimumBid: 23.5 });
    await bid(BIDDEN, "30.00");
    expect((await modal(BIDDEN)).minimumBid).toBe(
      (await detail(BIDDEN)).minimumBid,
    );
  });
  it("search rows reflect the new bid count", async () => {
    await bid(NO_BIDS, "10.00");
    const r = await fetch(`${sgw.url}/api/Search/ItemListing`, {
      method: "POST",
      headers: hdr(),
      body: JSON.stringify({
        searchText: "Hot Wheels",
        page: 1,
        closedAuctions: "false",
        sortDescending: "false",
      }),
    });
    const rows = (
      (await r.json()) as {
        searchResults: { items: Array<{ itemId: number; numBids: number }> };
      }
    ).searchResults.items;
    expect(rows.find((x) => x.itemId === NO_BIDS)?.numBids).toBe(1);
  });
});

describe("closing and timing", () => {
  it("a bid after close returns -3 and leaves the state alone", async () => {
    await scenario({ serverNowMs: NO_BIDS_END + 1 });
    const r = await bid(NO_BIDS, "10.00");
    expect(r).toMatchObject({ status: false, result: -3 });
    expect(r.message).toContain("closed");
    expect(await detail(NO_BIDS)).toMatchObject({
      isClosed: true,
      numBids: 0,
      isHighBidder: false,
    });
  });
  it("a bid just before the end instant is accepted", async () => {
    await scenario({ serverNowMs: NO_BIDS_END - 1000 });
    expect((await bid(NO_BIDS, "10.00")).result).toBe(
      BID_RESULT.ACCEPTED_HIGH.result,
    );
  });
  it("closed:true patch closes an auction on demand", async () => {
    await scenario({ bidding: { items: { [BIDDEN]: { closed: true } } } });
    expect((await bid(BIDDEN, "99.00")).result).toBe(-3);
  });
  it("soft close: a late bid moves endTime; an early bid does not", async () => {
    await scenario({ bidding: { preset: "soft-close" } });
    const before = (await detail(NO_BIDS)).endTime;
    // 30 minutes out: outside the 10 minute window.
    await scenario({ serverNowMs: NO_BIDS_END - 30 * 60_000 });
    await bid(NO_BIDS, "10.00");
    expect((await detail(NO_BIDS)).endTime).toBe(before);
    // 2 minutes out: inside the window, end moves to now + 10 min (the pinned clock ticks, allow drift).
    await scenario({ serverNowMs: NO_BIDS_END - 120_000 });
    await scenario({
      bidding: { competitorBids: [{ itemId: NO_BIDS, maxBid: 15 }] },
    });
    const d = await detail(NO_BIDS);
    expect(d.endTime).not.toBe(before);
    expect(
      Math.abs(
        pacificNaiveToEpoch(d.endTime) - (NO_BIDS_END - 120_000 + 600_000),
      ),
    ).toBeLessThan(2000);
    expect(d.isClosed).toBe(false);
  });
  it("soft close lets a bid land after the original end time", async () => {
    await scenario({
      serverNowMs: NO_BIDS_END - 5000,
      bidding: { preset: "soft-close" },
    });
    await scenario({
      bidding: { competitorBids: [{ itemId: NO_BIDS, maxBid: 6 }] },
    });
    await scenario({ serverNowMs: NO_BIDS_END + 1000 });
    expect((await bid(NO_BIDS, "9.00")).result).toBe(
      BID_RESULT.ACCEPTED_HIGH.result,
    );
  });
});

describe("faults", () => {
  it('authFailure "result" gives 200 with -110; "http" gives 401', async () => {
    await scenario({ bidding: { authFailure: "result" } });
    expect(await bid(NO_BIDS, "10.00")).toMatchObject({
      status: false,
      result: -110,
    });
    await scenario({ bidding: { authFailure: "http" } });
    expect((await rawBid(NO_BIDS, "10.00")).status).toBe(401);
    expect(
      (
        await fetch(
          `${sgw.url}/api/ItemBid/ShowBidModal?itemId=${String(NO_BIDS)}`,
          { headers: hdr() },
        )
      ).status,
    ).toBe(401);
    await scenario({ bidding: { authFailure: null } });
    expect((await bid(NO_BIDS, "10.00")).status).toBe(true);
  });
  it("a bid without a bearer is 401", async () => {
    const r = await fetch(`${sgw.url}/api/ItemBid/PlaceBid`, {
      method: "POST",
      body: "{}",
    });
    expect(r.status).toBe(401);
  });
  it("token expiry mid-window: the bearer works until the pinned clock passes tokenExpiresAtMs", async () => {
    await scenario({ bidding: { tokenExpiresAtMs: PIN + 60_000 } });
    expect((await rawBid(NO_BIDS, "10.00")).status).toBe(200);
    await scenario({ serverNowMs: PIN + 60_000 });
    expect((await rawBid(NO_BIDS, "12.00")).status).toBe(401);
  });
  it("a short-lived bearer expires on the pinned clock", async () => {
    bearer = sgw.mintToken({ expiresInMs: 30_000 }).accessToken;
    expect((await rawBid(NO_BIDS, "10.00")).status).toBe(200);
    await scenario({ serverNowMs: PIN + 31_000 });
    expect((await rawBid(NO_BIDS, "12.00")).status).toBe(401);
  });
  it("the Bid cookie makes the next ItemBid call 403", async () => {
    await scenario({ bidSetsCookie: true });
    const first = await rawBid(NO_BIDS, "10.00");
    expect(first.headers.get("set-cookie")).toContain("Bid=1");
    expect((await rawBid(NO_BIDS, "12.00", { cookie: "Bid=1" })).status).toBe(
      403,
    );
    const m = await fetch(
      `${sgw.url}/api/ItemBid/ShowBidModal?itemId=${String(NO_BIDS)}`,
      { headers: { ...hdr(), cookie: "Bid=1" } },
    );
    expect(m.status).toBe(403);
  });
  it("the stalled-place-bid preset configures a stall of at least 25 s", async () => {
    const r = (await scenario({
      bidding: { preset: "stalled-place-bid" },
    })) as { bidding: { faults: { stallMs: number } } };
    expect(r.bidding.faults.stallMs).toBeGreaterThanOrEqual(25_000);
  });
  it("a stall delays the response but the bid is evaluated on arrival", async () => {
    await scenario({ bidding: { stallMs: 400 } });
    const t0 = Date.now();
    const p = rawBid(NO_BIDS, "10.00");
    await new Promise((r) => setTimeout(r, 150));
    const peek = (await (await fetch(`${sgw.url}/__scenario`)).json()) as {
      bidding: { items: Record<string, { numBids: number }> };
    };
    expect(peek.bidding.items[String(NO_BIDS)]?.numBids).toBe(1);
    const res = await p;
    expect(Date.now() - t0).toBeGreaterThanOrEqual(380);
    expect(PlaceBidResponseSchema.parse(await res.json()).status).toBe(true);
  });
  it("close() returns promptly while a PlaceBid is stalled, and nothing throws afterwards", async () => {
    const local = await startFakeSgw({ port: 0 });
    const token = local.mintToken().accessToken;
    const unhandled: unknown[] = [];
    const onErr = (e: unknown): void => {
      unhandled.push(e);
    };
    process.on("uncaughtException", onErr);
    process.on("unhandledRejection", onErr);
    await fetch(`${local.url}/__scenario`, {
      method: "POST",
      body: JSON.stringify({ serverNowMs: PIN, bidding: { stallMs: 25_000 } }),
    });
    const stalled = fetch(`${local.url}/api/ItemBid/PlaceBid`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        itemId: NO_BIDS,
        bidAmount: "10.00",
        sellerId: 31,
        quantity: 1,
      }),
    }).catch(() => "aborted");
    await new Promise((r) => setTimeout(r, 100));
    const t0 = Date.now();
    await local.close();
    expect(Date.now() - t0).toBeLessThan(500);
    expect(await stalled).toBe("aborted");
    await new Promise((r) => setTimeout(r, 100));
    process.off("uncaughtException", onErr);
    process.off("unhandledRejection", onErr);
    expect(unhandled).toEqual([]);
  });
  it("a rejected scenario patch leaves nothing half-applied", async () => {
    const r = await fetch(`${sgw.url}/__scenario`, {
      method: "POST",
      body: JSON.stringify({
        skewMs: 9999,
        bidding: { stallMs: 7, competitorBids: [{ itemId: 1, maxBid: 5 }] },
      }),
    });
    expect(r.status).toBe(400);
    const s = (await (await fetch(`${sgw.url}/__scenario`)).json()) as {
      scenario: { skewMs: number };
      bidding: { faults: { stallMs: number } };
    };
    expect(s.scenario.skewMs).toBe(0);
    expect(s.bidding.faults.stallMs).toBe(0);
  });
  it("read-only views do not create state: the snapshot lists only touched items", async () => {
    await detail(NO_BIDS);
    await fetch(`${sgw.url}/api/Search/ItemListing`, {
      method: "POST",
      headers: hdr(),
      body: JSON.stringify({
        searchText: "",
        page: 1,
        closedAuctions: "false",
        sortDescending: "false",
      }),
    });
    const s = (await (await fetch(`${sgw.url}/__scenario`)).json()) as {
      bidding: { items: object };
    };
    expect(s.bidding.items).toEqual({});
  });
  it("malformed amounts and mismatched sellers are 400; unknown items 404; unknown presets 400", async () => {
    expect((await rawBid(NO_BIDS, "abc")).status).toBe(400);
    const wrongSeller = await fetch(`${sgw.url}/api/ItemBid/PlaceBid`, {
      method: "POST",
      headers: hdr(),
      body: JSON.stringify({
        itemId: NO_BIDS,
        bidAmount: "10.00",
        sellerId: 999,
        quantity: 1,
      }),
    });
    expect(wrongSeller.status).toBe(400);
    expect((await rawBid(1, "10.00")).status).toBe(404);
    const bad = await fetch(`${sgw.url}/__scenario`, {
      method: "POST",
      body: JSON.stringify({ bidding: { preset: "nope" } }),
    });
    expect(bad.status).toBe(400);
  });
  it("a top-level reset clears bidding state and faults", async () => {
    await bid(NO_BIDS, "10.00");
    await scenario({ bidding: { stallMs: 5, authFailure: "http" } });
    await scenario({ reset: true, serverNowMs: PIN });
    expect(await detail(NO_BIDS)).toMatchObject({
      numBids: 0,
      isHighBidder: false,
    });
    expect((await bid(NO_BIDS, "10.00")).status).toBe(true);
  });
});
