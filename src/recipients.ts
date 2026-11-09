// The refresh job: re-reads the database's layout, then workspace members, then people named on existing requests, then any
// missing names. It makes one Notion call per scheduler slice and keeps its place in the database, which is what Workers
// Free's 10 ms CPU limit asks of a job. Every module write pokes jobs, so it first checks whether a run is due.
import { clearRefusal, parseSchema, readConnection, recordRefusal, savedToken, type ConnectionRow, type Credentials } from "./connection.ts";
import { AppError, NotionClient, type Person, type Schema } from "./notion.ts";
import { installationId, type Database } from "./pairing.ts";

/** The copy of open orders is short-lived, so a day-old one is nobody's: people's names and prices should not sit here unused. */
const ordersRetentionMs = 24 * 60 * 60_000;
export const refreshIntervalMs = 6 * 60 * 60_000;
export const refreshRetryMs = 60 * 60_000;
export const requestPageSize = 50;
/** 2,000 rows at most per run, as the extension read. An older request's recipient is usually on a newer one too. */
export const maximumRequestPages = 40;
/** A person seen on nothing for this long drops off the list. */
export const recipientRetentionMs = 90 * 24 * 60 * 60_000;
const pruneAfterMs = 24 * 60 * 60_000;
/** Slices per run under Core's cron fallback, which has no one-step-per-slice mode. Its pass allows few provider requests. */
const cronSlices = 5;

/**
 * Kept in last_error on a run that otherwise finished: Notion refused to list workspace members, which is what a connection
 * without "Read user information" gets. People named on requests are still found, so it is a notice and not a failed run.
 */
const usersForbidden = "notion_users_403";

type Refresh = { readonly step: string; readonly cursor: string | null; readonly pages: number; readonly nextDue: number };
type JobContext = { readonly db: unknown; readonly services: { readonly credentials: Credentials }; readonly scheduler?: { readonly steps: boolean } };

const setState = (db: Database, step: string, cursor: string | null, pages: number) =>
  db.prepare(`INSERT INTO part_requests_recipient_refresh(installation_id,step,cursor,pages,next_due_ms) VALUES (?,?,?,?,0)
    ON CONFLICT(installation_id) DO UPDATE SET step=excluded.step,cursor=excluded.cursor,pages=excluded.pages`).bind(installationId, step, cursor, pages);

/** Keep an existing name when this source has none, and look a missing name up again if one is still missing. */
const upsert = (db: Database, person: Person, now: number) =>
  db.prepare(`INSERT INTO part_requests_recipients(installation_id,notion_user_id,name,last_seen_ms) VALUES (?,?,?,?)
    ON CONFLICT(installation_id,notion_user_id) DO UPDATE SET name=CASE WHEN excluded.name<>'' THEN excluded.name ELSE name END,last_seen_ms=excluded.last_seen_ms`)
    .bind(installationId, person.id, person.name.slice(0, 200), now);

const finishRun = (db: Database, now: number, error: string | null, retryMs: number) => db.batch([
  db.prepare("UPDATE part_requests_recipient_refresh SET step='idle',cursor=NULL,pages=0,next_due_ms=?,finished_ms=CASE WHEN ? IS NULL THEN ? ELSE finished_ms END,last_error=CASE WHEN ? IS NULL AND last_error=? THEN last_error ELSE ? END WHERE installation_id=?").bind(now + retryMs, error, now, error, usersForbidden, error, installationId),
  ...(error ? [] : [
    db.prepare("DELETE FROM part_requests_recipients WHERE installation_id=? AND last_seen_ms<?").bind(installationId, now - recipientRetentionMs),
    db.prepare("DELETE FROM part_requests_device_limits WHERE installation_id=? AND window_start_ms<?").bind(installationId, now - pruneAfterMs),
    db.prepare("DELETE FROM part_requests_pairing_address_limits WHERE installation_id=? AND window_start_ms<? AND paused_until_ms<?").bind(installationId, now - pruneAfterMs, now),
    db.prepare("DELETE FROM part_requests_cart_marks WHERE installation_id=? AND expires_ms<=?").bind(installationId, now),
    db.prepare("DELETE FROM part_requests_orders_cache WHERE installation_id=?1 AND EXISTS(SELECT 1 FROM part_requests_orders_state s WHERE s.installation_id=?1 AND (s.published_ms IS NULL OR s.published_ms<?2) AND (s.build_started_ms IS NULL OR s.build_started_ms<?2))").bind(installationId, now - ordersRetentionMs),
    db.prepare("UPDATE part_requests_orders_state SET published_generation=0,published_ms=NULL,build_generation=NULL,build_cursor=NULL,build_pages=0,build_started_ms=NULL WHERE installation_id=?1 AND published_ms<?2 AND (build_started_ms IS NULL OR build_started_ms<?2)").bind(installationId, now - ordersRetentionMs),
  ]),
]);

