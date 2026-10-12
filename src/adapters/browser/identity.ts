// T-119: the redirect URI the user must list in their Google OAuth client,
// for the options page's setup aid. It is the same value the PKCE provider
// sends (`redirectUriFor(identity.getRedirectURL())`), so what the page shows
// is exactly what Google will be asked for.
import { browser } from 'wxt/browser';

import { redirectUriFor } from '../google/auth-pkce';

interface IdentityLike {
  getRedirectURL(): string;
}

/**
 * The redirect URI for this browser, or undefined while `identity` is not
 * available (Chrome declares it optional: it appears once granted).
 */
export function googleRedirectUri(): string | undefined {
  try {
    const identity = (browser as unknown as { identity?: IdentityLike }).identity;
    return identity === undefined ? undefined : redirectUriFor(identity.getRedirectURL());
  } catch {
    return undefined;
  }
}
