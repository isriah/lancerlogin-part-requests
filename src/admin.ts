// Data for the Admin page, which is a later phase: the request log and paired devices, with revoke and a manual refresh.
// Core lets assigned Operators reach /admin/part-requests, because it requires a capability marked for Operators. Every
// handler here still requires an Admin, so that capability grants nothing.
import { requireAdmin, type AdminRouteContext } from "./connection.ts";
import { json, object, refuse } from "./http.ts";
import { installationId, type Database } from "./pairing.ts";
import { pendingLimitMs } from "./requests.ts";

const pageSize = (value: string | null) => Math.min(100, Math.max(1, Number.parseInt(value ?? "", 10) || 50));

/** GET /requests?limit=&before=: newest first. `before` is the `nextBefore` of the previous page. */
async function requestLog(context: AdminRouteContext, db: Database, now: number) {
  const limit = pageSize(context.url.searchParams.get("limit"));
  const before = Number(context.url.searchParams.get("before"));
  const rows = (await db.prepare(`SELECT id,member_name AS memberName,device_label AS deviceLabel,device_id AS deviceId,state,vendor_label AS vendor,description,status_name AS status,team_name AS team,
      recipient_name AS recipient,sku,url,quantity,price,page_url AS pageUrl,failure_code AS failureCode,failure_message AS failureMessage,created_ms AS createdMs,finished_ms AS finishedMs
    FROM part_requests_submissions WHERE installation_id=? AND created_ms<? ORDER BY created_ms DESC,id LIMIT ?`)
    .bind(installationId, Number.isSafeInteger(before) && before > 0 ? before : Number.MAX_SAFE_INTEGER, limit + 1).all<{ state: string; createdMs: number } & Record<string, unknown>>()).results ?? [];
  const page = rows.slice(0, limit).map((row) => row.state === "pending" && now - row.createdMs >= pendingLimitMs ? { ...row, state: "uncertain" } : row);
  return json({ requests: page, nextBefore: rows.length > limit ? page.at(-1)?.createdMs ?? null : null });
}

/** GET /devices: every paired device, revoked ones included, with no key material. */
async function devices(db: Database) {
  const rows = (await db.prepare(`SELECT d.id,d.label,d.member_id AS memberId,m.first_name AS firstName,m.last_name AS lastName,m.active AS memberActive,d.created_ms AS createdMs,d.last_used_ms AS lastUsedMs,d.revoked_ms AS revokedMs
    FROM part_requests_devices d JOIN members m ON m.installation_id=d.installation_id AND m.id=d.member_id WHERE d.installation_id=? ORDER BY d.revoked_ms IS NOT NULL,m.last_name COLLATE NOCASE,m.first_name COLLATE NOCASE,d.created_ms`)
    .bind(installationId).all<{ id: string; label: string; memberId: string; firstName: string; lastName: string; memberActive: number; createdMs: number; lastUsedMs: number | null; revokedMs: number | null }>()).results ?? [];
  return json({ devices: rows.map(({ firstName, lastName, memberActive, ...row }) => ({ ...row, memberName: `${firstName} ${lastName}`.trim(), memberActive: memberActive === 1 })) });
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
  const known = (path === "/requests" || path === "/devices") && method === "GET" || (path === "/devices/revoke" || path === "/recipients/refresh") && method === "POST";
  if (!known) return undefined;
  const { userId } = await requireAdmin(context);
  const db = context.db as Database; const now = Date.now();
  if (path === "/requests") return requestLog(context, db, now);
  if (path === "/devices") return devices(db);
  return path === "/devices/revoke" ? revoke(context, db, userId, now) : refresh(db);
}
