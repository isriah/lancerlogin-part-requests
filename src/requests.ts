// The device API behind the extension: teams and recipients, the repeat warning and creating a request.
//
// Duplicate protection: a submission ID's row is written before Notion is called, and only the request that wrote it calls
// Notion. Anything else with that ID gets the recorded result. A row still pending after the Notion timeout means the Worker
// stopped without an answer (the client can disconnect mid-request), so it reads as uncertain and is never sent again.
import { clearRefusal, connectionProblem, insertRefused, parseSchema, readCartsEnabled, readConnection, recordRefusal, savedToken, type ConnectionRow, type Credentials } from "./connection.ts";
import { json, object, refuse } from "./http.ts";
import { AppError, databaseLink, NotionClient, pagePayload, parseDraft, statusIncomplete, statusNormal, validateDraft, type RequestDraft } from "./notion.ts";
import { deviceKeyHash, deviceRefusedMessage, installationId, readDevice, sha256Hex, type AuthenticatedDevice, type Database } from "./pairing.ts";
import { productSkuKey, productUrlKey, vendorForUrl, vendors } from "./vendors.ts";

export const repeatWindowMs = 7 * 24 * 60 * 60_000;
export const limitWindowMs = 10 * 60_000;
/** Requests sent to Notion, per device per window. Well above a student working through a parts list by hand. */
export const maximumCreates = 30;
/** Other writes per device per window: repeat checks and choosing a person. */
export const maximumGeneral = 120;
/** Longer than the Notion timeout, so a row this old has no request still working on it. */
export const pendingLimitMs = 45_000;
/** The oldest extension this plugin expects. Older ones still work, and show a notice with the update link. */
export const minimumExtensionVersion = "0.2.0";
export const extensionUpdateUrl = "https://github.com/isriah/lancerlogin-part-requests-extension/releases";

const submissionIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const uncertainMessage = "Notion may or may not have created this request. Check the database before making a new request.";

const pairAgain = () => refuse(401, "pair_again", deviceRefusedMessage);

type Submission = { readonly memberId: string | null; readonly fingerprint: string; readonly state: string; readonly pageUrl: string | null; readonly failureCode: string | null; readonly failureMessage: string | null; readonly createdMs: number };

const readSubmission = (db: Database, id: string) => db.prepare(`SELECT member_id AS memberId,fingerprint,state,page_url AS pageUrl,failure_code AS failureCode,failure_message AS failureMessage,created_ms AS createdMs
  FROM part_requests_submissions WHERE installation_id=? AND id=?`).bind(installationId, id).first<Submission>();

/** A recorded submission as the extension sees it. `state` is the answer; the status only helps generic HTTP handling. */
function recorded(id: string, row: Submission, now: number): Response {
  if (row.state === "created") return json({ submissionId: id, state: "created", pageUrl: row.pageUrl, replayed: true }, 200);
  if (row.state === "failed") return json({ submissionId: id, state: "failed", error: row.failureMessage, code: row.failureCode, replayed: true }, 502);
  if (row.state === "uncertain" || now - row.createdMs >= pendingLimitMs) return json({ submissionId: id, state: "uncertain", error: uncertainMessage, code: "notion_uncertain", replayed: true }, 202);
  return json({ submissionId: id, state: "pending", replayed: true }, 202);
}

/** Up to five recent requests for the same product by anyone, newest first. Failed requests created nothing, so they do not count. */
function readRepeats(db: Database, urlKey: string, skuKey: string, now: number) {
  return db.prepare(`SELECT member_name AS memberName,created_ms AS createdMs,page_url AS pageUrl,state FROM part_requests_submissions
    WHERE installation_id=?1 AND created_ms>=?2 AND state<>'failed' AND (url_key=?3 OR (?4<>'' AND sku_key=?4)) ORDER BY created_ms DESC LIMIT 5`)
    .bind(installationId, now - repeatWindowMs, urlKey, skuKey).all<{ memberName: string; createdMs: number; pageUrl: string | null; state: string }>().then((result) => result.results ?? []);
}

export const countStatement = (db: Database, deviceId: string, bucket: "create" | "general", now: number) =>
  db.prepare(`INSERT INTO part_requests_device_limits(installation_id,device_id,bucket,window_start_ms,requests) VALUES (?1,?2,?3,?4,1)
    ON CONFLICT(installation_id,device_id,bucket) DO UPDATE SET
      requests=CASE WHEN window_start_ms<=?5 THEN 1 ELSE requests+1 END,
      window_start_ms=CASE WHEN window_start_ms<=?5 THEN ?4 ELSE window_start_ms END
    RETURNING requests,window_start_ms AS windowStart`).bind(installationId, deviceId, bucket, now, now - limitWindowMs);

