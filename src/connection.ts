// The Notion connection as Part Requests sees it, and the Admin setup routes for it.
//
// From 1.2.0 the token lives in Core (Settings > Integrations > Notion) and every Notion request goes through
// `services.notion` with the `orders` binding, which an Admin points at the ordering database. This plugin keeps only what
// is its own: the ordering database's layout (`schema_json`), when it was last checked, and why Notion last refused a call.
//
// Moving from 1.1: a 1.1 installation saved the token itself, as ciphertext in part_requests_notion. The first request or job
// run that finds it hands it to Core with `importLegacyConnection` and then clears the plugin's copy. The columns stay, empty,
// so the table needs no migration; going back to 1.1 means saving the token there again.
//
// These routes live under /module-setup, not /admin: Core refuses /admin/<module> until setup is complete, and they are how
// setup completes. Core keeps /module-setup open to Admins afterwards.
import type { NotionBinding, NotionService, NotionServiceStatus } from "@lancerlogin/module-sdk/api";
import { AppError, OrdersNotion, ordersBinding, sameId, type Schema } from "./notion.ts";
import { object, refuse, json } from "./http.ts";
import { installationId, maximumDevicesPerMember, type Database, type Statement } from "./pairing.ts";

export type Credentials = {
  readonly available: boolean;
  encrypt(value: Record<string, string>): Promise<{ ciphertext: string; iv: string }>;
  decrypt(ciphertext: string, iv: string): Promise<Record<string, string>>;
};
/** What Core gives a route or job: its Notion connection, and the credentials check that says whether Core can read a token at all. */
export type NotionServices = { readonly credentials: Credentials; readonly notion: NotionService };
export type ConnectionRow = {
  /** A token saved by Part Requests 1.1, until it has been handed to Core. Never used for a request. */
  readonly ciphertext: string | null; readonly iv: string | null;
  readonly databaseId: string | null; readonly dataSourceId: string | null;
  readonly schemaJson: string | null; readonly verifiedMs: number | null; readonly schemaError: string | null;
  readonly rejectionCode: string | null; readonly rejectedMs: number | null;
};

export const readConnection = (db: Database) => db.prepare(`SELECT ciphertext,iv,database_id AS databaseId,data_source_id AS dataSourceId,schema_json AS schemaJson,
  verified_ms AS verifiedMs,schema_error AS schemaError,rejection_code AS rejectionCode,rejected_ms AS rejectedMs FROM part_requests_notion WHERE installation_id=?`).bind(installationId).first<ConnectionRow>();

/** The Admin's Carts switch. On until an Admin turns it off, so a missing settings row reads as on. */
export const readCartsEnabled = (db: Database) => db.prepare("SELECT carts_enabled AS enabled FROM part_requests_settings WHERE installation_id=?").bind(installationId).first<{ enabled: number }>().then((row) => row?.enabled !== 0);

/** Forget the copy of the open orders: people's names and prices should not outlast the reason for holding them. */
const clearOrdersStatements = (db: Database): Statement[] => [
  db.prepare("DELETE FROM part_requests_orders_cache WHERE installation_id=?").bind(installationId),
  db.prepare(`UPDATE part_requests_orders_state SET published_generation=0,published_ms=NULL,published_truncated=0,published_skipped=0,build_generation=NULL,build_cursor=NULL,build_pages=0,build_started_ms=NULL,build_skipped=0,lease_until_ms=0,last_error=NULL WHERE installation_id=?`).bind(installationId),
];

export const parseSchema = (row: ConnectionRow | null): Schema | undefined => {
  if (!row?.schemaJson) return undefined;
  try { return JSON.parse(row.schemaJson) as Schema; } catch { return undefined; }
};

// ---- Moving a 1.1 token into Core

/**
 * Hand a token Part Requests 1.1 saved to Core, then clear this plugin's copy. Core fills its connection only when it has
 * none, and keeps the ordering database only when Notion confirms the data source belongs to it, so a working 1.1
 * installation carries on without an Admin doing anything.
 *
 * Every answer Core gives is final, so the copy is cleared after each of them:
 * - `imported`: Core now holds the token, and the `orders` binding when Notion confirmed it.
 * - `kept-existing`: Core already had a connection, and Core never replaces one with this token. An Admin chooses the
 *   ordering database for Core's connection (the setup page offers the one 1.1 used).
 * - `unreadable`: neither Core nor this plugin can use the token (it can't be decrypted, or Notion refused it). An Admin
 *   saves a token in Settings > Integrations > Notion.
 * The copy stays when encryption is unavailable, since Core could not read any token then, or when the call failed
 * (Notion or D1 did not answer): nothing changed in Core, and the next request or run tries again.
 */
