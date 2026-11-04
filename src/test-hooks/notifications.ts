// `sbw:test:notifications` (T-104): what the background asked the browser to
// show. Test builds only; see ./index.ts for how hooks are loaded and called,
// and `pnpm check:prod-bundle`, which fails if any of this reaches production.
//
// Why a hook. The money E2E asserts the outcome notification's exact text, and
// Chrome gives no way to read it back: `notifications.getAll()` answers ids
// only. On top of that, `notifications` is an OPTIONAL permission, and Chrome
// asks for it with a prompt a headless E2E cannot answer, so in an E2E profile
// the API is absent and every notify effect fails (best effort, logged). This
// is the google-auth-stub situation (`identity`), handled the same way:
//
//   - `{ op: 'install' }`: if the browser has `notifications` (the permission
//     was granted), its `create` is wrapped: every call is recorded, then
//     passed through unchanged. If it is absent, a stand-in takes its place
//     on the `browser` object main.ts was given (the notifier looks it up on
//     every call): `create` records and answers the id, as Chrome does; the
//     rest are inert. Answers `{ mode: 'wrapped' | 'stand-in' }`. Nothing
//     changes until the harness calls this: a test build left alone behaves
//     like production.
//   - `{ op: 'list' }`: every recorded call, oldest first:
//     `{ id, title, message, at }` (`at` is Date.now() of the background).
//   - `{ op: 'clear' }`: forgets the record.
//   - `{ op: 'uninstall' }`: restores whatever `notifications` was there.
//
// The notifier, the effect that calls it and the copy are the production
// ones; only the browser's display surface is replaced or observed. The
// record is in memory: a background restart drops it (and the stand-in), and
// the harness installs it again, as it re-applies `sbw:test:baseUrl`.
import { z } from 'zod';

import type { TestHookContext } from './index';

export const NOTIFICATIONS_HOOK = 'sbw:test:notifications';
/** Marks the wrapper and the stand-in (and, if it were ever bundled, trips check:prod-bundle's `sbw.test`). */
const HOOK_MARK = Symbol.for('sbw.testHooks.notifications');

/** One `notifications.create(id, options)` call, as the background made it. */
export interface RecordedNotification {
  id: string;
  title: string;
  message: string;
  at: number;
}

type Create = (...args: unknown[]) => unknown;

interface NotificationsLike {
  create?: Create;
}

const RequestSchema = z.discriminatedUnion('op', [
  z.strictObject({ op: z.literal('install') }),
  z.strictObject({ op: z.literal('list') }),
  z.strictObject({ op: z.literal('clear') }),
  z.strictObject({ op: z.literal('uninstall') }),
]);

/** `create(id, options)` or `create(options)`: the id and the options, whichever form was used. */
function callOf(args: readonly unknown[]): { id: string | undefined; options: Record<string, unknown> } {
  const [first, second] = args;
  if (typeof first === 'string') {
    return { id: first, options: typeof second === 'object' && second !== null ? (second as Record<string, unknown>) : {} };
  }
  return { id: undefined, options: typeof first === 'object' && first !== null ? (first as Record<string, unknown>) : {} };
}

const text = (v: unknown): string => (typeof v === 'string' ? v : '');

/** An inert event (`addListener` and friends do nothing). */
function inertEvent(): { addListener(): void; removeListener(): void; hasListener(): boolean } {
  return {
    addListener: () => undefined,
    removeListener: () => undefined,
    hasListener: () => false,
  };
}

export function install(ctx: TestHookContext): void {
  // The real `browser` object main.ts was given; `notifications` is looked up on it at every use.
  const target = ctx.browser as unknown as Record<string, unknown>;
  const recorded: RecordedNotification[] = [];
  let seq = 0;
  /** What install did, so uninstall can undo exactly that. */
  let installed:
    | { mode: 'stand-in'; previous: PropertyDescriptor | undefined }
    | { mode: 'wrapped'; api: NotificationsLike & Record<string | symbol, unknown>; create: Create }
    | undefined;

  const record = (args: readonly unknown[]): string => {
    const { id, options } = callOf(args);
    seq += 1;
    const finalId = id ?? `sbw:test:n:${String(seq)}`;
    recorded.push({ id: finalId, title: text(options['title']), message: text(options['message']), at: Date.now() });
    return finalId;
  };

  const standIn = (): Record<string | symbol, unknown> => ({
    [HOOK_MARK]: true,
    create: (...args: unknown[]) => Promise.resolve(record(args)),
    clear: () => Promise.resolve(true),
    getAll: () => Promise.resolve({}),
    getPermissionLevel: () => Promise.resolve('granted'),
    onClicked: inertEvent(),
    onClosed: inertEvent(),
    onButtonClicked: inertEvent(),
    onShowSettings: inertEvent(),
    onPermissionLevelChanged: inertEvent(),
  });

  ctx.serve(NOTIFICATIONS_HOOK, (payload) => {
    const parsed = RequestSchema.safeParse(payload);
    if (!parsed.success) {
      throw new Error(`expected { op: 'install' | 'list' | 'clear' | 'uninstall' }; got ${JSON.stringify(payload)}`);
    }
    switch (parsed.data.op) {
      case 'install': {
        if (installed !== undefined) return { mode: installed.mode };
        const api = target['notifications'] as (NotificationsLike & Record<string | symbol, unknown>) | undefined;
        const create = api?.create;
        if (api !== undefined && typeof create === 'function') {
          // Granted: record, then the browser's own create, unchanged.
          const recording = function (this: unknown, ...args: unknown[]): unknown {
            record(args);
            return create.apply(this, args);
          };
          Object.defineProperty(recording, HOOK_MARK, { value: true });
          api.create = recording;
          installed = { mode: 'wrapped', api, create };
        } else {
          const previous = Object.getOwnPropertyDescriptor(target, 'notifications');
          Object.defineProperty(target, 'notifications', { configurable: true, enumerable: true, writable: true, value: standIn() });
          installed = { mode: 'stand-in', previous };
        }
        return { mode: installed.mode };
      }
      case 'list':
        return recorded.map((n) => ({ ...n }));
      case 'clear':
        recorded.length = 0;
        return { cleared: true };
      case 'uninstall': {
        if (installed?.mode === 'wrapped') {
          installed.api.create = installed.create;
        } else if (installed?.mode === 'stand-in') {
          if (installed.previous === undefined) Reflect.deleteProperty(target, 'notifications');
          else Object.defineProperty(target, 'notifications', installed.previous);
        }
        installed = undefined;
        return { uninstalled: true };
      }
    }
  });
}