export type Count = { readonly requests: number; readonly windowStart: number };
export const rateLimited = (count: Count, now: number) => {
  const seconds = Math.max(1, Math.ceil((Number(count.windowStart) + limitWindowMs - now) / 1000));
  return refuse(429, "rate_limited", "This device has sent too many requests. Wait a few minutes and try again.", {}, seconds);
};

/** Count one write for the device. Returns the refusal when it is over the limit. */
export async function consumeGeneral(db: Database, device: Pick<AuthenticatedDevice, "deviceId">, now: number): Promise<Response | undefined> {
  const count = await countStatement(db, device.deviceId, "general", now).first<Count>();
  return count && Number(count.requests) > maximumGeneral ? rateLimited(count, now) : undefined;
}

export type DeviceRequest = { readonly db: Database; readonly authorization: string | null; readonly credentials: Credentials; readonly now: number };

/** GET /public/part-requests/options: everything the popup offers. Reads only, so it works during Core's maintenance. */
export async function readOptions({ db, authorization }: DeviceRequest): Promise<Response> {
  const keyHash = await deviceKeyHash(authorization);
  if (!keyHash) return pairAgain();
  const [device, connection, cartsEnabled, people, refresh] = await Promise.all([
    readDevice(db, keyHash),
    readConnection(db),
    readCartsEnabled(db),
    db.prepare("SELECT notion_user_id AS id,name FROM part_requests_recipients WHERE installation_id=? ORDER BY name COLLATE NOCASE,notion_user_id LIMIT 2000").bind(installationId).all<{ id: string; name: string }>(),
    db.prepare("SELECT finished_ms AS finishedMs FROM part_requests_recipient_refresh WHERE installation_id=?").bind(installationId).first<{ finishedMs: number | null }>(),
  ]);
  if (!device) return pairAgain();
  const problem = connectionProblem(connection);
  if (problem) return refuse(503, problem.code, problem.error);
  const chosen = await db.prepare("SELECT notion_user_id AS id FROM part_requests_member_recipients WHERE installation_id=? AND member_id=?").bind(installationId, device.memberId).first<{ id: string }>();
  const recipients = (people.results ?? []).map((person) => ({ id: person.id, name: person.name || "Unnamed Notion user" }));
  return json({
    memberName: device.memberName, teams: parseSchema(connection)?.properties.team.options ?? [], recipients,
    defaultRecipientId: chosen && recipients.some((person) => person.id === chosen.id) ? chosen.id : null,
    statuses: [statusNormal, statusIncomplete], vendors: vendors.map((vendor) => vendor.label), recipientsUpdatedMs: refresh?.finishedMs ?? null,
    minimumExtensionVersion, updateUrl: extensionUpdateUrl, databaseLink: connection?.databaseId ? databaseLink(connection.databaseId) : null,
    cartsEnabled,
  });
}

/**
 * POST /public/part-requests/devices/self/revoke: the device gives up its own key, which frees one of the member's slots.
 * It reads the key alone rather than through readDevice, because a key that is already revoked gets the same answer again, and
 * a member off the roster can still give up a slot. An unknown key changes nothing.
 */
export async function revokeSelf({ db, authorization, now }: DeviceRequest): Promise<Response> {
  const keyHash = await deviceKeyHash(authorization);
  const own = keyHash ? await db.prepare("SELECT id AS deviceId,revoked_ms AS revokedMs FROM part_requests_devices WHERE installation_id=? AND key_hash=?").bind(installationId, keyHash).first<{ deviceId: string; revokedMs: number | null }>() : null;
  if (!own) return pairAgain();
  const limited = await consumeGeneral(db, own, now);
  if (limited) return limited;
  if (own.revokedMs === null) {
    await db.batch([
      db.prepare("UPDATE part_requests_devices SET revoked_ms=? WHERE installation_id=? AND id=? AND revoked_ms IS NULL").bind(now, installationId, own.deviceId),
      // No person is signed in here, so there is no actor. The action says the device did this itself.
      db.prepare("INSERT INTO audit_log(id,installation_id,actor_user_id,action,target_type,target_id,created_at) SELECT ?,?,NULL,?,?,?,? WHERE changes()=1")
        .bind(crypto.randomUUID(), installationId, "part_requests.device_self_revoked", "part_requests_device", own.deviceId, new Date(now).toISOString()),
    ]);
  }
  return json({ revoked: true });
}

