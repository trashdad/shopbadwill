// T-35: the background message router and a security boundary (PLAN §2.4).
//
// Pipeline for every runtime message, each step failing with an explicit
// error code (nothing is silently dropped):
//   1. sender.id must equal the extension's own id           -> 'bad_sender'
//   2. classify the sender: content script or extension UI   -> 'bad_sender'
//      (content needs sender.tab and an https://shopgoodwill.com url)
//   3. the type must be known                                -> 'unknown_type'
//   4. content may send only MSG_SENDER === 'content'        -> 'forbidden'
//      (background-only broadcast types are refused to everyone)
//   5. the envelope and payload parse with MsgEnvelopeSchema -> 'invalid_message'
//   6. quick.favorite requires settings.overlay.quickFavorite -> 'disabled'
//   7. a handler must be registered                          -> 'no_handler'
//   8. the handler runs; its reply is validated              -> 'handler_error' / 'bad_reply'
//
// Wire reply envelope (defined here; PLAN §3 leaves it open):
//   { ok: true, reply } | { ok: false, error: { code, message } }
import type { ZodType } from 'zod';
import { browser } from 'wxt/browser';

import {
  MSG_SENDER,
  MsgEnvelopeSchema,
  MsgReplySchemas,
  type MsgPayload,
  type MsgReply,
  type MsgType,
} from '../messaging/protocol';

export const SGW_ORIGIN = 'https://shopgoodwill.com';

export type MessageErrorCode =
  | 'bad_sender'
  | 'unknown_type'
  | 'forbidden'
  | 'invalid_message'
  | 'disabled'
  | 'no_handler'
  | 'handler_error'
  | 'bad_reply';

export interface MessageError {
  code: MessageErrorCode;
  message: string;
}

export type MessageResponse = { ok: true; reply?: unknown } | { ok: false; error: MessageError };

/** The subset of runtime.MessageSender the router reads. */
export interface RouterSender {
  id?: string;
  url?: string;
  tab?: unknown;
}

export type SenderClass = 'content' | 'ui';

export interface HandlerContext {
  sender: RouterSender;
  senderClass: SenderClass;
}

export type Handler<K extends MsgType> = (
  payload: MsgPayload<K>,
  ctx: HandlerContext,
) => MsgReply<K> | Promise<MsgReply<K>>;

export interface RouterDeps {
  /** browser.runtime.id */
  runtimeId: string;
  /** Scheme + host of the extension's own pages without a trailing slash, e.g. `chrome-extension://<id>` (browser.runtime.getURL('/') minus the slash). */
  extensionOrigin: string;
  /** settings.overlay.quickFavorite; gates quick.favorite from content. */
  isQuickFavoriteEnabled: () => boolean | Promise<boolean>;
}

export interface Router {
  /** Registers the handler for `type`. Throws on a duplicate or a background-only type. Returns an unregister function. */
  register<K extends MsgType>(type: K, handler: Handler<K>): () => void;
  /** Validates and dispatches one raw runtime message. Never rejects. */
  handle(raw: unknown, sender: RouterSender): Promise<MessageResponse>;
  /** Installs the runtime.onMessage listener. Returns a function that removes it. */
  listen(): () => void;
}

const fail = (code: MessageErrorCode, message: string): MessageResponse => ({ ok: false, error: { code, message } });

function originOf(url: string | undefined): string | undefined {
  if (url === undefined) return undefined;
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

function isKnownType(type: unknown): type is MsgType {
  return typeof type === 'string' && Object.hasOwn(MSG_SENDER, type);
}

export function createRouter(deps: RouterDeps): Router {
  const handlers = new Map<MsgType, Handler<MsgType>>();

  /** Returns the sender class, or an error response. */
  function classify(sender: RouterSender): SenderClass | MessageResponse {
    if (sender.id !== deps.runtimeId) return fail('bad_sender', 'sender.id is not this extension');
    // Prefix match, not URL.origin: non-special schemes (chrome-extension:, moz-extension:) have no usable origin in every runtime.
    const isExtensionPage = sender.url !== undefined && sender.url.startsWith(`${deps.extensionOrigin}/`);
    const origin = originOf(sender.url);
    if (sender.tab === undefined) {
      // Popup, options, dashboard, background: no tab. A web url here is not ours.
      if (sender.url !== undefined && !isExtensionPage) {
        return fail('bad_sender', 'sender without a tab must be an extension page');
      }
      return 'ui';
    }
    // From a tab: an extension page opened in a tab is UI; anything else is a content script.
    if (isExtensionPage) return 'ui';
    if (origin !== SGW_ORIGIN) return fail('bad_sender', `content messages must come from ${SGW_ORIGIN}`);
    return 'content';
  }

  async function handle(raw: unknown, sender: RouterSender): Promise<MessageResponse> {
    const senderClass = classify(sender);
    if (typeof senderClass !== 'string') return senderClass;

    const rawType = typeof raw === 'object' && raw !== null ? (raw as { type?: unknown }).type : undefined;
    if (!isKnownType(rawType)) return fail('unknown_type', 'unknown message type');
    const type: MsgType = rawType;
    const sendable = MSG_SENDER[type];
    if (sendable === 'background' || (senderClass === 'content' && sendable !== 'content')) {
      return fail('forbidden', `"${type}" may not be sent from ${senderClass}`);
    }

    const parsed = MsgEnvelopeSchema.safeParse(raw);
    if (!parsed.success) return fail('invalid_message', `invalid "${type}" message: ${parsed.error.message}`);
    const msg = parsed.data;

    if (senderClass === 'content' && type === 'quick.favorite' && !(await deps.isQuickFavoriteEnabled())) {
      return fail('disabled', 'quick favorite is turned off');
    }

    const handler = handlers.get(type);
    if (handler === undefined) return fail('no_handler', `no handler for "${type}"`);

    let reply: unknown;
    try {
      reply = await handler((msg as { payload?: never }).payload, { sender, senderClass });
    } catch (e) {
      return fail('handler_error', e instanceof Error ? e.message : String(e));
    }

    const schema = (MsgReplySchemas as Record<string, ZodType | undefined>)[type];
    if (schema === undefined) return { ok: true };
    const checked = schema.safeParse(reply);
    if (!checked.success) return fail('bad_reply', `handler for "${type}" returned an invalid reply`);
    return { ok: true, reply: checked.data };
  }

  return {
    register(type, handler) {
      if (MSG_SENDER[type] === 'background') throw new Error(`cannot register a handler for broadcast "${type}"`);
      if (handlers.has(type)) throw new Error(`handler already registered for "${type}"`);
      handlers.set(type, handler as unknown as Handler<MsgType>);
      return () => {
        if (handlers.get(type) === (handler as unknown)) handlers.delete(type);
      };
    },
    handle,
    listen() {
      const listener = (
        raw: unknown,
        sender: RouterSender,
        sendResponse: (response: MessageResponse) => void,
      ): boolean => {
        void handle(raw, sender).then(sendResponse);
        return true; // respond asynchronously
      };
      const onMessage = browser.runtime.onMessage as unknown as {
        addListener(l: typeof listener): void;
        removeListener(l: typeof listener): void;
      };
      onMessage.addListener(listener);
      return () => {
        onMessage.removeListener(listener);
      };
    },
  };
}
