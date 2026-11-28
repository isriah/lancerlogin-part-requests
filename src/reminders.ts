// Stale-request reminders: the job `part-requests.reminders`. On each scheduled slot (Mon, Wed and Fri at 15:00 by default,
// in the installation's time zone) it finds Incomplete Requests in the ordering database older than the threshold, comments
// on each in Notion with a mention of its Orderer/Recipient, posts the same reminder in Discord with a ping, and sets
// "Reminder sent" so the cooldown holds.
//
// Notion goes through Core's connection (`services.notion`) and its `orders` binding, for the requests. Who each Notion person
// is comes from Core's people matching (`listNotionPeopleAccounts`, Core's local copy of its People database), which costs
// no Notion request. Workers Free allows 10 ms of CPU per invocation, so a run keeps its place in the database and each
// scheduler slice takes one step: a read of the layout or a page of rows, or one provider step for one request (a comment or
// the mark costs Core one more read of the page first, to prove it is in the ordering database). Steps for one request run
// in order and none starts while the one before it is pending: comment, then Discord, then the mark. The job never touches
// the ordering connection's own state, so a reminder failure cannot stop requests or the recipient refresh. Job results
// carry counts and codes only, never names.
import { installationTimeZone, listNotionPeopleAccounts, reportRosterData, type D1Database, type NotionPersonAccount, type NotionService } from "@lancerlogin/module-sdk/api";
import { AppError } from "./notion.ts";
import { installationId, sha256Hex, type Database, type Statement } from "./pairing.ts";
import { dueSlot, durationText, localAt, minuteMs, parseWeekdays } from "./reminder-schedule.ts";
import { RemindersNotion, maximumMentions, staleRow, type ReminderSchema, type StaleRow } from "./reminders-notion.ts";

export const remindersJobId = "part-requests.reminders";
export const collectPageSize = 20;
/** 10 pages of 20: a run reminds about 200 requests at most and says it was truncated. */
export const maximumCollectPages = 10;
export const leaseMs = 60_000;
export const historyMs = 30 * 24 * 60 * minuteMs;
/**
 * Slices per invocation under Core's cron fallback, which has no one-step-per-slice mode. Core allows 8 Notion requests per
 * invocation and a slice may cost 2 (a comment or the mark, with Core's page check), so the loop also stops before that cap.
 */
export const cronSlices = 3;
export const notionCallsPerInvocation = 8;
export const maximumSliceNotionCalls = 2;
export const commentAttempts = 3;
export const markAttempts = 3;
/** Discord is retried once, after its retry-after. */
export const discordAttempts = 2;
/** A schema or collect step that Notion could not answer is tried this many times before the run fails. */
export const runAttempts = 5;
/** How long a run waits while Core holds deliveries (after a restore) before it looks again. */
export const pausedWaitMs = 5 * minuteMs;
// 'people' is the state 1.3 and 1.4 used to read their own People database. A run left in it by an update is taken back
// to the schema step, which needs no People read now.
const activeStates = "('schema','people','collect','send')";

// ---- Settings

export type SettingsRow = {
  readonly enabled: number; readonly weekdays: string; readonly runTime: string; readonly staleMinutes: number; readonly cooldownMinutes: number;
  readonly discordChannelId: string | null; readonly databaseId: string | null; readonly dataSourceId: string | null; readonly schemaJson: string | null;
  readonly verifiedMs: number | null; readonly schemaError: string | null; readonly sinceMs: number;
  readonly lastError: string | null; readonly lastErrorMs: number | null; readonly revision: number; readonly updatedMs: number;
};

export const readSettings = (db: Database) => db.prepare(`SELECT enabled,weekdays,run_time AS runTime,stale_minutes AS staleMinutes,cooldown_minutes AS cooldownMinutes,
  discord_channel_id AS discordChannelId,database_id AS databaseId,data_source_id AS dataSourceId,schema_json AS schemaJson,verified_ms AS verifiedMs,schema_error AS schemaError,
  schedule_since_ms AS sinceMs,last_error AS lastError,last_error_ms AS lastErrorMs,revision,updated_ms AS updatedMs
  FROM part_requests_reminder_settings WHERE installation_id=?`).bind(installationId).first<SettingsRow>();

const parse = <T>(text: string | null | undefined): T | undefined => { if (!text) return undefined; try { return JSON.parse(text) as T; } catch { return undefined; } };
export const reminderSchema = (settings: SettingsRow | null) => parse<ReminderSchema>(settings?.schemaJson);
/** The ordering database's layout passed the reminders check and has not failed one since. Reminders need it, whatever the switch says. */
export const targetVerified = (settings: SettingsRow | null) => Boolean(settings?.verifiedMs && !settings.schemaError && reminderSchema(settings));

// ---- People to Discord IDs. A resolution is a Discord user ID, or "!" and why there is none.

export type Unpinged = "no_member" | "ambiguous" | "no_discord_id";
export type Resolutions = Readonly<Record<string, string>>;
export type RosterMember = { readonly id: string; readonly memberId: string; readonly discordUserId: string | null; readonly active: number };

