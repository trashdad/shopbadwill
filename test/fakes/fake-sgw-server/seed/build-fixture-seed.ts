// Builds seed/items-fixtures.json from the sanitized S-1 fixtures
// (test/fixtures/sgw/json). Regenerate with:
//   pnpm exec tsx test/fakes/fake-sgw-server/seed/build-fixture-seed.ts
// A contract test (test/contract/sgw/fake-seed.test.ts) rebuilds the rows and
// requires them to equal the committed file, so the seed cannot drift.
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SeedItem } from './loader';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const FIXTURE_JSON_DIR = path.resolve(HERE, '../../../fixtures/sgw/json');
export const FIXTURE_SEED_FILE = path.join(HERE, 'items-fixtures.json');

interface RawRow {
  itemId: number;
  title: string;
  currentPrice: number;
  minimumBid: number;
  numBids: number;
  endTime: string;
  sellerId: number;
  categoryId: number;
  shippingPrice: number;
  imageURL: string;
}
interface RawDetail {
  itemId: number;
  title: string;
  currentPrice: number;
  minimumBid: number;
  startingPrice: number;
  bidIncrement: number;
  numberOfBids: number;
  endTime: string;
  sellerId: number;
  sellerCompanyName: string;
  pickupState: string | null;
  categoryId: number;
  pickupOnly: boolean;
  shippingPrice: number;
  allowShippingCalculation: boolean;
  imageServer: string;
  imageUrlString: string;
  bidHistory: { bidComplete: Array<{ bidAmount: number; bidTime: string; bidderName: string }> };
}

// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- the type argument is a cast of fixture JSON
const read = <T>(dir: string, name: string): T => JSON.parse(readFileSync(path.join(dir, `${name}.json`), 'utf8')) as T;

/** Search rows (grid, list) first, then the detail fixtures, which replace a row with the same id. */
export function buildFixtureSeed(dir: string = FIXTURE_JSON_DIR): SeedItem[] {
  const items = new Map<number, SeedItem>();
  for (const f of ['search-grid-p1', 'search-list-p1']) {
    for (const r of read<{ searchResults: { items: RawRow[] } }>(dir, f).searchResults.items) {
      if (items.has(r.itemId)) continue;
      items.set(r.itemId, {
        itemId: r.itemId,
        title: r.title,
        description: '',
        currentPrice: r.currentPrice,
        minimumBid: r.minimumBid,
        bidIncrement: 1,
        numBids: r.numBids,
        endTime: r.endTime,
        sellerId: r.sellerId,
        sellerName: `Seller ${String(r.sellerId)}`,
        categoryId: r.categoryId,
        pickupOnly: false,
        shippingPrice: r.shippingPrice === 0 ? null : r.shippingPrice,
        imageURL: r.imageURL,
        bidHistory: [],
      });
    }
  }
  // item-detail-closed is the same item as item-detail-open, a later snapshot.
  for (const f of ['item-detail-open', 'item-detail-pickup']) {
    const d = read<RawDetail>(dir, f);
    items.set(d.itemId, {
      itemId: d.itemId,
      title: d.title,
      description: '',
      currentPrice: d.currentPrice,
      minimumBid: d.startingPrice,
      detailMinimumBid: d.minimumBid,
      bidIncrement: d.bidIncrement,
      numBids: d.numberOfBids,
      endTime: d.endTime,
      sellerId: d.sellerId,
      sellerName: d.sellerCompanyName,
      ...(d.pickupState === null ? {} : { sellerState: d.pickupState }),
      categoryId: d.categoryId,
      pickupOnly: d.pickupOnly,
      shippingPrice: d.shippingPrice === 0 && d.allowShippingCalculation ? null : d.shippingPrice,
      imageURL: d.imageServer + d.imageUrlString,
      bidHistory: [...d.bidHistory.bidComplete]
        .reverse()
        .map((b) => ({ bidAmount: b.bidAmount, bidTime: b.bidTime, bidderName: b.bidderName })),
    });
  }
  return [...items.values()].sort((a, b) => a.itemId - b.itemId);
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  writeFileSync(FIXTURE_SEED_FILE, `${JSON.stringify(buildFixtureSeed(), null, 2)}\n`);
  console.log(`wrote ${FIXTURE_SEED_FILE}`);
}
