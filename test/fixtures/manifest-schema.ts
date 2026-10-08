import { z } from 'zod';

/**
 * Shape of `test/fixtures/sgw/manifest.json` (PLAN §7.2: capture date, URL
 * pattern, anonymous/user, sanitizer version). T-07 produces the file; this
 * schema is T-03's reading of it. Unknown keys are stripped, so T-07 may add
 * provenance fields without breaking the loader.
 */
export const FixtureEntrySchema = z.object({
  /** Path relative to `test/fixtures/sgw/`, e.g. "json/search-grid-p1.json". */
  path: z.string().min(1),
  /** Lookup name; defaults to the file name without its extension. */
  name: z.string().min(1).optional(),
  kind: z.enum(['json', 'html']).optional(),
  capturedAt: z.string().optional(),
  urlPattern: z.string().optional(),
  auth: z.enum(['anonymous', 'user']).optional(),
  sanitizerVersion: z.union([z.string(), z.number()]).optional(),
});
export type FixtureEntry = z.infer<typeof FixtureEntrySchema>;

export const FixtureManifestSchema = z.object({
  fixtures: z.array(FixtureEntrySchema),
});
export type FixtureManifest = z.infer<typeof FixtureManifestSchema>;
