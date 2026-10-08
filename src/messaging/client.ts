// T-35: the real MessagingClient (src/ports/messaging.ts) over runtime.sendMessage
// and runtime.connect. It validates like test/fakes/ports/fake-messaging.ts:
// the outgoing message with MsgEnvelopeSchema, the reply with MsgReplySchemas,
// stream ticks with PortTickSchemas.
//
// Extension APIs are injected (callers pass `browser.runtime` from wxt/browser):
// ESLint allows `wxt/browser` only in adapters/background/content/entrypoints,
// and I-18 forbids an adapters/browser/messaging.ts.
//
// Wire reply (see src/background/router.ts):
//   { ok: true, reply } | { ok: false, error: { code, message } }
import { z } from 'zod';

import type { MessagingClient } from '../ports/messaging';
import { MessagingError } from './errors';
import {
  MSG_VERSION,
  MsgEnvelopeSchema,
  MsgReplySchemas,
  PortTickSchemas,
  type MsgBroadcastType,
  type MsgPayload,
  type MsgReply,
  type MsgType,
  type PortName,
  type PortTick,
} from './protocol';

const RouterErrorCodeSchema = z.enum([
  'bad_sender',
  'unknown_type',
  'forbidden',
  'invalid_message',
  'disabled',
  'no_handler',
  'handler_error',
  'bad_reply',
]);

/** The reply envelope the router sends. */
export const MessageResponseSchema = z.union([
  z.object({ ok: z.literal(true), reply: z.unknown().optional() }),
  z.object({ ok: z.literal(false), error: z.object({ code: RouterErrorCodeSchema, message: z.string() }) }),
]);

export { MessagingError, type MessagingErrorCode } from './errors';

/** The slice of browser.runtime the client uses. */
export interface ClientPort {
  onMessage: { addListener(l: (m: unknown) => void): void; removeListener(l: (m: unknown) => void): void };
  disconnect(): void;
}
type BroadcastListener = (message: unknown, sender: { id?: string; tab?: unknown }) => undefined | boolean;
export interface ClientRuntime {
  id?: string;
  sendMessage(message: unknown): Promise<unknown>;
  connect(info: { name: string }): ClientPort;
  onMessage: { addListener(l: BroadcastListener): void; removeListener(l: BroadcastListener): void };
}

export function createMessagingClient(runtime: ClientRuntime): MessagingClient {
  return {
    async send<K extends MsgType>(type: K, payload: MsgPayload<K>): Promise<MsgReply<K>> {
      const body = payload === undefined ? { type } : { type, payload };
      const envelope = MsgEnvelopeSchema.safeParse({ v: MSG_VERSION, reqId: crypto.randomUUID(), ...body });
      if (!envelope.success) {
        throw new MessagingError('invalid_message', `invalid "${type}" message: ${envelope.error.message}`, {
          cause: envelope.error,
        });
      }

      let raw: unknown;
      try {
        raw = await runtime.sendMessage(envelope.data);
      } catch (e) {
        throw new MessagingError('transport', e instanceof Error ? e.message : String(e), { cause: e });
      }

      const response = MessageResponseSchema.safeParse(raw);
      if (!response.success) throw new MessagingError('no_response', `no valid response to "${type}"`);
      if (!response.data.ok) throw new MessagingError(response.data.error.code, response.data.error.message);

      const schema = (MsgReplySchemas as Record<string, z.ZodType | undefined>)[type];
      if (schema === undefined) return undefined as MsgReply<K>;
      const reply = schema.safeParse(response.data.reply);
      if (!reply.success) {
        throw new MessagingError('bad_reply', `invalid reply to "${type}": ${reply.error.message}`, {
          cause: reply.error,
        });
      }
      return reply.data as MsgReply<K>;
    },

    connect<P extends PortName>(name: P, onTick: (t: PortTick<P>) => void): () => void {
      const port = runtime.connect({ name });
      const listener = (m: unknown): void => {
        const tick = PortTickSchemas[name].safeParse(m);
        if (tick.success) onTick(tick.data as PortTick<P>); // a malformed tick is dropped
      };
      port.onMessage.addListener(listener);
      return () => {
        port.onMessage.removeListener(listener);
        port.disconnect();
      };
    },

    onBroadcast<K extends MsgBroadcastType>(type: K, cb: (payload: MsgPayload<K>) => void): () => void {
      const listener: BroadcastListener = (message, sender) => {
        // Only the background broadcasts: our own id, never from a tab.
        if (sender.id !== runtime.id || sender.tab !== undefined) return undefined;
        const parsed = MsgEnvelopeSchema.safeParse(message);
        if (!parsed.success || parsed.data.type !== type) {
          return undefined;
        }
        cb((parsed.data as { payload?: unknown }).payload as MsgPayload<K>);
        return undefined;
      };
      runtime.onMessage.addListener(listener);
      return () => {
        runtime.onMessage.removeListener(listener);
      };
    },
  };
}
