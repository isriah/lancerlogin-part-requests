# LancerLogin Part Requests plugin

Students click a browser extension on a vendor's product page, review the details and create a request in the team's Notion ordering database. LancerLogin Core holds the Notion token, in its shared Notion connection. Students never sign in to LancerLogin.

**Needs Core's Notion connection: LancerLogin Core 2.1.0-beta.12 / module SDK 1.8.0 or later.** From 1.2.0 the plugin keeps no Notion token of its own. Core saves it in **Settings > Integrations > Notion** and sends every Notion request; the plugin names its `orders` binding, the ordering database an Admin chooses for it. An installation coming from 1.1 needs nothing done: see [Moving from 1.1](#moving-from-11).

**Status: v1.3.0.** The backend and the Admin pages are built: pairing, the Notion connection, the device API, the request log, the recipient job, [stale-request reminders](#stale-request-reminders), Core's setup screen and **Settings > Modules > Part Requests**. Carts here means reading open orders and recording who built a cart. Filling store carts belongs to the extension.

| Plugin | LancerLogin Core | Module SDK | Module contract |
| --- | --- | --- | --- |
| 1.3.x | `>=2.1.0-beta.12 <3.0.0` | `^1.8.0` | 1 |
| 1.2.x | `>=2.1.0-beta.12 <3.0.0` | `^1.8.0` | 1 |
| 1.1.x | `>=2.1.0-beta.7 <3.0.0` | `^1.6.0` | 1 |
| 1.0.x | `>=2.1.0-beta.7 <3.0.0` | `^1.6.0` | 1 |
| 0.1.x | `>=2.1.0-beta.7 <3.0.0` | `^1.6.0` | 1 |

## Admin pages

**Settings > Modules > Part Requests**, Admin only, has four sections:

- **Connection:** any problem and its fix at the top, then Core's Notion connection (with a link to **Settings > Integrations > Notion**, where the token is saved), the ordering database, last verified time, site address and Open setup, which reopens Core's setup screen; Core's own database picker for the `orders` binding, with **Use the previous ordering database** while Core has none chosen or a different one; **Verify connection**, which checks the chosen database's layout; the recipient list with Refresh now; pairing, with a notice while it is paused; and the Carts switch. Old `?section=setup` and `?section=status` links open this section.
- **Requests log:** every request with its member and device, newest first, with a banner when any result is uncertain.
- **Paired devices:** counts, search by name or device, and filters for No devices, At the limit, Inactive 30+ days and Off roster, then one compact row per member by name, including members with no devices. A row opens to that member's devices, with Revoke. **Generate pairing PIN** makes a PIN for a chosen member, for example one without Discord: the same PIN `/ordering-pin` makes, shown once with its expiry, the site address and a Copy button, and removed from the screen when it expires or the dialog closes. Inactive is a prompt to look, not a reason to revoke: last used only changes when a device sends a request or marks a cart item.
- **Reminders:** stale-request reminders: a status card with **Check ordering database**, **Preview** and **Send reminders now**; the settings form; Core's picker for the optional People database, with **Check People**; and the last run. See [Stale-request reminders](#stale-request-reminders).

Core shows its own setup screen by itself until setup is complete, and an Admin can reopen it from Connection. When Notion answers 401, 403 or 404 to a request or an orders read, or the refresh job gets a 403 or 404 reading the database or a 401 from any call, the code and time are recorded and Connection shows the rejected token or lost access at the top instead of Connected. A 500, a 429 and Core's own refusals record nothing. It clears on a successful verify or the next call that reaches the database, so a brief glitch doesn't stick. Listing users is not such a call. It doesn't stop requests or change what students are told: each call still tries Notion and reports its own result, and Carts can serve its copy for a while.

A 403 listing workspace members means Core's connection lacks Read user information. That is not lost access: the refresh carries on with the people named on existing requests, and the recipient card says what to check.

Core keeps a module open once its setup is complete, so a problem with Core's connection later stops requests without closing these pages.

## Notion capabilities

Core's Notion connection needs these of Notion's capabilities for this version: **Read content**, **Insert content**, **Update content**, **Insert comments** and **Read user information** (without email addresses). Update content and Insert comments are used only by stale-request reminders: requests, Carts and the recipient list work without them. It never receives email addresses. The manifest declares exactly what it calls, and Core refuses anything else:

- the required `orders` binding (the ordering database) with `retrieve`, `query`, `pages.create`, `comments.create` (a reminder comment) and `pages.update` (setting a request's Reminder sent date, and nothing else);
- the optional `people` binding (the People database) with `retrieve` and `query` only, so Part Requests can never write to it;
- users `list` and `retrieve`.

## Moving from 1.1

Version 1.1 saved the Notion token itself. The first request, Carts read, options read, setup page load or job run in 1.2 that finds that copy hands it to Core with `services.notion.importLegacyConnection` and clears the plugin's copy, whatever Core answers:

- **`imported`**: Core had no connection, so it now holds this token, after checking it with Notion. Core also chooses the ordering database for `orders` when Notion confirms the data source belongs to it, so requests carry on with nothing for an Admin to do.
- **`kept-existing`**: Core already had a connection, which wins. If no database is chosen for `orders` yet, requests stop with `503 notion_not_connected` until an Admin chooses one on the Connection tab; **Use the previous ordering database** asks Core to choose the one 1.1 used, and Core checks its own token can read it first. If it can't, share the ordering database with the Core connection in Notion and try again.
- **`unreadable`**: the copy can't be decrypted, or Notion refuses it. An Admin saves the token in **Settings > Integrations > Notion**.

The copy stays only while credential encryption is unavailable (Core could not read any token then) or when the call failed without an answer; the next request tries again. Each move writes `part_requests.token_moved_to_core` to the audit log, with the outcome and no actor, and Core writes its own entry. The `ciphertext` and `iv` columns stay in `part_requests_notion`, empty, so 1.2 needs no migration; going back to 1.1 means saving the token there again.

## Setup (Admin)

Core refuses `/admin/<module>` until a module's setup is complete, so setup uses `/module-setup/part-requests`, which stays open to Admins afterwards. Each route needs an Admin session, and each change must come from the dashboard origin.

| Route | Body | Result |
| --- | --- | --- |
| `GET /status` | | What is set up and what is missing, never a token. `core` is Core's connection as `services.notion.status()` reports it (`saved`, `enabled`, `readable`, `connected`, `pausedUntilMs`, `capabilities`); `binding` is the database Core has chosen for `orders` (`databaseId`, `dataSourceId`, `name`) or `null`; `databaseId`, `dataSourceId`, `dataSourceName` and `verifiedMs` are the database this plugin last verified; `legacyTokenSaved` is true only while a 1.1 token is waiting to move to Core. `problem` is, in the order to fix them: `notion_not_configured`, `notion_unreadable`, `notion_disabled` (Core's connection), `orders_unbound` (no database chosen), `not_verified` (the chosen database's layout has not been checked, for example after choosing another one), `notion_schema_changed`; then, without stopping requests, `notion_token_rejected` and `notion_access_lost` with `rejectedMs`, and `notion_insert_refused` after a 403 creating a page, which is a connection without Insert content (only a page that is created clears that one, or verifying a different database). Also `pairingPausedUntilMs` (the shared pause, `null` when pairing is open), `pairedDevices`, `deviceLimit` and `cartsEnabled`. |
| `POST /verify` | `{}` | What the Verify button calls. Reads the layout of the database Core has bound for `orders`, through Core, checks it and saves it with the dashboard address as the site address. A failed check saves nothing. Refusals: `409` with `notion_not_configured`, `notion_unreadable`, `notion_disabled` or `notion_unbound`; `422 schema_mismatch` (says which property is wrong), `notion_token_rejected`, `notion_403` or `notion_404`; `503 notion_rate_limited`; `502 notion_unavailable`. The token and the database are chosen in Core: in **Settings > Integrations > Notion**, or with Core's picker on this page (`PUT /admin/integrations/notion/bindings/part-requests/orders`). |
| `PUT /carts` | `{ enabled }` | Turns Carts on or off for the installation and returns the same as `GET /status`. It is on by default. Turning it off also deletes the copy of the open orders. |

Then record the step with Core: `PUT /admin/modules/part-requests/setup` with `{ generation, stepId: "notion-connection", outcome: "completed" }`. Core opens the module once the connection is verified.

The expected database layout: Item Description (title), Status (status or select, with `NORMAL Request` and `Incomplete Request`), Vendor (select, with all 20 store names), Team (select or multi-select), Orderer/Recipient (people), SKU (rich text), Product URL (url), Qty (number), Unit Price (number) and Extension (formula or rollup, never written). Core's Notion connection must be added to that database, with the capabilities above.

After a restore, the site address comes back with this plugin's data, and Core's Notion connection and `orders` binding come back with Core's part of an entire-installation backup (an installation whose key can't read the token shows it as saved but unreadable until an Admin saves it again). Core still shows the module as set up, but requests answer `503 notion_not_connected` until an Admin verifies the connection again. Every device pairs again, and the log, the recipient list and each member's chosen person start empty. So do the copy of the open orders and the cart marks, and the Carts switch returns to on. Reminders are off, and their settings and history are gone.

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
| `502` | `state: "failed", code, error` | Notion refused it, or Core refused it before sending (`notion_not_sent`, or a code such as `notion_429` while Core holds calls after a rate limit), so nothing was created. Repeats of this ID return the same answer; trying again needs a new ID. |
| `400` | `code: "validation", errors` | Nothing was recorded. Fix it and resend. |
| `401` | `code: "pair_again"` | Prompt to pair again. |
| `409` | `code: "submission_conflict"` | The ID was used for different content or by another member. Start a new request. |
| `429` | `code: "rate_limited", retryAfterSeconds` | Nothing was recorded. Retry the same ID after the wait. |
| `503` | `code: "notion_not_connected"` or `"notion_schema_changed"` | An Admin has to act. Nothing was recorded. `notion_not_connected` covers every problem with Core's connection or the ordering database. |
| `503` | `code: "delivery_paused"`, `Retry-After: 60` | Core is holding every module's Notion writes (an Admin's Stop, or a restore). Nothing was recorded; retry the same ID later. |
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
| `503` | `code: "notion_access_lost"`, `"notion_not_connected"` or `"notion_schema_changed"` | An Admin has to act. |

