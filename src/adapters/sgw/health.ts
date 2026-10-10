// T-30: SgwHealth (PLAN §3.3). Detects site drift and writes a HealthReport to
// `sbw:runtimeHealth`; T-36's GlobalSwitches blocks account writes while the
// last report is failing. This module only produces the report.
//
// Checks (HealthReport.checks, names frozen by the contract):
//   search-schema / detail-schema  one search + one item detail on the
//                                  background lane (at most 2 requests per run)
//   card-selectors                 the last DomAdapter DiscoveryReport (T-32 sends it)
//   clock                          SgwClock.offset() judged like T-81 clockSanity
//   session                        'full' mode only: expired / logged-out fails
//
// Rules:
//   R2 unknown: a check with no data and no way to get any (scheduler paused or
//      over budget, offline, no content-script report, no clock samples, no row to
//      probe) is UNKNOWN. The frozen contract has no status field, so an unknown
//      check is `ok: true` with a detail starting UNKNOWN_PREFIX (see
//      isUnknownCheck). The report is `ok` only when no check FAILED; unknown
//      checks never fail it (no flapping) but stay listed, and an unknown schema
//      check is probed again on the next run.
//   R4 request budget: schema checks reuse the stored report while its probe is
//      under 6 h old and all good: zero requests. A failing/unknown probe is
//      retried no sooner than every 10 min (the scheduler's 120 s background
//      spacing and budget still apply). Local checks (cards, clock, session) are
//      recomputed on every run and cost nothing.
//   R1 shipping-quote format: if a raw cached quote reply exists (`shippingReply`),
//      it is parsed with normalizeShippingQuote; a schema error or an unparseable
//      quote (null) fails `detail-schema` with detail "shipping-quote: ...". No
//      quote is ever requested.
//   R3 audit: `health.fail` only on a transition to failing, `health.recovered`
//      on failing -> ok. Audit errors never break a run.
//
// The probe age is kept in memory and, after a worker restart, falls back to the
// stored report's checkedAt (which local checks refresh), so a restart can only
// delay the next probe, never add requests.
import type { AuditLog } from '../../domain/audit/types';
import { STORAGE_KEYS, type StorageValue } from '../../domain/storage/schema';
import type { EpochMs, HealthReport, ItemId, SearchQuery } from '../../domain/types';
import type { Clock } from '../../ports/clock';
import { SgwApiError } from '../../ports/errors';
import type { SgwApi } from '../../ports/sgw-api';
import type { SgwClock } from '../../ports/sgw-clock';
import type { SgwHealth } from '../../ports/sgw-health';
import type { SgwSession } from '../../ports/sgw-session';
import type { SchemaFailure } from './api-adapter';
import { SGW_CONFIG_VERSION } from './config';
import type { DiscoveryReport } from './dom-adapter';
import { normalizeShippingQuote } from './normalize';

/** A good schema probe is trusted this long (zero requests). */
export const HEALTH_CACHE_TTL_MS = 6 * 3_600_000;
/** A failing or unknown probe is retried no sooner than this. */
export const HEALTH_REPROBE_MIN_MS = 10 * 60_000;
/** Detail prefix that marks an unknown check (R2). */
export const UNKNOWN_PREFIX = 'unknown: ';
const MAX_DETAIL_CHARS = 200;
/** |offset| above this is an insane clock. Mirrors T-81 clockSanity (MAX_CLOCK_OFFSET_MS); adapters may not import domain/snipe (PLAN 2.1). */
export const HEALTH_MAX_CLOCK_OFFSET_MS = 300_000;

/** The page-1 browse query used for the one search probe. */
export const HEALTH_PROBE_QUERY: SearchQuery = { searchText: '', categoryIds: [], sellerIds: [], page: 1 };

type Check = HealthReport['checks'][number];
type CheckName = Check['name'];

export function isUnknownCheck(c: { ok: boolean; detail?: string | undefined }): boolean {
  return c.ok && c.detail !== undefined && c.detail.startsWith(UNKNOWN_PREFIX);
}

/** The slice of the domain Repo used here (adapters may not import the Repo class, PLAN §2.1). */
export interface HealthRepo {
  find(key: typeof STORAGE_KEYS.runtimeHealth): Promise<StorageValue<typeof STORAGE_KEYS.runtimeHealth> | undefined>;
  set(key: typeof STORAGE_KEYS.runtimeHealth, value: StorageValue<typeof STORAGE_KEYS.runtimeHealth>): Promise<void>;
}

/** The last DomAdapter report as the content script (T-32) forwards it. */
export type DomDriftReport = DiscoveryReport;

