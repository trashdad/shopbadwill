import { z } from 'zod';

export const ErrorSpecSchema = z.object({
  status: z.number().int().min(400).max(599),
  /** Fail this many times, then recover. Omit for "always". */
  times: z.number().int().positive().optional(),
  retryAfterSec: z.number().int().nonnegative().optional(),
});
export type ErrorSpec = z.infer<typeof ErrorSpecSchema>;

export const ScenarioSchema = z.object({
  /** Added to the server clock (serverTime, GetCurrentTime, closing, token expiry). */
  skewMs: z.number(),
  /** Pin the server clock to this epoch ms at the moment the scenario is set (it then ticks). */
  serverNowMs: z.number().nullable(),
  /** Per-endpoint delay; key is "Search/ItemListing" (case-insensitive) or "*". */
  latencyMs: z.record(z.string(), z.number().nonnegative()),
  /** Per-endpoint forced error; key as above or "*". */
  errors: z.record(z.string(), ErrorSpecSchema),
  /** Lifetime of tokens minted by /__token (default) and SignIn/RefreshToken. */
  tokenLifetimeMs: z.number().positive(),
  /** PlaceBid sets a `Bid` cookie; a client that sends it back gets 403 on the next ItemBid call. */
  bidSetsCookie: z.boolean(),
});
export type Scenario = z.infer<typeof ScenarioSchema>;

export const DEFAULT_SCENARIO: Scenario = {
  skewMs: 0,
  serverNowMs: null,
  latencyMs: {},
  errors: {},
  tokenLifetimeMs: 30 * 24 * 3600 * 1000,
  bidSetsCookie: false,
};

export const NAMED_SCENARIOS: Record<string, Partial<Scenario>> = {
  default: {},
  'skew-plus-5s': { skewMs: 5000 },
  'skew-minus-5s': { skewMs: -5000 },
  slow: { latencyMs: { '*': 1500 } },
  'rate-limited': { errors: { '*': { status: 429, retryAfterSec: 30 } } },
  'server-error': { errors: { '*': { status: 503 } } },
  blocked: { errors: { '*': { status: 403 } } },
  'short-token': { tokenLifetimeMs: 60_000 },
  'bid-cookie': { bidSetsCookie: true },
};

/** Body of POST /__scenario: optional preset, optional reset, then field overrides. */
export const ScenarioPatchSchema = z.object({
  name: z.string().optional(),
  reset: z.boolean().optional(),
  skewMs: z.number().optional(),
  serverNowMs: z.number().nullable().optional(),
  latencyMs: z.record(z.string(), z.number().nonnegative().nullable()).optional(),
  errors: z.record(z.string(), ErrorSpecSchema.nullable()).optional(),
  tokenLifetimeMs: z.number().positive().optional(),
  bidSetsCookie: z.boolean().optional(),
});
export type ScenarioPatch = z.infer<typeof ScenarioPatchSchema>;

function mergeRecord<T>(base: Record<string, T>, patch: Record<string, T | null> | undefined): Record<string, T> {
  const out = { ...base };
  for (const [k, v] of Object.entries(patch ?? {})) {
    if (v === null) Reflect.deleteProperty(out, k);
    else out[k] = v;
  }
  return out;
}

export function applyPatch(current: Scenario, patch: ScenarioPatch): Scenario {
  let s = current;
  if (patch.reset === true || patch.name !== undefined) {
    const preset = patch.name === undefined ? {} : NAMED_SCENARIOS[patch.name];
    if (!preset) throw new Error(`unknown scenario "${String(patch.name)}"; known: ${Object.keys(NAMED_SCENARIOS).join(', ')}`);
    s = { ...DEFAULT_SCENARIO, ...preset };
  }
  return {
    skewMs: patch.skewMs ?? s.skewMs,
    serverNowMs: patch.serverNowMs === undefined ? s.serverNowMs : patch.serverNowMs,
    latencyMs: mergeRecord(s.latencyMs, patch.latencyMs),
    errors: mergeRecord(s.errors, patch.errors),
    tokenLifetimeMs: patch.tokenLifetimeMs ?? s.tokenLifetimeMs,
    bidSetsCookie: patch.bidSetsCookie ?? s.bidSetsCookie,
  };
}
