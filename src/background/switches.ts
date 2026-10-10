// T-36: GlobalSwitches (PLAN §3.10, port src/ports/global-switches.ts), the one
// answer to "may we write to the user's SGW account / calendar now?".
//
// writesAllowed(feature) is false when any of these holds (§3.3 fail-closed
// rule, plus the T-33 carry), checked in this order:
//   - the snapshot is not loaded yet (startup);
//   - storage needs repair: migrate() reported meta-corrupt, or failed;
//   - the kill switch is on;
//   - dryRun[feature] is on;
//   - health: the last HealthReport within 24 h has ok === false, or an SGW
//     reply just failed its schema and T-30 has not stored that yet;
//   - the SGW session is neither 'ok' nor 'expiring' (expiring still writes, I-08).
//
// It is an in-memory snapshot (T-26 carry): writesAllowed() reads no storage
// and calls no browser or session API, because T-26 asks it about twice a
// second for every queued write and an answer slower than 1 s makes the write
// give up as `lane-busy`. The snapshot is loaded once at startup (after
// migrate) and then follows storage.onChanged (`sbw:settings`,
// `sbw:healthReport`, `sbw:runtimeHealth`, `sbw:sgwSession`,
// `sbw:sgwSessionRejection`) plus direct notes from the handlers. Changes
// that arrive while it loads are applied after the load, in order.
//
// The kill switch (R3) is immediate in memory: setKill() flips the verdict
// before it persists `settings.killSwitch`, so a crash mid-persist still blocks
// writes until restart. A failed persist of "on" keeps it on in memory; a
// failed "off" falls back to the stored value. On restart the persisted value
// is loaded before any handler serves (main.ts awaits load()).
//
// Session changes fail closed first: a removed session is 'logged-out' at once,
// a new rejection is 'expired' at once, and a newly stored token only unblocks
// once the SessionAdapter confirms it. Time alone expires a session too
// (expiresAt is kept in the snapshot).
import type { SchemaFailure } from '../adapters/sgw/api-adapter';
import { SGW_CONFIG_VERSION } from '../adapters/sgw/config';
import type { AuditLog } from '../domain/audit/types';
import { defaultSettings } from '../domain/settings/defaults';
import { SettingsSchema, type Settings } from '../domain/settings/schema';
import type { Repo } from '../domain/storage/repo';
import { STORAGE_KEYS } from '../domain/storage/schema';
import {
  HealthReportSchema,
  SgwSessionRecordSchema,
  type EpochMs,
  type HealthReport,
  type SgwSessionState,
} from '../domain/types';
import type { Clock } from '../ports/clock';
import type { GlobalSwitches } from '../ports/global-switches';
import type { SgwSession } from '../ports/sgw-session';
import type { StorageAreas } from '../ports/storage';
import { errorText, withTimeout } from './context';

export const WRITE_FEATURES = ['favorites', 'calendar', 'bidding'] as const;
export type WriteFeature = (typeof WRITE_FEATURES)[number];

/** A failing HealthReport blocks writes for this long after its checkedAt. */
export const HEALTH_WINDOW_MS = 24 * 60 * 60 * 1000;
/** The startup load fails closed (and is retried) when storage takes longer than this. */
export const SWITCHES_LOAD_TIMEOUT_MS = 5_000;
/** A failed load or session re-check is retried after this long. */
export const SWITCHES_RETRY_MS = 30_000;
/** Most storage changes held while the snapshot loads. */
const MAX_QUEUED_CHANGES = 200;

/** The `why` texts (stable: the UI and the audit log show them). */
export const WHY = {
  starting: 'starting: the switch state is not loaded yet',
  kill: 'kill switch is on',
  dryRun: 'dry run',
  health: 'health check failed',
  storage: (reason: string): string => `storage needs repair: ${reason}`,
  session: (state: string): string => `SGW session is ${state}`,
} as const;

export interface SwitchesView {
  killSwitch: boolean;
  writesAllowed: Record<WriteFeature, boolean>;
}

export interface Verdict {
  ok: boolean;
  why?: string;
}

export interface SwitchesDeps {
  clock: Clock;
  /** Followed through onChanged only. */
  storage: StorageAreas;
  repo: Repo;
  session: Pick<SgwSession, 'state'>;
  audit: Pick<AuditLog, 'append'>;
  log: (message: string, error: unknown) => void;
}

type Changes = Record<string, { oldValue?: unknown; newValue?: unknown }>;
type SessionSnapshot = { state: SgwSessionState | 'being checked'; expiresAt: EpochMs | null };

