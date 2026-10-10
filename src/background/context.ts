// T-36: BackgroundContext, the one object every background module receives
// through `register(ctx)` (I-01), plus the small runtime pieces it is made of.
//
// main.ts builds exactly one of each port and adapter and puts them here; it is
// frozen after T-36. A later card adds a handler or job as its own module under
// src/background/handlers/ or src/background/jobs/ exporting
// `register(ctx: BackgroundContext)`; the glob registries in those folders'
// index.ts load it. Nothing else needs editing.
//
// Wake events (MV3). Chrome only delivers the event that woke the service
// worker to listeners added in its first turn, and register(ctx) runs after
// the asynchronous startup (migrate, switches, scheduler). So main.ts adds the
// browser listeners itself at top level, and modules subscribe through the
// context instead: `ctx.alarms.onAlarm`, `ctx.notifier.onAction`,
// `ctx.permissions.onRemoved`, `ctx.lifecycle.*` and `ctx.ports.serve`. Events
// that arrive before startup finishes are held and replayed, in arrival order,
// once every module has registered. Never add those browser listeners directly
// in a module.
import type { SchemaFailure, SgwApiAdapter } from '../adapters/sgw/api-adapter';
import type { DiscoveryReport } from '../adapters/sgw/dom-adapter';
import type { SgwRequestScheduler } from '../adapters/sgw/request-scheduler';
import type { PkceRefreshProvider } from '../adapters/google/auth-pkce';
import type { AuditLog } from '../domain/audit/types';
import type { Settings } from '../domain/settings/schema';
import type { MigrateResult } from '../domain/storage/migrations';
import type { Repo } from '../domain/storage/repo';
import type { EpochMs, ItemDetail, ItemId, Listing } from '../domain/types';
import type { MsgBroadcastType, MsgPayload } from '../messaging/protocol';
import type { Alarms } from '../ports/alarms';
import type { CalendarApi } from '../ports/calendar';
import type { Clock } from '../ports/clock';
import type { Http } from '../ports/http';
import type { KeepAlive } from '../ports/keep-alive';
import type { KeepAwake } from '../ports/keep-awake';
import type { Notifier } from '../ports/notifier';
import type { Permissions } from '../ports/permissions';
import type { SgwClock } from '../ports/sgw-clock';
import type { SgwHealth } from '../ports/sgw-health';
import type { SgwSession } from '../ports/sgw-session';
import type { StorageAreas } from '../ports/storage';
import type { HandlerContext, Router } from './router';
import type { Switches } from './switches';

// ── The context ─────────────────────────────────────────────────────────────

export interface BackgroundContext {
  // Ports: one instance each.
  readonly clock: Clock;
  readonly storage: StorageAreas;
  readonly http: Http;
  /** `onAlarm` is served from the top-level listener; alarms before ready are replayed. */
  readonly alarms: Alarms;
  /** `onAction` is served from the top-level listener; actions before ready are replayed. */
  readonly notifier: Notifier;
  /** `onRemoved` is served from the top-level listener. */
  readonly permissions: Permissions;
  readonly keepAwake: KeepAwake;
  readonly keepAlive: KeepAlive;

  // Domain services.
  readonly repo: Repo;
  readonly audit: AuditLog;

  // SGW (single instances: the scheduler and the session assume they are alone).
  readonly scheduler: SgwRequestScheduler;
  readonly api: SgwApiAdapter;
  readonly session: SgwSession;
  /**
   * The one server-clock estimator. Samples built by the API (ItemDetail
   * serverTime, GetCurrentTime) are added automatically; adding the sample
   * `api.serverTimeSample()` returned again is a no-op.
   */
  readonly sgwClock: SgwClock;
  /** T-30's health check. Every `run()` report also updates the switches at once. */
  readonly health: BackgroundHealth;

  // Google.
  readonly google: PkceRefreshProvider;
  /** Built over `google.authorizedHttp(http)`, so a 401 refreshes once (T-62). */
  readonly calendarApi: CalendarApi;
  /** Raised by the Google provider when the user must reconnect (the badge owner, T-86, subscribes). */
  readonly googleNeedsInteraction: Flag;

  // Background services.
  /** GlobalSwitches: kill switch, dry-run, health and session gating (in memory). */
  readonly switches: Switches;
  /** Message handlers: `ctx.router.register(type, handler)`. */
  readonly router: Pick<Router, 'register'>;
  /** runtime.onConnect streams by port name. Ports with names nobody serves are left alone. */
  readonly ports: PortRegistry;
  readonly lifecycle: Lifecycle;
  /** The scheduler tick (T-52 drives it on `sbw:tick`; other jobs subscribe). */
  readonly ticks: TickHub;
  readonly interceptors: { readonly settingsSet: SettingsSetInterceptors };
  /** What content scripts last reported, per tab (memory only). */
  readonly pages: PageStore;
  /** Sends a background → UI/content broadcast. Never rejects. */
  broadcast<K extends MsgBroadcastType>(type: K, ...payload: BroadcastPayload<K>): Promise<void>;
  readonly startup: StartupInfo;
}