export interface SgwHealthDeps {
  repo: HealthRepo;
  clock: Clock;
  /** Only search and itemDetail are used, always on the background lane. */
  api: Pick<SgwApi, 'search' | 'itemDetail'>;
  sgwClock: Pick<SgwClock, 'offset'>;
  session: Pick<SgwSession, 'state'>;
  audit: Pick<AuditLog, 'append'>;
  /**
   * The last DomAdapter DiscoveryReport received from a content script, or
   * null. No storage key holds it yet (T-32/T-36 decide); it is injected.
   */
  domReport: () => Promise<DomDriftReport | null>;
  /** The most recent raw shipping-quote reply, if one was kept (R1). Optional. */
  shippingReply?: () => Promise<unknown>;
  configVersion?: string;
  probeQuery?: SearchQuery;
}

const unknown = (name: CheckName, why: string): Check => ({ name, ok: true, detail: clip(UNKNOWN_PREFIX + why) });
const pass = (name: CheckName, detail?: string): Check => (detail === undefined ? { name, ok: true } : { name, ok: true, detail });
const fail = (name: CheckName, why: string): Check => ({ name, ok: false, detail: clip(why) });
const clip = (s: string): string => (s.length > MAX_DETAIL_CHARS ? `${s.slice(0, MAX_DETAIL_CHARS)}...` : s);

/** Schema error = drift (fail); anything else (paused, budget, network, 403...) = no answer (unknown). */
function fromError(name: CheckName, e: unknown): Check {
  if (e instanceof SgwApiError) {
    return e.kind === 'schema' ? fail(name, `schema: ${e.message}`) : unknown(name, `request not possible (${e.kind})`);
  }
  return unknown(name, 'request not possible');
}

