# Changelog

All notable changes to this plugin. Versions follow LancerLogin's release rules: stable `X.Y.Z`, beta `X.Y.Z-beta.N`. Testing-only nightly builds (`X.Y.Z-nightly.YYYYMMDD`) are not listed here; their GitHub prereleases list their commits. Full patch notes for each release are in [docs/releases](docs/releases/README.md).

Add a `## [X.Y.Z] - YYYY-MM-DD` entry above older entries for each stable or beta release.

## [1.0.0] - 2026-11-09

First stable release. Requires LancerLogin Core `>=2.1.0-beta.7 <3.0.0`. [Release notes](docs/releases/v1.0.0.md).

### Added

- Part requests from the Robotics Part Requests Chrome extension into the team's Notion ordering database, with duplicate protection and a repeat warning.
- Pairing through `/ordering-pin` in Discord, with no LancerLogin sign-in for students, per-member device limits, self-revoke and per-device rate limits.
- Carts: open orders, including Incomplete Requests, and cart marks recording who built a cart. Carts fills store carts and never checks out. An Admin switch turns it off.
- **Settings > Modules > Part Requests** with Connection, Requests log and Paired devices, one-step token replacement, and messages when Notion rejects the token or access is lost.

### Fixed

- A connection missing Notion's Insert content capability now stays on Needs attention instead of flipping back to Connected after the next successful read.