export type BroadcastPayload<K extends MsgBroadcastType> = MsgPayload<K> extends undefined ? [] : [payload: MsgPayload<K>];

export interface StartupInfo {
  /** null when migrate() threw (see storageProblem). */
  readonly migration: MigrateResult | null;
  /** Why writes are blocked for storage reasons (meta-corrupt, too new, migration failure), or null. */
  readonly storageProblem: string | null;
  readonly registered: RegistrationReport;
}

// ── Self-registration (I-01) ────────────────────────────────────────────────

export interface BackgroundModule {
  register?: (ctx: BackgroundContext) => void;
}

/** As `import.meta.glob(..., { eager: true })` returns it: `./file.ts` → module. */
export type ModuleMap = Readonly<Record<string, BackgroundModule>>;

export interface RegistrationFailure {
  kind: 'handlers' | 'jobs';
  file: string;
  error: string;
}

export interface RegistrationReport {
  handlers: string[];
  jobs: string[];
  failed: RegistrationFailure[];
}

/**
 * Calls `register(ctx)` on every module, in file-name order. A module without
 * `register`, or one whose register throws, is recorded in `failed` and the
 * others still register: one broken feature must not take the background down.
 */
export function registerModules(
  kind: RegistrationFailure['kind'],
  modules: ModuleMap,
  ctx: BackgroundContext,
  report: RegistrationReport,
): void {
  for (const [file, mod] of Object.entries(modules).sort(([a], [b]) => a.localeCompare(b))) {
    if (typeof mod.register !== 'function') {
      report.failed.push({ kind, file, error: 'module does not export register(ctx)' });
      continue;
    }
    try {
      mod.register(ctx);
      report[kind].push(file);
    } catch (e) {
      report.failed.push({ kind, file, error: e instanceof Error ? e.message : String(e) });
    }
  }
}

// ── Wake-event replay ───────────────────────────────────────────────────────

/** Most events held while starting; older ones are dropped beyond this. */
export const MAX_HELD_EVENTS = 200;

/**
 * Holds deliveries until `open()`, then runs them in arrival order; after that
 * deliveries run at once. One gate is shared by every channel, so replay keeps
 * the order events arrived in across alarms, ports and lifecycle events.
 */
export class EventGate {
  private held: Array<() => void> | undefined = [];

  constructor(private readonly log: (message: string, error: unknown) => void) {}

  get isOpen(): boolean {
    return this.held === undefined;
  }

  deliver(fn: () => void): void {
    if (this.held === undefined) {
      this.run(fn);
      return;
    }
    this.held.push(fn);
    if (this.held.length > MAX_HELD_EVENTS) this.held.shift();
  }

  open(): void {
    const held = this.held ?? [];
    this.held = undefined;
    for (const fn of held) this.run(fn);
  }

  private run(fn: () => void): void {
    try {
      fn();
    } catch (e) {
      this.log('background: an event subscriber threw', e);
    }
  }
}

/** A subscribable event whose deliveries go through an EventGate. */
export class Channel<A extends unknown[]> {
  private readonly subscribers = new Set<(...args: A) => void>();

  constructor(private readonly gate: EventGate) {}

  emit(...args: A): void {
    this.gate.deliver(() => {
      for (const cb of [...this.subscribers]) cb(...args);
    });
  }

  on(cb: (...args: A) => void): () => void {
    this.subscribers.add(cb);
    return () => {
      this.subscribers.delete(cb);
    };
  }
}

/** The slice of runtime.Port the background uses. */
export interface RuntimePort {
  readonly name: string;
  readonly sender?: { readonly id?: string; readonly url?: string; readonly tab?: unknown };
  postMessage(message: unknown): void;
  disconnect(): void;
  readonly onMessage: { addListener(l: (message: unknown) => void): void; removeListener(l: (message: unknown) => void): void };
  readonly onDisconnect: { addListener(l: () => void): void; removeListener(l: () => void): void };
}

export type PortHandler = (port: RuntimePort) => void;

export interface PortRegistry {
  /** Serves ports opened with `name`. Throws if the name is already served. Returns an unregister function. */
  serve(name: string, handler: PortHandler): () => void;
}

/** Dispatches connected ports by name; a name nobody serves (e.g. a test hook's) is ignored, never disconnected. */
export function createPortRegistry(connections: Channel<[RuntimePort]>): PortRegistry {
  const handlers = new Map<string, PortHandler>();
  connections.on((port) => {
    handlers.get(port.name)?.(port);
  });
  return {
    serve(name, handler) {
      if (handlers.has(name)) throw new Error(`port "${name}" is already served`);
      handlers.set(name, handler);
      return () => {
        if (handlers.get(name) === handler) handlers.delete(name);
      };
    },
  };
}

