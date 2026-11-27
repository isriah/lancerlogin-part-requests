# Changelog

All notable changes to this plugin. Versions follow LancerLogin's release rules: stable `X.Y.Z`, beta `X.Y.Z-beta.N`. Testing-only nightly builds (`X.Y.Z-nightly.YYYYMMDD`) are not listed here; their GitHub prereleases list their commits. Full patch notes for each release are in [docs/releases](docs/releases/README.md).

Add a `## [X.Y.Z] - YYYY-MM-DD` entry above older entries for each stable or beta release.

## [1.2.0] - Unreleased

Requires LancerLogin Core `>=2.1.0-beta.12 <3.0.0` (module SDK `^1.8.0`). [Release notes](docs/releases/v1.2.0.md).

### Changed

- Notion goes through Core's shared connection (`services.notion`) with the `orders` binding. The token lives in **Settings > Integrations > Notion**; the plugin keeps none. The manifest declares `orders` with `retrieve`, `query` and `pages.create`, and users `list` and `retrieve`.
- A token saved by 1.1 moves to Core on first use (`importLegacyConnection`) and the plugin's copy is cleared. The columns stay, empty; no migration.
- The setup step and every public route depend on Core's connection, the `orders` binding and the layout verified for that data source. `POST /verify` takes `{}`.
- Notion calls now count against the scheduler's budget, like Discord.
- Requests answer `503 delivery_paused` while Core holds deliveries.

### Removed

- The plugin's Notion client, token entry, Replace and Remove, and `PUT /token`, `DELETE /token`, `POST /database` and `POST /connection`.

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
