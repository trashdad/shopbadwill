// Test-only hooks (PLAN §7.5, I-05). Compiled into test builds only.
//
// The background's composition root calls, at top level:
//
//   if (import.meta.env.SBW_TEST) installTestHooks({ browser });
//
// `import.meta.env.SBW_TEST` is the literal `false` in production builds
// (wxt.config.ts), so the call, this module and every hook module are
// tree-shaken out; `pnpm check:prod-bundle` fails if `SBW_TEST` leaks.
// Hook modules must therefore have NO top-level side effects: everything
// happens inside `install()`.
//
// Each other `src/test-hooks/*.ts` file is a hook module exporting
// `install(ctx: TestHookContext)`. A hook that a test calls registers an
// endpoint with `ctx.serve('sbw:test:<name>', handler)`. Tests reach it from
// an extension page (Firefox has no service-worker handle; see
// docs/spikes/S-6.md) over a runtime Port, so test traffic never meets the
// message router:
//
//   const port = browser.runtime.connect({ name: 'sbw:test:state' });
//   port.onMessage.addListener((reply) => ...);  // { ok: true, value } | { ok: false, error }
//   port.postMessage({ payload });               // one request per port
//
// This module never imports `wxt/browser` (PLAN §2.1 allows it only in
// adapters/browser, background, content and entrypoints): the background
// passes its `browser` in, typed by the slice the hooks use.

/** Every test hook endpoint is a Port with this name prefix. */
export const TEST_HOOK_PREFIX = 'sbw:test:';
export type TestHookName = `sbw:test:${string}`;

/** The slice of `runtime.Port` the hooks use. */
export interface TestHookPort {
  readonly name: string;
  readonly sender?: { readonly id?: string; readonly url?: string };
  postMessage(message: unknown): void;
  disconnect(): void;
  readonly onMessage: { addListener(callback: (message: unknown) => void): void };
}

export interface TestHookAlarm {
  name: string;
  scheduledTime: number;
  periodInMinutes?: number;
}

/** The slice of WXT's `browser` the hooks use. A hook that needs more adds it here. */
export interface TestHookBrowser {
  readonly runtime: {
    readonly id: string;
    getURL(path: string): string;
    readonly onConnect: { addListener(callback: (port: TestHookPort) => void): void };
  };
  readonly storage: {
    readonly local: { get(keys: null): Promise<Record<string, unknown>> };
    readonly session: { get(keys: null): Promise<Record<string, unknown>> };
  };
  readonly alarms: { getAll(): Promise<TestHookAlarm[]> };
}

/** Receives the request's `payload`; its (awaited) return value is the reply's `value`. */
export type TestHookHandler = (payload: unknown) => unknown;

export interface TestHookContext {
  readonly browser: TestHookBrowser;
  /** Every installed hook, by module file name (`state` for state.ts), in install order. */
  readonly hooks: readonly string[];
  /** Answers `name` Ports opened by this extension's own pages. Throws if `name` is taken. */
  serve(name: TestHookName, handler: TestHookHandler): void;
}

export interface TestHookModule {
  install(ctx: TestHookContext): void;
}

export interface TestHookReply {
  ok: boolean;
  value?: unknown;
  error?: string;
}

/**
 * Installs every `src/test-hooks/*.ts` hook. A no-op unless this is a test
 * build. Must run synchronously in the background's first turn, so Firefox's
 * event page registers the `onConnect` listener before it handles any event.
 * Returns the installed hook names.
 */
export function installTestHooks({ browser }: { browser: TestHookBrowser }): readonly string[] {
  if (!import.meta.env.SBW_TEST) return [];
  const modules = import.meta.glob<Partial<TestHookModule>>(['./*.ts', '!./index.ts'], { eager: true });
  return installHooks(modules, browser);
}

/** Installs `modules` (keyed by `./<name>.ts`, as `import.meta.glob` returns them). Exported for unit tests. */
export function installHooks(
  modules: Record<string, Partial<TestHookModule>>,
  browser: TestHookBrowser,
): readonly string[] {
  const entries = Object.entries(modules).sort(([a], [b]) => a.localeCompare(b));
  const hooks = entries.map(([path]) => path.replace(/^.*\//, '').replace(/\.ts$/, ''));
  const handlers = new Map<string, TestHookHandler>();

  const ctx: TestHookContext = {
    browser,
    hooks,
    serve(name, handler) {
      if (handlers.has(name)) throw new Error(`test hook ${name} is served twice`);
      handlers.set(name, handler);
    },
  };

  for (const [path, module] of entries) {
    if (typeof module.install !== 'function') {
      throw new Error(`test hook ${path} must export install(ctx: TestHookContext)`);
    }
    module.install(ctx);
  }

  browser.runtime.onConnect.addListener((port) => {
    if (!port.name.startsWith(TEST_HOOK_PREFIX)) return; // another listener's port
    const handler = handlers.get(port.name);
    if (!handler) {
      replyAndClose(port, { ok: false, error: `no test hook serves ${port.name}` });
      return;
    }
    if (!isOwnExtensionPage(browser, port.sender)) {
      replyAndClose(port, { ok: false, error: `${port.name}: only extension pages may call test hooks` });
      return;
    }
    port.onMessage.addListener((message) => {
      void answer(handler, payloadOf(message)).then((reply) => {
        replyAndClose(port, reply);
      });
    });
  });

  return hooks;
}

function isOwnExtensionPage(browser: TestHookBrowser, sender: TestHookPort['sender']): boolean {
  return sender?.id === browser.runtime.id && (sender.url?.startsWith(browser.runtime.getURL('/')) ?? false);
}

function payloadOf(message: unknown): unknown {
  return typeof message === 'object' && message !== null && 'payload' in message ? message.payload : undefined;
}

async function answer(handler: TestHookHandler, payload: unknown): Promise<TestHookReply> {
  try {
    return { ok: true, value: await handler(payload) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function replyAndClose(port: TestHookPort, reply: TestHookReply): void {
  port.postMessage(reply);
  port.disconnect();
}
