import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { z } from 'zod';

import { FixtureManifestSchema, type FixtureEntry, type FixtureManifest } from './manifest-schema';

export const DEFAULT_FIXTURE_ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'sgw');

/** Reads and validates `<root>/manifest.json`. */
export function loadManifest(root: string = DEFAULT_FIXTURE_ROOT): FixtureManifest {
  const file = path.join(root, 'manifest.json');
  return FixtureManifestSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
}

function nameOf(entry: FixtureEntry): string {
  return entry.name ?? path.basename(entry.path, path.extname(entry.path));
}

/** Finds the entry called `name`; throws with the known names when absent. */
export function findFixture(name: string, root: string = DEFAULT_FIXTURE_ROOT): FixtureEntry {
  const manifest = loadManifest(root);
  const entry = manifest.fixtures.find((e) => nameOf(e) === name);
  if (entry === undefined) {
    throw new Error(`Fixture "${name}" is not in manifest.json (known: ${manifest.fixtures.map(nameOf).join(', ')})`);
  }
  return entry;
}

/** The fixture's raw text. */
export function loadFixtureText(name: string, root: string = DEFAULT_FIXTURE_ROOT): string {
  return readFileSync(path.join(root, findFixture(name, root).path), 'utf8');
}

/** A JSON fixture. Pass a zod schema to validate and type it; without one the result is `unknown`. */
export function loadJsonFixture(name: string, root?: string): unknown;
export function loadJsonFixture<S extends z.ZodType>(name: string, root: string | undefined, schema: S): z.infer<S>;
export function loadJsonFixture(name: string, root: string = DEFAULT_FIXTURE_ROOT, schema?: z.ZodType): unknown {
  const parsed: unknown = JSON.parse(loadFixtureText(name, root));
  return schema ? schema.parse(parsed) : parsed;
}

/** An HTML fixture as a string. */
export function loadHtmlFixture(name: string, root: string = DEFAULT_FIXTURE_ROOT): string {
  return loadFixtureText(name, root);
}
