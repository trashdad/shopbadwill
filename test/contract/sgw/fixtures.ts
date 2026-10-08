// Shared fixture access for the SGW contract tests (not a test file).
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export const SGW_FIXTURES = path.resolve(
  import.meta.dirname,
  "../../fixtures/sgw",
);

export interface ManifestEntry {
  file: string;
  kind: string;
  endpoint?: string;
  status: number;
  loggedIn: boolean;
}

export function manifestEntries(): ManifestEntry[] {
  const m = JSON.parse(
    readFileSync(path.join(SGW_FIXTURES, "manifest.json"), "utf8"),
  ) as { fixtures: ManifestEntry[] };
  return m.fixtures;
}

export function fixtureExists(file: string): boolean {
  return existsSync(path.join(SGW_FIXTURES, file));
}

/** Reads `json/<name>.json` fresh (callers may mutate the result). */
// The type argument is the test's own view of the raw JSON (a cast, by design).
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
export function loadFixture<T = unknown>(name: string): T {
  return JSON.parse(
    readFileSync(path.join(SGW_FIXTURES, "json", `${name}.json`), "utf8"),
  ) as T;
}
