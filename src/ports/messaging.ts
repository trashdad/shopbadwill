// Contract v1 (T-02, fix round 1): the §2.1 Messaging port, the typed client
// that content scripts and UI pages use to talk to the background. T-35
// implements it in src/messaging/client.ts (over runtime.sendMessage and
// runtime.connect); T-03's fake-messaging implements it for tests. Message
// shapes are in src/messaging/protocol.ts.
import type {
  MsgBroadcastType,
  MsgPayload,
  MsgReply,
  MsgType,
  PortName,
  PortTick,
} from '../messaging/protocol';

export interface MessagingClient {
  /**
   * Sends `{ v: 1, type, payload, reqId }` and resolves with the reply.
   * Messages without a payload pass `undefined`; messages without a reply
   * resolve `undefined`.
   */
  send<K extends MsgType>(type: K, payload: MsgPayload<K>): Promise<MsgReply<K>>;
  /** Opens a stream port (§3.12) and calls `onTick` per message. Returns a disconnect function. */
  connect<P extends PortName>(name: P, onTick: (t: PortTick<P>) => void): () => void;
  /** Subscribes to a background broadcast ('rules.changed', 'switches.changed'). Returns an unsubscribe function. */
  onBroadcast<K extends MsgBroadcastType>(type: K, cb: (payload: MsgPayload<K>) => void): () => void;
}
