// The Reminders tab's routes under /admin/part-requests/reminders, Admin only and audited. Reminders always use the ordering
// database, through Core's `orders` binding; People, when used, is Core's read-only `people` binding. Each layout is saved
// only by a check here. Preview reads Notion and writes nothing anywhere.
import { installationTimeZone, type D1Database } from "@lancerlogin/module-sdk/api";
import { requireAdmin, verifyFailure, type AdminRouteContext } from "./connection.ts";
import { json, object, refuse } from "./http.ts";
import { AppError, ordersBinding, sameId } from "./notion.ts";
import { installationId, type Database, type Statement } from "./pairing.ts";
import { formatWeekdays, localAt, minuteMs, nextSlot, parseWeekdays, settingsProblems, type PeopleKey } from "./reminder-schedule.ts";
import { RemindersNotion, peopleBinding, staleRow, type PeopleRow, type StaleRow } from "./reminders-notion.ts";
import {
  activeRunSql, cancelActiveRun, insertRun, isDue, numericCounts, peopleSchema, pings, readSettings, recentlyReminded, reminderSchema, resolveByPeople,
  rosterIndex, rosterMentions, runConfig, runCountsSql, targetVerified, type SettingsRow,
} from "./reminders.ts";

const audit = (db: Database, actor: string, action: string, now: number, onlyIfChanged = false): Statement =>
  db.prepare(`INSERT INTO audit_log(id,installation_id,actor_user_id,action,target_type,target_id,created_at) SELECT ?,?,?,?,?,?,?${onlyIfChanged ? " WHERE changes()=1" : ""}`)
    .bind(crypto.randomUUID(), installationId, actor, action, "part_requests_reminders", installationId, new Date(now).toISOString());

/** The settings row, created with the defaults when it is missing. Its since is now, so no past slot fires. */
const ensureSettings = (db: Database, now: number) =>
  db.prepare("INSERT INTO part_requests_reminder_settings(installation_id,schedule_since_ms,updated_ms) VALUES (?,?,?) ON CONFLICT(installation_id) DO NOTHING").bind(installationId, now, now);

export const previewPageSize = 50;
type ItemView = { pageUrl: string; description: string; unpinged: string; skipReason: string | null; commentState: string; discordState: string; discordNote: string | null; markState: string; errorCode: string | null };

const localToday = (timeZone: string | null, now: number) => { try { return timeZone ? localAt(timeZone, now).date : new Date(now).toISOString().slice(0, 10); } catch { return new Date(now).toISOString().slice(0, 10); } };

