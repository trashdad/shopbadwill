// T-36: the background composition root (PLAN §2.1). FROZEN after T-36 (I-01):
// later cards add a module under src/background/handlers/ or
// src/background/jobs/ exporting `register(ctx: BackgroundContext)` instead of
// editing this file.
//
// What it does, in order:
//   synchronously (the worker's first turn; MV3 only delivers the event that
//   woke it to listeners added now):
//     - under SBW_TEST only, T-12's installTestHooks();
//     - builds one of each port and adapter (no I/O, no network);
//     - adds the browser listeners: runtime.onMessage (held until ready),
//       runtime.onConnect / onStartup / onInstalled, alarms, notification
//       actions, permission removals (held and replayed), and the kill-switch
//       command (Alt+Shift+K), which acts at once;
//   then, asynchronously (R4):
//     1. migrate() (meta-corrupt, a failure, or no answer within
//        MIGRATE_TIMEOUT_MS blocks every write; startup continues);
//     2. loads the GlobalSwitches snapshot;
//     3. builds the single RequestScheduler and awaits scheduler.load();
//     4. registers every handler and job module (handlers/index.ts, jobs/index.ts);
//     5. serves: answers the held messages, then replays the held events.
//   A message that arrives before step 5 waits; past STARTUP_DEADLINE_MS it is
//   answered with a "starting" error instead.
//
// Startup sends no network request (R7): the scheduler only sends when a
// caller asks, and nothing here asks.
import { BrowserAlarms } from '../adapters/browser/alarms';
import { BrowserClock } from '../adapters/browser/clock';
import { BrowserHttp } from '../adapters/browser/http';
import { BrowserKeepAlive } from '../adapters/browser/keep-alive';
import { BrowserKeepAwake } from '../adapters/browser/keep-awake';
import { BrowserNotifier } from '../adapters/browser/notifier';
import { BrowserPermissions } from '../adapters/browser/permissions';
import { createStorageAreas } from '../adapters/browser/storage';
import { PkceRefreshProvider, type GoogleClientConfig, type WebAuthFlow } from '../adapters/google/auth-pkce';
import { GoogleCalendarApi } from '../adapters/google/calendar-api';
import { SgwApiAdapter } from '../adapters/sgw/api-adapter';
import { SgwClockAdapter } from '../adapters/sgw/clock-adapter';
import { SgwHealthAdapter } from '../adapters/sgw/health';
import { SgwRequestScheduler } from '../adapters/sgw/request-scheduler';
import { SgwSessionAdapter } from '../adapters/sgw/session-adapter';
import { createAuditLog } from '../domain/audit/log';
import { migrate, StorageTooNewError, type MigrateResult } from '../domain/storage/migrations';
import { Repo } from '../domain/storage/repo';
import { STORAGE_KEYS } from '../domain/storage/schema';
import type { ClockSample } from '../domain/types';
import { MSG_VERSION, MsgEnvelopeSchema, type MsgBroadcastType } from '../messaging/protocol';
import type { AlarmInfo, Alarms } from '../ports/alarms';
import type { Clock } from '../ports/clock';
import type { Http } from '../ports/http';
import type { KeepAlive } from '../ports/keep-alive';
import type { KeepAwake } from '../ports/keep-awake';
import type { Notifier } from '../ports/notifier';
import type { Permissions } from '../ports/permissions';
import type { SgwClock } from '../ports/sgw-clock';
import type { StorageAreas } from '../ports/storage';
import { installTestHooks, type TestHookBrowser } from '../test-hooks';
import {
  Channel,
  createFlag,
  createPortRegistry,
  createTickHub,
  errorText,
  EventGate,
  PageStore,
  SettingsSetInterceptors,
  toDiscoveryReport,
  withTimeout,
  type BackgroundContext,
  type BackgroundHealth,
  type BroadcastPayload,
  type InstalledDetails,
  type ModuleMap,
  type RegistrationReport,
  type RuntimePort,
} from './context';
import { HANDLER_MODULES, registerHandlers } from './handlers/index';
import { JOB_MODULES, registerJobs } from './jobs/index';
import { createRouter, SGW_ORIGIN, type MessageResponse, type Router, type RouterSender } from './router';
import { Switches } from './switches';

/** The manifest command (wxt.config.ts) bound to Alt+Shift+K. It only ever turns the kill switch ON. */
export const KILL_COMMAND = 'kill-switch';
/** Messages held longer than this while starting are answered with a "starting" error. */
export const STARTUP_DEADLINE_MS = 15_000;
export const STARTING_MESSAGE = 'ShopBadwill is still starting; try again in a moment.';
/** Most messages held while starting; more are answered "starting" at once. */
const MAX_HELD_MESSAGES = 100;
/**
 * migrate() fails closed when storage has not answered after this long: every
 * write is blocked (as for meta-corrupt), startup continues, and the next
 * worker start runs migrate() again.
 */
