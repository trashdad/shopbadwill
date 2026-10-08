// Fake SGW buyerapi: a Node HTTP server that reproduces the site's quirks for E2E,
// integration and timing tests. See README.md for the endpoint and scenario list.
import { createHmac, timingSafeEqual } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { BiddingPatchSchema, createBidding } from "./bidding";
import { epochToPacificNaive, pacificNaiveToEpoch } from "./clock";
import {
  applyPatch,
  DEFAULT_SCENARIO,
  NAMED_SCENARIOS,
  ScenarioPatchSchema,
  type ErrorSpec,
  type Scenario,
  type ScenarioPatch,
} from "./scenario";
import { loadSeed, type Seed, type SeedItem } from "./seed/loader";
import {
  CalculateShippingRequestSchema,
  FavoriteSaveRequestSchema,
  ItemListingRequestSchema,
  RefreshTokenRequestSchema,
} from "./shapes";

export const FAKE_JWT_SECRET = "sbw-fake-sgw-secret";
export const PAGE_SIZE = 40;
export const MAX_TOTAL_RECORDS = 10000;

export interface FakeSgwOptions {
  /** 0 picks a free port. Default 8787. */
  port?: number;
  host?: string;
  /** Named preset or a patch. */
  scenario?: string | ScenarioPatch;
  seedDir?: string;
  seed?: Seed;
}
export interface FakeSgw {
  url: string;
  close(): Promise<void>;
  /** Mint a valid bearer without HTTP (same as POST /__token). */
  mintToken(opts?: { expiresInMs?: number; buyerId?: string }): {
    accessToken: string;
    expiresAtMs: number;
  };
}

interface LogEntry {
  seq: number;
  method: string;
  path: string;
  query: string;
  endpoint: string;
  status: number;
  receivedAtMs: number;
  fakeNowMs: number | null;
  requestTimeMs: number;
  hasBearer: boolean;
  body: string;
}

interface Fav {
  watchlistId: number;
  itemId: number;
  notes: string;
}

const b64u = (b: Buffer | string): string =>
  Buffer.from(b).toString("base64url");

function sign(payload: Record<string, unknown>): string {
  const head = b64u(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64u(JSON.stringify(payload));
  const sig = createHmac("sha256", FAKE_JWT_SECRET)
    .update(`${head}.${body}`)
    .digest("base64url");
  return `${head}.${body}.${sig}`;
}

/** Returns the claims if the signature is good; expiry is checked by the caller. */
function verify(token: string): { exp: number; BuyerId: string } | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [head, body, sig] = parts as [string, string, string];
  const want = createHmac("sha256", FAKE_JWT_SECRET)
    .update(`${head}.${body}`)
    .digest();
  const got = Buffer.from(sig, "base64url");
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  try {
    const c = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as {
      exp?: unknown;
      BuyerId?: unknown;
    };
    if (typeof c.exp !== "number" || typeof c.BuyerId !== "string") return null;
    return { exp: c.exp, BuyerId: c.BuyerId };
  } catch {
    return null;
  }
}

const BODY_LIMIT = 1_000_000;
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let n = 0;
    req.on("data", (c: Buffer) => {
      n += c.length;
      if (n > BODY_LIMIT) reject(new Error("body too large"));
      else chunks.push(c);
    });
    req.on("end", () => {
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", reject);
  });
}

/** Resolves true after ms, or false if the response closed first (client gone or server closing). */
const sleep = (ms: number, res?: ServerResponse): Promise<boolean> =>
  new Promise((resolve) => {
    const done = (v: boolean): void => {
      clearTimeout(timer);
      res?.off("close", cancel);
      resolve(v);
    };
    const cancel = (): void => {
      done(false);
    };
    const timer = setTimeout(() => {
      done(true);
    }, ms);
    res?.once("close", cancel);
  });

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function parseFakeNow(h: string | undefined): number | null {
  if (h === undefined || h === "") return null;
  const n = /^-?\d+(\.\d+)?$/.test(h) ? Number(h) : Date.parse(h);
  return Number.isFinite(n) ? n : null;
}

