import type { GoogleAuthErrorCode } from '../../../../domain/calendar/types';

/** What to do about each last Google error. */
export const ERROR_HINTS: Record<GoogleAuthErrorCode, string> = {
  invalid_grant: 'Google no longer accepts your sign-in. Reconnect Google.',
  unauthorized: 'Google refused the request. Check your client ID and secret, then reconnect.',
  insufficient_scope: 'Calendar access was not granted. Reconnect and allow it.',
  rate_limited: 'Google is limiting requests. ShopBadwill will try again later.',
  offline: "ShopBadwill couldn't reach Google. Check your internet connection.",
  needs_interaction: 'Google needs you to sign in again. Use Reconnect.',
  not_configured: 'Enter your client ID and client secret above, then connect.',
  user_cancelled: "Sign-in was cancelled. Connect again when you're ready.",
};