After a failed read, Notion is left alone for 30 seconds, or for as long as Notion asked, up to 2 minutes. After Notion rate limits any module, Core holds every module's calls until the time Notion named; Carts serves its copy meanwhile.

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
| `POST /pins` | `{ memberId }`. `201 { pin, expiresMs, siteAddress, memberId, memberName, pairedDevices }`: a pairing PIN for that member, who needs no Discord account. It is made by the same function as `/ordering-pin`, so it is the same 8-character PIN, works once, expires in 10 minutes, counts against the device limit, is stored only as its SHA-256, and cancels the member's earlier unused PIN from either path. The response is the only place the PIN appears. Each PIN writes one audit row, `part_requests.pin_issued`, with the Admin's user ID, the member ID as the target and the time, never the PIN. Refusals: `400 validation`, `404 unknown_member`, `409 not_active` (off the active roster), `409 device_limit` (remove a device first), `409 not_set_up` (no site address saved yet), `409 devices_changed`, and `429 rate_limited` with `Retry-After` after 30 PINs from one Admin in 10 minutes. |

## Stale-request reminders

Off until an Admin turns them on. On the chosen days (Mon, Wed and Fri at 15:00 in the installation's time zone by default), the job `part-requests.reminders` finds every request in the ordering database whose Status is Incomplete Request, that was created more than the threshold ago (2 days by default) and whose **Reminder sent** is empty or older than the cooldown (2 days by default). For each one, in this order:

1. **A Notion comment on the request**, mentioning each person in Orderer/Recipient, so Notion notifies them.
2. **A Discord message** in the chosen channel: mentions of the people who could be matched to a member, the same text, and the request's link.
3. **Reminder sent** is set to now, so the request is not reminded again until the cooldown passes.

The text, the same in Notion and Discord, with the request's Item Description and the threshold filled in:

> Your part request '&lt;Item Description&gt;' has been in Incomplete Request for more than &lt;N&gt; days, so it has not been ordered. Finish the details and change the Status to NORMAL, RUSH or SLOW Request, or delete the request if you no longer need it.

A threshold of exactly one day reads "1 day", and one below a day, for testing, reads in minutes. Nothing else on a request is changed: no status, no archive, no trash.

**Setting it up.** Reminders always use the ordering database chosen on the Connection tab, through Core's `orders` binding. On the Reminders tab:

1. Add **Created** (created time) and **Reminder sent** (date) to the ordering database, and make sure Status has Incomplete Request, NORMAL Request, RUSH Request and SLOW Request. Turn on **Insert comments** and **Update content** for Core's Notion connection.
2. Press **Check ordering database**. It reads the layout through Core and saves it; a failed check saves nothing.
3. Optionally choose the **People database** with Core's picker and press **Check People**. It needs Notion account (people), LancerLogin member ID (text) and Active (checkbox), and is only ever read.
4. Choose the days, time, thresholds and the Discord channel (required while reminders are on), turn reminders on and save. **Preview** lists what the next run would do without sending or changing anything; **Send reminders now** starts a run at once.

**Who gets pinged.** With a checked People database: Notion account, then its LancerLogin member ID (by default the ID members type, the roster's external ID), then that active member's Discord account. A Notion account or member ID on more than one active row is ambiguous, and nobody is pinged for it. Without People, or while it has no active rows: the one active member who chose that person as their default recipient, which may be a mentor. Inactive members and members without a linked Discord account are not pinged. Everyone on the request is still mentioned in the Notion comment, and the last run lists each skipped ping and why.

**Failures.** A comment Notion refuses with 400 or 429 is tried 3 times; a 403 (Insert comments off) or 404 stops the run, and the tab says what to turn on. A comment Notion did not confirm (a network failure, 5xx or 409) is never sent again: it counts for the cooldown, is listed under "Check the page", and skips Discord and the mark. Discord is tried twice, and the mark still runs if it fails. The mark is tried 3 times; a 403 (Update content off) stops the run. While Core holds deliveries (after a restore) or waits out a Notion rate limit, the run waits. If Core's connection or the `orders` binding is unusable, or Core now points `orders` at another database, the run stops before sending and asks for a new check; a People database pointed elsewhere is not used until it is checked again. A run stops at 200 requests and says so. Run history is kept for 30 days.

**Privacy.** Notion gets only the comment: mentions and the text. Discord gets only mentions, the item description and the request's link: no names, team, price or check-in data, and no DMs. Reminder tables, logs and job results hold Notion and Discord IDs and counts, never names or emails; the Admin page shows names from the recipient list. Reminder settings and history are not in backups, so a restore turns reminders off.

**Budget.** Each scheduler slice is one step: the layouts (2 Notion requests with People), one page of 20 stale requests or 100 People rows (1), a comment or a mark (2, because Core first reads the page to prove it is in the ordering database), or one Discord message. Measured against the test stand-in, the worst slice uses 7 D1 queries and 2 external requests (9 of a slice's 40; the limits are 30 D1 and 12 external), and a cron-fallback pass runs at most 3 slices and stops before Core's 8 Notion requests per invocation (worst measured: 4 Notion requests, 22 of the pass's 46). Ten stale requests take about 35 slices.

Routes, under `/admin/part-requests/reminders`, Admin only; each change must come from the dashboard origin and is audited (`part_requests.reminders_saved`, `_target_verified`, `_people_verified`, `_people_removed`, `_run_requested`):

| Route | Body | Result |
| --- | --- | --- |
| `GET` (no further path) | | Settings; `core` (`connected`, `capabilities.comment` and `.update`, `ordersBound`, `peopleBound`); the checked layout `target`, with `current` while it is the data source Core binds; `targetVerified`; `people`; `problem`, the last run's or check's code; `timeZone`; `nextRunMs`; `activeRun`; and `lastRun`, with counts and the requests to look at. |
| `PUT /settings` | `{ revision, enabled, weekdays, runTime, staleMinutes, cooldownMinutes, discordChannelId, peopleKey }` | Saves the whole form. `400 validation` with `errors`, `409 target_unverified`, `409 revision_conflict`. Turning reminders off stops a run in progress. |
| `POST /verify` | `{}` | Checks the ordering database's layout through `orders`. The same refusals as `POST /module-setup/part-requests/verify`. |
| `POST /people/verify` | `{}` | Checks the People database's layout through `people`. `409 people_unbound` until one is chosen. |
| `DELETE /people` | | Stops using People; pings go back to default recipients. |
| `POST /preview` | | A dry run: at most 3 Notion requests, and nothing written anywhere. |
| `POST /run` | | `202 { runKey }`. `409 reminders_off`, `target_unverified` or `run_active`. |

## Recipient refresh

The job `part-requests.recipients` runs every six hours, doing one Notion call per scheduler slice (five per run under Core's cron fallback): the database layout, then workspace members, then people named on up to 2,000 existing requests (the only way to find guests), then any missing names. If the layout no longer fits, requests stop with `503 notion_schema_changed` until an Admin reconnects. It also removes expired cart marks, and a copy of the open orders nobody has used for a day. It makes no Notion call for Carts. It waits, and says so on the recipient card, while Core's connection is not usable or the `orders` binding is not the verified database.

Notion calls go through Core and count against the scheduler's budget like Discord requests: each is one provider request plus one D1 read, and Core reads its connection once per run. Measured against the test stand-in: an ordinary slice uses 6 of a Durable Object slice's 40 subrequests (1 provider request); the slice that moves a 1.1 token uses 15 (3); a cron-fallback run uses 23 of the pass's 46 (5 Notion requests), or 32 (7) on the run that moves a 1.1 token, within Core's 8 Notion requests per invocation. A request or Carts read makes one Notion request, or three when it moves a 1.1 token.

## Tests

- `npm test` runs the unit tests with no Core checkout. `tests/helpers/core-notion-stub.ts` stands in for Core's `services.notion` (bindings, refusals, the 8-request cap, the shared pause after a rate limit, held deliveries and `importLegacyConnection`), and Notion is stubbed at the fetch boundary under it, so no request leaves the computer.
- `npm run verify:core -- <Core checkout>` composes the committed plugin into Core, then typechecks and builds it.
- `spikes/mv3-pairing` holds the Phase 0 browser test of a Manifest V3 extension against a local preview. See its README.
