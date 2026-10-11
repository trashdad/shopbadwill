// T-35: errors shared by the real messaging client and test/fakes/ports/fake-messaging.ts.
export type RouterErrorCode =
  | 'bad_sender'
  | 'unknown_type'
  | 'forbidden'
  | 'invalid_message'
  | 'disabled'
  | 'no_handler'
  | 'handler_error'
  | 'bad_reply';

/** Router codes, plus client-side 'transport' (sendMessage threw) and 'no_response' (no valid envelope came back). */
export type MessagingErrorCode = RouterErrorCode | 'transport' | 'no_response';

export class MessagingError extends Error {
  readonly code: MessagingErrorCode;
  constructor(code: MessagingErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'MessagingError';
    this.code = code;
  }
}