/** GET /reminders: settings, the checked layouts, Core's connection as it bears on reminders, any problem, the active run and the last finished run. */
async function view(context: AdminRouteContext, db: Database, now: number) {
  const notion = context.services.notion;
  const [settings, active, last, timeZone, status, orders, people] = await Promise.all([
    readSettings(db), db.prepare(activeRunSql).bind(installationId).first<{ runKey: string; kind: string; state: string }>(),
    db.prepare(`SELECT run_key AS runKey,kind,state,error_code AS errorCode,truncated,created_ms AS createdMs,finished_ms AS finishedMs FROM part_requests_reminder_runs
      WHERE installation_id=? AND state IN ('done','failed') ORDER BY finished_ms DESC,created_ms DESC LIMIT 1`).bind(installationId).first<{ runKey: string; kind: string; state: string; errorCode: string | null; truncated: number; createdMs: number; finishedMs: number }>(),
    installationTimeZone(db as unknown as D1Database, installationId).catch(() => null as string | null),
    notion.status(), notion.binding(ordersBinding), notion.binding(peopleBinding),
  ]);
  const schema = reminderSchema(settings); const peopleLayout = peopleSchema(settings);
  let lastRun = null;
  if (last) {
    const [counts, items, names] = await Promise.all([
      db.prepare(runCountsSql).bind(installationId, last.runKey).first<Record<string, unknown>>(),
      db.prepare(`SELECT page_url AS pageUrl,description,unpinged_json AS unpinged,skip_reason AS skipReason,comment_state AS commentState,discord_state AS discordState,
        discord_note AS discordNote,mark_state AS markState,error_code AS errorCode FROM part_requests_reminder_items WHERE installation_id=? AND run_key=? ORDER BY seq LIMIT 200`).bind(installationId, last.runKey).all<ItemView>(),
      db.prepare("SELECT notion_user_id AS id,name FROM part_requests_recipients WHERE installation_id=?").bind(installationId).all<{ id: string; name: string }>(),
    ]);
    // Names are shown to the Admin from the recipient list. Reminder tables and job results hold IDs only.
    const name = new Map((names.results ?? []).map((row) => [row.id, row.name]));
    const rows = items.results ?? [];
    const link = (row: ItemView) => ({ description: row.description, pageUrl: row.pageUrl });
    lastRun = {
      ...last, truncated: last.truncated === 1, counts: numericCounts(counts),
      nobody: rows.filter((row) => row.skipReason === "no_people").map(link),
      pingSkipped: rows.filter((row) => !row.skipReason && row.unpinged !== "[]").map((row) => ({
        ...link(row), people: (JSON.parse(row.unpinged) as { person: string; reason: string }[]).map((item) => ({ name: name.get(item.person) || "Unknown person", reason: item.reason })),
      })),
      checkPage: rows.filter((row) => row.commentState === "uncertain").map(link),
      failed: rows.filter((row) => row.commentState === "failed" || row.markState === "failed" || row.discordState === "failed").map((row) => ({ ...link(row), step: row.commentState === "failed" ? "comment" : row.markState === "failed" ? "mark" : "discord", code: row.errorCode ?? row.discordNote })),
    };
  }
  let nextRunMs: number | null = null;
  try { if (timeZone && settings?.enabled) nextRunMs = nextSlot(timeZone, parseWeekdays(settings.weekdays), settings.runTime, now)?.ms ?? null; } catch { nextRunMs = null; }
  // A layout describes the database Core has bound now only while the data sources still match.
  const targetCurrent = Boolean(schema && orders && sameId(schema.dataSourceId, orders.dataSourceId));
  return json({
    settings: {
      enabled: settings?.enabled === 1, weekdays: parseWeekdays(settings?.weekdays ?? "1,3,5"), runTime: settings?.runTime ?? "15:00",
      staleMinutes: settings?.staleMinutes ?? 2880, cooldownMinutes: settings?.cooldownMinutes ?? 2880, discordChannelId: settings?.discordChannelId ?? null,
      peopleKey: settings?.peopleKey ?? "external_id", revision: settings?.revision ?? 0,
    },
    core: { connected: status.connected, capabilities: { comment: status.capabilities.comment, update: status.capabilities.update }, ordersBound: Boolean(orders), peopleBound: Boolean(people) },
    target: schema ? { dataSourceName: schema.dataSourceName ?? null, verifiedMs: settings?.verifiedMs ?? null, schemaError: settings?.schemaError ?? null, statuses: schema.statuses, current: targetCurrent } : null,
    targetVerified: targetVerified(settings) && targetCurrent,
    people: settings?.peopleDataSourceId ? {
      dataSourceName: parsePeopleName(settings), verifiedMs: settings.peopleVerifiedMs, error: settings.peopleError,
      current: Boolean(peopleLayout && people && sameId(peopleLayout.dataSourceId, people.dataSourceId)),
    } : null,
    problem: settings?.lastError ?? null, problemMs: settings?.lastErrorMs ?? null,
    timeZone, nextRunMs,
    activeRun: active ? { runKey: active.runKey, kind: active.kind, state: active.state } : null,
    lastRun,
  });
}

const parsePeopleName = (settings: SettingsRow) => { try { return (JSON.parse(settings.peopleSchemaJson ?? "") as { dataSourceName?: string }).dataSourceName ?? null; } catch { return null; } };

/** PUT /reminders/settings: the whole form, with the revision it was loaded at. */
async function saveSettings(context: AdminRouteContext, db: Database, actor: string, now: number) {
  const input = object(await context.json(4096));
  const allowed = new Set(["revision", "enabled", "weekdays", "runTime", "staleMinutes", "cooldownMinutes", "discordChannelId", "peopleKey"]);
  if (Object.keys(input).some((key) => !allowed.has(key)) || !Number.isInteger(input.revision)) return refuse(400, "validation", "Send the reminder settings and their revision only.");
  const problems = settingsProblems(input);
  if (Object.keys(problems).length) return refuse(400, "validation", Object.values(problems)[0]!, { errors: problems });
  const settings = await readSettings(db);
  if (input.enabled && !targetVerified(settings)) return refuse(409, "target_unverified", "Check the ordering database for reminders before turning them on.");
  const results = await db.batch([
    db.prepare(`INSERT INTO part_requests_reminder_settings(installation_id,enabled,weekdays,run_time,stale_minutes,cooldown_minutes,discord_channel_id,people_key,schedule_since_ms,revision,updated_ms)
      VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,1,?9)
      ON CONFLICT(installation_id) DO UPDATE SET enabled=excluded.enabled,weekdays=excluded.weekdays,run_time=excluded.run_time,stale_minutes=excluded.stale_minutes,
        cooldown_minutes=excluded.cooldown_minutes,discord_channel_id=excluded.discord_channel_id,people_key=excluded.people_key,
        schedule_since_ms=CASE WHEN (excluded.enabled=1 AND enabled=0) OR excluded.weekdays<>weekdays OR excluded.run_time<>run_time THEN excluded.schedule_since_ms ELSE schedule_since_ms END,
        revision=revision+1,updated_ms=excluded.updated_ms
      WHERE part_requests_reminder_settings.revision=?10`)
      .bind(installationId, input.enabled ? 1 : 0, formatWeekdays(input.weekdays as number[]), input.runTime, input.staleMinutes, input.cooldownMinutes, input.discordChannelId, input.peopleKey as PeopleKey, now, input.revision),
    audit(db, actor, "part_requests.reminders_saved", now, true),
  ]);
  if (results[0]?.meta?.changes !== 1) return refuse(409, "revision_conflict", "Someone else changed reminder settings. Reload to see their changes, then try again.");
  if (!input.enabled) await db.batch(cancelActiveRun(db, "disabled", now));
  return view(context, db, now);
}