/** One step, at most one Notion call. Returns whether the run has more to do. */
async function slice(db: Database, refresh: Refresh, connection: ConnectionRow, schema: Schema, client: NotionClient, now: number): Promise<boolean> {
  if (refresh.step === "idle" || refresh.step === "schema") {
    try {
      const fresh = await client.readSchema(schema.dataSourceId, schema.databaseId, schema);
      await db.batch([
        db.prepare("UPDATE part_requests_notion SET schema_json=?,schema_error=NULL WHERE installation_id=? AND data_source_id=?").bind(JSON.stringify(fresh), installationId, connection.dataSourceId),
        setState(db, "users", null, 0),
      ]);
    } catch (error) {
      // The database no longer fits. Stop sending requests to it until an Admin looks, and keep reading people.
      if (!(error instanceof AppError) || error.code !== "schema") throw error;
      await db.batch([
        db.prepare("UPDATE part_requests_notion SET schema_error=? WHERE installation_id=?").bind(error.message, installationId),
        setState(db, "users", null, 0),
      ]);
    }
    return true;
  }
  if (refresh.step === "users") {
    let page: Awaited<ReturnType<NotionClient["usersPage"]>>;
    try { page = await client.usersPage(refresh.cursor ?? undefined); }
    catch (error) {
      if (!(error instanceof AppError) || error.code !== "notion_403") throw error;
      await db.batch([
        db.prepare("UPDATE part_requests_recipient_refresh SET last_error=? WHERE installation_id=?").bind(usersForbidden, installationId),
        setState(db, "requests", null, 0),
      ]);
      return true;
    }
    await db.batch([
      db.prepare("UPDATE part_requests_recipient_refresh SET last_error=NULL WHERE installation_id=? AND last_error=?").bind(installationId, usersForbidden),
      ...page.people.map((person) => upsert(db, person, now)),
      page.next ? setState(db, "users", page.next, 0) : setState(db, "requests", null, 0),
    ]);
    return true;
  }
  if (refresh.step === "requests") {
    const page = await client.requestPeoplePage(schema, requestPageSize, refresh.cursor ?? undefined);
    const pages = refresh.pages + 1;
    await db.batch([...page.people.map((person) => upsert(db, person, now)), page.next && pages < maximumRequestPages ? setState(db, "requests", page.next, pages) : setState(db, "names", null, 0)]);
    return true;
  }
  // One at a time: an unresolved name costs a request, and a failed lookup keeps the person and is not repeated.
  const nameless = await db.prepare("SELECT notion_user_id AS id FROM part_requests_recipients WHERE installation_id=? AND name='' AND name_checked=0 LIMIT 1").bind(installationId).first<{ id: string }>();
  if (!nameless) {
    await finishRun(db, now, null, refreshIntervalMs);
    return false;
  }
  let name = "";
  try { name = await client.userName(nameless.id); }
  catch (error) { if (!(error instanceof AppError) || error.code === "notion_401") throw error; }
  await db.prepare("UPDATE part_requests_recipients SET name=?,name_checked=1 WHERE installation_id=? AND notion_user_id=?").bind(name.slice(0, 200), installationId, nameless.id).run();
  return true;
}

const readsDatabase = (step: string) => step === "idle" || step === "schema" || step === "requests";

/** The scheduled job. Returns `{ more: true }` when it stopped with work left, so the scheduler runs it again within seconds. */
export async function refreshRecipients(context: JobContext): Promise<unknown> {
  const db = context.db as Database;
  const now = Date.now();
  const [connection, state] = await Promise.all([
    readConnection(db),
    db.prepare("SELECT step,cursor,pages,next_due_ms AS nextDue FROM part_requests_recipient_refresh WHERE installation_id=?").bind(installationId).first<Refresh>(),
  ]);
  const schema = parseSchema(connection);
  if (!connection || !connection.ciphertext || !connection.verifiedMs || !schema) return { skipped: "not connected" };
  if (state?.step === "idle" && state.nextDue > now) return { skipped: "not due" };
  // The row must exist before any failure, or the next poke would call Notion again straight away.
  if (!state) await setState(db, "idle", null, 0).run();
  let refresh: Refresh = state ?? { step: "idle", cursor: null, pages: 0, nextDue: 0 };
  let client: NotionClient;
  try { client = new NotionClient(await savedToken(connection, context.services.credentials)); }
  catch (error) {
    if (!(error instanceof AppError)) throw error;
    await finishRun(db, now, error.code, refreshRetryMs);
    return { failed: error.code };
  }
  const steps = context.scheduler?.steps === true;
  let current = connection;
  let step = refresh.step;
  try {
    for (let run = 0; run < (steps ? 1 : cronSlices); run++) {
      step = refresh.step;
      const more = await slice(db, refresh, connection, schema, client, now);
      // Only reading the database says the database can be reached. Listing users and looking up one name say nothing about it.
      if (readsDatabase(step) && current.rejectionCode) { await clearRefusal(db, current); current = { ...current, rejectionCode: null, rejectedMs: null }; }
      if (!more) return { done: true };
      const next = await db.prepare("SELECT step,cursor,pages,next_due_ms AS nextDue FROM part_requests_recipient_refresh WHERE installation_id=?").bind(installationId).first<Refresh>();
      if (!next) return { done: true };
      refresh = next;
    }
  } catch (error) {
    // Only codes reach the record. Wait for the next try rather than asking the scheduler to repeat a failure.
    if (!(error instanceof AppError)) throw error;
    await finishRun(db, now, error.code, refreshRetryMs);
    // A 401 is about the token, whichever call got it. A 403 or 404 only counts when the database itself refused.
    if (error.code === "notion_401" || readsDatabase(step)) await recordRefusal(db, current, error.code, now);
    return { failed: error.code };
  }
  return { more: true, cursor: refresh.step };
}
