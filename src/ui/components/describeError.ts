import { MessagingError } from '../../messaging/errors';

/** Plain-English text for an error from the messaging client. Never shows raw codes. */
export function describeError(err: unknown): string {
  if (!(err instanceof MessagingError)) return 'Something went wrong.';
  switch (err.code) {
    case 'no_response':
    case 'transport':
      return "ShopBadwill's background isn't responding. Try reloading the extension.";
    case 'forbidden':
    case 'bad_sender':
      return 'Not allowed.';
    case 'invalid_message':
      return "That change wasn't valid.";
    case 'disabled':
      return 'Turned off in settings.';
    case 'handler_error':
      return err.message;
    case 'unknown_type':
    case 'no_handler':
    case 'bad_reply':
      return 'Something went wrong.';
  }
}
