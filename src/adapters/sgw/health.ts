// T-30: SgwHealth (PLAN §3.3). Detects site drift and writes a HealthReport to
// `sbw:runtimeHealth`; T-36's GlobalSwitches blocks account writes while the
// last report is failing. This module only produces the report.
//
// Checks (HealthReport.checks, names frozen by the contract):
//   search-schema / detail-schema  one search + one item detail on the
//                                  background lane (at most 2 requests per run)
//   card-selectors                 the last DomAdapter DiscoveryReport (T-32 sends it);
//                                  drift or zero cards is UNKNOWN, never a failure
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
// Probe bookkeeping lives in `sbw:healthProbe` (local, survives restarts): `probedAt`
// is the only clock for the 6 h / 10 min rules and is never refreshed on a cache
// hit; `lastGoodProbeAt` drives the 24 h stale escalation (a schema check with no
// good probe for over 24 h fails); `sticky` keeps a per-endpoint schema failure
// (recordSchemaFailure) failing until recordSchemaSuccess(endpoint) or a FULL run
// that probes that read endpoint successfully.
import type { AuditLog } from '../../domain/audit/types';
import { type HealthProbe, STORAGE_KEYS, type StorageValue } from '../../domain/storage/schema';
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

/** The fixed, known-good probe query (S-1-captured request shape): page 1, default page size. */
export const HEALTH_PROBE_QUERY: SearchQuery = {
  searchText: 'pyrex',
  categoryIds: [],
  sellerIds: [],
  page: 1,
};

type Check = HealthReport['checks'][number];
type CheckName = Check['name'];

export function isUnknownCheck(c: { ok: boolean; detail?: string | undefined }): boolean {
  return c.ok && c.detail !== undefined && c.detail.startsWith(UNKNOWN_PREFIX);
}

/** The slice of the domain Repo used here (adapters may not import the Repo class, PLAN §2.1). */
type HealthKey = typeof STORAGE_KEYS.runtimeHealth | typeof STORAGE_KEYS.healthReport | typeof STORAGE_KEYS.healthProbe;
export interface HealthRepo {
  find<K extends HealthKey>(key: K): Promise<StorageValue<K> | undefined>;
  set<K extends HealthKey>(key: K, value: StorageValue<K>): Promise<void>;
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

const unknown = (name: CheckName, why: string): Check => ({
  name,
  ok: true,
  detail: clip(UNKNOWN_PREFIX + why),
});
const pass = (name: CheckName, detail?: string): Check =>
  detail === undefined ? { name, ok: true } : { name, ok: true, detail };
const fail = (name: CheckName, why: string): Check => ({
  name,
  ok: false,
  detail: clip(why),
});
const clip = (s: string): string => (s.length > MAX_DETAIL_CHARS ? `${s.slice(0, MAX_DETAIL_CHARS)}...` : s);

/** Schema error = drift (fail); anything else (paused, budget, network, 403...) = no answer (unknown). */
function fromError(name: CheckName, e: unknown): Check {
  if (e instanceof SgwApiError) {
    return e.kind === 'schema' ? fail(name, `schema: ${e.message}`) : unknown(name, `request not possible (${e.kind})`);
  }
  return unknown(name, 'request not possible');
}

const STALE_PROBE_MS = 24 * 3_600_000;
const STALE_DETAIL = 'stale: no successful probe in 24h';
/** Detail prefix of a check failing only through sticky per-endpoint failures (T-30b: GlobalSwitches scopes by endpoint). */
export const STICKY_MARK = 'sticky schema failure';
export const SHIPPING_MARK = 'shipping-quote:';
/** Parts of a check detail that are derived on every run, never stored as a probe outcome. */
const DERIVED_MARKS = [STICKY_MARK, STALE_DETAIL, SHIPPING_MARK];

const emptyProbe = (): HealthProbe => ({
  probedAt: null,
  lastGoodProbeAt: {},
  sticky: [],
});
const checkFor = (endpoint: string): 'search-schema' | 'detail-schema' =>
  endpoint === 'search' ? 'search-schema' : 'detail-schema';
const goodKey = (name: CheckName): 'search' | 'detail' => (name === 'search-schema' ? 'search' : 'detail');

/** The probe-outcome part of a stored detail, or null when it was only derived (sticky, stale, shipping). */
function stripDerived(detail: string): string | null {
  if (DERIVED_MARKS.some((m) => detail.startsWith(m))) return null;
  const cuts = DERIVED_MARKS.map((m) => detail.indexOf(`; ${m}`)).filter((i) => i >= 0);
  return cuts.length === 0 ? detail : detail.slice(0, Math.min(...cuts));
}

interface ProbeResult {
  search: Check;
  detail: Check;
}

export class SgwHealthAdapter implements SgwHealth {
  private tail: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: SgwHealthDeps) {}

