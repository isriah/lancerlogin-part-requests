// Data for the Admin pages: the request log and paired devices, with revoke, pairing PINs and a manual refresh.
// Core lets assigned Operators reach /admin/part-requests, because it requires a capability marked for Operators. Every
// handler here still requires an Admin, so that capability grants nothing.
import { listActiveRosterIdentities, type D1Database } from "@lancerlogin/module-sdk/api";
import { requireAdmin, type AdminRouteContext } from "./connection.ts";
import { json, object, refuse } from "./http.ts";
import { installationId, issuePinForMember, maximumDevicesPerMember, type Database } from "./pairing.ts";
import { countStatement, limitWindowMs, pendingLimitMs, type Count } from "./requests.ts";

const pageSize = (value: string | null) => Math.min(100, Math.max(1, Number.parseInt(value ?? "", 10) || 50));

/** GET /requests?limit=&before=: newest first. `before` is the `nextBefore` of the previous page. `uncertainCount` covers the whole log. */
async function requestLog(context: AdminRouteContext, db: Database, now: number) {
  const limit = pageSize(context.url.searchParams.get("limit"));
  const before = Number(context.url.searchParams.get("before"));
  const [rows, uncertain] = await Promise.all([
    db.prepare(`SELECT id,member_name AS memberName,device_label AS deviceLabel,device_id AS deviceId,state,vendor_label AS vendor,description,status_name AS status,team_name AS team,
      recipient_name AS recipient,sku,url,quantity,price,page_url AS pageUrl,failure_code AS failureCode,failure_message AS failureMessage,created_ms AS createdMs,finished_ms AS finishedMs
    FROM part_requests_submissions WHERE installation_id=? AND created_ms<? ORDER BY created_ms DESC,id LIMIT ?`)
      .bind(installationId, Number.isSafeInteger(before) && before > 0 ? before : Number.MAX_SAFE_INTEGER, limit + 1).all<{ state: string; createdMs: number } & Record<string, unknown>>().then((result) => result.results ?? []),
    // A pending row past its time limit reads as uncertain, the same as in the page below.
    db.prepare("SELECT COUNT(*) AS count FROM part_requests_submissions WHERE installation_id=? AND (state='uncertain' OR state='pending' AND created_ms<=?)")
      .bind(installationId, now - pendingLimitMs).first<{ count: number }>(),
  ]);
  const page = rows.slice(0, limit).map((row) => row.state === "pending" && now - row.createdMs >= pendingLimitMs ? { ...row, state: "uncertain" } : row);
  return json({ requests: page, nextBefore: rows.length > limit ? page.at(-1)?.createdMs ?? null : null, uncertainCount: Number(uncertain?.count ?? 0) });
}

/** Core's roster projection stops here, with no paging and no total, so a full answer may have left people out. */
export const rosterLimit = 500;

/**
 * GET /devices: every paired device, revoked ones included, with no key material, and the active roster, so a member with no
 * device can be listed. Only each person's ID and name leave here: the projection also has their email and external ID.
 */
async function devices(db: Database) {
  const [deviceRows, roster] = await Promise.all([db.prepare(`SELECT d.id,d.label,d.member_id AS memberId,m.first_name AS firstName,m.last_name AS lastName,m.active AS memberActive,d.created_ms AS createdMs,d.last_used_ms AS lastUsedMs,d.revoked_ms AS revokedMs
    FROM part_requests_devices d JOIN members m ON m.installation_id=d.installation_id AND m.id=d.member_id WHERE d.installation_id=? ORDER BY d.revoked_ms IS NOT NULL,m.last_name COLLATE NOCASE,m.first_name COLLATE NOCASE,d.created_ms`)
    .bind(installationId).all<{ id: string; label: string; memberId: string; firstName: string; lastName: string; memberActive: number; createdMs: number; lastUsedMs: number | null; revokedMs: number | null }>(),
  listActiveRosterIdentities(db as unknown as D1Database, installationId)]);
  const people = roster.results ?? [];
  return json({
    limitPerMember: maximumDevicesPerMember,
    devices: (deviceRows.results ?? []).map(({ firstName, lastName, memberActive, ...row }) => ({ ...row, memberName: `${firstName} ${lastName}`.trim(), memberActive: memberActive === 1 })),
    roster: people.map(({ id, firstName, lastName }) => ({ id, name: `${firstName} ${lastName}`.trim() })),
    rosterLimited: people.length === rosterLimit,
  });
}