const SESSION_KEYS: readonly string[] = [STORAGE_KEYS.sgwSession, STORAGE_KEYS.sgwSessionRejection];
const HEALTH_KEYS: readonly string[] = [STORAGE_KEYS.healthReport, STORAGE_KEYS.runtimeHealth];

export class Switches implements GlobalSwitches {
  private isLoaded = false;
  private mirror: Settings | undefined;
  private killStored = false;
  /** An in-memory kill decision not yet confirmed by storage. */
  private killOverride: boolean | undefined;
  private killSeq = 0;
  /** Successful kill persists, so a load that read storage before one does not undo it. */
  private killWrites = 0;
  private dryRun: Settings['dryRun'] = { favorites: true, calendar: true, bidding: true };
  private lastReport: HealthReport | null = null;
  /** A schema failure flagged by the API that no stored report reflects yet. */
  private pendingSchemaFailure: SchemaFailure | null = null;
  private problem: { reason: string; at: EpochMs } | null = null;
  private session: SessionSnapshot = { state: 'logged-out', expiresAt: null };
  private sessionGen = 0;
  private loadGen = 0;
  private queued: Array<{ area: 'local' | 'session'; changes: Changes }> | undefined = [];
  private timers = new Set<number>();
  private migratedResolve!: () => void;
  private readonly migrated = new Promise<void>((resolve) => {
    this.migratedResolve = resolve;
  });
  private readonly changeListeners = new Set<(view: SwitchesView) => void>();
  private readonly settingsListeners = new Set<(settings: Settings) => void>();
  private lastViewKey = '';
  private readonly unsubscribe: Array<() => void>;

  constructor(private readonly deps: SwitchesDeps) {
    this.unsubscribe = [
      deps.storage.local.onChanged((changes) => {
        this.onStorage('local', changes);
      }),
      deps.storage.session.onChanged((changes) => {
        this.onStorage('session', changes);
      }),
    ];
    this.lastViewKey = JSON.stringify(this.view());
  }

  // ── GlobalSwitches ────────────────────────────────────────────────────

  /** In memory only: no storage, session or browser call. */
  writesAllowed(feature: WriteFeature): Promise<{ ok: boolean; why?: string }> {
    return Promise.resolve(this.verdict(feature));
  }

  /** The synchronous answer behind writesAllowed. */
  verdict(feature: WriteFeature): Verdict {
    if (!this.isLoaded) return { ok: false, why: WHY.starting };
    if (this.problem !== null) return { ok: false, why: WHY.storage(this.problem.reason) };
    if (this.killSwitchOn()) return { ok: false, why: WHY.kill };
    if (this.dryRun[feature]) return { ok: false, why: WHY.dryRun };
    const now = this.deps.clock.now();
    if (this.healthFailing(now)) return { ok: false, why: WHY.health };
    const { state, expiresAt } = this.session;
    if (state !== 'ok' && state !== 'expiring') return { ok: false, why: WHY.session(state) };
    if (expiresAt !== null && expiresAt <= now) return { ok: false, why: WHY.session('expired') };
    return { ok: true };
  }

  // ── Snapshot ──────────────────────────────────────────────────────────

  get loaded(): boolean {
    return this.isLoaded;
  }

  /** What `switches.changed` broadcasts. */
  view(): SwitchesView {
    const writesAllowed = {} as Record<WriteFeature, boolean>;
    for (const f of WRITE_FEATURES) writesAllowed[f] = this.verdict(f).ok;
    return { killSwitch: this.killSwitchOn(), writesAllowed };
  }

  /** The last known settings (undefined before the load). */
  settings(): Settings | undefined {
    return this.mirror;
  }

  /**
   * The report health.get shows: a failing one while storage needs repair
   * (the frozen reply has no storage field), else the last stored report.
   */
  healthReport(): HealthReport | null {
    if (this.problem === null) return this.lastReport;
    return {
      ok: false,
      checkedAt: this.problem.at,
      configVersion: SGW_CONFIG_VERSION,
      checks: this.lastReport?.checks ?? [],
    };
  }

  /** Why writes are blocked for storage reasons, or null. */
  storageProblem(): string | null {
    return this.problem?.reason ?? null;
  }

  /** Called by main.ts once migrate() has finished (or failed); writes to storage wait for this. */
  markMigrated(storageProblem: string | null): void {
    if (storageProblem !== null) this.problem = { reason: storageProblem, at: this.deps.clock.now() };
    this.migratedResolve();
    this.changed();
  }

