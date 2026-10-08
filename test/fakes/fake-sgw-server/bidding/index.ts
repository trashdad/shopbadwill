// Bidding and timing scenarios for the fake SGW server: proxy bidding state per item,
// PlaceBid / ShowBidModal behaviour, soft close, stalls, auth and token faults.
// Everything reads time from the server's (pinnable) clock via deps.now().
import { z } from "zod";
import { epochToPacificNaive } from "../clock";
import type { SeedItem } from "../seed/loader";
import { PlaceBidRequestSchema } from "../shapes";
import { minimumC, resolveBid, type AuctionState, type Bidder } from "./engine";
import { BID_RESULT, type BidResultCode } from "./result-codes";

export { BID_RESULT } from "./result-codes";

const cents = (n: number): number => Math.round(n * 100);
const dollars = (c: number): number => c / 100;
const money = (c: number): string => dollars(c).toFixed(2);

const ItemPatchSchema = z.object({
  currentPrice: z.number().optional(),
  numBids: z.number().int().nonnegative().optional(),
  bidIncrement: z.number().positive().optional(),
  /** Make a hidden competitor the leader with this max. */
  competitorMax: z.number().optional(),
  /** Make the caller the leader with this max. */
  myMax: z.number().optional(),
  /** Override the end time (epoch ms on the server clock); null restores the seed value. */
  endsAtMs: z.number().nullable().optional(),
  /** Close the auction now (end = current server time). */
  closed: z.boolean().optional(),
});

export const BiddingPatchSchema = z.object({
  /** Named preset from BIDDING_PRESETS; implies a reset. */
  preset: z.string().optional(),
  /** Drop all bidding state and faults. */
  reset: z.boolean().optional(),
  /** Per-item overrides, keyed by itemId. */
  items: z.record(z.string(), ItemPatchSchema).optional(),
  /** Competitor bids placed at the moment the patch is applied (server clock). */
  competitorBids: z
    .array(z.object({ itemId: z.number().int(), maxBid: z.number() }))
    .optional(),
  /** A bid within windowMs of the end pushes the end out; null disables. */
  softClose: z
    .object({
      windowMs: z.number().nonnegative(),
      extensionMs: z.number().positive(),
    })
    .nullable()
    .optional(),
  /** "result" = 200 with result -110; "http" = 401. null disables. */
  authFailure: z.enum(["result", "http"]).nullable().optional(),
  /** Delay PlaceBid responses by this many ms (the bid is evaluated on arrival). */
  stallMs: z.number().nonnegative().optional(),
  /** From this server-clock instant the bid endpoints answer 401 whatever the bearer says. */
  tokenExpiresAtMs: z.number().nullable().optional(),
});
export type BiddingPatch = z.infer<typeof BiddingPatchSchema>;

interface Faults {
  softClose: { windowMs: number; extensionMs: number } | null;
  authFailure: "result" | "http" | null;
  stallMs: number;
  tokenExpiresAtMs: number | null;
}
const NO_FAULTS: Faults = {
  softClose: null,
  authFailure: null,
  stallMs: 0,
  tokenExpiresAtMs: null,
};

/** Preset names for the bidding patch. The stall preset is 25 s, the floor in the T-88 card. */
export const BIDDING_PRESETS: Record<string, Partial<Faults>> = {
  // Soft-close timings are unverified placeholders (see README).
  "soft-close": { softClose: { windowMs: 600_000, extensionMs: 600_000 } },
  "stalled-place-bid": { stallMs: 25_000 },
  "auth-failure": { authFailure: "result" },
  "auth-failure-http": { authFailure: "http" },
};

export interface BiddingDeps {
  items: readonly SeedItem[];
  /** The seed end time of an item, epoch ms. */
  baseEndMs: (it: SeedItem) => number;
  /** Server clock (pinned/skewed). */
  now: () => number;
}

export interface BidHttpResult {
  status: number;
  body?: unknown;
  delayMs?: number;
}

interface ItemState {
  auction: AuctionState;
  endOverrideMs: number | null;
  history: Array<{ bidAmount: number; bidTime: string; bidderName: string }>;
}

export interface ItemView {
  currentPrice: number;
  minimumBid: number;
  numBids: number;
  endMs: number;
  /** null when anonymous. */
  isHighBidder: boolean | null;
  /** Bids placed through this module, newest first. */
  bidHistory: ItemState["history"];
}