export interface InstalledDetails {
  reason: string;
  previousVersion?: string;
}

export interface Lifecycle {
  /** runtime.onStartup (browser start). */
  onStartup(cb: () => void): () => void;
  /** runtime.onInstalled (install, update). */
  onInstalled(cb: (details: InstalledDetails) => void): () => void;
}

// ── Tick hub ────────────────────────────────────────────────────────────────

export type TickCallback = () => void | Promise<void>;

export interface TickHub {
  /** Runs `cb` on every scheduler tick. Returns an unsubscribe function. */
  onTick(cb: TickCallback): () => void;
  /** Called by the tick owner (T-52) once per tick: runs every callback in turn; a failure is logged, never thrown. */
  tick(): Promise<void>;
}

export function createTickHub(log: (message: string, error: unknown) => void): TickHub {
  const callbacks = new Set<TickCallback>();
  return {
    onTick(cb) {
      callbacks.add(cb);
      return () => {
        callbacks.delete(cb);
      };
    },
    async tick() {
      for (const cb of [...callbacks]) {
        try {
          await cb();
        } catch (e) {
          log('background: a tick callback failed', e);
        }
      }
    },
  };
}

// ── Flag ────────────────────────────────────────────────────────────────────

export interface Flag {
  get(): boolean;
  set(on: boolean): void;
  /** Called with the new value on every change. */
  subscribe(cb: (on: boolean) => void): () => void;
}

export function createFlag(initial = false): Flag {
  let value = initial;
  const subscribers = new Set<(on: boolean) => void>();
  return {
    get: () => value,
    set(on) {
      if (on === value) return;
      value = on;
      for (const cb of [...subscribers]) cb(on);
    },
    subscribe(cb) {
      subscribers.add(cb);
      return () => {
        subscribers.delete(cb);
      };
    },
  };
}

// ── settings.set interceptors ───────────────────────────────────────────────

export interface SettingsSetChange {
  /** What the sender asked for (killSwitch is never applied: kill.set owns it). */
  readonly patch: Partial<Settings>;
  readonly current: Settings;
  /** What would be stored. */
  readonly next: Settings;
  readonly sender: HandlerContext;
}

/** `{ veto }` refuses the write with that message; `undefined` lets it through. */
export type SettingsSetVerdict = { veto: string } | undefined;

/**
 * Runs inside the settings write lock, before the write. Return `{ veto }` to
 * refuse the write with that message, or `undefined` to allow it; a throw also
 * refuses it (fail closed). It must not write `sbw:settings` itself (that
 * would wait on its own lock).
 */
export type SettingsSetInterceptor = (change: SettingsSetChange) => SettingsSetVerdict | Promise<SettingsSetVerdict>;

export class SettingsVetoError extends Error {
  override readonly name = 'SettingsVetoError';
}

export interface InterceptorList<F> {
  /** Adds an interceptor. Returns a function that removes it. */
  add(fn: F): () => void;
}

export class SettingsSetInterceptors implements InterceptorList<SettingsSetInterceptor> {
  private readonly list: SettingsSetInterceptor[] = [];

  add(fn: SettingsSetInterceptor): () => void {
    this.list.push(fn);
    return () => {
      const i = this.list.indexOf(fn);
      if (i >= 0) this.list.splice(i, 1);
    };
  }

  /** Throws SettingsVetoError on the first veto, in the order interceptors were added. */
  async check(change: SettingsSetChange): Promise<void> {
    for (const fn of [...this.list]) {
      let verdict: SettingsSetVerdict;
      try {
        verdict = await fn(change);
      } catch (e) {
        throw new SettingsVetoError(e instanceof Error ? e.message : String(e), { cause: e });
      }
      if (verdict !== undefined) throw new SettingsVetoError(verdict.veto);
    }
  }
}

// ── Page store ──────────────────────────────────────────────────────────────

/** The last `page.listings` of one tab. */
export interface PageSnapshot {
  tabId: number | undefined;
  url: string;
  listings: Listing[];
  capturedAt: EpochMs;
  receivedAt: EpochMs;
}

/** A content script's card-selector report (`page.domHealth`), as kept for the health check. */
export interface DomHealthReport {
  url: string;
  configVersion: string;
  pageKind: string;
  cardsFound: number;
  fallbackUsed: boolean;
  tabId: number | undefined;
  /** When the background received it. */
  at: EpochMs;
}

/** Tabs remembered; the least recently reporting one goes first. */
export const PAGE_STORE_MAX_TABS = 20;
/** Item details remembered (from `page.detail`). */
export const PAGE_STORE_MAX_DETAILS = 100;