  run(mode: 'anonymous' | 'full'): Promise<HealthReport> {
    return this.serial(() => this.doRun(mode));
  }

  async last(): Promise<HealthReport | null> {
    // The local key survives a restart (a failure must keep blocking writes); the session copy is a fallback.
    return (
      (await this.deps.repo.find(STORAGE_KEYS.healthReport)) ??
      (await this.deps.repo.find(STORAGE_KEYS.runtimeHealth)) ??
      null
    );
  }

  /**
   * T-36's hook for ApiAdapterDeps.health: a reply failed its schema. The
   * failure is sticky per endpoint (cleared by recordSchemaSuccess for that
   * endpoint) and the report is written failing now, so writes fail closed.
   */
  recordSchemaFailure(f: SchemaFailure): Promise<void> {
    return this.serial(async () => {
      const now = this.deps.clock.now();
      const prev = await this.last();
      const st = await this.loadProbe();
      const sticky = st.sticky.filter((x) => x.endpoint !== f.endpoint);
      sticky.push({ endpoint: f.endpoint, at: now, detail: clip(f.message) });
      // probedAt is only set when never probed, so the next run does not probe at once; it is never refreshed.
      const next: HealthProbe = { ...st, sticky, probedAt: st.probedAt ?? now, firstSeenAt: st.firstSeenAt ?? now };
      await this.deps.repo.set(STORAGE_KEYS.healthProbe, next);
      await this.store(prev, await this.compose(prev, next, now, null, this.localFromPrev(prev)));
    });
  }

