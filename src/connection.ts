// The saved Notion connection and the Admin setup routes for it. Modelled on Carpool's Geoapify key: the token goes through
// services.credentials, only its ciphertext is stored, in a table in nonPortableTables, and it is never returned.
//
// These routes live under /module-setup, not /admin: Core refuses /admin/<module> until setup is complete, and they are how
// setup completes. Core keeps /module-setup open to Admins afterwards, so the token can be replaced later or after a restore.
import { AppError, NotionClient, type Choice, type Schema } from "./notion.ts";
import { object, refuse, json } from "./http.ts";
import { installationId, type Database, type Statement } from "./pairing.ts";

export type Credentials = {
  readonly available: boolean;
  encrypt(value: Record<string, string>): Promise<{ ciphertext: string; iv: string }>;
  decrypt(ciphertext: string, iv: string): Promise<Record<string, string>>;
};
export type ConnectionRow = {
  readonly ciphertext: string | null; readonly iv: string | null; readonly databaseId: string | null; readonly dataSourceId: string | null;
  readonly schemaJson: string | null; readonly verifiedMs: number | null; readonly schemaError: string | null;
};

export const readConnection = (db: Database) => db.prepare(`SELECT ciphertext,iv,database_id AS databaseId,data_source_id AS dataSourceId,schema_json AS schemaJson,
  verified_ms AS verifiedMs,schema_error AS schemaError FROM part_requests_notion WHERE installation_id=?`).bind(installationId).first<ConnectionRow>();

export const parseSchema = (row: ConnectionRow | null): Schema | undefined => {
  if (!row?.schemaJson) return undefined;
  try { return JSON.parse(row.schemaJson) as Schema; } catch { return undefined; }
};

/** The token for this request. Errors say what to do and never carry the value. */
export async function savedToken(row: ConnectionRow | null, credentials: Credentials): Promise<string> {
  if (!row?.ciphertext || !row.iv) throw new AppError("No Notion token is saved. An Admin needs to finish Part Requests setup.", "notion_not_connected");
  if (!credentials.available) throw new AppError("Credential encryption is unavailable on this installation.", "credentials_unavailable");
  try {
    const token = (await credentials.decrypt(row.ciphertext, row.iv)).token;
    if (!token) throw new Error("empty");
    return token;
  } catch { throw new AppError("The saved Notion token could not be read. An Admin needs to save it again.", "credentials_unreadable"); }
}

/** What stops requests going to Notion, if anything. A saved token alone is not a connection. */
export function connectionProblem(row: ConnectionRow | null): { readonly code: string; readonly error: string } | undefined {
  if (!row?.ciphertext || !row.schemaJson || !row.verifiedMs) return { code: "notion_not_connected", error: "Part Requests is not connected to Notion. Ask an Admin to finish its setup." };
  if (row.schemaError) return { code: "notion_schema_changed", error: "The Notion database no longer matches what Part Requests expects. Ask an Admin to check the connection." };
  return undefined;
}

export const stepSql = "EXISTS(SELECT 1 FROM part_requests_settings WHERE installation_id=?) AND EXISTS(SELECT 1 FROM part_requests_notion WHERE installation_id=? AND ciphertext IS NOT NULL AND schema_json IS NOT NULL AND verified_ms IS NOT NULL)";

const randomHex = () => [...crypto.getRandomValues(new Uint8Array(32))].map((byte) => byte.toString(16).padStart(2, "0")).join("");

const audit = (db: Database, actor: string, action: string, now: number): Statement =>
  db.prepare("INSERT INTO audit_log(id,installation_id,actor_user_id,action,target_type,target_id,created_at) VALUES (?,?,?,?,?,?,?)")
    .bind(crypto.randomUUID(), installationId, actor, action, "part_requests_notion", installationId, new Date(now).toISOString());