/** POST /public/part-requests/recipient: { notionUserId } saves this member's default person, null clears it. */
export async function saveRecipient({ db, authorization, now }: DeviceRequest, body: unknown): Promise<Response> {
  const keyHash = await deviceKeyHash(authorization);
  const device = keyHash ? await readDevice(db, keyHash) : null;
  if (!device) return pairAgain();
  const input = object(body);
  const id = input.notionUserId;
  if (id !== null && (typeof id !== "string" || id.length > 64)) return refuse(400, "validation", "Choose a person from the list.");
  const limited = await consumeGeneral(db, device, now);
  if (limited) return limited;
  if (id === null) {
    await db.prepare("DELETE FROM part_requests_member_recipients WHERE installation_id=? AND member_id=?").bind(installationId, device.memberId).run();
    return json({ defaultRecipientId: null });
  }
  const saved = await db.prepare(`INSERT INTO part_requests_member_recipients(installation_id,member_id,notion_user_id,updated_ms)
    SELECT ?1,?2,?3,?4 WHERE EXISTS(SELECT 1 FROM part_requests_recipients WHERE installation_id=?1 AND notion_user_id=?3)
    ON CONFLICT(installation_id,member_id) DO UPDATE SET notion_user_id=excluded.notion_user_id,updated_ms=excluded.updated_ms`).bind(installationId, device.memberId, id, now).run();
  if (saved.meta?.changes !== 1) return refuse(400, "validation", "Choose a person from the list.");
  return json({ defaultRecipientId: id });
}

/** POST /public/part-requests/check: { url, sku } says whether anyone asked for this product recently, before the student sends. */
export async function checkRepeats({ db, authorization, now }: DeviceRequest, body: unknown): Promise<Response> {
  const keyHash = await deviceKeyHash(authorization);
  const device = keyHash ? await readDevice(db, keyHash) : null;
  if (!device) return pairAgain();
  const input = object(body);
  const urlKey = typeof input.url === "string" && input.url.length <= 2000 ? productUrlKey(input.url) : undefined;
  if (!urlKey) return refuse(400, "validation", "Use a product URL from a supported store.");
  const limited = await consumeGeneral(db, device, now);
  if (limited) return limited;
  const sku = typeof input.sku === "string" ? input.sku.slice(0, 2000) : "";
  return json({ repeats: await readRepeats(db, urlKey, productSkuKey(input.url as string, sku), now) });
}

/** GET /public/part-requests/requests/<id>: the recorded result, for checking on a request without resending it. */
export async function readRequest({ db, authorization, now }: DeviceRequest, id: string): Promise<Response> {
  const keyHash = await deviceKeyHash(authorization);
  if (!keyHash) return pairAgain();
  const [device, row] = await Promise.all([readDevice(db, keyHash), submissionIdPattern.test(id) ? readSubmission(db, id) : null]);
  if (!device) return pairAgain();
  if (!row || row.memberId !== device.memberId) return refuse(404, "not_found", "There is no request with that ID.");
  return recorded(id, row, now);
}

const fingerprintOf = (draft: RequestDraft) => sha256Hex(JSON.stringify([draft.description, draft.status, draft.url, draft.sku, draft.team, draft.recipient, draft.quantity, draft.price, draft.currencyConfirmed]));