  /**
   * Loads the snapshot (after migrate). Never throws: a failure or a storage
   * that does not answer within SWITCHES_LOAD_TIMEOUT_MS leaves writes blocked
   * and retries after SWITCHES_RETRY_MS. Resolves whether it loaded.
   */
  async load(): Promise<boolean> {
    const gen = ++this.loadGen;
    const killWrites = this.killWrites;
    let data: Awaited<ReturnType<Switches['read']>>;
    try {
      data = await withTimeout(this.deps.clock, this.read(), SWITCHES_LOAD_TIMEOUT_MS, 'the switch state');
    } catch (e) {
      this.deps.log('switches: loading the snapshot failed; writes stay blocked and the load is retried', e);
      if (gen === this.loadGen) this.later(() => void this.load());
      return false;
    }
    if (gen !== this.loadGen || this.isLoaded) return this.isLoaded;
    // A kill persisted while this load was reading is newer than what it read.
    this.applySettings(data.settings, this.killWrites !== killWrites);
    for (const r of data.reports) if (r !== undefined) this.noteHealthReport(r);
    this.session = { state: data.state, expiresAt: data.expiresAt };
    this.isLoaded = true;
    const queued = this.queued ?? [];
    this.queued = undefined;
    for (const q of queued) this.applyChanges(q.area, q.changes);
    this.changed();
    return true;
  }

  private async read() {
    const { repo, session } = this.deps;
    const settings = await repo.get(STORAGE_KEYS.settings);
    const reports = [await repo.find(STORAGE_KEYS.healthReport), await repo.find(STORAGE_KEYS.runtimeHealth)];
    const state = await session.state();
    const expiresAt = (await repo.find(STORAGE_KEYS.sgwSession))?.expiresAt ?? null;
    return { settings, reports, state, expiresAt };
  }

  // ── Notes from the handlers and the API ───────────────────────────────

  /** Settings just written (settings.set): applied now rather than when onChanged arrives. */
  noteSettings(settings: Settings): void {
    this.applySettings(settings);
    this.changed();
  }

  /** A HealthReport (from a run, or stored by T-30). The newest by checkedAt wins. */
  noteHealthReport(report: HealthReport): void {
    if (this.lastReport === null || report.checkedAt >= this.lastReport.checkedAt) this.lastReport = report;
    // T-30 has stored a report at or after the flagged failure: the report now speaks for it.
    if (this.pendingSchemaFailure !== null && report.checkedAt >= this.pendingSchemaFailure.at) this.pendingSchemaFailure = null;
    this.changed();
  }

  /**
   * An SGW reply failed its schema (T-26 flagSchemaFailure). Writes fail closed
   * at once; T-30's recordSchemaFailure stores the sticky failure, and the
   * report it writes takes over (see noteHealthReport).
   */
  flagSchemaFailure(f: SchemaFailure): void {
    this.pendingSchemaFailure = f;
    this.changed();
  }

  // ── Kill switch (R3) ──────────────────────────────────────────────────

  /**
   * Flips the kill switch in memory now, then (after migrate) persists
   * `settings.killSwitch` and audits `kill.on` / `kill.off`. Rejects if the
   * persist failed: "on" stays on in memory regardless (fail closed).
   */
  async setKill(on: boolean, source: string): Promise<void> {
    const seq = ++this.killSeq;
    this.killOverride = on;
    this.changed();
    await this.migrated;
    let failure: unknown;
    try {
      await this.deps.repo.update(STORAGE_KEYS.settings, (s) => ({ ...s, killSwitch: on }));
      this.killStored = on;
      this.killWrites += 1;
      if (seq === this.killSeq) this.killOverride = undefined;
    } catch (e) {
      failure = e;
      // "on" stays in memory until restart; a failed "off" falls back to what is stored.
      if (!on && seq === this.killSeq) this.killOverride = undefined;
    }
    this.changed();
    try {
      await this.deps.audit.append({
        actor: 'user',
        kind: on ? 'kill.on' : 'kill.off',
        details: failure === undefined ? { source } : { source, persisted: false },
      });
    } catch (e) {
      this.deps.log('switches: could not audit the kill switch', e);
    }
    if (failure !== undefined) throw failure instanceof Error ? failure : new Error(errorText(failure));
  }

  // ── Subscriptions ─────────────────────────────────────────────────────

  /** Called with the new view whenever it changes (kill, dry-run, health, session, load). */
  onChange(cb: (view: SwitchesView) => void): () => void {
    this.changeListeners.add(cb);
    return () => {
      this.changeListeners.delete(cb);
    };
  }

  /** Called with the new settings whenever they change. */
  onSettings(cb: (settings: Settings) => void): () => void {
    this.settingsListeners.add(cb);
    return () => {
      this.settingsListeners.delete(cb);
    };
  }

  dispose(): void {
    for (const off of this.unsubscribe) off();
    for (const t of this.timers) this.deps.clock.clearTimeout(t);
    this.timers.clear();
  }

