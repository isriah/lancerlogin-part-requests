# LancerLogin Part Requests plugin

Students click a browser extension on a vendor's product page, review the details and create a request in the team's Notion ordering database. LancerLogin holds the Notion token. Students never sign in to LancerLogin.

**Status: Phase 2.** The backend and the Admin pages are built: pairing, the Notion connection, the device API, the request log, the recipient job, Core's setup screen and **Settings > Modules > Part Requests**. The browser extension's pairing and sending are a later phase.

| Plugin | LancerLogin Core | Module SDK | Module contract |
| --- | --- | --- | --- |
| 0.1.x | `>=2.1.0-beta.7 <3.0.0` | `^1.6.0` | 1 |

## Admin pages

**Settings > Modules > Part Requests**, Admin only, has four sections:

- **Setup:** the connection and its token, with Replace and Remove, and a link to Core's setup screen. Core shows that screen by itself until setup is complete. One Verify button saves the token and checks the database together.
- **Requests log:** every request with its member and device, newest first, with a banner when any result is uncertain.
- **Paired devices:** grouped by member, with Revoke. It also shows a member at the limit of 5 and a member who left the active roster.
- **Status:** the connection, the recipient list with Refresh now, and whether pairing is paused.

Core keeps a module open once its setup is complete, so replacing or removing the token later stops requests without closing these pages.

## Setup (Admin)

Core refuses `/admin/<module>` until a module's setup is complete, so setup uses `/module-setup/part-requests`, which stays open to Admins afterwards. Each route needs an Admin session, and each change must come from the dashboard origin.

| Route | Body | Result |
| --- | --- | --- |
| `GET /status` | | What is saved and what is missing. Says whether a token is saved, never the token. Also `dataSourceName`, `pairingPausedUntilMs` (the shared pause, `null` when pairing is open), `pairedDevices` and `deviceLimit`. |
| `POST /verify` | `{ token?, databaseUrl, dataSourceId? }` | What the setup page's Verify button calls. Checks the token and the database, then saves both together, so a failed check saves nothing. The exception is `409 data_source_required`, which lists the choices and keeps the token, because it has already proved itself. Leave out `token` to use the saved one. Refusals are the same as `PUT /token` and `POST /connection`. |
| `PUT /token` | `{ token }` | Checks the token with Notion, encrypts and saves it, and saves the dashboard address as the site address. A replaced token must be verified again with `POST /connection`. |
| `DELETE /token` | | Removes the token. Requests stop. |
| `POST /database` | `{ databaseUrl }` | `{ databaseId, dataSources }`. Accepts `notion.so`, `notion.com` and `notion.site` links, or a bare ID. |
| `POST /connection` | `{ databaseUrl, dataSourceId? }` | Validates the layout and saves it. `409 data_source_required` lists the choices, and `422 schema_mismatch` says which property is wrong. |

Then record the step with Core: `PUT /admin/modules/part-requests/setup` with `{ generation, stepId: "notion-connection", outcome: "completed" }`. Core opens the module once the connection is verified.

The expected database layout: Item Description (title), Status (status or select, with `NORMAL Request` and `Incomplete Request`), Vendor (select, with all 20 store names), Team (select or multi-select), Orderer/Recipient (people), SKU (rich text), Product URL (url), Qty (number), Unit Price (number) and Extension (formula or rollup, never written). The connection must be added to that database, with these capabilities: Read content, Insert content, and Read user information without email addresses.

After a restore, only the site address comes back. Core still shows the module as set up, but requests answer `503 notion_not_connected` until an Admin saves the token and connection again. Every device pairs again, and the log, the recipient list and each member's chosen person start empty.

## Device API

All under `/public/part-requests`, through the dashboard address plus `/api`. Except for `/pair`, each needs `Authorization: Bearer <deviceKey>`. A device that was revoked, or whose member left the active roster, gets `401 pair_again`.

| Route | Body | Result |
| --- | --- | --- |
| `POST /pair` | `{ pin, deviceLabel? }` | `201 { deviceKey, memberName }` |
| `GET /options` | | `{ memberName, teams, recipients, defaultRecipientId, statuses, vendors, recipientsUpdatedMs, minimumExtensionVersion, updateUrl, databaseLink }`. See below. |
| `POST /devices/self/revoke` | None | `200 { revoked: true }`. See below. |
| `POST /recipient` | `{ notionUserId }`, or `null` to clear | Saves this member's default person. |
| `POST /check` | `{ url, sku? }` | `{ repeats }`: the same product requested by anyone in the last 7 days. It never blocks. |
| `POST /requests` | `{ submissionId, draft }` | See below. |
| `GET /requests/<id>` | | The recorded result, the same as a repeated `POST`. |
| `POST /ping` | `{ echo }` | The Phase 0 test route. |

`draft` has exactly these fields: `description`, `status`, `url`, `sku`, `team` (an option ID), `recipient` (a Notion user ID), `quantity`, `price`, `currencyConfirmed`. Use `""` and `null` for what an Incomplete request leaves out. The vendor always comes from the URL.