export async function adoptLegacyToken(db: Database, services: NotionServices, row: ConnectionRow | null, now: number): Promise<ConnectionRow | null> {
  if (!row?.ciphertext || !row.iv || !services.credentials.available) return row;
  const bindings = row.databaseId && row.dataSourceId ? [{ id: ordersBinding, databaseId: row.databaseId, dataSourceId: row.dataSourceId, name: parseSchema(row)?.dataSourceName ?? "" }] : [];
  let outcome: string;
  try { outcome = await services.notion.importLegacyConnection({ ciphertext: row.ciphertext, iv: row.iv, bindings }); }
  catch { return row; }
  // `ciphertext` in the WHERE: another request may have moved it already, and then this one writes nothing.
  await db.batch([
    db.prepare("UPDATE part_requests_notion SET ciphertext=NULL,iv=NULL,updated_ms=? WHERE installation_id=? AND ciphertext=?").bind(now, installationId, row.ciphertext),
    db.prepare("INSERT INTO audit_log(id,installation_id,actor_user_id,action,target_type,target_id,metadata_json,created_at) SELECT ?,?,NULL,?,?,?,?,? WHERE changes()=1")
      .bind(crypto.randomUUID(), installationId, "part_requests.token_moved_to_core", "part_requests_notion", installationId, JSON.stringify({ outcome }), new Date(now).toISOString()),
  ]).catch(() => undefined); // A copy that could not be cleared is cleared next time; Core ignores a second import.
  return { ...row, ciphertext: null, iv: null };
}

// ---- Core's connection and binding

export type CoreState = { readonly status: NotionServiceStatus; readonly binding: NotionBinding | undefined };

/** Core's connection and the `orders` binding: one D1 read by Core, shared by every later Notion call in this request or run. */
export async function readCore(notion: NotionService): Promise<CoreState> {
  const [status, binding] = await Promise.all([notion.status(), notion.binding(ordersBinding)]);
  return { status, binding };
}

/**
 * The plugin's row and Core's state for a request or job run, after moving a 1.1 token into Core if one is still saved.
 * `row` is the row the caller already read alongside its own reads.
 */
export async function connectionState(db: Database, services: NotionServices, row: ConnectionRow | null, now: number): Promise<{ readonly row: ConnectionRow | null; readonly core: CoreState }> {
  const adopted = await adoptLegacyToken(db, services, row, now);
  return { row: adopted, core: await readCore(services.notion) };
}

/** The saved layout describes the database Core has bound now. A different binding needs verifying first. */
const verifiedForBinding = (row: ConnectionRow | null, core: CoreState) => Boolean(row?.schemaJson && row.verifiedMs && core.binding && sameId(row.dataSourceId, core.binding.dataSourceId));

/** What stops requests going to Notion, if anything, in words for students. Only Core's connection and binding count, and the checked layout. */
export function connectionProblem(row: ConnectionRow | null, core: CoreState): { readonly code: string; readonly error: string } | undefined {
  if (!core.status.connected || !verifiedForBinding(row, core)) return { code: "notion_not_connected", error: "Part Requests is not connected to Notion. Ask an Admin to finish its setup." };
  if (row!.schemaError) return { code: "notion_schema_changed", error: "The Notion database no longer matches what Part Requests expects. Ask an Admin to check the connection." };
  return undefined;
}

/**
 * Kept in rejection_code when Notion answered 403 to creating a page: the connection can read the database but lacks the
 * "Insert content" capability. Only creating a page proves otherwise, so reads leave it alone. See clearRefusal.
 */
export const insertRefused = "notion_insert_403";

/**
 * Why requests have stopped, or what Notion last refused, for the Admin page. Checked in the order an Admin fixes them:
 * Core's connection, the ordering database, this plugin's check of its layout, then refusals, which do not stop requests.
 */
export function adminProblem(row: ConnectionRow | null, core: CoreState): string | null {
  const { status } = core;
  if (!status.saved) return "notion_not_configured";
  if (!status.readable) return "notion_unreadable";
  if (!status.enabled) return "notion_disabled";
  if (!core.binding) return "orders_unbound";
  if (!verifiedForBinding(row, core)) return "not_verified";
  if (row!.schemaError) return "notion_schema_changed";
  if (!row!.rejectionCode) return null;
  return row!.rejectionCode === "notion_401" ? "notion_token_rejected" : row!.rejectionCode === insertRefused ? "notion_insert_refused" : "notion_access_lost";
}