  /** A reply from `endpoint` passed its schema: clears that endpoint's sticky failure (T-36 wires this). */
  recordSchemaSuccess(endpoint: string): Promise<void> {
    return this.serial(async () => {
      const st = await this.loadProbe();
      if (!st.sticky.some((x) => x.endpoint === endpoint)) return;
      const now = this.deps.clock.now();
      const prev = await this.last();
      const next: HealthProbe = {
        ...st,
        sticky: st.sticky.filter((x) => x.endpoint !== endpoint),
      };
      await this.deps.repo.set(STORAGE_KEYS.healthProbe, next);
      await this.store(prev, await this.compose(prev, next, now, null, this.localFromPrev(prev)));
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

  private async loadProbe(): Promise<HealthProbe> {
    return (await this.deps.repo.find(STORAGE_KEYS.healthProbe)) ?? emptyProbe();
  }

  private async doRun(mode: 'anonymous' | 'full'): Promise<HealthReport> {
    const { deps } = this;
    const now = deps.clock.now();
    const prev = await this.last();
    let st = await this.loadProbe();
    if (st.firstSeenAt === undefined) {
      st = { ...st, firstSeenAt: now };
      await deps.repo.set(STORAGE_KEYS.healthProbe, st);
    }
    let probed: ProbeResult | null = null;
    if (this.probeDue(st, now, mode)) {
      probed = await this.probe();
      const good = { ...st.lastGoodProbeAt };
      if (probed.search.ok && !isUnknownCheck(probed.search)) good.search = now;
      if (probed.detail.ok && !isUnknownCheck(probed.detail)) good.detail = now;
      let sticky = st.sticky;
      // Only a FULL run may clear a sticky failure by probing, and only for the read endpoints it probed.
      if (mode === 'full') {
        sticky = sticky.filter(
          (x) =>
            !((x.endpoint === 'search' && good.search === now) || (x.endpoint === 'itemDetail' && good.detail === now)),
        );
      }
      st = { ...st, probedAt: now, lastGoodProbeAt: good, sticky };
      await deps.repo.set(STORAGE_KEYS.healthProbe, st);
    }
    const local: Check[] = [await this.cardCheck(), this.clockCheck()];
    if (mode === 'full') local.push(await this.sessionCheck());
    const report = await this.compose(prev, st, now, probed, local);
    await this.store(prev, report);
    return report;
  }

  /** probedAt is the only clock: 10 min throttle, 6 h trust for a probe whose two checks both succeeded. */
  private probeDue(st: HealthProbe, now: EpochMs, mode: 'anonymous' | 'full'): boolean {
    if (st.probedAt === null) return true;
    const age = now - st.probedAt;
    if (age < 0) return true;
    if (age < HEALTH_REPROBE_MIN_MS) return false;
    // A full run re-probes to try to clear a sticky search/detail failure, even under a good cache.
    if (mode === 'full' && st.sticky.some((x) => x.endpoint === 'search' || x.endpoint === 'itemDetail')) return true;
    const good = st.lastGoodProbeAt.search === st.probedAt && st.lastGoodProbeAt.detail === st.probedAt;
    return !(good && age < HEALTH_CACHE_TTL_MS);
  }

  private localFromPrev(prev: HealthReport | null): Check[] {
    const keep = (name: CheckName, why: string): Check =>
      prev?.checks.find((c) => c.name === name) ?? unknown(name, why);
    const out = [keep('card-selectors', 'no content-script report yet'), keep('clock', 'no clock samples')];
    const session = prev?.checks.find((c) => c.name === 'session');
    if (session !== undefined) out.push(session);
    return out;
  }

  /** Builds the report: base schema checks, then stale, sticky and shipping overlays. */
  private async compose(
    prev: HealthReport | null,
    st: HealthProbe,
    now: EpochMs,
    probed: ProbeResult | null,
    local: Check[],
  ): Promise<HealthReport> {
    const schema = (['search-schema', 'detail-schema'] as const).map((name): Check => {
      let c = this.baseCheck(name, prev, st, probed);
      const lastGood = st.lastGoodProbeAt[goodKey(name)];
      // Stale: the last good probe, or (never good) the first sighting, is over 24 h old.
      // A never-good detail check after an empty search (nothing to probe with) is exempt.
      const since = lastGood ?? st.firstSeenAt;
      const exempt = lastGood === undefined && c.detail === `${UNKNOWN_PREFIX}no item to probe`;
      if (c.ok && !exempt && since !== undefined && now - since > STALE_PROBE_MS) c = fail(name, STALE_DETAIL);
      for (const x of st.sticky.filter((y) => checkFor(y.endpoint) === name)) {
        const mark = `${STICKY_MARK}: ${x.endpoint}: ${x.detail}`;
        c = c.ok ? fail(name, mark) : { name, ok: false, detail: `${c.detail ?? 'schema'}; ${mark}` };
      }
      return c;
    });
    const checks = [...schema, ...local];
    const problem = await this.shippingProblem();
    if (problem !== null) {
      const i = checks.findIndex((c) => c.name === 'detail-schema');
      const existing = checks[i];
      checks[i] =
        existing !== undefined && !existing.ok
          ? {
              name: 'detail-schema',
              ok: false,
              detail: `${existing.detail ?? 'schema'}; ${SHIPPING_MARK} ${problem}`,
            }
          : fail('detail-schema', `${SHIPPING_MARK} ${problem}`);
    }
    return {
      ok: checks.every((c) => c.ok),
      checkedAt: now,
      configVersion: this.deps.configVersion ?? SGW_CONFIG_VERSION,
      checks: sortChecks(checks),
    };
  }

  /** This run's probe outcome, else the outcome kept in the previous report, else the last good probe, else unknown. */
  private baseCheck(name: CheckName, prev: HealthReport | null, st: HealthProbe, probed: ProbeResult | null): Check {
    if (probed !== null) return name === 'search-schema' ? probed.search : probed.detail;
    const stored = prev?.checks.find((c) => c.name === name);
    if (stored !== undefined) {
      if (stored.detail === undefined) return stored;
      const head = stripDerived(stored.detail);
      if (head !== null) return { ...stored, detail: head };
    }
    const good = st.lastGoodProbeAt[goodKey(name)];
    if (good !== undefined && good === st.probedAt) return pass(name);
    return unknown(name, 'not probed yet');
  }

  /** At most one search and one item detail. */
  private async probe(): Promise<ProbeResult> {
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
    return { search, detail };
  }

  private async cardCheck(): Promise<Check> {
    let r: DomDriftReport | null;
    try {
      r = await this.deps.domReport();
    } catch {
      r = null;
    }
    if (r === null) return unknown('card-selectors', 'no content-script report yet');
    // Never a failure: favorites and bids use the API, and the overlay pauses itself on drift.
    if (r.drifted) {
      return unknown(
        'card-selectors',
        `selector drift (fallback rank ${String(r.rank)}, ${String(r.unreadable)} unreadable, config ${r.configVersion})`,
      );
    }
    if (r.count === 0) return unknown('card-selectors', 'no cards parsed on the reported page');
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

  /** R1: format-check the newest cached quote reply; the problem text, or null when fine or absent. */
  private async shippingProblem(): Promise<string | null> {
    if (this.deps.shippingReply === undefined) return null;
    let raw: unknown;
    try {
      raw = await this.deps.shippingReply();
    } catch {
      return null;
    }
    if (raw === undefined || raw === null) return null;
    try {
      return normalizeShippingQuote(raw) === null ? 'cached reply no longer parses (unparseable quote)' : null;
    } catch (e) {
      return e instanceof SgwApiError ? e.message : 'cached reply failed its schema';
    }
  }

  private async store(prev: HealthReport | null, report: HealthReport): Promise<void> {
    await this.deps.repo.set(STORAGE_KEYS.healthReport, report);
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
            detail: failing
              .map((c) => c.detail ?? c.name)
              .join(' | ')
              .slice(0, MAX_DETAIL_CHARS),
          },
        });
      } else if (report.ok && wasOk === false) {
        await this.deps.audit.append({
          actor: 'health',
          kind: 'health.recovered',
          details: {},
        });
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