export class SgwHealthAdapter implements SgwHealth {
  private probedAt: EpochMs | null = null;
  private tail: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: SgwHealthDeps) {}

  run(mode: 'anonymous' | 'full'): Promise<HealthReport> {
    return this.serial(() => this.doRun(mode));
  }

  async last(): Promise<HealthReport | null> {
    return (await this.deps.repo.find(STORAGE_KEYS.runtimeHealth)) ?? null;
  }

  /**
   * T-36's hook for ApiAdapterDeps.health: a reply failed its schema, so write
   * a failing report now (writes fail closed) and hold off re-probing for 10 min.
   */
  recordSchemaFailure(f: SchemaFailure): Promise<void> {
    return this.serial(async () => {
      const now = this.deps.clock.now();
      const prev = await this.last();
      const name: CheckName = f.endpoint === 'search' ? 'search-schema' : 'detail-schema';
      const why = f.endpoint === 'search' ? f.message : `${f.endpoint}: ${f.message}`;
      const checks = (prev?.checks ?? []).filter((c) => c.name !== name);
      checks.push(fail(name, `schema: ${why}`));
      this.probedAt = now;
      await this.store(prev, {
        ok: false,
        checkedAt: now,
        configVersion: this.deps.configVersion ?? SGW_CONFIG_VERSION,
        checks: sortChecks(checks),
      });
    });
  }

  /** The synchronous, never-throwing shape of ApiAdapterDeps.health. */
  flagSchemaFailure(f: SchemaFailure): void {
    this.recordSchemaFailure(f).catch(() => undefined);
  }

  // ── internals ─────────────────────────────────────────────────────────

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(fn, fn);
    this.tail = next.catch(() => undefined);
    return next;
  }

  private async doRun(mode: 'anonymous' | 'full'): Promise<HealthReport> {
    const { deps } = this;
    const now = deps.clock.now();
    const prev = await this.last();
    const schema = await this.schemaChecks(prev, now);
    const checks: Check[] = [...schema, await this.cardCheck(), this.clockCheck()];
    if (mode === 'full') checks.push(await this.sessionCheck());
    await this.applyShipping(checks);
    const report: HealthReport = {
      ok: checks.every((c) => c.ok),
      checkedAt: now,
      configVersion: deps.configVersion ?? SGW_CONFIG_VERSION,
      checks: sortChecks(checks),
    };
    await this.store(prev, report);
    return report;
  }

  private async schemaChecks(prev: HealthReport | null, now: EpochMs): Promise<Check[]> {
    const s = prev?.checks.find((c) => c.name === 'search-schema');
    const d0 = prev?.checks.find((c) => c.name === 'detail-schema');
    if (prev !== null && s !== undefined && d0 !== undefined) {
      // A shipping-quote failure is recomputed from the cached reply (applyShipping), not part of the probe.
      const d = isShippingDetail(d0) ? pass('detail-schema') : d0;
      const age = now - (this.probedAt ?? prev.checkedAt);
      const good = [s, d].every((c) => c.ok && !isUnknownCheck(c));
      // A good probe is trusted for 6 h; a bad or unknown one is only throttled.
      if (age >= 0 && (age < HEALTH_REPROBE_MIN_MS || (good && age < HEALTH_CACHE_TTL_MS))) return [s, d];
    }
    return this.probe(now);
  }

  /** At most one search and one item detail. */
  private async probe(now: EpochMs): Promise<Check[]> {
    const { api } = this.deps;
    let search: Check;
    let itemId: ItemId | null = null;
    try {
      const res = await api.search(this.deps.probeQuery ?? HEALTH_PROBE_QUERY, 'background');
      search = pass('search-schema');
      itemId = res.items[0]?.itemId ?? null;
    } catch (e) {
      search = fromError('search-schema', e);
    }
    let detail: Check;
    if (itemId === null) {
      detail = unknown('detail-schema', 'no item to probe');
    } else {
      try {
        await api.itemDetail(itemId, 'background', { maxAgeMs: 0 });
        detail = pass('detail-schema');
      } catch (e) {
        detail = fromError('detail-schema', e);
      }
    }
    this.probedAt = now;
    return [search, detail];
  }

  private async cardCheck(): Promise<Check> {
    let r: DomDriftReport | null;
    try {
      r = await this.deps.domReport();
    } catch {
      r = null;
    }
    if (r === null) return unknown('card-selectors', 'no content-script report yet');
    if (r.drifted) {
      return fail('card-selectors', `drift: fallback rank ${String(r.rank)}, ${String(r.unreadable)} unreadable (config ${r.configVersion})`);
    }
    return pass('card-selectors');
  }

  private clockCheck(): Check {
    const o = this.deps.sgwClock.offset();
    if (o === null || o.confidence === 'none') return unknown('clock', 'no clock samples');
    const sane = Math.abs(o.offsetMs) <= HEALTH_MAX_CLOCK_OFFSET_MS;
    return sane ? pass('clock') : fail('clock', `skew: offset ${String(Math.round(o.offsetMs))} ms exceeds 5 min`);
  }

  private async sessionCheck(): Promise<Check> {
    try {
      const s = await this.deps.session.state();
      return s === 'expired' || s === 'logged-out' ? fail('session', `session ${s}`) : pass('session');
    } catch {
      return unknown('session', 'session state unreadable');
    }
  }

  /** R1: format-check the newest cached quote reply, folding a failure into detail-schema. */
  private async applyShipping(checks: Check[]): Promise<void> {
    if (this.deps.shippingReply === undefined) return;
    let raw: unknown;
    try {
      raw = await this.deps.shippingReply();
    } catch {
      return;
    }
    if (raw === undefined || raw === null) return;
    let problem: string | null = null;
    try {
      if (normalizeShippingQuote(raw) === null) problem = 'cached reply no longer parses (unparseable quote)';
    } catch (e) {
      problem = e instanceof SgwApiError ? e.message : 'cached reply failed its schema';
    }
    if (problem === null) return;
    const i = checks.findIndex((c) => c.name === 'detail-schema');
    const existing = checks[i];
    // Keep a real item-detail failure visible; otherwise the shipping problem is the detail.
    if (existing !== undefined && !existing.ok) {
      checks[i] = fail('detail-schema', `${existing.detail ?? 'schema'}; shipping-quote: ${problem}`);
    } else {
      checks[i] = fail('detail-schema', `shipping-quote: ${problem}`);
    }
  }

  private async store(prev: HealthReport | null, report: HealthReport): Promise<void> {
    await this.deps.repo.set(STORAGE_KEYS.runtimeHealth, report);
    const wasOk = prev?.ok;
    try {
      if (!report.ok && wasOk !== false) {
        const failing = report.checks.filter((c) => !c.ok);
        await this.deps.audit.append({
          actor: 'health',
          kind: 'health.fail',
          details: {
            checks: failing.map((c) => c.name).join(','),
            detail: failing.map((c) => c.detail ?? c.name).join(' | ').slice(0, MAX_DETAIL_CHARS),
          },
        });
      } else if (report.ok && wasOk === false) {
        await this.deps.audit.append({ actor: 'health', kind: 'health.recovered', details: {} });
      }
    } catch {
      // An audit failure must never break a health run.
    }
  }
}

const ORDER: readonly CheckName[] = ['search-schema', 'detail-schema', 'card-selectors', 'clock', 'session'];
function sortChecks(checks: Check[]): Check[] {
  return [...checks].sort((a, b) => ORDER.indexOf(a.name) - ORDER.indexOf(b.name));
}
function isShippingDetail(c: Check): boolean {
  return !c.ok && (c.detail ?? '').startsWith('shipping-quote:');
}
