# Changelog

All notable changes to ShopBadwill are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Chrome and Firefox Manifest V3 extension for shopgoodwill.com, built with WXT, TypeScript, Preact and Zod.
- Layered source structure with ESLint layer rules, `no-unsanitized`, and a production-bundle check.
- Fake shopgoodwill.com and Google servers plus Vitest (unit, contract, DOM, integration) and Playwright suites.
- Audit log with hardened secret redaction.
- Manifest permission snapshot test and `web-ext lint` wrapper (`pnpm lint:webext`).
- Continuous integration on pushes to `dev` and pull requests into `main`.
- Release pipeline: tag-triggered GitHub release with a Chrome zip, a reproducible source zip, `SHA256SUMS`, and an unlisted self-signed Firefox `.xpi` when AMO keys are configured.
- `pnpm release` version bump and `pnpm sign:firefox` signing scripts.