/** POST /devices/revoke: { deviceId }. Ends that device's access at once. Its log entries stay. */
async function revoke(context: AdminRouteContext, db: Database, actor: string, now: number) {
  const { deviceId } = object(await context.json(1024));
  if (typeof deviceId !== "string" || !deviceId || deviceId.length > 64) return refuse(400, "validation", "Choose a device.");
  const results = await db.batch([
    db.prepare("UPDATE part_requests_devices SET revoked_ms=? WHERE installation_id=? AND id=? AND revoked_ms IS NULL").bind(now, installationId, deviceId),
    db.prepare(`INSERT INTO audit_log(id,installation_id,actor_user_id,action,target_type,target_id,created_at) SELECT ?,?,?,?,?,?,? WHERE changes()=1`)
      .bind(crypto.randomUUID(), installationId, actor, "part_requests.device_revoked", "part_requests_device", deviceId, new Date(now).toISOString()),
  ]);
  if (results[0]?.meta?.changes !== 1) return refuse(404, "not_found", "That device is not paired.");
  return json({ revoked: deviceId });
}

/** PINs one Admin may generate per rate-limit window. Well above pairing a team one by one, and a stop for a stuck script. */
export const maximumAdminPins = 30;

/** Why the Admin page got no PIN, in words an Admin can act on. Never the PIN or anything about one. */
export const adminPinRefusals = {
  validation: [400, "Choose a member."],
  unknown_member: [404, "That member is not on the roster. Choose someone else."],
  not_active: [409, "That member is not on the active roster, so they cannot pair a device."],
  not_set_up: [409, "Part Requests is not set up yet. Finish the Notion connection first."],
  device_limit: [409, `That member already has ${maximumDevicesPerMember} paired devices, the most allowed. Remove one of their devices first, then generate a PIN.`],
  devices_changed: [409, "That member's paired devices changed while the PIN was being made. Try again."],
  rate_limited: [429, "Too many PINs were generated in the last few minutes. Wait a few minutes and try again."],
} as const satisfies Record<string, readonly [number, string]>;

const pinRefusal = (code: keyof typeof adminPinRefusals, retryAfterSeconds?: number) => refuse(adminPinRefusals[code][0], code, adminPinRefusals[code][1], {}, retryAfterSeconds);

/**
 * POST /pins: { memberId }. A pairing PIN for a member, for someone without Discord. It is the same PIN /ordering-pin makes,
 * through the same function: one use, 10 minutes, the device limit, only its hash stored, and any earlier unused PIN of that
 * member cancelled. The response is the only place the PIN appears. The audit row names the Admin and the member, never the PIN.
 */
async function issueAdminPin(context: AdminRouteContext, db: Database, actor: string, now: number) {
  const { memberId } = object(await context.json(1024));
  if (typeof memberId !== "string" || !memberId || memberId.length > 64) return pinRefusal("validation");
  // Counted per Admin in the devices' counter table, under a key no device ID can take.
  const count = await countStatement(db, `admin-pins:${actor}`, "general", now).first<Count>();
  if (count && Number(count.requests) > maximumAdminPins) return pinRefusal("rate_limited", Math.max(1, Math.ceil((Number(count.windowStart) + limitWindowMs - now) / 1000)));
  const result = await issuePinForMember(db, memberId, now, {
    after: [db.prepare("INSERT INTO audit_log(id,installation_id,actor_user_id,action,target_type,target_id,created_at) SELECT ?,?,?,?,?,?,? WHERE changes()=1")
      .bind(crypto.randomUUID(), installationId, actor, "part_requests.pin_issued", "member", memberId, new Date(now).toISOString())],
  });
  if (!result.issued) return pinRefusal(result.reason);
  const { issued: _, ...pin } = result;
  return json(pin, 201);
}

/** POST /recipients/refresh: run the refresh job now. This write also pokes it. */
async function refresh(db: Database) {
  await db.prepare(`INSERT INTO part_requests_recipient_refresh(installation_id,step,next_due_ms) VALUES (?,'idle',0)
    ON CONFLICT(installation_id) DO UPDATE SET next_due_ms=0`).bind(installationId).run();
  return json({ requested: true }, 202);
}

/** /admin/part-requests */
export async function adminRoute(context: AdminRouteContext): Promise<Response | undefined> {
  const path = context.url.pathname.slice("/admin/part-requests".length);
  const method = context.request.method;
  const known = (path === "/requests" || path === "/devices") && method === "GET" || (path === "/devices/revoke" || path === "/recipients/refresh" || path === "/pins") && method === "POST";
  if (!known) return undefined;
  const { userId } = await requireAdmin(context);
  const db = context.db as Database; const now = Date.now();
  if (path === "/requests") return requestLog(context, db, now);
  if (path === "/devices") return devices(db);
  if (path === "/pins") return issueAdminPin(context, db, userId, now);
  return path === "/devices/revoke" ? revoke(context, db, userId, now) : refresh(db);
}
