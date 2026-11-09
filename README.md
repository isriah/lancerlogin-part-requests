# LancerLogin Part Requests plugin

Students click a browser extension on a vendor's product page, review the details and create a request in the team's Notion ordering database. LancerLogin holds the Notion token. Students never sign in to LancerLogin.

**Status: Phase 2, with the Carts backend.** The backend and the Admin pages are built: pairing, the Notion connection, the device API, the request log, the recipient job, Core's setup screen and **Settings > Modules > Part Requests**. Carts here means reading open orders and recording who built a cart. Filling store carts belongs to the extension.

| Plugin | LancerLogin Core | Module SDK | Module contract |
| --- | --- | --- | --- |
| 0.1.x | `>=2.1.0-beta.7 <3.0.0` | `^1.6.0` | 1 |

## Admin pages

**Settings > Modules > Part Requests**, Admin only, has three sections:

- **Connection:** any problem and its fix at the top, then the Notion connection and its token, with Replace and Remove, the data source, last verified time, site address and Open setup, which reopens Core's setup screen; the repair fields whenever requests have stopped, as Core does not reopen setup by itself after a token is removed; the recipient list with Refresh now; pairing, with a notice while it is paused; and the Carts switch. One Verify button saves the token and checks the database together. Old `?section=setup` and `?section=status` links open this section.
- **Requests log:** every request with its member and device, newest first, with a banner when any result is uncertain.
- **Paired devices:** counts, search by name or device, and filters for No devices, At the limit, Inactive 30+ days and Off roster, then one compact row per member by name, including members with no devices. A row opens to that member's devices, with Revoke. Inactive is a prompt to look, not a reason to revoke: last used only changes when a device sends a request or marks a cart item.

Core shows its own setup screen by itself until setup is complete, and an Admin can reopen it from Connection. When Notion answers 401, 403 or 404 to a request or an orders read, or the refresh job gets a 403 or 404 reading the database or a 401 from any call, the code and time are recorded and Connection shows the rejected token or lost access at the top instead of Connected. A 500 or a 429 records nothing. It clears on a successful verify, a new or removed token, or the next call that reaches the database, so a brief glitch doesn't stick. Listing users is not such a call. It doesn't stop requests or change what students are told: each call still tries Notion and reports its own result, and Carts can serve its copy for a while.

A 403 listing workspace members means the connection lacks Read user information. That is not lost access: the refresh carries on with the people named on existing requests, and the recipient card says what to check.

Core keeps a module open once its setup is complete, so replacing or removing the token later stops requests without closing these pages.

## Setup (Admin)

Core refuses `/admin/<module>` until a module's setup is complete, so setup uses `/module-setup/part-requests`, which stays open to Admins afterwards. Each route needs an Admin session, and each change must come from the dashboard origin.

| Route | Body | Result |
| --- | --- | --- |
| `GET /status` | | What is saved and what is missing. Says whether a token is saved, never the token. Also `problem`, which adds `notion_token_rejected` and `notion_access_lost` with `rejectedMs` when Notion has refused the saved token, and `notion_insert_refused` when it refused to create a page with a 403, which is a connection without the Insert content capability (only a page that is created clears that one, since reading and verifying cannot prove inserting works; replacing the token also clears it), `dataSourceName`, `pairingPausedUntilMs` (the shared pause, `null` when pairing is open), `pairedDevices`, `deviceLimit` and `cartsEnabled`. |
| `POST /verify` | `{ token?, databaseUrl, dataSourceId? }` | What the setup page's Verify button calls. Checks the token and the database, then saves both together, so a failed check saves nothing. The exception is `409 data_source_required` during first-time setup, which lists the choices and keeps the token, because it has already proved itself. With a token already saved, nothing is saved. Leave out `token` to use the saved one. Replace token uses this route with the saved `dataSourceId`, so it saves and verifies in one step, and a failure leaves the old token in place. Refusals are the same as `PUT /token` and `POST /connection`. |
| `PUT /token` | `{ token }` | Checks the token with Notion, encrypts and saves it, and saves the dashboard address as the site address. A token saved this way must be verified with `POST /connection`. The page uses it only when no database is saved yet. |
| `DELETE /token` | | Removes the token. Requests stop. |
| `POST /database` | `{ databaseUrl }` | `{ databaseId, dataSources }`. Accepts `notion.so`, `notion.com` and `notion.site` links, or a bare ID. |
| `POST /connection` | `{ databaseUrl, dataSourceId? }` | Validates the layout and saves it. `409 data_source_required` lists the choices, and `422 schema_mismatch` says which property is wrong. |
| `PUT /carts` | `{ enabled }` | Turns Carts on or off for the installation and returns the same as `GET /status`. It is on by default. Turning it off also deletes the copy of the open orders. |

