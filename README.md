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
| `pnpm build:test [wxt options]` | Test build (`SBW_TEST=1`, mode `test`) → `.output/chrome-mv3-test`; add `-b firefox --mv3` for Firefox |
| `pnpm lint` | ESLint, zero warnings (typescript-eslint, no-unsanitized, layer rules) |
| `pnpm lint:webext` | `web-ext lint --warnings-as-errors` on the Firefox build |
| `pnpm typecheck` | `tsc --noEmit` |
| `pnpm test:unit [filter]` | Vitest unit suite: `test/**` outside the other suites' folders, plus `scripts/**` and `companion/**` tests |
| `pnpm test:contract [filter]`, `test:dom [filter]`, `test:integration [filter]` | The other Vitest suites (`test/contract`, `test/dom` on happy-dom, `test/integration`) |
| `pnpm test:e2e:chromium [filter]` | Playwright, Chromium with the unpacked extension (`test/e2e/chromium`) |
| `pnpm test:e2e:firefox` | Firefox E2E (stub until T-12) |
| `pnpm fake:sgw`, `pnpm fake:google` | Fake buyerapi / Google servers (stubs until T-04 / T-05) |
| `pnpm canary`, `pnpm release`, `pnpm sign:firefox` | Live canary, release, AMO signing (stubs until T-60 / T-74) |
| `pnpm check:permissions`, `check:prod-bundle` | Permission snapshot and production-bundle checks (stubs until T-06) |
| `pnpm check:all` | Everything except E2E: lint, typecheck, all Vitest suites, both builds, web-ext lint, T-06 checks |

A filter is a substring of the test file path (`pnpm test:unit -- domain/time` runs `test/unit/domain/time/*.test.ts`); a leading `--` is accepted. A filter that matches no test fails the run, so a mistyped gate cannot pass vacuously. Every Vitest suite has a smoke test, so a run without a filter is never empty.

### Build-time environment

- `SBW_GOOGLE_CLIENT_ID`: Google OAuth client ID injected into the Chrome manifest's `oauth2.client_id`. Put it in `.env.local` (git-ignored; see `.env.example`). When unset, the `oauth2` key is omitted.
- `SBW_TEST=1`: makes a **test build** (`pnpm build:test` sets it): `import.meta.env.SBW_TEST` is `true` and the manifest gains `http://127.0.0.1/*` for the fake servers. It is read from the shell only, never from `.env` files, so a production build cannot become a test build by accident.

### Loading the unpacked extension

- Chrome: `chrome://extensions` → Developer mode → Load unpacked → `.output/chrome-mv3`.
- Firefox: `about:debugging#/runtime/this-firefox` → Load Temporary Add-on → `.output/firefox-mv3/manifest.json`.

`pnpm exec tsx scripts/badge-check.ts` (after `pnpm build`) loads the Chromium build in Playwright, opens the shopgoodwill.com home page once, checks the "ShopBadwill ready" Shadow DOM badge and saves `test-results/t01-badge.png`.

## Reproducible build

The Firefox add-on is distributed as an unlisted, self-signed `.xpi`. Mozilla (AMO) receives the source with each signing upload; this is how to rebuild it from that source (or from a release tag):

- Node 25 (`.nvmrc`; `engines` requires `>=25`)
- pnpm 12.9.1 (the `packageManager` field in `package.json`; `corepack enable` selects it)

```sh
pnpm install --frozen-lockfile
pnpm build:firefox
```

The unpacked Firefox extension lands in `.output/firefox-mv3/` (`manifest.json` plus bundled assets). `pnpm build` writes the Chrome build to `.output/chrome-mv3/`. Leave `SBW_TEST` and `SBW_GOOGLE_CLIENT_ID` unset to match the Firefox build; the release workflow's source zip (`shopbadwill-<version>-sources.zip`, produced by `git archive`) contains exactly the tracked files of the tagged commit.

Release checksums are in `SHA256SUMS` on each GitHub release.
