// T-70d: what "Connect Google" must hold before it sends calendar.connect.
// wxt.config.ts declares these optional, so the click asks for them first.
import type { AccessRequest } from '../../../../ui/permissions';

/** Token endpoint and Calendar API (wxt.config.ts OPTIONAL_HOSTS). */
export const GOOGLE_ORIGINS: readonly string[] = ['https://oauth2.googleapis.com/*', 'https://www.googleapis.com/*'];

export const GOOGLE_PERMISSION_REFUSED = 'Google Calendar needs permission to sign in and add events. Nothing was changed.';

/** Chrome declares `identity` optional; Firefox already requires it (it cannot be optional there). */
export function googleAccessRequest(firefox: boolean): AccessRequest {
  return firefox ? { origins: [...GOOGLE_ORIGINS] } : { permissions: ['identity'], origins: [...GOOGLE_ORIGINS] };
}
