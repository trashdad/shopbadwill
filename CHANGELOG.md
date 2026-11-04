# Changelog

All notable changes to ShopBadwill are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

Versioning: every change that ships in the extension gets a new version (test- or docs-only changes do not).
PATCH (0.1.x) for fixes, MINOR (0.x.0) for new features or behaviour you would notice, and 1.0.0 once the
extension is reliable enough to run unattended every day. Bump with `pnpm release patch|minor|major`.

## [Unreleased]

## [0.2.3] - 2026-11-04

### Fixed

- On tier T0 (nothing keeps the computer awake), the 24 h and 1 h checks warn when the computer is usually asleep at the auction's end, or the end falls in quiet hours (R-6).

## [0.2.2] - 2026-11-04

### Fixed

- The quick result reads after a snipe stay logged in, so won or lost is confirmed sooner (R-5).
- The bid reply's "high bidder" flag never decides won or lost: without a read after the close, the result shows Unconfirmed (R-5).

## [0.2.1] - 2026-11-04

### Fixed

- The bid itself is never refused by the request budget, a "slow down" (429) pause or a lane backoff; a 403 still stops it. The snipe lane's daily budget (now 240) is counted and warned on, never enforced (R-1).
- The 24 h and 1 h checks warn when the snipe lane runs low or ShopGoodwill has asked to slow down (R-1).

## [0.2.0] - 2026-11-04

### Changed

- Snipes time the fire from the whole send chain (the bid form, the site's pacing gap and the bid itself), so a bid lands on time even when ShopGoodwill is slow (R-2).
- One slow read at T-60 s no longer triggers the early bid: the speed is re-measured first, and only a site that stays slow gets the early fallback (R-2).

## [0.1.0] - 2026-11-04

### Added

- Chrome and Firefox Manifest V3 extension for shopgoodwill.com, built with WXT, TypeScript, Preact and Zod.
- Layered source structure with ESLint layer rules, `no-unsanitized`, and a production-bundle check.
- Fake shopgoodwill.com and Google servers plus Vitest (unit, contract, DOM, integration) and Playwright suites.
- Audit log with hardened secret redaction.
- Manifest permission snapshot test and `web-ext lint` wrapper (`pnpm lint:webext`).
- Continuous integration on pushes to `dev` and pull requests into `main`.
- Release pipeline: tag-triggered GitHub release with a Chrome zip, a reproducible source zip, `SHA256SUMS`, and an unlisted self-signed Firefox `.xpi` when AMO keys are configured.
- `pnpm release` version bump and `pnpm sign:firefox` signing scripts.
- Search-page overlay that highlights or hides listings, big injected Track and Snipe buttons on item pages.
- Saved watches that run daily and track new matches; hide rules (for example by brand).
- Google Calendar sync of auction ends with 60/15/5-minute reminders, a toolbar Sync button, and ntfy push reminders.
- Last-second sniping with a preset max: preflight, clock sampling, a T-60 s verify, one bid per snipe, and an outcome read.
- Bid groups ("win at most N of these"), spending caps, an exposure meter, a kill switch and an audit log.
- A live-bidding gate: dry runs first; typing GO LIVE can skip the remaining dry runs, and the skip is audited (T-130).

### Changed

- Ended auctions drop off every list at once and are pruned from storage 6 h after the end; resolved snipes move to "Past snipes" (T-129).

### Fixed

- An item tracked again after it was pruned gets its calendar event again (T-131).
- ShopGoodwill's "Bid Received" reply to a bid is recognised; its status flag is logged (T-132).
