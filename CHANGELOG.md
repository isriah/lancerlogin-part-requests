# Changelog

All notable changes to this plugin. Versions follow LancerLogin's release rules: stable `X.Y.Z`, beta `X.Y.Z-beta.N`. Testing-only nightly builds (`X.Y.Z-nightly.YYYYMMDD`) are not listed here; their GitHub prereleases list their commits. Full patch notes for each release are in [docs/releases](docs/releases/README.md).

Add a `## [X.Y.Z] - YYYY-MM-DD` entry above older entries for each stable or beta release.

## [1.1.0] - 2026-11-09

Requires LancerLogin Core `>=2.1.0-beta.7 <3.0.0`. [Release notes](docs/releases/v1.1.0.md).

### Added

- **Generate pairing PIN** in **Settings > Modules > Part Requests > Paired devices**: an Admin chooses a member and gets the same one-time, 10-minute pairing PIN `/ordering-pin` makes, so a member without Discord can pair the extension. The PIN is shown once with its expiry, the site address and a Copy button. Each PIN is audited without the PIN, and generating is rate limited per Admin.
- `POST /admin/part-requests/pins`, the Admin route behind it.

### Changed

- `/ordering-pin` and the Admin page now make PINs through one shared function. The command's replies and rules are unchanged.

## [1.0.0] - 2026-11-09

First stable release. Requires LancerLogin Core `>=2.1.0-beta.7 <3.0.0`. [Release notes](docs/releases/v1.0.0.md).

### Added

- Part requests from the Robotics Part Requests Chrome extension into the team's Notion ordering database, with duplicate protection and a repeat warning.
- Pairing through `/ordering-pin` in Discord, with no LancerLogin sign-in for students, per-member device limits, self-revoke and per-device rate limits.
- Carts: open orders, including Incomplete Requests, and cart marks recording who built a cart. Carts fills store carts and never checks out. An Admin switch turns it off.
- **Settings > Modules > Part Requests** with Connection, Requests log and Paired devices, one-step token replacement, and messages when Notion rejects the token or access is lost.

### Fixed

- A connection missing Notion's Insert content capability now stays on Needs attention instead of flipping back to Connected after the next successful read.