/**
 * In-memory record of what SGW pages reported. Lost on a worker restart (a
 * page reports again on its next render); nothing here is persisted.
 */
export class PageStore {
  private readonly pages = new Map<number | undefined, PageSnapshot>();
  private readonly dom = new Map<number | undefined, DomHealthReport>();
  private readonly details = new Map<ItemId, ItemDetail>();

  recordListings(snapshot: PageSnapshot): void {
    remember(this.pages, snapshot.tabId, snapshot, PAGE_STORE_MAX_TABS);
  }

  /** The tab's last listings, else the most recent SGW page's (I-08); undefined when no page reported. */
  listingsFor(tabId?: number): PageSnapshot | undefined {
    if (tabId !== undefined) {
      const own = this.pages.get(tabId);
      if (own !== undefined) return own;
    }
    return last(this.pages);
  }

  recordDetail(detail: ItemDetail): void {
    remember(this.details, detail.itemId, detail, PAGE_STORE_MAX_DETAILS);
  }

  /** The newest data seen for an item: its detail, else a listing (most recent page first). */
  findItem(itemId: ItemId): Listing | undefined {
    const detail = this.details.get(itemId);
    if (detail !== undefined) return detail;
    for (const page of [...this.pages.values()].reverse()) {
      const hit = page.listings.find((l) => l.itemId === itemId);
      if (hit !== undefined) return hit;
    }
    return undefined;
  }

  recordDomHealth(report: DomHealthReport): void {
    remember(this.dom, report.tabId, report, PAGE_STORE_MAX_TABS);
  }

  /** The latest card-selector report across tabs (T-30's `domReport()`), or null. */
  domReport(): DomHealthReport | null {
    return last(this.dom) ?? null;
  }

  /** The latest card-selector report per tab. */
  domReports(): DomHealthReport[] {
    return [...this.dom.values()];
  }

  /** Tabs that reported anything (for broadcasts). */
  tabIds(): number[] {
    const ids = new Set<number>();
    for (const map of [this.pages, this.dom]) for (const id of map.keys()) if (id !== undefined) ids.add(id);
    return [...ids];
  }
}

/** Moves `key` to the newest position and evicts the oldest beyond `max`. */
function remember<K, V>(map: Map<K, V>, key: K, value: V, max: number): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > max) {
    const oldest = map.keys().next();
    if (oldest.done === true) break;
    map.delete(oldest.value);
  }
}

function last<K, V>(map: Map<K, V>): V | undefined {
  let out: V | undefined;
  for (const v of map.values()) out = v;
  return out;
}

/** `sender.tab.id` of a content message, when there is one. */
export function tabIdOf(sender: { tab?: unknown }): number | undefined {
  const tab = sender.tab;
  if (typeof tab !== 'object' || tab === null) return undefined;
  const id = (tab as { id?: unknown }).id;
  return typeof id === 'number' && Number.isInteger(id) ? id : undefined;
}

// ── Health (T-30) ───────────────────────────────────────────────────────────

/** `ctx.health`: T-30's SgwHealth, plus its per-endpoint schema hooks (wired from the API adapter by main.ts). */
export interface BackgroundHealth extends SgwHealth {
  /** A reply failed its schema: sticky per endpoint until that endpoint answers validly. */
  recordSchemaFailure(f: SchemaFailure): Promise<void>;
  /** A reply from `endpoint` passed its schema: clears that endpoint's sticky failure. */
  recordSchemaSuccess(endpoint: string): Promise<void>;
}

/**
 * The frozen `page.domHealth` payload as T-30's DomAdapter DiscoveryReport.
 * The message carries no strategy rank or unreadable count, so: `drifted` is
 * `fallbackUsed`; `rank` is 1 for a fallback, 0 for the primary strategy, null
 * when no card was found; `unreadable` is 0 and `strategy` is null.
 */
export function toDiscoveryReport(r: DomHealthReport): DiscoveryReport {
  return {
    configVersion: r.configVersion,
    rank: r.cardsFound === 0 ? null : r.fallbackUsed ? 1 : 0,
    strategy: null,
    count: r.cardsFound,
    unreadable: 0,
    drifted: r.fallbackUsed,
  };
}

// ── Utilities ───────────────────────────────────────────────────────────────

/** Settles like `p`, or rejects after `ms` on the Clock (a hung storage must not hang the background). */
export function withTimeout<T>(clock: Clock, p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = clock.setTimeout(() => {
      reject(new Error(`${what} did not answer within ${String(ms)} ms`));
    }, ms);
    p.then(
      (value) => {
        clock.clearTimeout(timer);
        resolve(value);
      },
      (e: unknown) => {
        clock.clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

export function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