export type AdminRouteContext = {
  readonly request: Request; readonly url: URL; readonly db: unknown; readonly dashboardOrigin: string | undefined;
  readonly services: { readonly credentials: Credentials };
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

/** How a Notion failure reads to an Admin. Only fixed messages: nothing from Notion's reply or the token. */
const notionFailure = (error: unknown) => {
  if (!(error instanceof AppError)) throw error;
  const details = object(error.details);
  if (error.code === "data_source_required") return refuse(409, error.code, error.message, { dataSources: details.dataSources as readonly Choice[] });
  if (error.code === "validation" || error.code === "schema") return refuse(422, error.code === "schema" ? "schema_mismatch" : "invalid_link", error.message);
  if (error.code === "notion_401") return refuse(422, "notion_token_rejected", error.message);
  if (error.code === "notion_403" || error.code === "notion_404") return refuse(422, error.code, error.message);
  if (error.code === "notion_not_connected") return refuse(409, error.code, error.message);
  if (error.code === "credentials_unavailable" || error.code === "credentials_unreadable") return refuse(503, error.code, error.message);
  return refuse(502, "notion_unavailable", "Notion could not be reached or did not answer as expected. Try again.");
};

const validToken = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{20,1000}$/.test(value.trim());

async function saveToken(context: AdminRouteContext, db: Database, actor: string, now: number) {
  const input = object(await context.json(4096));
  if (Object.keys(input).some((key) => key !== "token") || !validToken(input.token)) return refuse(400, "invalid_token", "Enter the connection's Notion token.");
  const { credentials } = context.services;
  if (!credentials.available) return refuse(503, "credentials_unavailable", "Credential encryption is unavailable on this installation.");
  const site = context.dashboardOrigin;
  if (!site || site.length > 200) return refuse(409, "site_address_unknown", "The dashboard address of this installation is unknown.");
  const token = input.token.trim();
  try { await new NotionClient(token).verifyToken(); } catch (error) { return notionFailure(error); }
  const encrypted = await credentials.encrypt({ token });
  // A new token is unproven against the saved database until the connection is checked again.
  await db.batch([
    db.prepare(`INSERT INTO part_requests_notion(installation_id,ciphertext,iv,address_salt,updated_ms) VALUES (?,?,?,?,?)
      ON CONFLICT(installation_id) DO UPDATE SET ciphertext=excluded.ciphertext,iv=excluded.iv,verified_ms=NULL,updated_ms=excluded.updated_ms`)
      .bind(installationId, encrypted.ciphertext, encrypted.iv, randomHex(), now),
    db.prepare("INSERT INTO part_requests_settings(installation_id,site_address,updated_ms) VALUES (?,?,?) ON CONFLICT(installation_id) DO UPDATE SET site_address=excluded.site_address,updated_ms=excluded.updated_ms")
      .bind(installationId, site, now),
    audit(db, actor, "part_requests.token_saved", now),
  ]);
  return status(context, db);
}

async function listDataSources(context: AdminRouteContext, db: Database) {
  const input = object(await context.json(4096));
  if (typeof input.databaseUrl !== "string" || input.databaseUrl.length > 2000) return refuse(400, "invalid_link", "Enter the database's Notion link.");
  try { return json(await new NotionClient(await savedToken(await readConnection(db), context.services.credentials)).dataSources(input.databaseUrl)); }
  catch (error) { return notionFailure(error); }
}

async function connect(context: AdminRouteContext, db: Database, actor: string, now: number) {
  const input = object(await context.json(4096));
  if (typeof input.databaseUrl !== "string" || input.databaseUrl.length > 2000 || input.dataSourceId !== undefined && typeof input.dataSourceId !== "string") return refuse(400, "invalid_link", "Enter the database's Notion link and data source.");
  const row = await readConnection(db);
  let schema: Schema;
  try { schema = await new NotionClient(await savedToken(row, context.services.credentials)).connect(input.databaseUrl, input.dataSourceId as string | undefined, parseSchema(row)); }
  catch (error) { return notionFailure(error); }
  await db.batch([
    db.prepare("UPDATE part_requests_notion SET database_id=?,data_source_id=?,schema_json=?,verified_ms=?,schema_error=NULL,updated_ms=? WHERE installation_id=?")
      .bind(schema.databaseId, schema.dataSourceId, JSON.stringify(schema), now, now, installationId),
    // Have the refresh job start from the top on its next run; this write also pokes it.
    db.prepare(`INSERT INTO part_requests_recipient_refresh(installation_id,step,next_due_ms) VALUES (?,'idle',0)
      ON CONFLICT(installation_id) DO UPDATE SET step='idle',cursor=NULL,pages=0,next_due_ms=0`).bind(installationId),
    audit(db, actor, "part_requests.connection_verified", now),
  ]);
  return status(context, db);
}

async function disconnect(context: AdminRouteContext, db: Database, actor: string, now: number) {
  await db.batch([
    db.prepare("UPDATE part_requests_notion SET ciphertext=NULL,iv=NULL,verified_ms=NULL,updated_ms=? WHERE installation_id=?").bind(now, installationId),
    audit(db, actor, "part_requests.token_removed", now),
  ]);
  return status(context, db);
}

/** What the setup page shows. Whether a token is saved, never the token or its ciphertext. */
async function status(context: AdminRouteContext, db: Database) {
  const [row, settings, recipients, refresh, addresses] = await Promise.all([
    readConnection(db),
    db.prepare("SELECT site_address AS siteAddress FROM part_requests_settings WHERE installation_id=?").bind(installationId).first<{ siteAddress: string }>(),
    db.prepare("SELECT COUNT(*) AS count FROM part_requests_recipients WHERE installation_id=?").bind(installationId).first<{ count: number }>(),
    db.prepare("SELECT step,finished_ms AS finishedMs,last_error AS lastError FROM part_requests_recipient_refresh WHERE installation_id=?").bind(installationId).first<{ step: string; finishedMs: number | null; lastError: string | null }>(),
    db.prepare("SELECT COUNT(*) AS count FROM part_requests_pairing_address_limits WHERE installation_id=?").bind(installationId).first<{ count: number }>(),
  ]);
  const schema = parseSchema(row);
  return json({
    tokenSaved: Boolean(row?.ciphertext), canSaveToken: context.services.credentials.available, siteAddress: settings?.siteAddress ?? null,
    databaseId: row?.databaseId ?? null, dataSourceId: row?.dataSourceId ?? null, verifiedMs: row?.verifiedMs ?? null, schemaError: row?.schemaError ?? null,
    problem: connectionProblem(row)?.code ?? null, teams: schema?.properties.team.options ?? [],
    recipients: Number(recipients?.count ?? 0), refresh: refresh ?? null,
    // Above zero means real client addresses reach the pairing route, so wrong PINs are being counted per address.
    pairingAddressesCounted: Number(addresses?.count ?? 0),
  });
}

/** /module-setup/part-requests */
export async function setupRoute(context: AdminRouteContext): Promise<Response | undefined> {
  const path = context.url.pathname.slice("/module-setup/part-requests".length);
  const method = context.request.method;
  const known = path === "/status" && method === "GET" || path === "/token" && (method === "PUT" || method === "DELETE") || (path === "/database" || path === "/connection") && method === "POST";
  if (!known) return undefined;
  const { userId } = await requireAdmin(context);
  const db = context.db as Database; const now = Date.now();
  if (path === "/status") return status(context, db);
  if (path === "/token") return method === "PUT" ? saveToken(context, db, userId, now) : disconnect(context, db, userId, now);
  return path === "/database" ? listDataSources(context, db) : connect(context, db, userId, now);
}