export const MIGRATE_TIMEOUT_MS = 10_000;

// ── The browser slice used directly here ────────────────────────────────────

interface BrowserEvent<L> {
  addListener(listener: L): void;
}

/** Always answers asynchronously through sendResponse (works on Chrome and Firefox). */
export type BackgroundMessageListener = (
  message: unknown,
  sender: RouterSender,
  sendResponse: (response: unknown) => void,
) => true;

export interface BackgroundRuntime {
  readonly id: string;
  getURL(path: string): string;
  sendMessage(message: unknown): Promise<unknown>;
  readonly onMessage: BrowserEvent<BackgroundMessageListener>;
  readonly onConnect: BrowserEvent<(port: RuntimePort) => void>;
  readonly onStartup: BrowserEvent<() => void>;
  readonly onInstalled: BrowserEvent<(details: InstalledDetails) => void>;
}

/** The part of WXT's `browser` this file touches (the adapters import their own). */
export interface BackgroundBrowser extends TestHookBrowser {
  readonly runtime: TestHookBrowser['runtime'] & BackgroundRuntime;
  readonly commands?: { readonly onCommand: BrowserEvent<(command: string) => void> };
  readonly tabs: {
    query(queryInfo: { url: string[] }): Promise<Array<{ id?: number }>>;
    sendMessage(tabId: number, message: unknown): Promise<unknown>;
  };
  /** Optional on Chrome until the user grants it (Connect Google). */
  readonly identity?: WebAuthFlow;
}

export interface BackgroundPorts {
  clock: Clock;
  storage: StorageAreas;
  http: Http;
  alarms: Alarms;
  notifier: Notifier;
  permissions: Permissions;
  keepAwake: KeepAwake;
  keepAlive: KeepAlive;
  /** Uniform in [0, 1), for the scheduler's jitter. */
  random: () => number;
}

export interface StartBackgroundOptions {
  browser: BackgroundBrowser;
  /** Test seams: any port given here replaces the browser adapter. */
  ports?: Partial<BackgroundPorts>;
  /** Test seams: the module maps (default: the handlers/ and jobs/ globs). */
  handlerModules?: ModuleMap;
  jobModules?: ModuleMap;
  log?: (message: string, error?: unknown) => void;
}

export interface BackgroundHandle {
  /** Resolves once every module registered and messages are served. */
  readonly ready: Promise<BackgroundContext>;
  /** Available at once (the kill switch acts before ready). */
  readonly switches: Switches;
  readonly router: Router;
}

// ── Composition ─────────────────────────────────────────────────────────────