/**
 * Remember that Notion refused a call: 401, 403 or 404 for lost access, or `insertRefused`. Other failures, such as a 500 or a
 * 429, and Core's own refusals say nothing about the database. `data_source_id` in the WHERE means a slow call made before an
 * Admin verified another database cannot mark the new one. A failure to write this must not change the answer to whoever
 * made the call.
 */
export async function recordRefusal(db: Database, row: ConnectionRow, code: string, now: number): Promise<void> {
  if (code !== "notion_401" && code !== "notion_403" && code !== "notion_404" && code !== insertRefused || row.rejectionCode === code || !row.dataSourceId) return;
  await db.prepare("UPDATE part_requests_notion SET rejection_code=?,rejected_ms=? WHERE installation_id=? AND data_source_id=?").bind(code, now, installationId, row.dataSourceId).run().catch(() => undefined);
}

/**
 * A Notion call worked, so whatever refused it before has passed. No write unless a refusal is recorded. A read (`created`
 * false) says nothing about inserting, so it never clears `insertRefused`, even one recorded after `row` was read: the check
 * is in the WHERE. Only a page that was created does.
 */
export async function clearRefusal(db: Database, row: ConnectionRow, created = false): Promise<void> {
  if (!row.rejectionCode || !row.dataSourceId || !created && row.rejectionCode === insertRefused) return;
  await db.prepare(`UPDATE part_requests_notion SET rejection_code=NULL,rejected_ms=NULL WHERE installation_id=? AND data_source_id=?${created ? "" : " AND rejection_code<>?"}`)
    .bind(installationId, row.dataSourceId, ...created ? [] : [insertRefused]).run().catch(() => undefined);
}

/**
 * The setup step: the site address is saved and the ordering database's layout has been checked through Core's `orders`
 * binding. A layout is only ever saved from a read through that binding, by POST /verify. Whether Core's connection and
 * binding still work is checked on every request instead (connectionProblem), since Core's tables are not this plugin's.
 */
export const stepSql = "EXISTS(SELECT 1 FROM part_requests_settings WHERE installation_id=?) AND EXISTS(SELECT 1 FROM part_requests_notion WHERE installation_id=? AND data_source_id IS NOT NULL AND schema_json IS NOT NULL AND verified_ms IS NOT NULL)";

const randomHex = () => [...crypto.getRandomValues(new Uint8Array(32))].map((byte) => byte.toString(16).padStart(2, "0")).join("");

const audit = (db: Database, actor: string, action: string, now: number): Statement =>
  db.prepare("INSERT INTO audit_log(id,installation_id,actor_user_id,action,target_type,target_id,created_at) VALUES (?,?,?,?,?,?,?)")
    .bind(crypto.randomUUID(), installationId, actor, action, "part_requests_notion", installationId, new Date(now).toISOString());

export type AdminRouteContext = {
  readonly request: Request; readonly url: URL; readonly db: unknown; readonly dashboardOrigin: string | undefined;
  readonly services: NotionServices;
  requireRole(roles: readonly "admin"[]): Promise<{ readonly userId: string }>;
  requireDashboardOrigin(message: string): void;
  json<T = unknown>(maxBytes?: number): Promise<T>;
};

/** Core lets Admins and assigned Operators in; Part Requests is Admin only. Changes must also come from the dashboard. */
export async function requireAdmin(context: AdminRouteContext) {
  const principal = await context.requireRole(["admin"]);
  if (context.request.method !== "GET") context.requireDashboardOrigin("Use the dashboard to change Part Requests.");
  return principal;
}

/** How a Notion failure reads to an Admin verifying (here and on the Reminders tab). Only fixed messages: nothing from Notion's reply. */
export const verifyFailure = (error: unknown) => {
  if (!(error instanceof AppError)) throw error;
  if (error.code === "schema") return refuse(422, "schema_mismatch", error.message);
  if (error.code === "notion_401") return refuse(422, "notion_token_rejected", error.message);
  if (error.code === "notion_403" || error.code === "notion_404") return refuse(422, error.code, error.message);
  if (error.code === "notion_429") return refuse(503, "notion_rate_limited", error.message);
  if (["notion_not_configured", "notion_disabled", "notion_unreadable", "notion_unbound"].includes(error.code)) return refuse(409, error.code, error.message);
  return refuse(502, "notion_unavailable", "Notion could not be reached or did not answer as expected. Try again.");
};