const emptyBody = async (context: AdminRouteContext) => Object.keys(object(await context.json(1024))).length === 0;

/**
 * POST /reminders/verify: {}. Reads the ordering database's layout through Core's `orders` binding and checks what reminders
 * need: Created, Reminder sent, Orderer/Recipient and the four statuses. The only way the layout is saved. A failure saves nothing.
 */
async function verifyTarget(context: AdminRouteContext, db: Database, actor: string, now: number) {
  if (!await emptyBody(context)) return refuse(400, "validation", "Send an empty body. Reminders always use the ordering database chosen in Core.");
  const settings = await readSettings(db);
  let schema;
  try { schema = await new RemindersNotion(context.services.notion).readReminderSchema(reminderSchema(settings)); }
  catch (error) { return verifyFailure(error); }
  const changed = !sameId(settings?.dataSourceId, schema.dataSourceId);
  await db.batch([
    ensureSettings(db, now),
    db.prepare(`UPDATE part_requests_reminder_settings SET database_id=?,data_source_id=?,schema_json=?,verified_ms=?,schema_error=NULL,
      last_error=CASE WHEN last_error IN ('schema','target_changed') THEN NULL ELSE last_error END,last_error_ms=CASE WHEN last_error IN ('schema','target_changed') THEN NULL ELSE last_error_ms END,updated_ms=? WHERE installation_id=?`)
      .bind(schema.databaseId, schema.dataSourceId, JSON.stringify(schema), now, now, installationId),
    ...(changed ? cancelActiveRun(db, "target_changed", now) : []),
    audit(db, actor, "part_requests.reminders_target_verified", now),
  ]);
  return view(context, db, now);
}

/** POST /reminders/people/verify: {}. Reads the layout of the People database chosen in Core. Read only from then on. */
async function verifyPeople(context: AdminRouteContext, db: Database, actor: string, now: number) {
  if (!await emptyBody(context)) return refuse(400, "validation", "Send an empty body. Choose the People database in the field above.");
  const settings = await readSettings(db);
  const previous = settings?.peopleSchemaJson ? JSON.parse(settings.peopleSchemaJson) : undefined;
  let schema;
  try { schema = await new RemindersNotion(context.services.notion).readPeopleSchema(previous); }
  catch (error) { return verifyFailure(error); }
  if (!schema) return refuse(409, "people_unbound", "Choose the People database first.");
  await db.batch([
    ensureSettings(db, now),
    db.prepare(`UPDATE part_requests_reminder_settings SET people_data_source_id=?,people_schema_json=?,people_verified_ms=?,people_error=NULL,
      last_error=CASE WHEN last_error='people_schema' THEN NULL ELSE last_error END,updated_ms=? WHERE installation_id=?`)
      .bind(schema.dataSourceId, JSON.stringify(schema), now, now, installationId),
    audit(db, actor, "part_requests.reminders_people_verified", now),
  ]);
  return view(context, db, now);
}

/** DELETE /reminders/people: stop using People; pings go back to default recipients. Core's binding is cleared in Core. */
async function removePeople(context: AdminRouteContext, db: Database, actor: string, now: number) {
  await db.batch([
    db.prepare("UPDATE part_requests_reminder_settings SET people_data_source_id=NULL,people_schema_json=NULL,people_verified_ms=NULL,people_error=NULL,updated_ms=? WHERE installation_id=?").bind(now, installationId),
    audit(db, actor, "part_requests.reminders_people_removed", now),
  ]);
  return view(context, db, now);
}

/**
 * POST /reminders/preview: a dry run. It reads the ordering database's layout, People's first page when it is used, and one
 * page of 50 stale requests (3 Notion requests at most), and writes nothing anywhere: no comment, no message, no mark, no row.
 */