/** POST /public/part-requests/requests: { submissionId, draft }. See the README for each response. */
export async function createRequest({ db, authorization, credentials, now }: DeviceRequest, body: unknown): Promise<Response> {
  const keyHash = await deviceKeyHash(authorization);
  if (!keyHash) return pairAgain();
  const input = object(body);
  const id = typeof input.submissionId === "string" && submissionIdPattern.test(input.submissionId) ? input.submissionId : undefined;
  const draft = parseDraft(input.draft);
  const urlKey = draft && draft.url.length <= 2000 ? productUrlKey(draft.url) : undefined;
  const skuKey = draft && urlKey ? productSkuKey(draft.url, draft.sku) : "";
  const fingerprint = draft ? await fingerprintOf(draft) : "";

  // One D1 round trip: these all start in the same tick.
  const [device, connection, existing, recipient, repeats] = await Promise.all([
    readDevice(db, keyHash),
    readConnection(db),
    id ? readSubmission(db, id) : null,
    draft?.recipient ? db.prepare("SELECT name FROM part_requests_recipients WHERE installation_id=? AND notion_user_id=?").bind(installationId, draft.recipient).first<{ name: string }>() : null,
    urlKey ? readRepeats(db, urlKey, skuKey, now) : [],
  ]);
  if (!device) return pairAgain();
  if (!id || !draft || Object.keys(input).some((key) => key !== "submissionId" && key !== "draft")) return refuse(400, "validation", "Send a submission ID (a UUID) and a request with the expected fields.");

  // A repeated ID never reaches Notion, and works even if the connection has since gone down.
  if (existing) {
    if (existing.memberId !== device.memberId || existing.fingerprint !== fingerprint) return refuse(409, "submission_conflict", "This submission ID was already used for a different request. Start a new request.");
    return recorded(id, existing, now);
  }
  const problem = connectionProblem(connection);
  const schema = parseSchema(connection);
  if (problem || !schema) return refuse(503, problem?.code ?? "notion_not_connected", problem?.error ?? "Part Requests is not connected to Notion. Ask an Admin to finish its setup.");
  const errors = validateDraft(draft, schema, Boolean(recipient));
  if (errors.length) return refuse(400, "validation", errors.join(" "), { errors });

  let payload: Record<string, unknown>;
  let token: string;
  try {
    payload = pagePayload(draft, schema);
    token = await savedToken(connection, credentials);
  } catch (error) {
    if (!(error instanceof AppError)) throw error;
    return refuse(503, error.code, error.message);
  }

  // Count the request and record the ID together. The insert also rechecks the device and the roster at this moment.
  const vendor = vendorForUrl(draft.url)!;
  const team = schema.properties.team.options?.find((option) => option.id === draft.team);
  const results = await db.batch([
    countStatement(db, device.deviceId, "create", now),
    db.prepare(`INSERT INTO part_requests_submissions(installation_id,id,member_id,member_name,device_id,device_label,fingerprint,state,vendor_label,description,status_name,team_name,recipient_name,sku,url,url_key,sku_key,quantity,price,created_ms)
      SELECT d.installation_id,?1,d.member_id,?2,d.id,d.label,?3,'pending',?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15
      FROM part_requests_devices d JOIN members m ON m.installation_id=d.installation_id AND m.id=d.member_id AND m.active=1
      WHERE d.installation_id=?16 AND d.id=?17 AND d.revoked_ms IS NULL
        AND (SELECT requests FROM part_requests_device_limits l WHERE l.installation_id=?16 AND l.device_id=?17 AND l.bucket='create')<=?18
      ON CONFLICT(installation_id,id) DO NOTHING`)
      .bind(id, device.memberName, fingerprint, vendor.label, draft.description.trim(), draft.status, team?.name ?? null, recipient?.name ?? null, draft.sku.trim(), draft.url.trim(), urlKey!, skuKey, draft.quantity, draft.price, now, installationId, device.deviceId, maximumCreates),
  ]);
  const count = results[0]?.results?.[0] as Count | undefined;
  if (results[1]?.meta?.changes !== 1) {
    if (count && Number(count.requests) > maximumCreates) return rateLimited(count, now);
    // Another request with this ID won the race, or the device stopped being allowed since the first read.
    const winner = await readSubmission(db, id);
    if (!winner) return pairAgain();
    if (winner.memberId !== device.memberId || winner.fingerprint !== fingerprint) return refuse(409, "submission_conflict", "This submission ID was already used for a different request. Start a new request.");
    return recorded(id, winner, now);
  }

  const finish = (state: "created" | "failed" | "uncertain", pageUrl: string | null, code: string | null, message: string | null) => db.batch([
    db.prepare("UPDATE part_requests_submissions SET state=?,page_url=?,failure_code=?,failure_message=?,finished_ms=? WHERE installation_id=? AND id=? AND state='pending'").bind(state, pageUrl, code, message, Date.now(), installationId, id),
    db.prepare("UPDATE part_requests_devices SET last_used_ms=? WHERE installation_id=? AND id=?").bind(now, installationId, device.deviceId),
  ]).catch(() => undefined); // The pending row stays and later reads as uncertain, so nothing is ever sent twice.

  try {
    const pageUrl = await new NotionClient(token).create(payload);
    await finish("created", pageUrl, null, null);
    await clearRefusal(db, connection as ConnectionRow, true);
    return json({ submissionId: id, state: "created", pageUrl, repeats }, 201);
  } catch (error) {
    if (!(error instanceof AppError)) {
      await finish("uncertain", null, "unexpected", uncertainMessage);
      throw error;
    }
    if (error.uncertain) {
      await finish("uncertain", null, error.code, uncertainMessage);
      return json({ submissionId: id, state: "uncertain", error: uncertainMessage, code: "notion_uncertain" }, 202);
    }
    await finish("failed", null, error.code, error.message);
    // A 403 here, from a connection that passed verification by reading the database, is a missing Insert content capability.
    await recordRefusal(db, connection as ConnectionRow, error.code === "notion_403" ? insertRefused : error.code, now);
    const retryAfter = object(error.details).retryAfterSeconds;
    return json({ submissionId: id, state: "failed", error: error.message, code: error.code, ...(typeof retryAfter === "number" ? { retryAfterSeconds: retryAfter } : {}) }, 502);
  }
}