export function startBackground(opts: StartBackgroundOptions): BackgroundHandle {
  const { browser } = opts;
  // T-12: test builds only. `import.meta.env.SBW_TEST` is the literal `false`
  // in production, so this call and the hook modules are compiled out.
  if (import.meta.env.SBW_TEST) installTestHooks({ browser });

  const log = (message: string, error?: unknown): void => {
    if (opts.log) opts.log(message, error);
    else console.error(`[ShopBadwill] ${message}`, error);
  };
  const ports = resolvePorts(opts.ports);
  const { clock, storage, http } = ports;

  // Domain services and the adapters that do no I/O when built.
  const repo = new Repo(storage, clock);
  const audit = createAuditLog(repo);
  const session = new SgwSessionAdapter({ repo, clock, audit }); // the only instance (T-28)
  const switches = new Switches({ clock, storage, repo, session, audit, log });
  const router = createRouter({
    runtimeId: browser.runtime.id,
    getURL: (path) => browser.runtime.getURL(path),
    isQuickFavoriteEnabled: () => switches.settings()?.overlay.quickFavorite === true,
    log,
  });

  // Wake events: listeners now, deliveries held until ready (see context.ts).
  const gate = new EventGate(log);
  const messages = createMessageGate(router, clock, log);
  browser.runtime.onMessage.addListener(messages.listener);
  const connections = new Channel<[RuntimePort]>(gate);
  browser.runtime.onConnect.addListener((port: RuntimePort) => {
    connections.emit(port);
  });
  const startups = new Channel<[]>(gate);
  browser.runtime.onStartup.addListener(() => {
    startups.emit();
  });
  const installs = new Channel<[InstalledDetails]>(gate);
  browser.runtime.onInstalled.addListener((details) => {
    installs.emit(details);
  });
  const alarmEvents = new Channel<[AlarmInfo]>(gate);
  ports.alarms.onAlarm((alarm) => {
    alarmEvents.emit(alarm);
  });
  const actions = new Channel<[string, string]>(gate);
  try {
    ports.notifier.onAction((id, action) => {
      actions.emit(id, action);
    });
  } catch (e) {
    // Chrome hides `notifications` until its optional permission is granted.
    log('background: notification actions are not available', e);
  }
  const removals = new Channel<[]>(gate);
  ports.permissions.onRemoved(() => {
    removals.emit();
  });
  // R3: the shortcut acts at once (in memory), even before startup finishes.
  let serving = false;
  browser.commands?.onCommand.addListener((command) => {
    if (command !== KILL_COMMAND) return;
    const early = !serving; // switches.changed is only broadcast once serving: announce it then
    switches
      .setKill(true, 'shortcut')
      .then(async () => {
        if (early) await ready.then(() => broadcast('switches.changed', switches.view()));
      })
      .catch((e: unknown) => {
        log('background: persisting the kill switch failed (it stays on in memory)', e);
      });
  });

  const alarms: Alarms = {
    create: (name, o) => ports.alarms.create(name, o),
    clear: (name) => ports.alarms.clear(name),
    getAll: () => ports.alarms.getAll(),
    onAlarm: (cb) => alarmEvents.on(cb),
  };
  const notifier: Notifier = {
    get supportsActions() {
      return ports.notifier.supportsActions;
    },
    notify: (n) => ports.notifier.notify(n),
    onAction: (cb) => actions.on(cb),
  };
  const permissions: Permissions = {
    contains: (p) => ports.permissions.contains(p),
    request: (p) => ports.permissions.request(p),
    onRemoved: (cb) => removals.on(cb),
  };

  const clockAdapter = new SgwClockAdapter(clock);
  const sgwClock = feedingClock(clockAdapter);
  const googleNeedsInteraction = createFlag(false);
  const google = new PkceRefreshProvider({
    storage,
    http,
    clock,
    identity: identityOf(browser),
    clientConfig: () => googleClientConfig(repo),
    // T-86 owns the action badge; it subscribes to ctx.googleNeedsInteraction.
    badge: {
      set: (on) => {
        googleNeedsInteraction.set(on);
      },
    },
    audit,
  });
  const calendarApi = new GoogleCalendarApi({ http: google.authorizedHttp(http), auth: google, clock });
  const pages = new PageStore();
  const broadcast = createBroadcaster(browser, pages, log);

  const ready = (async (): Promise<BackgroundContext> => {
    // 1. migrate() before anything else reads storage.
    let migration: MigrateResult | null = null;
    let storageProblem: string | null = null;
    try {
      migration = await withTimeout(clock, migrate(repo), MIGRATE_TIMEOUT_MS, 'storage (migrate)');
      if (migration.health === 'meta-corrupt') {
        storageProblem = 'sbw:meta is unreadable and some records are invalid (meta-corrupt)';
        log(`background: ${storageProblem}; every write stays blocked`);
      }
    } catch (e) {
      storageProblem = e instanceof StorageTooNewError ? e.message : `storage migration failed: ${errorText(e)}`;
      log('background: migrate() failed; every write stays blocked', e);
    }
    switches.markMigrated(storageProblem);

    // 2. The switch snapshot: settings, the last HealthReport (sbw:healthReport, else
    //    sbw:runtimeHealth, as T-30's last() reads them) and the session. It fails
    //    closed and retries on its own.
    await switches.load();

    // 3. The single scheduler, built after migrate; its saved pause/budget must be read before serving.
    const scheduler = new SgwRequestScheduler({
      clock,
      http,
      storage: storage.local,
      notifier,
      random: ports.random,
      considerateMode: switches.settings()?.considerateMode ?? 'normal',
    });
    // The API reports schema outcomes to T-30's health, which itself reads through the API.
    const healthRef: { current?: SgwHealthAdapter } = {};
    const api = new SgwApiAdapter({
      scheduler,
      clock,
      session,
      switches,
      // No window between the last verdict refresh and the send (kill switch, R3).
      writesAllowedNow: (feature) => switches.verdictNow(feature),
      audit,
      health: {
        // Writes fail closed at once; T-30 stores the sticky per-endpoint failure.
        flagSchemaFailure: (f) => {
          switches.flagSchemaFailure(f);
          healthRef.current?.flagSchemaFailure(f);
        },
        // Clears that endpoint's sticky failure (T-30); a no-op when there is none.
        onSchemaOk: (endpoint) => {
          healthRef.current?.recordSchemaSuccess(endpoint).catch((e: unknown) => {
            log('background: recording a schema success failed', e);
          });
        },
      },
      sgwClock: sgwClock.builders,
    });
    const healthAdapter = new SgwHealthAdapter({
      repo,
      clock,
      api,
      sgwClock: sgwClock.port,
      session,
      audit,
      domReport: () => {
        const r = pages.domReport();
        return Promise.resolve(r === null ? null : toDiscoveryReport(r));
      },
    });
    healthRef.current = healthAdapter;
    const health = observedHealth(healthAdapter, switches);
    if (!(await scheduler.load())) log('background: the request scheduler state is unreadable; SGW requests stay paused until it is');

    // 4. Register every module.
    const registered: RegistrationReport = { handlers: [], jobs: [], failed: [] };
    const ctx: BackgroundContext = {
      clock,
      storage,
      http,
      alarms,
      notifier,
      permissions,
      keepAwake: ports.keepAwake,
      keepAlive: ports.keepAlive,
      repo,
      audit,
      scheduler,
      api,
      session,
      sgwClock: sgwClock.port,
      health,
      google,
      calendarApi,
      googleNeedsInteraction,
      switches,
      router,
      ports: createPortRegistry(connections),
      lifecycle: { onStartup: (cb) => startups.on(cb), onInstalled: (cb) => installs.on(cb) },
      ticks: createTickHub(log),
      interceptors: { settingsSet: new SettingsSetInterceptors() },
      pages,
      broadcast,
      startup: { migration, storageProblem, registered },
    };
    switches.onSettings((s) => {
      scheduler.setConsiderateMode(s.considerateMode);
    });
    switches.onChange((view) => {
      void broadcast('switches.changed', view);
    });
    registerHandlers(ctx, opts.handlerModules ?? HANDLER_MODULES);
    registerJobs(ctx, opts.jobModules ?? JOB_MODULES);
    for (const f of registered.failed) log(`background: ${f.kind} module ${f.file} did not register: ${f.error}`);

    // 5. Serve: held messages first (a held kill.set applies before any replayed alarm), then events.
    serving = true;
    messages.open();
    gate.open();
    return ctx;
  })();
  ready.catch((e: unknown) => {
    log('background: startup failed', e);
    messages.fail(e);
  });

  return { ready, switches, router };
}

