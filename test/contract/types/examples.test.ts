// Contract fixtures (T-02): every exported `*Schema` of every contract module
// has one valid and one invalid JSON example in ./examples/.
//
//   examples/<Name>.valid.json     the value itself; parsing must succeed and
//                                  return it unchanged (so a field the schema
//                                  does not know, which zod would strip, fails)
//   examples/<Name>.invalid.json   { "invalidBecause": "...", "path": [...],
//                                    "value": ... }; parsing must fail with an
//                                  issue at exactly `path`
//
// <Name> is the schema export without its `Schema` suffix. Message examples
// (one pair per `Msg` type) live in examples/Msg/ and are checked by
// messages.test.ts.
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import * as auditTypes from '../../../src/domain/audit/types';
import * as calendarTypes from '../../../src/domain/calendar/types';
import * as rulesSchema from '../../../src/domain/rules/schema';
import * as settingsSchema from '../../../src/domain/settings/schema';
import * as snipeTypes from '../../../src/domain/snipe/types';
import * as storageSchema from '../../../src/domain/storage/schema';
import * as domainTypes from '../../../src/domain/types';
import * as watchesSchema from '../../../src/domain/watches/schema';
import * as protocol from '../../../src/messaging/protocol';

const EXAMPLES_DIR = path.join(import.meta.dirname, 'examples');

const CONTRACT_MODULES: Record<string, Record<string, unknown>> = {
  'src/domain/types.ts': domainTypes,
  'src/domain/rules/schema.ts': rulesSchema,
  'src/domain/watches/schema.ts': watchesSchema,
  'src/domain/settings/schema.ts': settingsSchema,
  'src/domain/snipe/types.ts': snipeTypes,
  'src/domain/calendar/types.ts': calendarTypes,
  'src/domain/audit/types.ts': auditTypes,
  'src/domain/storage/schema.ts': storageSchema,
  'src/messaging/protocol.ts': protocol,
};

// The frozen v1 schema surface, by module. Adding or removing a schema is a
// contract change (.github/PULL_REQUEST_TEMPLATE/contract-change.md).
const EXPECTED_SCHEMAS: Record<string, string[]> = {
  'src/domain/types.ts': [
    'ItemId',
    'Cents',
    'EpochMs',
    'IsoUtc',
    'PacificNaiveRaw',
    'UsState',
    'Listing',
    'ItemDetail',
    'Favorite',
    'BidResultKind',
    'BidResult',
    'TrackedItem',
    'SearchQuery',
    'Lane',
    'LaneConfig',
    'RequestSchedulerStats',
    'ClockSample',
    'HealthReport',
    'SgwSessionState',
    'SgwSessionRecord',
    'GoogleCredentials',
  ],
  'src/domain/rules/schema.ts': ['Condition', 'Rule', 'MatchReason', 'MatchResult'],
  'src/domain/watches/schema.ts': ['FavoriteMode', 'Watch', 'JobStep', 'StepOutcome', 'JobRun'],
  'src/domain/settings/schema.ts': ['Settings'],
  'src/domain/snipe/types.ts': [
    'SnipeId',
    'SnipeState',
    'SnipeOutcome',
    'LeadMs',
    'Snipe',
    'SnipeEvent',
    'Effect',
    'CapsCheck',
    'CapsResult',
  ],
  'src/domain/calendar/types.ts': [
    'DesiredEvent',
    'CalendarLink',
    'GcalEventBody',
    'GcalEvent',
    'GoogleAuthErrorCode',
    'AuthStatus',
  ],
  'src/domain/audit/types.ts': ['AuditEntry'],
  'src/domain/storage/schema.ts': [
    'StorageMeta',
    'ListingCacheEntry',
    'DetailCacheEntry',
    'ShippingCacheEntry',
    'FavoritesCache',
    'CalendarState',
    'AuditChunk',
    'AuditMeta',
    'RequestBudget',
    'RequestSchedulerState',
    'GoogleAccess',
    'GoogleClient',
    'HealthProbe',
    'QuarantineRecord',
  ],
  'src/messaging/protocol.ts': ['Msg', 'MsgEnvelope', 'SnipeCountdownTick'],
};

function collectSchemas(): Map<string, { module: string; schema: z.ZodType }> {
  const found = new Map<string, { module: string; schema: z.ZodType }>();
  for (const [module, exports] of Object.entries(CONTRACT_MODULES)) {
    for (const [exportName, value] of Object.entries(exports)) {
      if (!exportName.endsWith('Schema') || !(value instanceof z.ZodType)) continue;
      const name = exportName.slice(0, -'Schema'.length);
      const previous = found.get(name);
      if (previous) throw new Error(`${name}Schema is exported by both ${previous.module} and ${module}`);
      found.set(name, { module, schema: value });
    }
  }
  return found;
}

interface InvalidExample {
  invalidBecause: string;
  path: PropertyKey[];
  value: unknown;
}

function readJson(file: string): unknown {
  return JSON.parse(readFileSync(path.join(EXAMPLES_DIR, file), 'utf8'));
}

function readInvalid(file: string): InvalidExample {
  const raw = readJson(file);
  const parsed = z
    .object({ invalidBecause: z.string().min(1), path: z.array(z.union([z.string(), z.number()])), value: z.unknown() })
    .safeParse(raw);
  if (!parsed.success) throw new Error(`${file} is not an invalid-example wrapper: ${z.prettifyError(parsed.error)}`);
  return parsed.data;
}

const schemas = collectSchemas();

describe('contract schema surface', () => {
  it('exports exactly the expected *Schema names from each contract module', () => {
    const actual: Record<string, string[]> = {};
    for (const [name, { module }] of schemas) (actual[module] ??= []).push(name);
    const sorted = (rec: Record<string, string[]>) =>
      Object.fromEntries(Object.entries(rec).map(([module, names]) => [module, [...names].sort()]));
    expect(sorted(actual)).toEqual(sorted(EXPECTED_SCHEMAS));
  });

  it('has no example file without a schema', () => {
    const files = readdirSync(EXAMPLES_DIR, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name);
    const orphans = files.filter((file) => {
      const match = /^(.+)\.(valid|invalid)\.json$/.exec(file);
      return !match?.[1] || !schemas.has(match[1]);
    });
    expect(orphans).toEqual([]);
  });
});

describe.each([...schemas.keys()].sort())('%s', (name) => {
  const entry = schemas.get(name);
  if (!entry) throw new Error(`no schema ${name}`);
  const { schema } = entry;

  it('parses its valid example and returns it unchanged', () => {
    const value = readJson(`${name}.valid.json`);
    const result = schema.safeParse(value);
    if (!result.success) expect.fail(`${name}.valid.json:\n${z.prettifyError(result.error)}`);
    expect(result.data).toEqual(value);
  });

  it('rejects its invalid example at the documented path', () => {
    const example = readInvalid(`${name}.invalid.json`);
    const result = schema.safeParse(example.value);
    expect(result.success, `${name}.invalid.json should fail: ${example.invalidBecause}`).toBe(false);
    const paths = result.error?.issues.map((issue) => issue.path) ?? [];
    expect(paths, example.invalidBecause).toContainEqual(example.path);
  });
});