/** What stops Core's connection or binding from being used yet, with Core's codes and the fix. */
function coreBlocker({ status, binding }: CoreState): { readonly code: string; readonly message: string } | undefined {
  if (!status.saved) return { code: "notion_not_configured", message: "Core's Notion connection is not set up. Save the Notion integration token in Settings > Integrations > Notion first." };
  if (!status.readable) return { code: "notion_unreadable", message: "The Notion token saved in Core can't be read. Save it again in Settings > Integrations > Notion first." };
  if (!status.enabled) return { code: "notion_disabled", message: "Core's Notion connection is turned off. Turn it on in Settings > Integrations > Notion first." };
  if (!binding) return { code: "notion_unbound", message: "Choose the ordering database for Part Requests first." };
  return undefined;
}

const siteUnknown = () => refuse(409, "site_address_unknown", "The dashboard address of this installation is unknown.");
const usableSite = (site: string | undefined): site is string => Boolean(site) && site!.length <= 200;

/** Saving the dashboard address as the site address /ordering-pin sends. Verifying records it, as saving the token did in 1.1. */
const siteStatement = (db: Database, site: string, now: number) =>
  db.prepare("INSERT INTO part_requests_settings(installation_id,site_address,updated_ms) VALUES (?,?,?) ON CONFLICT(installation_id) DO UPDATE SET site_address=excluded.site_address,updated_ms=excluded.updated_ms")
    .bind(installationId, site, now);

/**
 * Verifying only reads, so a missing Insert content capability outlasts it unless the database changed. The row is created
 * here on a new installation; address_salt keeps client addresses out of the database (see pairing.ts).
 */
const connectionStatements = (db: Database, schema: Schema, actor: string, now: number): Statement[] => [
  db.prepare(`INSERT INTO part_requests_notion(installation_id,address_salt,database_id,data_source_id,schema_json,verified_ms,updated_ms) VALUES (?1,?2,?3,?4,?5,?6,?6)
    ON CONFLICT(installation_id) DO UPDATE SET database_id=excluded.database_id,data_source_id=excluded.data_source_id,schema_json=excluded.schema_json,verified_ms=excluded.verified_ms,schema_error=NULL,
    rejection_code=CASE WHEN rejection_code=?7 AND data_source_id=excluded.data_source_id THEN rejection_code END,rejected_ms=CASE WHEN rejection_code=?7 AND data_source_id=excluded.data_source_id THEN rejected_ms END,updated_ms=excluded.updated_ms`)
    .bind(installationId, randomHex(), schema.databaseId, schema.dataSourceId, JSON.stringify(schema), now, insertRefused),
  // Have the refresh job start from the top on its next run; this write also pokes it.
  db.prepare(`INSERT INTO part_requests_recipient_refresh(installation_id,step,next_due_ms) VALUES (?,'idle',0)
    ON CONFLICT(installation_id) DO UPDATE SET step='idle',cursor=NULL,pages=0,next_due_ms=0`).bind(installationId),
  // The binding may now point somewhere else, so the copy of the old database's orders goes.
  ...clearOrdersStatements(db),
  audit(db, actor, "part_requests.connection_verified", now),
];

/**
 * POST /verify: {}. The setup page's Verify button. Reads the layout of the database Core has bound for `orders`, checks it
 * and saves it with the site address. A failed check saves nothing. The token and the database are chosen in Core.
 */
async function verify(context: AdminRouteContext, db: Database, actor: string, now: number) {
  const input = object(await context.json(1024));
  if (Object.keys(input).length) return refuse(400, "validation", "Send an empty body. The token and the ordering database are chosen in Core's Notion settings.");
  const site = context.dashboardOrigin;
  if (!usableSite(site)) return siteUnknown();
  const { row, core } = await connectionState(db, context.services, await readConnection(db), now);
  // Core's own order of checks reads the binding first; an Admin fixes the connection first, so say that first.
  const blocked = coreBlocker(core);
  if (blocked) return refuse(409, blocked.code, blocked.message);
  let schema: Schema;
  try { schema = await new OrdersNotion(context.services.notion).readSchema(parseSchema(row) ?? undefined); }
  catch (error) { return verifyFailure(error); }
  await db.batch([siteStatement(db, site, now), ...connectionStatements(db, schema, actor, now)]);
  return status(context, db, now);
}

/**
 * PUT /carts: { enabled }. The switch lives in the settings row, which holds the site address, so saving it before setup
 * records that address too, as verifying would. Turning it off also forgets the copy of the orders.
 */