### What `GET /options` adds for the extension

- **`minimumExtensionVersion`** and **`updateUrl`** are constants in `src/requests.ts`. An older extension still works, and shows a notice with the link.
- **`databaseLink`** is a `https://www.notion.so/<id>` link built from the saved database ID, for the "Check ordering database" link after an uncertain result.

`/options` answers `503` while the Notion connection is down, so none of these change until it is back.

### Revoking a device from itself

`POST /devices/self/revoke` ends the key that sends it and frees one of the member's 5 slots. It takes no body, and needs no Admin.

- **It is idempotent.** A key that is already revoked, by itself or by an Admin, gets `200 { revoked: true }` again, and the first revocation time stays. Every other route answers that key with `401 pair_again`.
- **Leaving the roster does not block it,** so a member off the roster can still give up the slot.
- **A key that isn't a device** gets `401 pair_again`, and nothing changes.
- **It counts as one of the 120 other writes,** so it can answer `429 rate_limited`. Nothing is revoked then.

The device shows on the Admin page as revoked, like one an Admin revoked. The audit log records `part_requests.device_self_revoked` with no actor, because nobody is signed in.

### Results of `POST /requests`

The extension creates `submissionId` (a lowercase UUID) when a request starts and sends the same one on every retry. Read `state` in the body.

| Status | Body | What the extension does |
| --- | --- | --- |
| `201` | `state: "created", pageUrl, repeats` | Done. `repeats` is the same warning as `/check`. |
| `200` | `state: "created", pageUrl, replayed: true` | Done. This ID had already succeeded. |
| `202` | `state: "pending"` | Another request with this ID is still running. Ask again shortly. |
| `202` | `state: "uncertain"` | **Do not retry on its own.** Notion may have created the page. Ask the student to check, and use a new ID only if they choose to make a new request. |
| `502` | `state: "failed", code, error` | Notion refused it, so nothing was created. Repeats of this ID return the same answer; trying again needs a new ID. |
| `400` | `code: "validation", errors` | Nothing was recorded. Fix it and resend. |
| `401` | `code: "pair_again"` | Prompt to pair again. |
| `409` | `code: "submission_conflict"` | The ID was used for different content or by another member. Start a new request. |
| `429` | `code: "rate_limited", retryAfterSeconds` | Nothing was recorded. Retry the same ID after the wait. |
| `503` | `code: "notion_not_connected"`, `"notion_schema_changed"`, `"credentials_unavailable"` or `"credentials_unreadable"` | An Admin has to act. Nothing was recorded. |
| `503` | `code: "update_maintenance"` | See below. |

Rate limits are per device, in 10-minute windows: 30 creates, and 120 other writes (`/check`, `/recipient` and `/devices/self/revoke`). `GET` routes are not counted, because they make no Notion call and should not write during maintenance. `/pair` allows 20 wrong PINs per client address when one is available, and 200 across the installation, then pauses for 15 minutes with `429 pairing_paused`.

### Maintenance

While an installation update is running, Core answers every non-`GET` request itself, before any plugin code runs:

```text
503  Retry-After: 30
{ "error": "An installation update requires temporary write suspension. Retry after recovery or completion.", "code": "update_maintenance" }
```

The request never reached the plugin, so nothing was recorded and nothing went to Notion. The extension should wait for `Retry-After`, then send the same request with the same `submissionId`, showing the student that the site is updating. The same rule covers any other failure with no recorded result, such as a network error or a `500`: resending the same ID is always safe, because the server allows one create per ID. `GET` routes keep working during maintenance.

## Admin data

Under `/admin/part-requests`, Admin only. Core requires a capability marked for Operators on these routes, so the manifest declares one, and every handler still requires an Admin.

| Route | Result |
| --- | --- |
| `GET /requests?limit=&before=` | `{ requests, nextBefore, uncertainCount }`, newest first. Each shows the member, device, state and request details. `uncertainCount` covers the whole log, not just this page. |
| `GET /devices` | `{ devices, limitPerMember }`: label, member, created, last used and revoked. No key material. |
| `POST /devices/revoke` | `{ deviceId }` ends that device's access at once. |
| `POST /recipients/refresh` | Runs the recipient refresh now. |

## Recipient refresh

The job `part-requests.recipients` runs every six hours, doing one Notion call per scheduler slice: the database layout, then workspace members, then people named on up to 2,000 existing requests (the only way to find guests), then any missing names. If the layout no longer fits, requests stop with `503 notion_schema_changed` until an Admin reconnects.

## Tests

- `npm test` runs the unit tests with no Core checkout. Notion is stubbed at the fetch boundary, so no request leaves the computer.
- `npm run verify:core -- <Core checkout>` composes the committed plugin into Core, then typechecks and builds it.
- `spikes/mv3-pairing` holds the Phase 0 browser test of a Manifest V3 extension against a local preview. See its README.