  // ── internals ─────────────────────────────────────────────────────────

  private killSwitchOn(): boolean {
    return this.killOverride ?? this.killStored;
  }

  private healthFailing(now: EpochMs): boolean {
    if (this.pendingSchemaFailure !== null) return true;
    const r = this.lastReport;
    // A checkedAt in the future (the clock moved back) still counts: fail closed.
    return r !== null && !r.ok && now - r.checkedAt < HEALTH_WINDOW_MS;
  }

  private applySettings(settings: Settings, keepKill = false): void {
    const before = this.mirror === undefined ? '' : JSON.stringify(this.mirror);
    if (keepKill) settings = { ...settings, killSwitch: this.killStored };
    this.mirror = settings;
    this.killStored = settings.killSwitch;
    this.dryRun = { ...settings.dryRun };
    if (JSON.stringify(settings) === before) return;
    for (const cb of [...this.settingsListeners]) {
      try {
        cb(settings);
      } catch (e) {
        this.deps.log('switches: a settings listener threw', e);
      }
    }
  }

  private onStorage(area: 'local' | 'session', changes: Changes): void {
    if (this.queued !== undefined) {
      this.queued.push({ area, changes });
      if (this.queued.length > MAX_QUEUED_CHANGES) this.queued.shift();
      return;
    }
    this.applyChanges(area, changes);
    this.changed();
  }

  private applyChanges(area: 'local' | 'session', changes: Changes): void {
    for (const [key, change] of Object.entries(changes)) {
      if (area === 'local' && key === STORAGE_KEYS.settings) this.settingsChanged(change.newValue);
      else if (area === 'local' && SESSION_KEYS.includes(key)) this.sessionChanged(key, change.newValue);
      else if (HEALTH_KEYS.includes(key) && STORAGE_AREA_OF[key] === area) {
        const parsed = HealthReportSchema.safeParse(change.newValue);
        if (parsed.success) this.noteHealthReport(parsed.data);
      }
    }
  }

  private settingsChanged(value: unknown): void {
    const parsed = SettingsSchema.safeParse(value);
    // Removed or invalid (the repo quarantines it): defaults, which have every dry-run on;
    // the kill switch keeps its last known value rather than turning off.
    this.applySettings(parsed.success ? parsed.data : { ...defaultSettings(), killSwitch: this.killStored });
  }

  private sessionChanged(key: string, value: unknown): void {
    if (key === STORAGE_KEYS.sgwSession) {
      if (value === undefined) {
        this.session = { state: 'logged-out', expiresAt: null };
      } else {
        const rec = SgwSessionRecordSchema.safeParse(value);
        // Keep the current verdict until the adapter confirms the new token (a usable one stays usable).
        if (rec.success) this.session = { ...this.session, expiresAt: rec.data.expiresAt };
        else this.session = { state: 'being checked', expiresAt: null };
      }
    } else if (value !== undefined && this.session.state !== 'logged-out') {
      this.session = { ...this.session, state: 'expired' }; // a new rejection: SGW refused the held token
    }
    void this.refreshSession();
  }

  /** Re-reads the session state through the adapter; a failure blocks and retries. */
  private async refreshSession(): Promise<void> {
    const gen = ++this.sessionGen;
    try {
      const state = await this.deps.session.state();
      const expiresAt = (await this.deps.repo.find(STORAGE_KEYS.sgwSession))?.expiresAt ?? null;
      if (gen !== this.sessionGen) return;
      this.session = { state, expiresAt };
    } catch (e) {
      if (gen !== this.sessionGen) return;
      this.deps.log('switches: reading the SGW session failed; writes stay blocked until it can be read', e);
      this.session = { state: 'being checked', expiresAt: null };
      this.later(() => void this.refreshSession());
    }
    this.changed();
  }

  private later(fn: () => void): void {
    const t = this.deps.clock.setTimeout(() => {
      this.timers.delete(t);
      fn();
    }, SWITCHES_RETRY_MS);
    this.timers.add(t);
  }

  /** Notifies onChange subscribers when the view differs from the last one notified. */
  private changed(): void {
    const view = this.view();
    const key = JSON.stringify(view);
    if (key === this.lastViewKey) return;
    this.lastViewKey = key;
    for (const cb of [...this.changeListeners]) {
      try {
        cb(view);
      } catch (e) {
        this.deps.log('switches: a change listener threw', e);
      }
    }
  }
}

const STORAGE_AREA_OF: Readonly<Record<string, 'local' | 'session'>> = {
  [STORAGE_KEYS.healthReport]: 'local',
  [STORAGE_KEYS.runtimeHealth]: 'session',
};