export function createBidding(deps: BiddingDeps) {
  const byId = new Map(deps.items.map((i) => [i.itemId, i]));
  let states = new Map<number, ItemState>();
  let faults: Faults = { ...NO_FAULTS };

  const initial = (it: SeedItem): ItemState => ({
    auction: {
      priceC: cents(it.currentPrice),
      numBids: it.numBids,
      holder: it.numBids > 0 ? "other" : null,
      holderMaxC: cents(it.currentPrice),
      incC: cents(it.bidIncrement),
      startMinC: cents(it.minimumBid),
      seededMinC: cents(
        it.detailMinimumBid ??
          (it.numBids > 0 ? it.currentPrice + it.bidIncrement : it.minimumBid),
      ),
    },
    endOverrideMs: null,
    history: [],
  });
  const stateOf = (it: SeedItem): ItemState => {
    let s = states.get(it.itemId);
    if (!s) {
      s = initial(it);
      states.set(it.itemId, s);
    }
    return s;
  };
  const endMs = (it: SeedItem): number =>
    states.get(it.itemId)?.endOverrideMs ?? deps.baseEndMs(it);
  const isClosed = (it: SeedItem): boolean => endMs(it) <= deps.now();

  const view = (it: SeedItem, authed: boolean): ItemView => {
    // Read-only: never creates state, so snapshots list only touched items.
    const s = states.get(it.itemId) ?? initial(it);
    return {
      currentPrice: dollars(s.auction.priceC),
      minimumBid: dollars(minimumC(s.auction)),
      numBids: s.auction.numBids,
      endMs: endMs(it),
      isHighBidder: authed ? s.auction.holder === "me" : null,
      bidHistory: s.history,
    };
  };

  const applyItemPatch = (
    id: number,
    p: z.infer<typeof ItemPatchSchema>,
  ): void => {
    const it = byId.get(id);
    if (!it) throw new Error(`bidding: unknown itemId ${String(id)}`);
    const s = stateOf(it);
    let a = s.auction;
    const touched =
      p.currentPrice !== undefined ||
      p.numBids !== undefined ||
      p.bidIncrement !== undefined ||
      p.competitorMax !== undefined ||
      p.myMax !== undefined;
    if (p.currentPrice !== undefined)
      a = { ...a, priceC: cents(p.currentPrice) };
    if (p.numBids !== undefined)
      a = {
        ...a,
        numBids: p.numBids,
        holder: p.numBids === 0 ? null : (a.holder ?? "other"),
      };
    if (p.bidIncrement !== undefined) a = { ...a, incC: cents(p.bidIncrement) };
    if (p.competitorMax !== undefined) {
      a = {
        ...a,
        holder: "other",
        holderMaxC: cents(p.competitorMax),
        numBids: Math.max(a.numBids, 1),
      };
    }
    if (p.myMax !== undefined)
      a = {
        ...a,
        holder: "me",
        holderMaxC: cents(p.myMax),
        numBids: Math.max(a.numBids, 1),
      };
    if (touched) a = { ...a, seededMinC: null };
    s.auction = a;
    if (p.endsAtMs !== undefined) s.endOverrideMs = p.endsAtMs;
    if (p.closed === true) s.endOverrideMs = deps.now();
  };

  /** Resolve one bid and apply soft close. The caller has checked that the auction is open. */
  const resolve = (it: SeedItem, bidder: Bidder, amount: number) => {
    const s = stateOf(it);
    const r = resolveBid(s.auction, bidder, cents(amount));
    s.auction = r.state;
    const t = deps.now();
    if (r.outcome !== "too-low" && r.outcome !== "not-above-own-max") {
      if (r.outcome !== "raised") {
        s.history.unshift({
          bidAmount: dollars(r.state.priceC),
          bidTime: epochToPacificNaive(t, true),
          bidderName: bidder === "me" ? "you" : "c***r",
        });
      }
      const end = endMs(it);
      if (faults.softClose && end - t <= faults.softClose.windowMs) {
        s.endOverrideMs = Math.max(end, t + faults.softClose.extensionMs);
      }
    }
    return r.outcome;
  };

  const code = (c: BidResultCode, message: string): BidHttpResult => ({
    status: 200,
    body: { status: c.status, result: c.result, message },
  });

  /** Shared auth faults. Null means proceed. */
  const gate = (): BidHttpResult | null => {
    if (
      faults.tokenExpiresAtMs !== null &&
      deps.now() >= faults.tokenExpiresAtMs
    ) {
      return { status: 401, body: { message: "Unauthorized" } };
    }
    if (faults.authFailure === "http")
      return { status: 401, body: { message: "Unauthorized" } };
    return null;
  };

  const place = (it: SeedItem, bidAmount: string): BidHttpResult => {
    if (isClosed(it))
      return code(BID_RESULT.CLOSED, "<p>This auction is closed.</p>");
    const outcome = resolve(it, "me", Number(bidAmount));
    const a = stateOf(it).auction;
    switch (outcome) {
      case "too-low":
        return code(
          BID_RESULT.TOO_LOW,
          `<p>Your bid must be at least $${money(minimumC(a))}.</p>`,
        );
      case "not-above-own-max":
        return code(
          BID_RESULT.NOT_ABOVE_OWN_MAX,
          "<p>Your bid must be higher than your current maximum bid.</p>",
        );
      case "outbid":
        return code(
          BID_RESULT.ACCEPTED_OUTBID,
          `<p>You have been outbid. The current price is $${money(a.priceC)}.</p>`,
        );
      default:
        return code(
          BID_RESULT.ACCEPTED_HIGH,
          `<p>You are the high bidder at $${money(a.priceC)}.</p>`,
        );
    }
  };

  type Snap = {
    price: number;
    numBids: number;
    holder: Bidder | null;
    endMs: number;
  };
  return {
    /** Overlay for the detail and search endpoints. */
    view,
    /** Effective end time (epoch ms), including soft-close extension. */
    endMs,
    applyPatch(patch: BiddingPatch): void {
      if (patch.reset === true || patch.preset !== undefined) {
        states = new Map();
        faults = { ...NO_FAULTS };
      }
      if (patch.preset !== undefined) {
        const p = BIDDING_PRESETS[patch.preset];
        if (!p)
          throw new Error(
            `unknown bidding preset "${patch.preset}"; known: ${Object.keys(BIDDING_PRESETS).join(", ")}`,
          );
        faults = { ...faults, ...p };
      }
      if (patch.softClose !== undefined) faults.softClose = patch.softClose;
      if (patch.authFailure !== undefined)
        faults.authFailure = patch.authFailure;
      if (patch.stallMs !== undefined) faults.stallMs = patch.stallMs;
      if (patch.tokenExpiresAtMs !== undefined)
        faults.tokenExpiresAtMs = patch.tokenExpiresAtMs;
      for (const [k, v] of Object.entries(patch.items ?? {}))
        applyItemPatch(Number(k), v);
      for (const b of patch.competitorBids ?? []) {
        const it = byId.get(b.itemId);
        if (!it) throw new Error(`bidding: unknown itemId ${String(b.itemId)}`);
        if (isClosed(it))
          throw new Error(`bidding: item ${String(b.itemId)} is closed`);
        resolve(it, "other", b.maxBid);
      }
    },
    /** Capture state so a failed multi-step patch can be undone. */
    checkpoint(): () => void {
      const savedStates = new Map(
        [...states].map(
          ([k, v]) =>
            [
              k,
              {
                ...v,
                auction: { ...v.auction },
                history: v.history.map((h) => ({ ...h })),
              },
            ] as const,
        ),
      );
      const savedFaults = {
        ...faults,
        softClose: faults.softClose && { ...faults.softClose },
      };
      return () => {
        states = savedStates;
        faults = savedFaults;
      };
    },
    snapshot(): { faults: Faults; items: Record<string, Snap> } {
      const items: Record<string, Snap> = {};
      for (const [id, s] of states) {
        const it = byId.get(id);
        if (it)
          items[String(id)] = {
            price: dollars(s.auction.priceC),
            numBids: s.auction.numBids,
            holder: s.auction.holder,
            endMs: endMs(it),
          };
      }
      return { faults: { ...faults }, items };
    },
    showBidModal(itemId: number): BidHttpResult {
      const g = gate();
      if (g) return g;
      const it = byId.get(itemId);
      if (!it) return { status: 404, body: { message: "Item not found" } };
      return {
        status: 200,
        body: { sellerId: it.sellerId, minimumBid: view(it, true).minimumBid },
      };
    },
    placeBid(rawBody: unknown): BidHttpResult {
      const g = gate();
      if (g) return g;
      if (faults.authFailure === "result")
        return code(BID_RESULT.AUTH, "<p>You must be signed in to bid.</p>");
      const parsed = PlaceBidRequestSchema.safeParse(rawBody);
      if (!parsed.success)
        return { status: 400, body: { message: "Bad request" } };
      const { itemId, bidAmount, sellerId } = parsed.data;
      const it = byId.get(itemId);
      if (!it) return { status: 404, body: { message: "Item not found" } };
      if (sellerId !== it.sellerId || !/^\d+(\.\d{1,2})?$/.test(bidAmount))
        return { status: 400, body: { message: "Bad request" } };
      const out = place(it, bidAmount);
      return faults.stallMs > 0 ? { ...out, delayMs: faults.stallMs } : out;
    },
  };
}
export type Bidding = ReturnType<typeof createBidding>;
