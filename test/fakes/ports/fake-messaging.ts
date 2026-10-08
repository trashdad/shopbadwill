import type { MessagingClient } from '../../../src/ports/messaging';
import {
  MsgReplySchemas,
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
 * stream ticks with `emitTick` and broadcasts with `broadcast`. A message
 * without a handler resolves `undefined` if the protocol declares no reply for
 * it, and rejects otherwise (a missing handler is a test bug).
 */
export class FakeMessaging implements MessagingClient {
  /** Every send(), in order. */
  readonly sent: Array<{ type: MsgType; payload: unknown }> = [];
  private readonly handlers = new Map<MsgType, (payload: never) => unknown>();
  private readonly ports = new Map<PortName, Set<(t: never) => void>>();
  private readonly broadcasts = new Map<MsgBroadcastType, Set<(p: never) => void>>();

  handle<K extends MsgType>(type: K, handler: Handler<K>): this {
    this.handlers.set(type, handler);
    return this;
  }

  async send<K extends MsgType>(type: K, payload: MsgPayload<K>): Promise<MsgReply<K>> {
    this.sent.push({ type, payload: structuredClone(payload) });
    const handler = this.handlers.get(type);
    if (handler === undefined) {
      if (type in MsgReplySchemas) throw new Error(`FakeMessaging: no handler for "${type}"`);
      return undefined as MsgReply<K>;
    }
    return (await handler(structuredClone(payload) as never)) as MsgReply<K>;
  }

  connect<P extends PortName>(name: P, onTick: (t: PortTick<P>) => void): () => void {
    const set = this.ports.get(name) ?? new Set();
    this.ports.set(name, set);
    const cb = onTick as (t: never) => void;
    set.add(cb);
    return () => {
      set.delete(cb);
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
    for (const cb of [...(this.ports.get(name) ?? [])]) cb(structuredClone(tick) as never);
  }

  /** Test helper: the background broadcasts to every subscriber. */
  broadcast<K extends MsgBroadcastType>(type: K, payload: MsgPayload<K>): void {
    for (const cb of [...(this.broadcasts.get(type) ?? [])]) cb(structuredClone(payload) as never);
  }

  /** Test helper: how many ports of that name are open. */
  openPorts(name: PortName): number {
    return this.ports.get(name)?.size ?? 0;
  }
}
