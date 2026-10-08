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
const REQUIRED_PERMISSIONS = {
  chrome: ['storage', 'alarms'],
  // Firefox cannot make `identity` optional (PermissionNoPrompt only); it shows
  // no install prompt. Controller ruling A.
  firefox: ['storage', 'alarms', 'identity'],
};
const OPTIONAL_PERMISSIONS = {
  // WXT adds `sidePanel` as required once a sidepanel entrypoint exists (no
  // install warning). Controller ruling D: accepted.
  chrome: ['notifications', 'identity', 'sidePanel', 'background', 'power', 'nativeMessaging'],
  firefox: ['notifications', 'nativeMessaging'],
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
  // `version` is not set here: WXT takes it from package.json.
  manifest: ({ browser }) => {
    const isFirefox = browser === 'firefox';
    const googleClientId = process.env.SBW_GOOGLE_CLIENT_ID?.trim();

    return {
      name: 'ShopBadwill',
      permissions: isFirefox ? REQUIRED_PERMISSIONS.firefox : REQUIRED_PERMISSIONS.chrome,
      host_permissions: [...SGW_HOSTS, ...(TEST_BUILD ? TEST_HOSTS : [])],
      optional_permissions: isFirefox ? OPTIONAL_PERMISSIONS.firefox : OPTIONAL_PERMISSIONS.chrome,
      optional_host_permissions: OPTIONAL_HOSTS,
      commands: {
        'kill-switch': {
          // Not Ctrl+Shift+K: that is Firefox's Web Console. Controller ruling C.
          suggested_key: { default: 'Alt+Shift+K' },
          description: 'Kill switch: stop all ShopBadwill automation',
        },
      },
      ...(isFirefox
        ? {
            // Firefox dashboard surface (§2.6); Chrome uses the optional
            // sidePanel instead. Panel page: src/entrypoints/sidebar/.
            sidebar_action: {
              default_panel: 'sidebar.html',
              default_title: 'ShopBadwill',
              open_at_install: false,
            },
            browser_specific_settings: {
              gecko: {
                id: GECKO_ID,
                // 140/142: first versions supporting data_collection_permissions
                // (controller ruling B; web-ext lint warns below that).
                strict_min_version: '140.0',
                data_collection_permissions: {
                  required: ['none'],
                  // Requested at runtime only when the user enables ntfy push.
                  optional: ['technicalAndInteraction'],
                },
              },
              gecko_android: { strict_min_version: '142.0' },
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
