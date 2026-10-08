import preact from '@preact/preset-vite';
import { defineConfig } from 'wxt';

// Read at config load, BEFORE WXT loads .env files, so only the shell
// environment can make a test build: `SBW_TEST=1 pnpm build`.
const TEST_BUILD = process.env.SBW_TEST === '1';

const GECKO_ID = 'shopbadwill@trashdad.github.io';
const CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar.app.created';

// Permissions per PLAN §2.5. test/unit/manifest-permissions.test.ts snapshots
// the result; any change here must update that snapshot in review.
const SGW_HOSTS = ['https://shopgoodwill.com/*', 'https://buyerapi.shopgoodwill.com/*'];
const TEST_HOSTS = ['http://127.0.0.1/*']; // test builds only (fake servers)
const OPTIONAL_HOSTS = [
  'https://oauth2.googleapis.com/*', // "Connect Google": token endpoint
  'https://www.googleapis.com/*', // "Connect Google": Calendar API
  'https://ntfy.sh/*', // "Enable phone push"
];
const OPTIONAL_PERMISSIONS = {
  chrome: ['notifications', 'identity', 'sidePanel', 'background', 'power', 'nativeMessaging'],
  firefox: ['notifications', 'identity', 'nativeMessaging'],
};

export default defineConfig({
  srcDir: 'src',
  // Explicit imports only, so ESLint can enforce where `wxt/browser` is used.
  imports: false,
  vite: () => ({
    plugins: [preact()],
    define: {
      // Literal `false` in production, so `if (import.meta.env.SBW_TEST)` blocks
      // (and the string "SBW_TEST") are compiled out.
      'import.meta.env.SBW_TEST': JSON.stringify(TEST_BUILD),
    },
  }),
  // Function form: runs after WXT has loaded .env files into process.env.
  manifest: ({ browser }) => {
    const isFirefox = browser === 'firefox';
    const googleClientId = process.env.SBW_GOOGLE_CLIENT_ID?.trim();

    return {
      name: 'ShopBadwill',
      permissions: ['storage', 'alarms'],
      host_permissions: [...SGW_HOSTS, ...(TEST_BUILD ? TEST_HOSTS : [])],
      optional_permissions: isFirefox ? OPTIONAL_PERMISSIONS.firefox : OPTIONAL_PERMISSIONS.chrome,
      optional_host_permissions: OPTIONAL_HOSTS,
      commands: {
        'kill-switch': {
          suggested_key: { default: 'Ctrl+Shift+K' },
          description: 'Kill switch: stop all ShopBadwill automation',
        },
      },
      ...(isFirefox
        ? {
            browser_specific_settings: {
              gecko: {
                id: GECKO_ID,
                strict_min_version: '128.0',
                data_collection_permissions: {
                  required: ['none'],
                  // Requested at runtime only when the user enables ntfy push.
                  optional: ['technicalAndInteraction'],
                },
              },
            },
          }
        : {
            minimum_chrome_version: '148',
            // Injected from SBW_GOOGLE_CLIENT_ID (.env.local); omitted when unset.
            ...(googleClientId
              ? { oauth2: { client_id: googleClientId, scopes: [CALENDAR_SCOPE] } }
              : {}),
          }),
    };
  },
});