const discordPattern = /^\d{17,20}$/;
/** Active members by their internal ID: their Discord ID, or "" without one. Inactive members are not here, so they match nobody. */
export function rosterIndex(members: readonly RosterMember[]): Record<string, string> {
  const index: Record<string, string> = {};
  for (const member of members) if (member.active === 1 && member.id) index[member.id] = member.discordUserId && discordPattern.test(member.discordUserId) ? member.discordUserId : "";
  return index;
}

const resolved = (discord: string | undefined): string => discord === undefined ? "!no_member" : discord || "!no_discord_id";

/** Core's rows that match a member: only these are ever used to ping anyone. Names and external IDs are dropped here. */
export const matchedAccounts = (accounts: readonly NotionPersonAccount[] | undefined) =>
  (accounts ?? []).filter((row) => row?.matched === true && typeof row.memberId === "string" && row.memberId !== "" && typeof row.notionUserId === "string" && row.notionUserId !== "")
    .map((row) => ({ notionUserId: row.notionUserId, memberId: row.memberId! }));

/**
 * Core's people matching: Notion account → member → Discord ID, from matched rows only. Core matches a member ID to one row
 * at most; a Notion account on two matched rows, or a member on two, is ambiguous here anyway, and nobody is pinged for it.
 */
export function resolveByPeople(rows: readonly { readonly notionUserId: string; readonly memberId: string }[], rosterById: Readonly<Record<string, string>>): Record<string, string> {
  const perAccount = new Map<string, Set<string>>(); const perMember = new Map<string, Set<string>>();
  for (const row of rows) {
    perAccount.set(row.notionUserId, (perAccount.get(row.notionUserId) ?? new Set()).add(row.memberId));
    perMember.set(row.memberId, (perMember.get(row.memberId) ?? new Set()).add(row.notionUserId));
  }
  const map: Record<string, string> = {};
  for (const [account, members] of perAccount) {
    const member = [...members][0]!;
    map[account] = members.size > 1 || (perMember.get(member)?.size ?? 0) > 1 ? "!ambiguous" : resolved(rosterById[member]);
  }
  return map;
}

/**
 * The fallback, while Core's people matching is not set up or matches nobody: the one active member who chose this Notion
 * person as their default recipient. That may be a mentor rather than the member, and two members choosing the same person
 * is ambiguous.
 */
export function resolveByRecipients(rows: readonly { readonly notionUserId: string; readonly memberId: string }[], rosterById: Readonly<Record<string, string>>): Record<string, string> {
  const members = new Map<string, Set<string>>();
  for (const row of rows) if (rosterById[row.memberId] !== undefined) members.set(row.notionUserId, (members.get(row.notionUserId) ?? new Set()).add(row.memberId));
  const map: Record<string, string> = {};
  for (const [user, ids] of members) map[user] = ids.size > 1 ? "!ambiguous" : resolved(rosterById[[...ids][0]!]);
  return map;
}

/** Discord IDs to ping for a request's people, and each person skipped with why. */
export function pings(people: readonly string[], map: Resolutions): { readonly ids: string[]; readonly unpinged: { readonly person: string; readonly reason: Unpinged }[] } {
  const ids: string[] = []; const unpinged: { person: string; reason: Unpinged }[] = [];
  for (const person of people) {
    const value = map[person] ?? "!no_member";
    if (value.startsWith("!")) unpinged.push({ person, reason: value.slice(1) as Unpinged });
    else if (!ids.includes(value)) ids.push(value);
  }
  return { ids: ids.slice(0, maximumMentions), unpinged };
}

// ---- Message

/**
 * The reminder, in the team's own wording, the same in Notion and in Discord. Only the request's description and the
 * threshold change: "<N> days", or minutes for a testing threshold that is not a whole number of days.
 */
export function reminderText(description: string, staleMinutes: number): string {
  return `Your part request '${description || "(no description)"}' has been in Incomplete Request for more than ${durationText(staleMinutes)}, so it has not been ordered. Finish the details and change the Status to NORMAL, RUSH or SLOW Request, or delete the request if you no longer need it.`;
}