async function saveCarts(context: AdminRouteContext, db: Database, actor: string, now: number) {
  const input = object(await context.json(1024));
  if (typeof input.enabled !== "boolean" || Object.keys(input).length !== 1) return refuse(400, "validation", "Send enabled as true or false.");
  const site = context.dashboardOrigin;
  if (!usableSite(site)) return siteUnknown();
  await db.batch([
    db.prepare("INSERT INTO part_requests_settings(installation_id,site_address,carts_enabled,updated_ms) VALUES (?,?,?,?) ON CONFLICT(installation_id) DO UPDATE SET carts_enabled=excluded.carts_enabled,updated_ms=excluded.updated_ms")
      .bind(installationId, site, input.enabled ? 1 : 0, now),
    ...(input.enabled ? [] : clearOrdersStatements(db)),
    audit(db, actor, input.enabled ? "part_requests.carts_enabled" : "part_requests.carts_disabled", now),
  ]);
  return status(context, db, now);
}

/** What the setup page shows. Core's connection as Core reports it, never a token or ciphertext. */
async function status(context: AdminRouteContext, db: Database, now: number) {
  const [saved, settings, recipients, refresh, addresses, pairing, paired] = await Promise.all([
    readConnection(db),
    db.prepare("SELECT site_address AS siteAddress,carts_enabled AS cartsEnabled FROM part_requests_settings WHERE installation_id=?").bind(installationId).first<{ siteAddress: string; cartsEnabled: number }>(),
    db.prepare("SELECT COUNT(*) AS count FROM part_requests_recipients WHERE installation_id=?").bind(installationId).first<{ count: number }>(),
    db.prepare("SELECT step,finished_ms AS finishedMs,last_error AS lastError FROM part_requests_recipient_refresh WHERE installation_id=?").bind(installationId).first<{ step: string; finishedMs: number | null; lastError: string | null }>(),
    db.prepare("SELECT COUNT(*) AS count FROM part_requests_pairing_address_limits WHERE installation_id=?").bind(installationId).first<{ count: number }>(),
    db.prepare("SELECT paused_until_ms AS pausedUntil FROM part_requests_pairing_limits WHERE installation_id=?").bind(installationId).first<{ pausedUntil: number }>(),
    db.prepare("SELECT COUNT(*) AS count FROM part_requests_devices WHERE installation_id=? AND revoked_ms IS NULL").bind(installationId).first<{ count: number }>(),
  ]);
  const { row, core } = await connectionState(db, context.services, saved, now);
  const pausedUntil = Number(pairing?.pausedUntil ?? 0);
  const schema = parseSchema(row);
  const { status: notion, binding } = core;
  return json({
    siteAddress: settings?.siteAddress ?? null,
    core: { saved: notion.saved, enabled: notion.enabled, readable: notion.readable, connected: notion.connected, pausedUntilMs: notion.pausedUntilMs, capabilities: notion.capabilities },
    binding: binding ? { databaseId: binding.databaseId, dataSourceId: binding.dataSourceId, name: binding.name } : null,
    // The database this plugin last verified, so the page can offer it while Core's binding is missing or points elsewhere.
    databaseId: row?.databaseId ?? null, dataSourceId: row?.dataSourceId ?? null, dataSourceName: schema?.dataSourceName ?? null, verifiedMs: row?.verifiedMs ?? null, schemaError: row?.schemaError ?? null,
    // True only while a 1.1 token could not be handed to Core yet, for example with encryption unavailable.
    legacyTokenSaved: Boolean(row?.ciphertext),
    problem: adminProblem(row, core), rejectedMs: row?.rejectedMs ?? null, teams: schema?.properties.team.options ?? [],
    recipients: Number(recipients?.count ?? 0), refresh: refresh ?? null,
    // Above zero means real client addresses reach the pairing route, so wrong PINs are being counted per address.
    pairingAddressesCounted: Number(addresses?.count ?? 0),
    // The shared pause, which stops pairing for everyone. Null when pairing is open.
    pairingPausedUntilMs: pausedUntil > now ? pausedUntil : null,
    pairedDevices: Number(paired?.count ?? 0), deviceLimit: maximumDevicesPerMember,
    cartsEnabled: settings?.cartsEnabled !== 0,
  });
}

/** /module-setup/part-requests */
export async function setupRoute(context: AdminRouteContext): Promise<Response | undefined> {
  const path = context.url.pathname.slice("/module-setup/part-requests".length);
  const method = context.request.method;
  const known = path === "/status" && method === "GET" || path === "/carts" && method === "PUT" || path === "/verify" && method === "POST";
  if (!known) return undefined;
  const { userId } = await requireAdmin(context);
  const db = context.db as Database; const now = Date.now();
  if (path === "/status") return status(context, db, now);
  if (path === "/verify") return verify(context, db, userId, now);
  return saveCarts(context, db, userId, now);
}
