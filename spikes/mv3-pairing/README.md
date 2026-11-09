# Manifest V3 pairing spike

Phase 0 only, and not part of the plugin. `extension/` is the smallest extension that pairs through a service worker. `e2e.mjs` runs it in Microsoft Edge against a fresh local preview.

## Run

1. In a Core worktree at `origin/main` (by default `modular-dev/.local/part-requests-core`; set `PART_REQUESTS_CORE` for another), run `npm ci`.
2. Here, run `npm ci`, then `npm run e2e`.

Ports 8807, 5193 and 5194 must be free. The run deletes that worktree's `.provision/plugin-dev/state`, so it always starts from an empty local database. It stops only the servers it started. A headed Edge window opens for the permission prompt, so don't use the mouse during that part.

Playwright uses `channel: "msedge"` because this machine blocks unsigned Chromium builds.

## Test seams

These are labelled in `e2e.mjs`:

- **Discord:** the integration row goes straight into the local database, with a throwaway key pair, and the test signs interactions itself. Core's real `/discord/interactions` route checks the signature and the server, then calls the handler. Real Discord is tested on dev.
- **Site address:** written with SQL, because the Admin page is a later phase. Core's real setup route then accepts it.
- **Time:** expired PINs and the end of a pause are simulated by moving timestamps in the local database.
- **The /api proxy:** the Vite dashboard has no `/api` proxy, so the test runs Core's generated `_worker.js` under `wrangler pages dev` on port 5194, with only its upstream constant swapped for the local Worker, because the generator accepts HTTPS only.