async function preview(context: AdminRouteContext, db: Database, now: number) {
  const settings = await readSettings(db);
  const config = settings && targetVerified(settings) ? runConfig(settings) : undefined;
  if (!settings || !config) return refuse(409, "target_unverified", "Check the ordering database for reminders first.");
  const timeZone = await installationTimeZone(db as unknown as D1Database, installationId).catch(() => null as string | null);
  const staleBefore = now - config.staleMinutes * minuteMs; const cooldownBefore = now - config.cooldownMinutes * minuteMs;
  try {
    const notion = new RemindersNotion(context.services.notion);
    const schema = await notion.readReminderSchema(config.schema);
    if (!sameId(schema.dataSourceId, config.schema.dataSourceId)) return refuse(409, "target_changed", "The ordering database chosen in Core changed. Check it again for reminders.");
    const { members, fallback } = await rosterMentions(db, localToday(timeZone, now));
    let map = fallback; let source: "people" | "fallback" = "fallback"; let peopleIncomplete = false;
    const peopleNow = config.people ? await context.services.notion.binding(peopleBinding) : undefined;
    if (config.people && peopleNow && sameId(peopleNow.dataSourceId, config.people.schema.dataSourceId)) {
      const page = await notion.peoplePage(config.people.schema, 100);
      const rows: PeopleRow[] = page.rows.filter((row) => row.active && row.memberKey && row.accounts.length);
      if (rows.length) { map = resolveByPeople(rows, rosterIndex(members, config.people.key)); source = "people"; peopleIncomplete = Boolean(page.next); }
    }
    const page = await notion.staleRequestsPage(schema, new Date(staleBefore).toISOString(), new Date(cooldownBefore).toISOString(), previewPageSize);
    const rows = page.rows.map((row) => staleRow(row, schema)).filter((row): row is StaleRow => row !== undefined).filter((row) => isDue(row, schema.statuses.incomplete, staleBefore, cooldownBefore));
    const [recent, names] = await Promise.all([
      recentlyReminded(db, rows.map((row) => row.pageId), cooldownBefore),
      db.prepare("SELECT notion_user_id AS id,name FROM part_requests_recipients WHERE installation_id=?").bind(installationId).all<{ id: string; name: string }>(),
    ]);
    const name = new Map((names.results ?? []).map((row) => [row.id, row.name]));
    return json({
      requests: rows.map((row) => {
        const { ids, unpinged } = pings(row.people, map);
        return {
          description: row.description, pageUrl: row.pageUrl, createdMs: row.createdMs,
          skipReason: !row.people.length ? "no_people" : recent.has(row.pageId) ? "recently_reminded" : null,
          people: row.people.map((person) => ({ name: name.get(person) || "Unknown person", ping: !unpinged.some((item) => item.person === person), reason: unpinged.find((item) => item.person === person)?.reason ?? null })),
          pings: ids.length,
        };
      }),
      more: Boolean(page.next), source, peopleIncomplete, discordOff: !config.channelId,
    });
  } catch (error) {
    if (error instanceof AppError) return verifyFailure(error);
    throw error;
  }
}

/** POST /reminders/run: Send reminders now. Refused while reminders are off or a run is in progress. */
async function runNow(db: Database, actor: string, now: number) {
  const [settings, active] = await Promise.all([readSettings(db), db.prepare(activeRunSql).bind(installationId).first<{ runKey: string }>()]);
  if (!settings?.enabled) return refuse(409, "reminders_off", "Turn reminders on first.");
  const config = targetVerified(settings) ? runConfig(settings) : undefined;
  if (!config) return refuse(409, "target_unverified", "Check the ordering database for reminders first.");
  if (active) return refuse(409, "run_active", "A reminder run is already in progress. Wait for it to finish.");
  const runKey = `manual:${now}`;
  // The write also pokes Core's scheduler, so the run starts within seconds.
  await db.batch([insertRun(db, runKey, "manual", config, now), audit(db, actor, "part_requests.reminders_run_requested", now)]);
  return json({ runKey }, 202);
}

/** /admin/part-requests/reminders... Returns undefined for anything else. */
export async function remindersRoute(context: AdminRouteContext, path: string): Promise<Response | undefined> {
  const method = context.request.method;
  const known = path === "" && method === "GET" || path === "/settings" && method === "PUT" || path === "/verify" && method === "POST" || path === "/people/verify" && method === "POST"
    || path === "/people" && method === "DELETE" || path === "/preview" && method === "POST" || path === "/run" && method === "POST";
  if (!known) return undefined;
  const { userId } = await requireAdmin(context);
  const db = context.db as Database; const now = Date.now();
  if (path === "") return view(context, db, now);
  if (path === "/settings") return saveSettings(context, db, userId, now);
  if (path === "/verify") return verifyTarget(context, db, userId, now);
  if (path === "/people/verify") return verifyPeople(context, db, userId, now);
  if (path === "/people") return removePeople(context, db, userId, now);
  if (path === "/preview") return preview(context, db, now);
  return runNow(db, userId, now);
}