export async function startFakeSgw(
  opts: FakeSgwOptions = {},
): Promise<FakeSgw> {
  const seed = opts.seed ?? loadSeed(opts.seedDir);
  let scenario: Scenario = { ...DEFAULT_SCENARIO };
  /** Anchor for a pinned clock: serverNowMs at realMs. */
  let anchor: { fake: number; real: number } | null = null;
  const errorCounts = new Map<string, number>();
  const log: LogEntry[] = [];
  let seq = 0;
  const favs: Fav[] = seed.favorites.map((f) => ({ ...f }));
  let nextWatchlistId = Math.max(9000, ...favs.map((f) => f.watchlistId)) + 1;
  const loadedAt = Date.now();

  const serverNow = (): number => {
    const base = anchor ? anchor.fake + (Date.now() - anchor.real) : Date.now();
    return base + scenario.skewMs;
  };
  const setScenario = (patch: ScenarioPatch): void => {
    scenario = applyPatch(scenario, patch);
    for (const k of Object.keys(patch.errors ?? {})) errorCounts.delete(k);
    if (patch.serverNowMs !== undefined)
      anchor =
        patch.serverNowMs === null
          ? null
          : { fake: patch.serverNowMs, real: Date.now() };
    if (patch.name !== undefined || patch.reset === true) {
      errorCounts.clear();
      if (patch.serverNowMs === undefined) anchor = null;
    }
  };

  const baseEnd = (it: SeedItem): number =>
    it.endTime === undefined
      ? loadedAt + (it.endsInMs ?? 0)
      : pacificNaiveToEpoch(it.endTime);
  const bidding = createBidding({
    items: seed.items,
    baseEndMs: baseEnd,
    now: serverNow,
  });
  const itemEnd = (it: SeedItem): number => bidding.endMs(it);
  const itemEndRaw = (it: SeedItem): string =>
    it.endTime !== undefined && itemEnd(it) === baseEnd(it)
      ? it.endTime
      : epochToPacificNaive(itemEnd(it), true);
  const byId = new Map(seed.items.map((i) => [i.itemId, i]));
  const isFav = (id: number): boolean => favs.some((f) => f.itemId === id);

  const mint = (o?: {
    expiresInMs?: number;
    buyerId?: string;
  }): { accessToken: string; expiresAtMs: number } => {
    const now = serverNow();
    const expiresAtMs = now + (o?.expiresInMs ?? scenario.tokenLifetimeMs);
    const accessToken = sign({
      BuyerId: o?.buyerId ?? "1234567",
      IpAddress: "127.0.0.1",
      Browser: "fake-sgw",
      iat: Math.floor(now / 1000),
      exp: Math.floor(expiresAtMs / 1000),
    });
    return { accessToken, expiresAtMs };
  };

  type Ctx = {
    req: IncomingMessage;
    url: URL;
    body: string;
    bearer: string | null;
  };
  type Result = {
    status: number;
    body?: unknown;
    headers?: Record<string, string>;
    delayMs?: number;
  };
  interface Route {
    name: string;
    auth?: boolean;
    handler: (c: Ctx, m: RegExpExecArray) => Result;
  }

  const ok = (body: unknown, headers?: Record<string, string>): Result => ({
    status: 200,
    body,
    ...(headers ? { headers } : {}),
  });
  const ack = (message = ""): Result => ok({ status: true, message });
  const bad = (status: number, message: string): Result => ({
    status,
    body: { message },
  });

  const searchRow = (
    it: SeedItem,
    authed: boolean,
  ): Record<string, unknown> => {
    const bv = bidding.view(it, authed);
    return {
      itemId: it.itemId,
      title: it.title,
      currentPrice: bv.currentPrice,
      minimumBid: it.minimumBid,
      numBids: bv.numBids,
      endTime: itemEndRaw(it),
      sellerId: it.sellerId,
      sellerName: it.sellerName,
      categoryId: it.categoryId,
      isFavorite: authed && isFav(it.itemId),
      shippingPrice: it.shippingPrice,
      imageURL: it.imageURL,
    };
  };

  const routes = new Map<string, Route>();
  const add = (method: string, pattern: string, r: Route): void => {
    routes.set(`${method} ${pattern.toLowerCase()}`, r);
  };

  add("POST", "/api/Search/ItemListing", {
    name: "Search/ItemListing",
    handler: ({ body, bearer }) => {
      const empty = ok({
        searchResults: { items: [], itemCount: 0 },
        maxTotalRecords: MAX_TOTAL_RECORDS,
        page: 1,
      });
      const parsed = ItemListingRequestSchema.safeParse(parseJson(body));
      // Malformed bodies (bad JSON, non-string booleans...) get 200 with zero rows.
      if (!parsed.success) return empty;
      const q = parsed.data;
      if (q.searchText.includes('"')) return bad(403, "Forbidden");
      const words = q.searchText.toLowerCase().split(/\s+/).filter(Boolean);
      const cats = (q.selectedCategoryIds ?? "")
        .split(",")
        .filter(Boolean)
        .map(Number);
      const sellers = (q.selectedSellerIds ?? "")
        .split(",")
        .filter(Boolean)
        .map(Number);
      const lo =
        q.lowPrice === undefined || q.lowPrice === "" ? 0 : Number(q.lowPrice);
      const hi =
        q.highPrice === undefined ||
        q.highPrice === "" ||
        Number(q.highPrice) === 0
          ? Infinity
          : Number(q.highPrice);
      const now = serverNow();
      const closed = q.closedAuctions === "true";
      let rows = seed.items.filter((it) => {
        const t = it.title.toLowerCase();
        if (!words.every((w) => t.includes(w))) return false;
        if (cats.length && !cats.includes(it.categoryId)) return false;
        if (sellers.length && !sellers.includes(it.sellerId)) return false;
        if (it.currentPrice < lo || it.currentPrice > hi) return false;
        if (q.pickupOnly === "true" && !it.pickupOnly) return false;
        if (q.isAllExceptPickupOnly === "true" && it.pickupOnly) return false;
        if (q.oneCentShippingOnly === "true" && it.shippingPrice !== 0.01)
          return false;
        return closed ? itemEnd(it) <= now : itemEnd(it) > now;
      });
      const col = Number(q.sortColumn ?? 1);
      const desc = q.sortDescending === "true";
      rows = rows.sort((a, b) => {
        const d =
          col === 2 ? a.currentPrice - b.currentPrice : itemEnd(a) - itemEnd(b);
        return (desc ? -d : d) || a.itemId - b.itemId;
      });
      const page = Math.max(1, Number(q.page ?? 1));
      const slice = rows
        .slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)
        .map((it) => searchRow(it, bearer !== null));
      return ok({
        searchResults: {
          items: slice,
          itemCount: Math.min(rows.length, MAX_TOTAL_RECORDS),
        },
        maxTotalRecords: MAX_TOTAL_RECORDS,
        page,
      });
    },
  });

  add("GET", "/api/ItemDetail/GetItemDetailModelByItemId/(\\d+)", {
    name: "ItemDetail/GetItemDetailModelByItemId",
    handler: ({ bearer }, m) => {
      const it = byId.get(Number(m[1]));
      if (!it) return bad(404, "Item not found");
      const now = serverNow();
      const v = bidding.view(it, bearer !== null);
      return ok({
        itemId: it.itemId,
        title: it.title,
        description: it.description,
        currentPrice: v.currentPrice,
        minimumBid: v.minimumBid,
        bidIncrement: it.bidIncrement,
        numBids: v.numBids,
        isHighBidder: v.isHighBidder,
        endTime: itemEndRaw(it),
        serverTime: epochToPacificNaive(now, true),
        sellerId: it.sellerId,
        sellerName: it.sellerName,
        categoryId: it.categoryId,
        pickupOnly: it.pickupOnly,
        shippingPrice: it.shippingPrice,
        isClosed: itemEnd(it) <= now,
        inWatchlist: bearer === null ? null : isFav(it.itemId),
        bidHistory: [...v.bidHistory, ...it.bidHistory],
      });
    },
  });

  add("POST", "/api/Dashboard/GetCurrentTime", {
    name: "Dashboard/GetCurrentTime",
    handler: () => ok(epochToPacificNaive(serverNow(), false)),
  });

  add("POST", "/api/itemDetail/CalculateShipping", {
    name: "itemDetail/CalculateShipping",
    handler: ({ body }) => {
      const p = CalculateShippingRequestSchema.safeParse(parseJson(body));
      if (!p.success) return bad(400, "Bad request");
      const it = byId.get(p.data.itemId);
      if (!it) return bad(404, "Item not found");
      if (it.pickupOnly || it.shippingPrice === null)
        return ok({ shippingPrice: 12.5, handlingPrice: 3 });
      return ok({ shippingPrice: it.shippingPrice, handlingPrice: 3 });
    },
  });

  add("GET", "/api/Favorite/AddToFavorite", {
    name: "Favorite/AddToFavorite",
    auth: true,
    handler: ({ url }) => {
      const id = Number(url.searchParams.get("itemId"));
      if (!byId.has(id)) return bad(404, "Item not found");
      if (!isFav(id))
        favs.push({ watchlistId: nextWatchlistId++, itemId: id, notes: "" });
      return ack();
    },
  });
  add("GET", "/api/Favorite/RemoveItemFromFavoriteList", {
    name: "Favorite/RemoveItemFromFavoriteList",
    auth: true,
    handler: ({ url }) => {
      const id = Number(url.searchParams.get("itemId"));
      const i = favs.findIndex((f) => f.itemId === id);
      if (i >= 0) favs.splice(i, 1);
      return ack();
    },
  });
  add("POST", "/api/Favorite/GetAllFavoriteItemsByType", {
    name: "Favorite/GetAllFavoriteItemsByType",
    auth: true,
    handler: ({ url }) => {
      const type = (url.searchParams.get("Type") ?? "all").toLowerCase();
      if (!["open", "close", "all"].includes(type)) return bad(400, "Bad type");
      const now = serverNow();
      const rows = favs.flatMap((f) => {
        const it = byId.get(f.itemId);
        if (!it) return [];
        const closed = itemEnd(it) <= now;
        if ((type === "open" && closed) || (type === "close" && !closed))
          return [];
        return [
          {
            itemId: it.itemId,
            watchlistId: f.watchlistId,
            notes: f.notes,
            endTime: itemEndRaw(it),
            sellerId: it.sellerId,
            title: it.title,
            currentPrice: it.currentPrice,
          },
        ];
      });
      return ok(rows);
    },
  });
  add("POST", "/api/Favorite/Save", {
    name: "Favorite/Save",
    auth: true,
    handler: ({ body }) => {
      const p = FavoriteSaveRequestSchema.safeParse(parseJson(body));
      if (!p.success) return bad(400, "Bad request");
      const f = favs.find((x) => x.watchlistId === p.data.watchlistId);
      if (!f) return bad(404, "Watchlist entry not found");
      f.notes = p.data.notes;
      return ack();
    },
  });
  add("POST", "/api/SaveSearches/GetSaveSearches", {
    name: "SaveSearches/GetSaveSearches",
    auth: true,
    handler: () => ok(seed.savedSearches),
  });

  // Bidding: proxy-bid state and faults live in ./bidding. The Bid cookie 403 stays here.
  const bidCookie = /(?:^|;\s*)Bid=/;
  add("GET", "/api/ItemBid/ShowBidModal", {
    name: "ItemBid/ShowBidModal",
    auth: true,
    handler: ({ req, url }) => {
      if (bidCookie.test(req.headers.cookie ?? ""))
        return bad(403, "Forbidden");
      return bidding.showBidModal(Number(url.searchParams.get("itemId")));
    },
  });
  add("POST", "/api/ItemBid/PlaceBid", {
    name: "ItemBid/PlaceBid",
    auth: true,
    handler: ({ req, body }) => {
      if (bidCookie.test(req.headers.cookie ?? ""))
        return bad(403, "Forbidden");
      const r = bidding.placeBid(parseJson(body));
      return r.status === 200 && scenario.bidSetsCookie
        ? { ...r, headers: { "set-cookie": "Bid=1; Path=/" } }
        : r;
    },
  });

  add("POST", "/api/SignIn/RefreshToken", {
    name: "SignIn/RefreshToken",
    handler: ({ body }) => {
      const p = RefreshTokenRequestSchema.safeParse(parseJson(body));
      if (!p.success || p.data.refreshToken === "revoked")
        return bad(401, "Invalid refresh token");
      return ok({
        accessToken: mint().accessToken,
        refreshToken: "fake-refresh-token",
      });
    },
  });
  add("POST", "/api/SignIn/RevokeToken", {
    name: "SignIn/RevokeToken",
    auth: true,
    handler: () => ack(),
  });

  const bearerValid = (token: string | null): boolean => {
    const claims = token === null ? null : verify(token);
    return claims !== null && claims.exp * 1000 > serverNow();
  };

  const matchRoute = (
    method: string,
    pathname: string,
  ): { route: Route; m: RegExpExecArray } | "method" | null => {
    const lower = pathname.toLowerCase();
    let pathKnown = false;
    for (const [key, route] of routes) {
      const sp = key.indexOf(" ");
      const m = new RegExp(`^${key.slice(sp + 1)}/?$`).exec(lower);
      if (!m) continue;
      if (key.slice(0, sp) === method) return { route, m };
      pathKnown = true;
    }
    return pathKnown ? "method" : null;
  };

  const findSpec = <T>(
    table: Record<string, T>,
    name: string,
  ): [string, T] | undefined => {
    const n = name.toLowerCase();
    return (
      Object.entries(table).find(([k]) => k.toLowerCase() === n) ??
      Object.entries(table).find(([k]) => k === "*")
    );
  };

  const send = (
    res: ServerResponse,
    status: number,
    body: unknown,
    headers: Record<string, string> = {},
  ): void => {
    const text = body === undefined ? "" : JSON.stringify(body);
    res.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      ...headers,
    });
    res.end(text);
  };

  const handleControl = (
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
    body: string,
  ): boolean => {
    const p = url.pathname;
    if (!p.startsWith("/__")) return false;
    const method = req.method ?? "GET";
    if (p === "/__log" && method === "GET") send(res, 200, { entries: log });
    else if (p === "/__log" && method === "DELETE") {
      log.length = 0;
      send(res, 200, { entries: [] });
    } else if (p === "/__scenario" && method === "GET") {
      send(res, 200, {
        scenario,
        known: Object.keys(NAMED_SCENARIOS),
        bidding: bidding.snapshot(),
      });
    } else if (p === "/__scenario" && method === "POST") {
      const raw = parseJson(body);
      const parsed = ScenarioPatchSchema.safeParse(raw);
      const bidPatch = BiddingPatchSchema.safeParse(
        (raw as { bidding?: unknown } | undefined)?.bidding ?? {},
      );
      if (!parsed.success) send(res, 400, { message: parsed.error.message });
      else if (!bidPatch.success)
        send(res, 400, { message: bidPatch.error.message });
      else {
        const savedScenario = scenario;
        const savedAnchor = anchor;
        const savedCounts = new Map(errorCounts);
        const restoreBidding = bidding.checkpoint();
        try {
          setScenario(parsed.data);
          // A top-level preset or reset also clears bidding state; then apply the bidding patch.
          if (parsed.data.reset === true || parsed.data.name !== undefined)
            bidding.applyPatch({ reset: true });
          bidding.applyPatch(bidPatch.data);
          send(res, 200, { scenario, bidding: bidding.snapshot() });
        } catch (e) {
          // Roll back so a rejected patch leaves nothing half-applied.
          scenario = savedScenario;
          anchor = savedAnchor;
          errorCounts.clear();
          for (const [k, v] of savedCounts) errorCounts.set(k, v);
          restoreBidding();
          send(res, 400, {
            message: e instanceof Error ? e.message : String(e),
          });
        }
      }
    } else if (p === "/__token" && method === "POST") {
      const b = parseJson(body) as
        { expiresInMs?: number; buyerId?: string } | undefined;
      send(res, 200, mint(b && typeof b === "object" ? b : undefined));
    } else send(res, 404, { message: "Unknown control route" });
    return true;
  };

  const server: Server = createServer((req, res) => {
    const started = Date.now();
    let logged = false;
    void (async () => {
      const receivedAtMs = Date.now();
      const url = new URL(req.url ?? "/", "http://fake");
      const method = req.method ?? "GET";
      const origin = req.headers.origin;
      const cors: Record<string, string> = {
        "access-control-allow-origin": origin ?? "*",
        "access-control-allow-headers":
          "authorization, content-type, x-sbw-fake-now",
        "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
        vary: "Origin",
      };
      for (const [k, v] of Object.entries(cors)) res.setHeader(k, v);

      if (method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
      }
      let body: string;
      try {
        body = await readBody(req);
      } catch {
        send(res, 413, { message: "Body too large" });
        return;
      }
      if (handleControl(req, res, url, body)) return;

      const hit = matchRoute(method, url.pathname);
      const route = hit && hit !== "method" ? hit.route : null;
      const endpoint = route?.name ?? url.pathname;
      const auth = req.headers.authorization;
      const bearer = auth?.startsWith("Bearer ") ? auth.slice(7).trim() : null;

      let result: Result;
      if (hit === null) result = bad(404, "Not found");
      else if (hit === "method") result = bad(405, "Method not allowed");
      else {
        const lat = findSpec(scenario.latencyMs, endpoint);
        if (lat && lat[1] > 0 && !(await sleep(lat[1], res))) return;
        const err = findSpec<ErrorSpec>(scenario.errors, endpoint);
        let forced: ErrorSpec | null = null;
        if (err) {
          const used = errorCounts.get(err[0]) ?? 0;
          if (err[1].times === undefined || used < err[1].times) {
            errorCounts.set(err[0], used + 1);
            forced = err[1];
          }
        }
        if (forced) {
          result = {
            status: forced.status,
            body: { message: `Injected ${String(forced.status)}` },
            ...(forced.retryAfterSec === undefined
              ? {}
              : { headers: { "retry-after": String(forced.retryAfterSec) } }),
          };
        } else if (route?.auth === true && !bearerValid(bearer)) {
          result = bad(401, "Unauthorized");
        } else {
          result = hit.route.handler({ req, url, body, bearer }, hit.m);
        }
      }

      const fakeNowMs = parseFakeNow([req.headers["x-sbw-fake-now"]].flat()[0]);
      logged = true;
      log.push({
        seq: ++seq,
        method,
        path: url.pathname,
        query: url.search,
        endpoint,
        status: result.status,
        receivedAtMs,
        fakeNowMs,
        requestTimeMs: fakeNowMs ?? receivedAtMs,
        hasBearer: bearer !== null,
        body,
      });
      if (
        result.delayMs !== undefined &&
        result.delayMs > 0 &&
        !(await sleep(result.delayMs, res))
      )
        return;
      send(res, result.status, result.body, result.headers);
    })().catch((e: unknown) => {
      // Never leave a request hanging or raise an unhandled rejection.
      if (!logged) {
        log.push({
          seq: ++seq,
          method: req.method ?? "GET",
          path: req.url ?? "",
          query: "",
          endpoint: req.url ?? "",
          status: 500,
          receivedAtMs: started,
          fakeNowMs: null,
          requestTimeMs: started,
          hasBearer: false,
          body: "",
        });
      }
      if (!res.headersSent) {
        res.writeHead(500, {
          "content-type": "application/json; charset=utf-8",
        });
        res.end(
          JSON.stringify({
            message: e instanceof Error ? e.message : "Internal error",
          }),
        );
      } else res.end();
    });
  });

  if (opts.scenario !== undefined)
    setScenario(
      typeof opts.scenario === "string"
        ? { name: opts.scenario }
        : opts.scenario,
    );

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port ?? 8787, opts.host ?? "127.0.0.1", resolve);
  });
  const addr = server.address() as AddressInfo;
  return {
    url: `http://${addr.address}:${String(addr.port)}`,
    mintToken: mint,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((e) => {
          if (e) reject(e);
          else resolve();
        });
      }),
  };
}