/** Request text made inert in Discord: one line, Markdown escaped, no mentions, no unfurled links. */
export function escapeDiscord(text: string): string {
  return text.replace(/\s+/g, " ").trim().replace(/[\\*_~`|>#\-[\]()<]/g, (character) => `\\${character}`).replace(/@/g, "@​").replace(/:\/\//g, ":​//");
}

export const discordSuppressEmbeds = 1 << 2;

/** The Discord message: the mentions, the reminder, then the page link. Only these IDs can ping. No names, team or price. */
export function discordBody(ids: readonly string[], description: string, staleMinutes: number, pageUrl: string, nonce: string) {
  const mentions = ids.map((id) => `<@${id}>`).join(" ");
  const content = `${mentions ? `${mentions} ` : ""}${reminderText(escapeDiscord(description), staleMinutes)}\n${pageUrl}`;
  return { content: content.slice(0, 2000), allowed_mentions: { parse: [] as const, users: [...ids] }, nonce, enforce_nonce: true, flags: discordSuppressEmbeds };
}

/** The same nonce on every retry of one request's message, so Discord posts it once. Discord allows 25 characters. */
export const discordNonce = async (runKey: string, pageId: string) => (await sha256Hex(`part-requests:reminder:${runKey}:${pageId}`)).slice(0, 25);

// ---- Runs

export type RunConfig = { readonly staleMinutes: number; readonly cooldownMinutes: number; readonly channelId: string | null; readonly schema: ReminderSchema };
type RunRow = {
  readonly runKey: string; readonly kind: string; readonly state: string; readonly configJson: string; readonly mentionsJson: string | null;
  readonly cursor: string | null; readonly pages: number; readonly truncated: number; readonly attempts: number; readonly leaseUntil: number; readonly nextAttempt: number;
};
type ItemRow = {
  readonly pageId: string; readonly pageUrl: string; readonly description: string; readonly mentionsJson: string; readonly peopleJson: string;
  readonly commentState: string; readonly discordState: string; readonly markState: string; readonly attempts: number; readonly nextAttempt: number;
};

export function runConfig(settings: SettingsRow): RunConfig | undefined {
  const schema = reminderSchema(settings);
  if (!schema) return undefined;
  return { staleMinutes: settings.staleMinutes, cooldownMinutes: settings.cooldownMinutes, channelId: settings.discordChannelId, schema };
}

/** A new run, unless one with this key exists. */
export const insertRun = (db: Database, runKey: string, kind: "scheduled" | "manual", config: RunConfig, now: number) =>
  db.prepare(`INSERT INTO part_requests_reminder_runs(installation_id,run_key,kind,state,config_json,created_ms) VALUES (?,?,?,'schema',?,?) ON CONFLICT(installation_id,run_key) DO NOTHING`)
    .bind(installationId, runKey, kind, JSON.stringify(config), now);

export const activeRunSql = `SELECT run_key AS runKey,kind,state,config_json AS configJson,mentions_json AS mentionsJson,cursor,pages,truncated,attempts,
  lease_until_ms AS leaseUntil,next_attempt_ms AS nextAttempt FROM part_requests_reminder_runs WHERE installation_id=? AND state IN ${activeStates} ORDER BY created_ms LIMIT 1`;

/** Stop whatever run is in progress, as when reminders are turned off or the target changes. Steps not started are skipped. */
export const cancelActiveRun = (db: Database, code: string, now: number): Statement[] => [
  db.prepare(`UPDATE part_requests_reminder_items SET comment_state=CASE WHEN comment_state='pending' THEN 'skipped' ELSE comment_state END,
    discord_state=CASE WHEN discord_state='pending' THEN 'skipped' ELSE discord_state END,mark_state=CASE WHEN mark_state='pending' THEN 'skipped' ELSE mark_state END
    WHERE installation_id=?1 AND run_key IN (SELECT run_key FROM part_requests_reminder_runs WHERE installation_id=?1 AND state IN ${activeStates})`).bind(installationId),
  db.prepare(`UPDATE part_requests_reminder_runs SET state='failed',error_code=?,finished_ms=?,lease_token=NULL,lease_until_ms=0 WHERE installation_id=? AND state IN ${activeStates}`).bind(code, now, installationId),
];

/** Counts for a run, from its items. No names: only how many. */
export const runCountsSql = `SELECT COUNT(*) AS found,
  SUM(CASE WHEN comment_state='sent' THEN 1 ELSE 0 END) AS reminded,
  SUM(CASE WHEN mark_state='set' THEN 1 ELSE 0 END) AS marked,
  SUM(CASE WHEN discord_state='sent' THEN 1 ELSE 0 END) AS discordSent,
  SUM(CASE WHEN discord_state='failed' THEN 1 ELSE 0 END) AS discordFailed,
  SUM(CASE WHEN comment_state='failed' OR mark_state='failed' THEN 1 ELSE 0 END) AS notionFailed,
  SUM(CASE WHEN comment_state='uncertain' THEN 1 ELSE 0 END) AS uncertain,
  SUM(CASE WHEN skip_reason='no_people' THEN 1 ELSE 0 END) AS nobody,
  SUM(CASE WHEN skip_reason='recently_reminded' THEN 1 ELSE 0 END) AS recent,
  SUM(CASE WHEN unpinged_json<>'[]' THEN 1 ELSE 0 END) AS pingSkipped
  FROM part_requests_reminder_items WHERE installation_id=? AND run_key=?`;
export type RunCounts = Record<"found" | "reminded" | "marked" | "discordSent" | "discordFailed" | "notionFailed" | "uncertain" | "nobody" | "recent" | "pingSkipped", number>;
export const numericCounts = (row: Record<string, unknown> | null): RunCounts => Object.fromEntries(
  ["found", "reminded", "marked", "discordSent", "discordFailed", "notionFailed", "uncertain", "nobody", "recent", "pingSkipped"].map((key) => [key, Number(row?.[key] ?? 0)])) as RunCounts;

/** Whether a row read from Notion is really due a reminder, checked here whatever the filter returned. */
export function isDue(row: { readonly status: string; readonly createdMs: number; readonly reminderSentMs: number | null }, incomplete: string, staleBefore: number, cooldownBefore: number) {
  return row.status === incomplete && Number.isFinite(row.createdMs) && row.createdMs < staleBefore && (row.reminderSentMs === null || row.reminderSentMs < cooldownBefore);
}

export type Mentions = { readonly map: Resolutions; readonly source: "people" | "fallback" };

/**
 * Who to ping, from the roster, Core's people matching and the default recipients: everything a run needs from LancerLogin,
 * as IDs only, and no Notion request. Core's matched rows decide when there are any; otherwise the default recipients do.
 */
export async function rosterMentions(db: Database, today: string): Promise<Mentions> {
  const [roster, chosen, accounts] = await Promise.all([
    reportRosterData(db as unknown as D1Database, today),
    db.prepare("SELECT notion_user_id AS notionUserId,member_id AS memberId FROM part_requests_member_recipients WHERE installation_id=?").bind(installationId).all<{ notionUserId: string; memberId: string }>(),
    listNotionPeopleAccounts(db as unknown as D1Database, installationId),
  ]);
  // Names and emails come back with the roster and with Core's People rows; only IDs leave this function.
  const members = (roster.members as readonly RosterMember[]).map(({ id, memberId, discordUserId, active }) => ({ id, memberId, discordUserId, active: Number(active) }));
  const byId = rosterIndex(members);
  const matched = matchedAccounts(accounts);
  if (matched.length) return { map: resolveByPeople(matched, byId), source: "people" };
  return { map: resolveByRecipients(chosen.results ?? [], byId), source: "fallback" };
}

// ---- The job

export type DiscordService = {
  ready(): Promise<boolean>;
  client(): Promise<{ request<T = Record<string, unknown>>(path: string, init: RequestInit): Promise<T> }>;
  providerStatus(error: unknown): number | undefined;
  retryAfterMs(error: unknown): number | undefined;
};
export type ReminderJobContext = { readonly db: unknown; readonly services: { readonly notion: NotionService; readonly discord?: DiscordService }; readonly scheduler?: { readonly steps: boolean } };

type Slice = { readonly more: boolean; readonly result: Record<string, unknown> };
const stop = (result: Record<string, unknown>): Slice => ({ more: false, result });
const go = (result: Record<string, unknown> = {}): Slice => ({ more: true, result });

const retryMs = (error: unknown, fallback: number) => {
  const seconds = error instanceof AppError ? Number((error.details as { retryAfterSeconds?: number } | undefined)?.retryAfterSeconds) : NaN;
  return Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds * 1000, 15 * minuteMs) : fallback;
};
/** Core held the call before sending it: its per-invocation cap, or its shared pause after a rate limit. Nothing was sent. */
const heldByCore = (error: AppError) => error.code === "notion_call_limit" || error.code === "notion_paused";
/** Core's refusals that need an Admin, as opposed to Notion not answering for now. */
const coreRefusals = new Set(["notion_not_configured", "notion_disabled", "notion_unreadable", "notion_unbound", "notion_not_declared", "notion_out_of_scope"]);

/** The scheduled job. Returns `{ more: true }` with work left, so the scheduler runs it again within seconds. */
export async function remindersJob(context: ReminderJobContext): Promise<unknown> {
  const steps = context.scheduler?.steps === true;
  // Core builds `services.notion` once per invocation, with its own cap on requests, so the slices share one client.
  const notion = new RemindersNotion(context.services.notion);
  let last: Slice = stop({ skipped: "idle" });
  for (let run = 0; run < (steps ? 1 : cronSlices); run++) {
    if (notion.calls + maximumSliceNotionCalls > notionCallsPerInvocation) break;
    last = await reminderSlice(context, Date.now(), notion);
    if (!last.more) return last.result;
  }
  return { more: true, ...last.result };
}

type Held = { readonly db: Database; readonly runKey: string; readonly lease: string; readonly now: number };

/** One slice: one step. Exported for tests, which pass the time. */
export async function reminderSlice(context: ReminderJobContext, now: number, notion = new RemindersNotion(context.services.notion)): Promise<Slice> {
  const db = context.db as Database;
  const nextItemSql = `SELECT page_id AS pageId,page_url AS pageUrl,description,mentions_json AS mentionsJson,people_json AS peopleJson,comment_state AS commentState,
    discord_state AS discordState,mark_state AS markState,attempts,next_attempt_ms AS nextAttempt FROM part_requests_reminder_items
    WHERE installation_id=?1 AND run_key=(SELECT run_key FROM part_requests_reminder_runs WHERE installation_id=?1 AND state='send' ORDER BY created_ms LIMIT 1)
      AND (comment_state IN ('pending','sending') OR discord_state='pending' OR mark_state='pending')
    ORDER BY CASE WHEN next_attempt_ms<=?2 THEN 0 ELSE 1 END,next_attempt_ms,seq LIMIT 1`;
  // One coalesced read decides almost every slice.
  const [settings, run, latest, item, timeZone] = await Promise.all([
    readSettings(db),
    db.prepare(activeRunSql).bind(installationId).first<RunRow>(),
    db.prepare("SELECT MAX(run_key) AS runKey FROM part_requests_reminder_runs WHERE installation_id=? AND kind='scheduled'").bind(installationId).first<{ runKey: string | null }>(),
    db.prepare(nextItemSql).bind(installationId, now).first<ItemRow>(),
    installationTimeZone(db as unknown as D1Database, installationId).catch(() => null as string | null),
  ]);
  if (!settings?.enabled) {
    if (run) { await db.batch(cancelActiveRun(db, "disabled", now)); return stop({ cancelled: "disabled" }); }
    return stop({ skipped: "disabled" });
  }
  if (!run) {
    if (!targetVerified(settings)) return stop({ skipped: "unverified" });
    if (!timeZone) { await recordProblem(db, settings, "time_zone_missing", now); return stop({ failed: "time_zone_missing" }); }
    let slot;
    try { slot = dueSlot(timeZone, parseWeekdays(settings.weekdays), settings.runTime, settings.sinceMs, now); }
    catch { await recordProblem(db, settings, "time_zone_invalid", now); return stop({ failed: "time_zone_invalid" }); }
    if (!slot || (latest?.runKey && latest.runKey >= slot.date)) return stop({ skipped: "not due" });
    const config = runConfig(settings);
    if (!config) return stop({ skipped: "unverified" });
    await insertRun(db, slot.date, "scheduled", config, now).run();
    return go({ started: "scheduled" });
  }
  if (run.nextAttempt > now) return stop({ skipped: "waiting" });
  if (run.leaseUntil > now) return stop({ skipped: "busy" });
  const config = parse<RunConfig>(run.configJson);
  const lease = crypto.randomUUID();
  const claimed = await db.prepare("UPDATE part_requests_reminder_runs SET lease_token=?,lease_until_ms=? WHERE installation_id=? AND run_key=? AND state=? AND lease_until_ms<=?")
    .bind(lease, now + leaseMs, installationId, run.runKey, run.state, now).run();
  if (claimed.meta?.changes !== 1) return stop({ skipped: "busy" });
  const held: Held = { db, runKey: run.runKey, lease, now };
  if (!config) return failRun(held, "config");
  const discordNext = run.state === "send" && item && item.nextAttempt <= now && item.commentState !== "pending" && item.commentState !== "sending" && item.discordState === "pending";
  try {
    // Every step but Discord calls Notion: wait while Core cannot send, and stop when it never will without an Admin.
    if (!discordNext && (run.state !== "send" || item)) {
      const gate = await notionGate(held, context.services.notion);
      if (gate) return gate;
    }
    if (run.state === "schema" || run.state === "people") return await schemaStep(held, run, config, notion, timeZone);
    if (run.state === "collect") return await collectStep(held, run, config, notion);
    if (!item) return await finishRun(held, settings);
    if (item.nextAttempt > now) {
      await release(held, [db.prepare("UPDATE part_requests_reminder_runs SET next_attempt_ms=? WHERE installation_id=? AND run_key=? AND lease_token=?").bind(item.nextAttempt, installationId, run.runKey, lease)]);
      return stop({ waiting: item.nextAttempt - now });
    }
    if (item.commentState === "pending" || item.commentState === "sending") return await commentStep(held, item, config, notion);
    if (item.discordState === "pending") return await discordStep(held, item, config, context.services.discord);
    return await markStep(held, item, config, notion);
  } catch (error) {
    await release(held, []);
    throw error;
  }
}

/**
 * Whether Notion can be called now, from what Core loaded for this invocation (one D1 read, shared with the calls after it).
 * Undefined when it can. While Core holds deliveries or calls (after a restore, or a rate limit), the run waits; without a
 * usable connection or the ordering database, it fails and the Reminders tab says what to fix.
 */
async function notionGate(held: Held, notion: NotionService): Promise<Slice | undefined> {
  const [ready, status] = await Promise.all([notion.ready(), notion.status()]);
  if (ready && !status.pausedUntilMs) return undefined;
  if (!status.connected) return failRun(held, "notion_not_connected");
  if (!status.bindings.some((binding) => binding.id === "orders" && binding.bound)) return failRun(held, "notion_unbound");
  const until = status.pausedUntilMs && status.pausedUntilMs > held.now ? status.pausedUntilMs : held.now + pausedWaitMs;
  await release(held, [held.db.prepare("UPDATE part_requests_reminder_runs SET next_attempt_ms=? WHERE installation_id=? AND run_key=? AND lease_token=?").bind(until, installationId, held.runKey, held.lease)]);
  return stop({ waiting: until - held.now });
}

/** Writes made while holding the lease, then the lease released. A slice that lost its lease writes nothing. */
async function release(held: Held, statements: Statement[]) {
  const { db } = held;
  await db.batch([...statements, db.prepare("UPDATE part_requests_reminder_runs SET lease_token=NULL,lease_until_ms=0 WHERE installation_id=? AND run_key=? AND lease_token=?").bind(installationId, held.runKey, held.lease)]);
}
const holds = "EXISTS(SELECT 1 FROM part_requests_reminder_runs r WHERE r.installation_id=?1 AND r.run_key=?2 AND r.lease_token=?3)";

const recordProblem = async (db: Database, settings: SettingsRow, code: string, now: number) => {
  if (settings.lastError === code) return;
  await db.prepare("UPDATE part_requests_reminder_settings SET last_error=?,last_error_ms=? WHERE installation_id=?").bind(code, now, installationId).run();
};

async function failRun(held: Held, code: string, extra: Statement[] = []): Promise<Slice> {
  const { db, now } = held;
  await db.batch([
    ...extra,
    db.prepare(`UPDATE part_requests_reminder_items SET comment_state=CASE WHEN comment_state='pending' THEN 'skipped' ELSE comment_state END,
      discord_state=CASE WHEN discord_state='pending' THEN 'skipped' ELSE discord_state END,mark_state=CASE WHEN mark_state='pending' THEN 'skipped' ELSE mark_state END
      WHERE installation_id=?1 AND run_key=?2 AND ${holds}`).bind(installationId, held.runKey, held.lease),
    db.prepare("UPDATE part_requests_reminder_settings SET last_error=?,last_error_ms=? WHERE installation_id=? AND EXISTS(SELECT 1 FROM part_requests_reminder_runs WHERE installation_id=? AND run_key=? AND lease_token=?)")
      .bind(code, now, installationId, installationId, held.runKey, held.lease),
    db.prepare("UPDATE part_requests_reminder_runs SET state='failed',error_code=?,finished_ms=?,lease_token=NULL,lease_until_ms=0 WHERE installation_id=? AND run_key=? AND lease_token=?").bind(code, now, installationId, held.runKey, held.lease),
  ]);
  return stop({ failed: code });
}

/** Try the same step again later without counting an attempt: Core held the call, so Notion never saw it. */
async function later(held: Held, error: AppError): Promise<Slice> {
  const wait = retryMs(error, 1000);
  await release(held, [held.db.prepare("UPDATE part_requests_reminder_runs SET next_attempt_ms=? WHERE installation_id=? AND run_key=? AND lease_token=?").bind(held.now + wait, installationId, held.runKey, held.lease)]);
  return stop({ waiting: wait });
}

/** A step Notion could not answer for now: try again later, and fail the run after `runAttempts`. Refusals fail it at once. */
async function stepFailed(held: Held, run: RunRow, error: unknown): Promise<Slice> {
  if (!(error instanceof AppError)) throw error;
  if (error.code === "schema") return failRun(held, "schema", [held.db.prepare("UPDATE part_requests_reminder_settings SET schema_error=? WHERE installation_id=?").bind(error.message.slice(0, 500), installationId)]);
  if (heldByCore(error)) return later(held, error);
  if (coreRefusals.has(error.code) || ["notion_401", "notion_403", "notion_404", "notion_400"].includes(error.code) || run.attempts + 1 >= runAttempts) return failRun(held, error.code);
  const wait = retryMs(error, minuteMs * (run.attempts + 1));
  await release(held, [held.db.prepare("UPDATE part_requests_reminder_runs SET attempts=attempts+1,next_attempt_ms=? WHERE installation_id=? AND run_key=? AND lease_token=?").bind(held.now + wait, installationId, held.runKey, held.lease)]);
  return stop({ retry: error.code });
}

/**
 * Step 0: the ordering database's layout again through `orders` (the step's one Notion request), then who to ping, from the
 * roster and Core's people matching (no Notion request), read once per run. A binding that now points at another data source
 * stops the run: an Admin checks it again first.
 */
async function schemaStep(held: Held, run: RunRow, config: RunConfig, notion: RemindersNotion, timeZone: string | null): Promise<Slice> {
  const { db, now } = held;
  let fresh: ReminderSchema;
  try { fresh = await notion.readReminderSchema(config.schema); }
  catch (error) { return stepFailed(held, run, error); }
  if (fresh.dataSourceId !== config.schema.dataSourceId) {
    return failRun(held, "target_changed", [db.prepare("UPDATE part_requests_reminder_settings SET schema_error=? WHERE installation_id=?").bind("The ordering database chosen in Core changed. Check it again for reminders.", installationId)]);
  }
  const today = timeZone ? localAt(timeZone, now).date : new Date(now).toISOString().slice(0, 10);
  const mentions = await rosterMentions(db, today);
  // The config is written field by field, so a run started by 1.3 or 1.4 leaves its People layout behind.
  const next: RunConfig = { staleMinutes: config.staleMinutes, cooldownMinutes: config.cooldownMinutes, channelId: config.channelId, schema: fresh };
  await release(held, [db.prepare("UPDATE part_requests_reminder_runs SET state='collect',config_json=?,mentions_json=?,people_json=NULL,attempts=0,cursor=NULL,pages=0 WHERE installation_id=? AND run_key=? AND lease_token=?")
    .bind(JSON.stringify(next), JSON.stringify(mentions), installationId, held.runKey, held.lease)]);
  return go({ step: "collect" });
}

/** Page IDs reminded within the cooldown by a local record: a comment sent or uncertain counts, even when "Reminder sent" was never set. */
export async function recentlyReminded(db: Database, pageIds: readonly string[], cooldownBefore: number): Promise<Set<string>> {
  if (!pageIds.length) return new Set();
  const rows = await db.prepare(`SELECT DISTINCT page_id AS pageId FROM part_requests_reminder_items WHERE installation_id=? AND comment_ms>=?
    AND comment_state IN ('sent','uncertain','sending') AND page_id IN (SELECT value FROM json_each(?))`).bind(installationId, cooldownBefore, JSON.stringify(pageIds)).all<{ pageId: string }>();
  return new Set((rows.results ?? []).map((row) => row.pageId));
}

/** One page of stale requests: each becomes an item with its pings, or a skip with its reason. */
async function collectStep(held: Held, run: RunRow, config: RunConfig, notion: RemindersNotion): Promise<Slice> {
  const { db, now } = held;
  const staleBefore = now - config.staleMinutes * minuteMs;
  const cooldownBefore = now - config.cooldownMinutes * minuteMs;
  let page;
  try { page = await notion.staleRequestsPage(config.schema, new Date(staleBefore).toISOString(), new Date(cooldownBefore).toISOString(), collectPageSize, run.cursor ?? undefined); }
  catch (error) { return stepFailed(held, run, error); }
  const rows = page.rows.map((row) => staleRow(row, config.schema)).filter((row): row is StaleRow => row !== undefined).filter((row) => isDue(row, config.schema.statuses.incomplete, staleBefore, cooldownBefore));
  const recent = await recentlyReminded(db, rows.map((row) => row.pageId), cooldownBefore);
  const map = parse<{ map: Resolutions }>(run.mentionsJson)?.map ?? {};
  const inserts = rows.map((row, index) => {
    const { ids, unpinged } = pings(row.people, map);
    const skip = !row.people.length ? "no_people" : recent.has(row.pageId) ? "recently_reminded" : null;
    const state = skip ? "skipped" : "pending";
    return db.prepare(`INSERT INTO part_requests_reminder_items(installation_id,run_key,page_id,seq,page_url,description,people_json,mentions_json,unpinged_json,skip_reason,comment_state,discord_state,mark_state)
      SELECT ?1,?2,?4,?5,?6,?7,?8,?9,?10,?11,?12,?12,?12 WHERE ${holds} ON CONFLICT(installation_id,run_key,page_id) DO NOTHING`)
      .bind(installationId, held.runKey, held.lease, row.pageId, run.pages * collectPageSize + index, row.pageUrl, row.description, JSON.stringify(row.people), JSON.stringify(ids), JSON.stringify(skip ? [] : unpinged), skip, state);
  });
  const pages = run.pages + 1;
  const more = Boolean(page.next) && pages < maximumCollectPages;
  const truncated = Boolean(page.next) && !more;
  await release(held, [...inserts, db.prepare("UPDATE part_requests_reminder_runs SET state=?,cursor=?,pages=?,truncated=?,attempts=0 WHERE installation_id=? AND run_key=? AND lease_token=?")
    .bind(more ? "collect" : "send", more ? page.next! : null, pages, truncated ? 1 : 0, installationId, held.runKey, held.lease)]);
  return go({ step: more ? "collect" : "send", found: rows.length });
}

const itemUpdate = (held: Held, pageId: string, set: string, values: unknown[]) =>
  held.db.prepare(`UPDATE part_requests_reminder_items SET ${set} WHERE installation_id=?1 AND run_key=?2 AND page_id=?4 AND ${holds}`).bind(installationId, held.runKey, held.lease, pageId, ...values);

/** After the comment: Discord when there is a channel and someone to ping, then the mark. */
function afterComment(item: ItemRow, config: RunConfig): { discord: string; note: string | null } {
  if (!config.channelId) return { discord: "skipped", note: "discord_off" };
  if (!(parse<string[]>(item.mentionsJson) ?? []).length) return { discord: "skipped", note: "no_ids" };
  return { discord: "pending", note: null };
}

async function commentStep(held: Held, item: ItemRow, config: RunConfig, notion: RemindersNotion): Promise<Slice> {
  const { now } = held;
  // A comment left "sending" belongs to a slice that stopped mid-call: Notion may have it, so it is never sent again.
  if (item.commentState === "sending") {
    await release(held, [itemUpdate(held, item.pageId, "comment_state='uncertain',discord_state='skipped',mark_state='skipped',error_code='interrupted'", [])]);
    return go({ uncertain: 1 });
  }
  const started = await itemUpdate(held, item.pageId, "comment_state='sending',comment_ms=?5", [now]).run();
  if (started.meta?.changes !== 1) { await release(held, []); return stop({ skipped: "busy" }); }
  const people = parse<string[]>(item.peopleJson) ?? [];
  try {
    await notion.createComment(item.pageId, people, reminderText(item.description, config.staleMinutes));
  } catch (error) {
    if (!(error instanceof AppError)) { await release(held, [itemUpdate(held, item.pageId, "comment_state='uncertain',discord_state='skipped',mark_state='skipped',error_code='error'", [])]); throw error; }
    if (error.uncertain) {
      await release(held, [itemUpdate(held, item.pageId, "comment_state='uncertain',discord_state='skipped',mark_state='skipped',error_code=?5", [error.code])]);
      return go({ uncertain: 1 });
    }
    // Core held the call (its cap or its pause after a rate limit): nothing reached Notion, so it is simply tried again.
    if (heldByCore(error)) {
      await release(held, [itemUpdate(held, item.pageId, "comment_state='pending',comment_ms=NULL,next_attempt_ms=?5", [now + retryMs(error, 1000)])]);
      return stop({ waiting: retryMs(error, 1000) });
    }
    if (error.code === "notion_401" || error.code === "notion_403" || error.code === "notion_404" || coreRefusals.has(error.code)) {
      const code = error.code === "notion_403" || error.code === "notion_404" ? `notion_comment_${error.code.slice(-3)}` : error.code;
      return failRun(held, code, [itemUpdate(held, item.pageId, "comment_state='failed',comment_ms=NULL,discord_state='skipped',mark_state='skipped',error_code=?5", [code])]);
    }
    // 400 and 429, or anything else Notion refused outright: nothing was created, so it may be tried again.
    if (item.attempts + 1 < commentAttempts) {
      await release(held, [itemUpdate(held, item.pageId, "comment_state='pending',comment_ms=NULL,attempts=attempts+1,next_attempt_ms=?5,error_code=?6", [now + retryMs(error, minuteMs), error.code])]);
      return go({ retry: error.code });
    }
    await release(held, [itemUpdate(held, item.pageId, "comment_state='failed',comment_ms=NULL,discord_state='skipped',mark_state='skipped',error_code=?5", [error.code])]);
    return go({ failed: error.code });
  }
  const next = afterComment(item, config);
  await release(held, [itemUpdate(held, item.pageId, "comment_state='sent',comment_ms=?5,discord_state=?6,discord_note=?7,attempts=0,next_attempt_ms=0,error_code=NULL", [now, next.discord, next.note])]);
  return go({ commented: 1 });
}

async function discordStep(held: Held, item: ItemRow, config: RunConfig, discord: DiscordService | undefined): Promise<Slice> {
  const { now } = held;
  const finish = (state: string, note: string | null) => release(held, [itemUpdate(held, item.pageId, "discord_state=?5,discord_note=?6,attempts=0,next_attempt_ms=0", [state, note])]);
  if (!discord || !config.channelId || !await discord.ready().catch(() => false)) { await finish("failed", "discord_unavailable"); return go({ discord: "unavailable" }); }
  const ids = parse<string[]>(item.mentionsJson) ?? [];
  const body = discordBody(ids, item.description, config.staleMinutes, item.pageUrl, await discordNonce(held.runKey, item.pageId));
  try {
    const client = await discord.client();
    await client.request(`/channels/${encodeURIComponent(config.channelId)}/messages`, { method: "POST", body: JSON.stringify(body) });
  } catch (error) {
    const status = discord.providerStatus(error);
    const note = `discord_${status ?? "error"}`;
    if (item.attempts + 1 < discordAttempts) {
      await release(held, [itemUpdate(held, item.pageId, "attempts=attempts+1,next_attempt_ms=?5,discord_note=?6", [now + Math.max(1000, Math.min(discord.retryAfterMs(error) ?? 5000, 15 * minuteMs)), note])]);
      return go({ retry: note });
    }
    await finish("failed", note);
    return go({ discord: "failed" });
  }
  await finish("sent", null);
  return go({ discord: "sent" });
}

async function markStep(held: Held, item: ItemRow, config: RunConfig, notion: RemindersNotion): Promise<Slice> {
  const { now } = held;
  try { await notion.setReminderSent(item.pageId, config.schema.properties.reminderSent.id, new Date(now).toISOString()); }
  catch (error) {
    if (!(error instanceof AppError)) throw error;
    if (heldByCore(error)) {
      await release(held, [itemUpdate(held, item.pageId, "next_attempt_ms=?5", [now + retryMs(error, 1000)])]);
      return stop({ waiting: retryMs(error, 1000) });
    }
    if (error.code === "notion_401" || error.code === "notion_403" || coreRefusals.has(error.code)) {
      const code = error.code === "notion_403" ? "notion_update_403" : error.code;
      return failRun(held, code, [itemUpdate(held, item.pageId, "mark_state='failed',error_code=?5", [code])]);
    }
    if (error.code !== "notion_404" && item.attempts + 1 < markAttempts) {
      await release(held, [itemUpdate(held, item.pageId, "attempts=attempts+1,next_attempt_ms=?5,error_code=?6", [now + retryMs(error, minuteMs), error.code])]);
      return go({ retry: error.code });
    }
    await release(held, [itemUpdate(held, item.pageId, "mark_state='failed',attempts=0,error_code=?5", [error.code])]);
    return go({ mark: "failed" });
  }
  await release(held, [itemUpdate(held, item.pageId, "mark_state='set',attempts=0,next_attempt_ms=0", [])]);
  return go({ mark: "set" });
}

/** Every step is final: record the counts, clear the setup problem and forget runs older than 30 days. */
async function finishRun(held: Held, settings: SettingsRow): Promise<Slice> {
  const { db, now } = held;
  const counts = numericCounts(await db.prepare(runCountsSql).bind(installationId, held.runKey).first<Record<string, unknown>>());
  const cutoff = now - historyMs;
  await db.batch([
    db.prepare("UPDATE part_requests_reminder_runs SET state='done',counts_json=?,finished_ms=?,lease_token=NULL,lease_until_ms=0 WHERE installation_id=? AND run_key=? AND lease_token=?").bind(JSON.stringify(counts), now, installationId, held.runKey, held.lease),
    ...(settings.lastError ? [db.prepare("UPDATE part_requests_reminder_settings SET last_error=NULL,last_error_ms=NULL WHERE installation_id=?").bind(installationId)] : []),
    db.prepare(`DELETE FROM part_requests_reminder_items WHERE installation_id=?1 AND run_key IN (SELECT run_key FROM part_requests_reminder_runs WHERE installation_id=?1 AND created_ms<?2 AND state IN ('done','failed'))`).bind(installationId, cutoff),
    db.prepare("DELETE FROM part_requests_reminder_runs WHERE installation_id=? AND created_ms<? AND state IN ('done','failed')").bind(installationId, cutoff),
  ]);
  return stop({ done: true, ...counts });
}