Then record the step with Core: `PUT /admin/modules/part-requests/setup` with `{ generation, stepId: "notion-connection", outcome: "completed" }`. Core opens the module once the connection is verified.

The expected database layout: Item Description (title), Status (status or select, with `NORMAL Request` and `Incomplete Request`), Vendor (select, with all 20 store names), Team (select or multi-select), Orderer/Recipient (people), SKU (rich text), Product URL (url), Qty (number), Unit Price (number) and Extension (formula or rollup, never written). The connection must be added to that database, with these capabilities: Read content, Insert content, and Read user information without email addresses.

After a restore, only the site address comes back. Core still shows the module as set up, but requests answer `503 notion_not_connected` until an Admin saves the token and connection again. Every device pairs again, and the log, the recipient list and each member's chosen person start empty. So do the copy of the open orders and the cart marks, and the Carts switch returns to on.

## Device API

All under `/public/part-requests`, through the dashboard address plus `/api`. Except for `/pair`, each needs `Authorization: Bearer <deviceKey>`. A device that was revoked, or whose member left the active roster, gets `401 pair_again`.

| Route | Body | Result |
| --- | --- | --- |
| `POST /pair` | `{ pin, deviceLabel? }` | `201 { deviceKey, memberName }` |
| `GET /options` | | `{ memberName, teams, recipients, defaultRecipientId, statuses, vendors, recipientsUpdatedMs, minimumExtensionVersion, updateUrl, databaseLink, cartsEnabled }`. See below. |
| `POST /devices/self/revoke` | None | `200 { revoked: true }`. See below. |
| `POST /recipient` | `{ notionUserId }`, or `null` to clear | Saves this member's default person. |
| `POST /check` | `{ url, sku? }` | `{ repeats }`: the same product requested by anyone in the last 7 days. It never blocks. |
| `POST /requests` | `{ submissionId, draft }` | See below. |
| `GET /requests/<id>` | | The recorded result, the same as a repeated `POST`. |
| `GET /orders` | | The team's open orders. See [Carts](#carts). `?refresh=1` is the Refresh button. |
| `POST /orders/marks` | `{ marks: [{ orderId, quantity }] }` | Records that this device built a cart. See [Carts](#carts). |
| `POST /orders/marks/clear` | `{}`, or `{ orderIds }` | Removes this device's own marks, all of them or the ones named. |
| `POST /ping` | `{ echo }` | The Phase 0 test route. |

`draft` has exactly these fields: `description`, `status`, `url`, `sku`, `team` (an option ID), `recipient` (a Notion user ID), `quantity`, `price`, `currencyConfirmed`. Use `""` and `null` for what an Incomplete request leaves out. The vendor always comes from the URL.

### What `GET /options` adds for the extension

- **`minimumExtensionVersion`** and **`updateUrl`** are constants in `src/requests.ts`. An older extension still works, and shows a notice with the link.
- **`databaseLink`** is a `https://www.notion.so/<id>` link built from the saved database ID, for the "Check ordering database" link after an uncertain result.
- **`cartsEnabled`** is the Admin's Carts switch. When it is `false`, hide Carts: `/orders` answers `403 carts_disabled`.

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

Rate limits are per device, in 10-minute windows: 30 creates, and 120 other writes (`/check`, `/recipient`, `/devices/self/revoke`, `/orders/marks` and `/orders/marks/clear`), which also count each `GET /orders` that reads Notion. Other `GET` routes, and a `GET /orders` served from the copy, are not counted, because they make no Notion call and should not write during maintenance. `/pair` allows 20 wrong PINs per client address when one is available, and 200 across the installation, then pauses for 15 minutes with `429 pairing_paused`.

### Maintenance

While an installation update is running, Core answers every non-`GET` request itself, before any plugin code runs:

```text
503  Retry-After: 30
{ "error": "An installation update requires temporary write suspension. Retry after recovery or completion.", "code": "update_maintenance" }
```

The request never reached the plugin, so nothing was recorded and nothing went to Notion. The extension should wait for `Retry-After`, then send the same request with the same `submissionId`, showing the student that the site is updating. The same rule covers any other failure with no recorded result, such as a network error or a `500`: resending the same ID is always safe, because the server allows one create per ID. `GET` routes keep working during maintenance.

## Carts

All paired devices can read the whole team's open orders, requester names and prices, unless an Admin turns Carts off. Nothing here writes to Notion, and nothing checks out.

### `GET /orders`

```json
{
  "orders": [{
    "id": "<Notion page ID>", "url": "https://app.notion.com/p/...",
    "description": "Test bracket", "vendor": "REV", "urlVendor": "REV", "sku": "REV-41-1600",
    "productUrl": "https://www.revrobotics.com/rev-41-1600/", "quantity": 2, "unitPrice": 12.5,
    "status": "NORMAL Request", "statusGroup": "NORMAL", "teams": ["Test Team One"], "requesters": ["Test Student A"],
    "cartMarks": [{ "memberName": "Test Student B", "deviceLabel": "Workshop laptop", "quantity": 2, "markedMs": 0, "expiresMs": 0, "ownDevice": false }]
  }],
  "fetchedMs": 0, "stale": false, "refreshing": false, "refreshError": null, "truncated": false, "skippedRows": 0,
  "statuses": [{ "name": "NORMAL Request", "group": "NORMAL" }]
}
```

- **Which orders.** Those in a status named NORMAL, RUSH, SLOW or INCOMPLETE, alone or followed by "Request", in any case, as listed in the saved schema. A status the database doesn't have returns nothing. `statuses` lists what was asked for. Tick by `statusGroup`: NORMAL and RUSH on, SLOW and INCOMPLETE off.
- **Blank fields.** Rows are also written by hand in Notion, so `description`, `vendor`, `sku`, `productUrl`, `quantity` and `unitPrice` can each be `null`, and `teams` and `requesters` can be empty. `productUrl` is only ever an `http` or `https` address. `quantity` is above zero and `unitPrice` is zero or more, and anything else reads as `null`.
- **`vendor` and `urlVendor`.** `vendor` is the row's Vendor option. `urlVendor` is the supported store the product address belongs to. Either can be `null`, and they can disagree.
- **`cartMarks`** is one entry per device that built a cart for this order, newest first. Empty means nobody has. Marks are always current, whatever the age of the list.
- **`skippedRows`** counts rows Notion returned that aren't open orders, which should be 0. **`truncated`** means there were more than 500 rows, and the newest are missing.

### How `GET /orders` reads Notion

The answer comes from a copy shared by all devices, kept for 60 seconds, so the number of Notion calls doesn't grow with the number of devices. A request that finds the copy out of date makes one Notion call for 50 rows, and it is the only `GET` route that writes. Nothing reads Notion for Carts when nobody is using it. `?refresh=1` reads again if the copy is at least 15 seconds old, and otherwise changes nothing.

| Status | Body | What the extension does |
| --- | --- | --- |
| `200` | The orders, `stale: false` | Show them. |
| `200` | `stale: true` or `refreshError` set | Show them with their age from `fetchedMs`. `refreshError` is a code: Notion's reply failed, or `rate_limited`. A copy is served like this for up to 15 minutes. |
| `200` | `refreshing: true` | More than 50 rows are being read. Show these, then ask again after a second. Each request reads the next 50. |
| `202` | `state: "refreshing", orders: [], retryAfterSeconds` | There is nothing to show yet, which does not mean there are no orders. Ask again after `Retry-After`. |
| `401` | `code: "pair_again"` | Prompt to pair again. |
| `403` | `code: "carts_disabled", error` | Show `error`. An Admin turned Carts off. |
| `429` | `code: "rate_limited", retryAfterSeconds` | Wait. Only when there is no copy to serve. |
| `502` | `code: "notion_unavailable"` | Try again after `Retry-After`. |
| `503` | `code: "notion_rate_limited"` | Try again after `Retry-After`. |
| `503` | `code: "notion_access_lost"`, `"notion_not_connected"`, `"notion_schema_changed"`, `"credentials_unavailable"` or `"credentials_unreadable"` | An Admin has to act. |

After a failed read, Notion is left alone for 30 seconds, or for as long as Notion asked, up to 2 minutes.

### Cart marks

`POST /orders/marks` takes up to 100 marks and answers `201 { marked, markedMs, expiresMs }`. A bad item refuses the whole request with `400 validation`. Marking an order again from the same device replaces the mark. Marks expire after 14 days, so an unbought cart can't hide an order for good, and a device can hold 500 (`409 too_many_marks`).

`POST /orders/marks/clear` answers `{ cleared }`, and it never touches another device's marks, including the same member's. It always needs a JSON body, so send `{}` to clear everything.

Marks need no Notion permission and aren't written to Notion. While Carts is off, `/orders/marks` answers `403 carts_disabled`, and clearing still works. A revoked device's marks stay until they expire, because the cart it built is still there. They go at once if the member is deleted from the roster. Both routes answer `401 pair_again` like the rest of the API, and count as other writes for the rate limit, so they can answer `429`. During maintenance they answer Core's `503`, like any other write.

The orders copy and the marks are not in backups: the copy can be read again in a minute, and a mark names a device that has to pair again after a restore. The switch isn't either, so it returns to on after a restore.

## Admin data

Under `/admin/part-requests`, Admin only. Core requires a capability marked for Operators on these routes, so the manifest declares one, and every handler still requires an Admin.

| Route | Result |
| --- | --- |
| `GET /requests?limit=&before=` | `{ requests, nextBefore, uncertainCount }`, newest first. Each shows the member, device, state and request details. `uncertainCount` covers the whole log, not just this page. |
| `GET /devices` | `{ devices, limitPerMember, roster, rosterLimited }`. `devices`: label, member, created, last used and revoked, with no key material. `roster`: the active roster, each person's `id` and `name` only, never their email or external ID. Core's projection stops at 500 members, so `rosterLimited` is true at exactly 500 and the page says the No devices list may be incomplete. |
| `POST /devices/revoke` | `{ deviceId }` ends that device's access at once. |
| `POST /recipients/refresh` | Runs the recipient refresh now. |

## Recipient refresh

The job `part-requests.recipients` runs every six hours, doing one Notion call per scheduler slice: the database layout, then workspace members, then people named on up to 2,000 existing requests (the only way to find guests), then any missing names. If the layout no longer fits, requests stop with `503 notion_schema_changed` until an Admin reconnects. It also removes expired cart marks, and a copy of the open orders nobody has used for a day. It makes no Notion call for Carts.

## Tests

- `npm test` runs the unit tests with no Core checkout. Notion is stubbed at the fetch boundary, so no request leaves the computer.
- `npm run verify:core -- <Core checkout>` composes the committed plugin into Core, then typechecks and builds it.
- `spikes/mv3-pairing` holds the Phase 0 browser test of a Manifest V3 extension against a local preview. See its README.