// ── Pieces ──────────────────────────────────────────────────────────────────

function resolvePorts(given: Partial<BackgroundPorts> = {}): BackgroundPorts {
  const clock = given.clock ?? new BrowserClock();
  return {
    clock,
    storage: given.storage ?? createStorageAreas(),
    http: given.http ?? new BrowserHttp(),
    alarms: given.alarms ?? new BrowserAlarms(),
    notifier: given.notifier ?? new BrowserNotifier(),
    permissions: given.permissions ?? new BrowserPermissions(),
    keepAwake: given.keepAwake ?? new BrowserKeepAwake(),
    keepAlive: given.keepAlive ?? new BrowserKeepAlive(),
    random: given.random ?? Math.random,
  };
}

/** runtime.onMessage until ready: holds messages, or answers "starting" after the deadline. */
function createMessageGate(router: Router, clock: Clock, log: (message: string, error?: unknown) => void) {
  interface Held {
    raw: unknown;
    sender: RouterSender;
    respond: (response: MessageResponse) => void;
  }
  const held: Held[] = [];
  let state: 'starting' | 'ready' | 'failed' = 'starting';
  let late = false;
  const reply = (message: string): MessageResponse => ({ ok: false, error: { code: 'handler_error', message } });
  const deadline = clock.setTimeout(() => {
    late = true;
    for (const h of held.splice(0)) h.respond(reply(STARTING_MESSAGE));
  }, STARTUP_DEADLINE_MS);
  const serve = (h: Held): void => {
    router.handle(h.raw, h.sender).then(h.respond, (e: unknown) => {
      log('background: answering a message failed', e);
      h.respond(reply('internal error'));
    });
  };
  const listener: BackgroundMessageListener = (raw, sender, sendResponse) => {
    const h: Held = { raw, sender, respond: sendResponse };
    if (state === 'ready') serve(h);
    else if (state === 'failed') sendResponse(reply('ShopBadwill could not start; reload the extension.'));
    else if (late || held.length >= MAX_HELD_MESSAGES) sendResponse(reply(STARTING_MESSAGE));
    else held.push(h);
    return true;
  };
  return {
    listener,
    open(): void {
      state = 'ready';
      clock.clearTimeout(deadline);
      for (const h of held.splice(0)) serve(h);
    },
    fail(e: unknown): void {
      state = 'failed';
      clock.clearTimeout(deadline);
      for (const h of held.splice(0)) h.respond(reply(`ShopBadwill could not start: ${errorText(e)}`));
    },
  };
}

