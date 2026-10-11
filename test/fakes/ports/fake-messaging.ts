import type { z } from 'zod';

import { MessagingError } from '../../../src/messaging/errors';
import type { MessagingClient } from '../../../src/ports/messaging';
import {
  MsgReplySchemas,
  MsgSchema,
  PortTickSchemas,
  type MsgBroadcastType,
  type MsgPayload,
  type MsgReply,
  type MsgType,
  type PortName,
  type PortTick,
} from '../../../src/messaging/protocol';

type Handler<K extends MsgType> = (payload: MsgPayload<K>) => MsgReply<K> | Promise<MsgReply<K>>;

/**
 * In-memory MessagingClient. Register background handlers with `handle`, push
 * stream ticks with `emitTick` and broadcasts with `broadcast`. Payloads, replies, ticks and broadcasts are parsed with the protocol schemas and a
 * malformed one throws. `send` rejects with MessagingError exactly like the
 * production client + router: invalid_message, no_handler, handler_error,
 * bad_reply. A duplicate `handle()` throws, as router.register does.
 */
export class FakeMessaging implements MessagingClient {
  /** Every send(), in order. */
  readonly sent: Array<{ type: MsgType; payload: unknown }> = [];
  private readonly handlers = new Map<MsgType, (payload: never) => unknown>();
  private readonly ports = new Map<PortName, Set<(t: never) => void>>();
  private readonly gone = new Map<(t: never) => void, () => void>();
  private readonly broadcasts = new Map<MsgBroadcastType, Set<(p: never) => void>>();

  /** Registers the handler for `type`. Like router.register, a duplicate throws. */
  handle<K extends MsgType>(type: K, handler: Handler<K>): this {
    if (this.handlers.has(type)) throw new Error(`FakeMessaging: handler already registered for "${type}"`);
    this.handlers.set(type, handler);
    return this;
  }

  async send<K extends MsgType>(type: K, payload: MsgPayload<K>): Promise<MsgReply<K>> {
    // Production behavior (client + router): the same errors, as MessagingError.
    const parsed = MsgSchema.safeParse(payload === undefined ? { type } : { type, payload });
    if (!parsed.success) {
      throw new MessagingError('invalid_message', `invalid "${type}" message: ${parsed.error.message}`, { cause: parsed.error });
    }
    this.sent.push({ type, payload: structuredClone(payload) });
    const handler = this.handlers.get(type);
    if (handler === undefined) throw new MessagingError('no_handler', `no handler for "${type}"`);
    let reply: unknown;
    try {
      reply = await handler(structuredClone(payload) as never);
    } catch (e) {
      throw new MessagingError('handler_error', e instanceof Error ? e.message : String(e), { cause: e });
    }
    const schema = (MsgReplySchemas as Record<string, z.ZodType | undefined>)[type];
    if (schema === undefined) return undefined as MsgReply<K>;
    const checked = schema.safeParse(reply);
    if (!checked.success) {
      throw new MessagingError('bad_reply', `invalid reply to "${type}": ${checked.error.message}`, { cause: checked.error });
    }
    return checked.data as MsgReply<K>;
  }

  connect<P extends PortName>(name: P, onTick: (t: PortTick<P>) => void, onDisconnect?: () => void): () => void {
    const set = this.ports.get(name) ?? new Set();
    this.ports.set(name, set);
    const cb = onTick as (t: never) => void;
    set.add(cb);
    if (onDisconnect !== undefined) this.gone.set(cb, onDisconnect);
    return () => {
      set.delete(cb);
      this.gone.delete(cb);
    };
  }

  onBroadcast<K extends MsgBroadcastType>(type: K, cb: (payload: MsgPayload<K>) => void): () => void {
    const set = this.broadcasts.get(type) ?? new Set();
    this.broadcasts.set(type, set);
    const fn = cb as (p: never) => void;
    set.add(fn);
    return () => {
      set.delete(fn);
    };
  }

  /** Test helper: the background streams a tick to every open port of that name. */
  emitTick<P extends PortName>(name: P, tick: PortTick<P>): void {
    PortTickSchemas[name].parse(tick);
    for (const cb of [...(this.ports.get(name) ?? [])]) cb(structuredClone(tick) as never);
  }

  /** Test helper: the background broadcasts to every subscriber. */
  broadcast<K extends MsgBroadcastType>(type: K, payload: MsgPayload<K>): void {
    MsgSchema.parse(payload === undefined ? { type } : { type, payload });
    for (const cb of [...(this.broadcasts.get(type) ?? [])]) cb(structuredClone(payload) as never);
  }

  /** Test helper: the background goes away (worker restart). Every open port of that name closes and its onDisconnect fires. */
  disconnectPorts(name: PortName): void {
    const set = this.ports.get(name) ?? new Set();
    for (const cb of [...set]) {
      set.delete(cb);
      const g = this.gone.get(cb);
      this.gone.delete(cb);
      g?.();
    }
  }

  /** Test helper: how many ports of that name are open. */
  openPorts(name: PortName): number {
    return this.ports.get(name)?.size ?? 0;
  }
}
