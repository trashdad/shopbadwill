# shopbadwill
A Firefox and Chrome extension for assisting with shopping at shopgoodwill.com

## Development

Requirements: Node 25 (`.nvmrc`) and pnpm 12. Built with [WXT](https://wxt.dev) 0.21, TypeScript (strict), Preact, Vitest and Playwright.

```sh
pnpm install                          # also runs `wxt prepare` (generates .wxt/ types)
pnpm exec playwright install chromium # once, for Chromium E2E and the badge check
```

| Command | What it does |
|---|---|
| `pnpm dev` / `pnpm dev:firefox` | Dev build with reload, Chrome / Firefox MV3 |
| `pnpm build` | Production build → `.output/chrome-mv3` |
| `pnpm build:firefox` | Production build → `.output/firefox-mv3` (`wxt build -b firefox --mv3`; WXT defaults Firefox to MV2) |
| `pnpm lint` | ESLint, zero warnings (typescript-eslint, no-unsanitized, layer rules) |
| `pnpm lint:webext` | `web-ext lint --warnings-as-errors` on the Firefox build |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm test:unit [path]` | Vitest unit suite (`test/unit`, `test/fakes`); a `src/...` path maps to `test/unit/...` |
| `pnpm test:contract [path]`, `test:dom [path]`, `test:integration [path]` | The other Vitest suites (`test/contract`, `test/dom` on happy-dom, `test/integration`) |
| `pnpm test:e2e:chromium [filter]` | Playwright, Chromium with the unpacked extension |
| `pnpm test:e2e:firefox` | Firefox E2E (placeholder until S-6/T-40) |
| `pnpm check:permissions`, `check:prod-bundle` | Placeholders until T-06 |
| `pnpm check:all` | Everything except E2E: lint, typecheck, all Vitest suites, both builds, web-ext lint, T-06 checks |

Suites with no tests pass; a path filter that matches no test fails, so a mistyped gate cannot pass vacuously. A leading `--` before the filter (`pnpm test:unit -- src/domain/time`) is accepted.

### Build-time environment

- `SBW_GOOGLE_CLIENT_ID`: Google OAuth client ID injected into the Chrome manifest's `oauth2.client_id`. Put it in `.env.local` (git-ignored; see `.env.example`). When unset, the `oauth2` key is omitted.
- `SBW_TEST=1`: makes a **test build** (`SBW_TEST=1 pnpm build`): `import.meta.env.SBW_TEST` is `true` and the manifest gains `http://127.0.0.1/*` for the fake servers. It is read from the shell only, never from `.env` files, so a production build cannot become a test build by accident.

### Loading the unpacked extension

- Chrome: `chrome://extensions` → Developer mode → Load unpacked → `.output/chrome-mv3`.
- Firefox: `about:debugging#/runtime/this-firefox` → Load Temporary Add-on → `.output/firefox-mv3/manifest.json`.

`node scripts/badge-check.ts` (after `pnpm build`) loads the Chromium build in Playwright, opens the shopgoodwill.com home page once, checks the "ShopBadwill ready" Shadow DOM badge and saves `test-results/t01-badge.png`.
