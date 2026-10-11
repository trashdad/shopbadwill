// Reads seed/**/*.json: items*.json (arrays of SeedItem), favorites.json, saved-searches.json.
// T-24 re-seeds these files from the Task 0 fixtures; the shapes stay the same.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { NaivePacificSchema, SavedSearchRowSchema } from '../shapes';

const SeedBidSchema = z.object({ bidAmount: z.number(), bidTime: NaivePacificSchema, bidderName: z.string() });

export const SeedItemSchema = z.object({
  itemId: z.number().int().positive(),
  title: z.string(),
  description: z.string().default(''),
  currentPrice: z.number(),
  /** Search-row minimumBid (the STARTING minimum). */
  minimumBid: z.number(),
  /** Detail minimumBid (next acceptable bid); defaults to currentPrice + bidIncrement when bids exist. */
  detailMinimumBid: z.number().optional(),
  bidIncrement: z.number(),
  numBids: z.number().int(),
  /** Fixed naive-Pacific end time... */
  endTime: NaivePacificSchema.optional(),
  /** ...or relative to server-now at load time (for tests that need an auction ending soon). */
  endsInMs: z.number().optional(),
  sellerId: z.number().int(),
  sellerName: z.string(),
  /** The seller's 2-letter state, when known (fixture-seeded items); detail `pickupState`. */
  sellerState: z.string().optional(),
  categoryId: z.number().int(),
  pickupOnly: z.boolean(),
  shippingPrice: z.number().nullable(),
  imageURL: z.string(),
  bidHistory: z.array(SeedBidSchema),
});
export type SeedItem = z.infer<typeof SeedItemSchema>;

export const SeedFavoriteSchema = z.object({ watchlistId: z.number().int(), itemId: z.number().int(), notes: z.string() });
export type SeedFavorite = z.infer<typeof SeedFavoriteSchema>;

export interface Seed {
  items: SeedItem[];
  favorites: SeedFavorite[];
  savedSearches: Array<z.infer<typeof SavedSearchRowSchema>>;
}

export const DEFAULT_SEED_DIR = path.dirname(fileURLToPath(import.meta.url));

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)],
  );
}

function readJson(file: string): unknown {
  return JSON.parse(readFileSync(file, 'utf8'));
}

export function loadSeed(dir: string = DEFAULT_SEED_DIR): Seed {
  const files = walk(dir)
    .filter((f) => f.endsWith('.json'))
    .sort();
  const seed: Seed = { items: [], favorites: [], savedSearches: [] };
  for (const f of files) {
    const base = path.basename(f);
    if (base.startsWith('items')) seed.items.push(...z.array(SeedItemSchema).parse(readJson(f)));
    else if (base === 'favorites.json') seed.favorites.push(...z.array(SeedFavoriteSchema).parse(readJson(f)));
    else if (base === 'saved-searches.json')
      seed.savedSearches.push(...z.array(SavedSearchRowSchema).parse(readJson(f)));
  }
  const ids = new Set<number>();
  for (const it of seed.items) {
    if (ids.has(it.itemId)) throw new Error(`duplicate seed itemId ${String(it.itemId)}`);
    ids.add(it.itemId);
    if (it.endTime === undefined && it.endsInMs === undefined) throw new Error(`seed item ${String(it.itemId)} has no end time`);
  }
  return seed;
}
