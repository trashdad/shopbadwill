// The fixture-seeded rows of the fake SGW server are reproducible and actually used.
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { normalizeItemDetail } from "../../../src/adapters/sgw/normalize";
import {
  FIXTURE_SEED_FILE,
  buildFixtureSeed,
} from "../../fakes/fake-sgw-server/seed/build-fixture-seed";
import { loadSeed } from "../../fakes/fake-sgw-server/seed/loader";
import { startFakeSgw, type FakeSgw } from "../../fakes/fake-sgw-server/server";
import { loadFixture } from "./fixtures";

describe("seed/items-fixtures.json", () => {
  it("equals what build-fixture-seed.ts builds from the fixtures", () => {
    const committed: unknown = JSON.parse(
      readFileSync(FIXTURE_SEED_FILE, "utf8"),
    );
    expect(committed).toEqual(JSON.parse(JSON.stringify(buildFixtureSeed())));
  });
  it("is loaded by the seed loader", () => {
    const ids = new Set(loadSeed().items.map((i) => i.itemId));
    for (const row of buildFixtureSeed())
      expect(ids.has(row.itemId)).toBe(true);
  });
});

describe("fake serves the fixture item 702801256", () => {
  let sgw: FakeSgw;
  beforeAll(async () => {
    // 2026-10-07 17:00 PT: the fixture auction (ends 20:39 PT) is open.
    sgw = await startFakeSgw({
      port: 0,
      scenario: { serverNowMs: Date.parse("2026-10-08T00:00:00.000Z") },
    });
  });
  afterAll(async () => {
    await sgw.close();
  });

  it("matches the fixture detail values", async () => {
    const res = await fetch(
      `${sgw.url}/api/ItemDetail/GetItemDetailModelByItemId/702801256`,
    );
    expect(res.status).toBe(200);
    const d = normalizeItemDetail(await res.json(), {
      observedAt: 0,
      authenticated: false,
    });
    const real = normalizeItemDetail(loadFixture("item-detail-open"), {
      observedAt: 0,
      authenticated: false,
    });
    expect(d).toMatchObject({
      itemId: 702801256,
      currentPrice: 6701,
      minimumBid: 6801,
      startingMinimumBid: 999,
      bidIncrement: 100,
      numBids: 22,
      sellerId: 135,
      sellerName: "Goodwill of O",
      sellerState: "IL",
      endTimeRaw: real.endTimeRaw,
      isClosed: false,
    });
    expect(d.bidHistory).toHaveLength(22);
  });
});