/** Sends a broadcast to extension pages and to every SGW tab's content script. Never rejects. */
function createBroadcaster(browser: BackgroundBrowser, pages: PageStore, log: (message: string, error?: unknown) => void) {
  return async <K extends MsgBroadcastType>(type: K, ...payload: BroadcastPayload<K>): Promise<void> => {
    const message: Record<string, unknown> = { v: MSG_VERSION, type, reqId: crypto.randomUUID() };
    if (payload.length > 0) message.payload = payload[0];
    if (!MsgEnvelopeSchema.safeParse(message).success) {
      log(`background: refusing to broadcast an invalid "${type}"`);
      return;
    }
    // No page open answers "Receiving end does not exist": nothing to do.
    const toPages = quietly(() => browser.runtime.sendMessage(message));
    const toTabs = (async () => {
      const ids = new Set(pages.tabIds());
      try {
        for (const tab of await browser.tabs.query({ url: [`${SGW_ORIGIN}/*`] })) if (tab.id !== undefined) ids.add(tab.id);
      } catch (e) {
        log('background: listing SGW tabs for a broadcast failed', e);
      }
      await Promise.all([...ids].map((id) => quietly(() => browser.tabs.sendMessage(id, message))));
    })();
    await Promise.all([toPages, toTabs]);
  };
}

async function quietly(fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch {
    // a tab without our content script, or no page listening
  }
}

/**
 * The one SgwClockAdapter: every sample the API builds (ItemDetail serverTime,
 * ms; GetCurrentTime, 1 s; with the real sent/received times) is added as it
 * is built; null samples (ambiguous or nonexistent Pacific time, a backwards
 * clock, malformed input) are skipped. Adding a sample the API already added
 * is a no-op, so samples are never counted twice.
 */
function feedingClock(adapter: SgwClockAdapter): {
  builders: Pick<SgwClockAdapter, 'sampleFromServerTime' | 'sampleFromGetCurrentTime'>;
  port: SgwClock;
} {
  const fed = new WeakSet<ClockSample>();
  const feed = (s: ClockSample | null): ClockSample | null => {
    if (s !== null) {
      fed.add(s);
      adapter.addSample(s);
    }
    return s;
  };
  return {
    builders: {
      sampleFromServerTime: (raw, sentAt, receivedAt) => feed(adapter.sampleFromServerTime(raw, sentAt, receivedAt)),
      sampleFromGetCurrentTime: (data, sentAt, receivedAt) => feed(adapter.sampleFromGetCurrentTime(data, sentAt, receivedAt)),
    },
    port: {
      parsePacific: (raw) => adapter.parsePacific(raw),
      parsePacificDetailed: (raw) => adapter.parsePacificDetailed(raw),
      addSample: (s) => {
        if (!fed.has(s)) adapter.addSample(s);
      },
      offset: () => adapter.offset(),
      serverNow: () => adapter.serverNow(),
    },
  };
}

/** T-30's health, with every run's report applied to the switches at once (not only when onChanged arrives). */
function observedHealth(inner: SgwHealthAdapter, switches: Switches): BackgroundHealth {
  return {
    run: async (mode) => {
      const report = await inner.run(mode);
      switches.noteHealthReport(report);
      return report;
    },
    last: () => inner.last(),
    recordSchemaFailure: (f) => inner.recordSchemaFailure(f),
    recordSchemaSuccess: (endpoint) => inner.recordSchemaSuccess(endpoint),
  };
}

/** The OAuth client the user pasted on the options page (T-70 writes `sbw:googleClient`; ruling: the only source). */
async function googleClientConfig(repo: Repo): Promise<GoogleClientConfig | undefined> {
  const client = await repo.find(STORAGE_KEYS.googleClient);
  const clientId = client?.clientId.trim() ?? '';
  if (clientId === '') return undefined;
  const secret = client?.clientSecret?.trim() ?? '';
  return secret === '' ? { clientId } : { clientId, clientSecret: secret };
}

/** `identity`, looked up when used: on Chrome it exists only once the optional permission is granted. */
function identityOf(browser: BackgroundBrowser): WebAuthFlow {
  const api = (): WebAuthFlow => {
    if (browser.identity === undefined) throw new Error('the identity permission has not been granted');
    return browser.identity;
  };
  return {
    launchWebAuthFlow: (details) => api().launchWebAuthFlow(details),
    getRedirectURL: () => api().getRedirectURL(),
  };
}
