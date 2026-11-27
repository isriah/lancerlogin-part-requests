// Stale-request reminders end to end: the admin routes and the job, on the real migrations, with Core's `services.notion`
// stubbed (core-notion-stub.ts, which sends real requests to the fetch-boundary Notion stub) and a fake Discord service.
// Every person, member and ID here is synthetic.
import test, { afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { createHarness, discordA, discordB, goodDraft, type Harness } from "./helpers/harness.ts";
import { dataSource, dataSourceId, databaseId, guestPerson, memberPerson, notionResponse, otherDataSourceId, stubNotion, type Call, type Stub } from "./helpers/notion-stub.ts";

const sdk = new URL("./helpers/module-sdk-stub.ts", import.meta.url).href;
registerHooks({ resolve: (specifier, context, next) => specifier === "@lancerlogin/module-sdk/api" ? { url: sdk, shortCircuit: true } : next(specifier, context) });
const { default: api } = await import("../src/api.ts") as { default: any };
const reminders = await import("../src/reminders.ts");
const remindersNotion = await import("../src/reminders-notion.ts");

const peopleDb = "33333333-2222-4333-8444-555555555555";
const peopleSource = "eeeeeeee-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const thirdPerson = "c0000000-0000-4000-8000-00000000000d";
const channel = "300000000000000001";
const day = 86_400_000;
const exactText = (description: string, duration = "2 days") =>
  `Your part request '${description}' has been in Incomplete Request for more than ${duration}, so it has not been ordered. Finish the details and change the Status to NORMAL, RUSH or SLOW Request, or delete the request if you no longer need it.`;

type Row = { id: string; description: string; people: string[]; status?: string; createdMs: number; reminderMs?: number | null; dataSource?: string };

/** The ordering database as reminders need it: the ordering layout plus Created, Reminder sent and the four statuses. */
function orderingWithReminders(overrides: Record<string, unknown> = {}) {
  const base = dataSource();
  return {
    ...base,
    properties: {
      ...base.properties,
      Status: { id: "st%40t", type: "status", status: { options: ["Incomplete Request", "NORMAL Request", "RUSH Request", "SLOW Request"].map((name, index) => ({ id: index === 0 ? "incomplete" : index === 1 ? "normal" : `s${index}`, name })) } },
      Created: { id: "cr:t", type: "created_time", created_time: {} },
      "Reminder sent": { id: "r@m", type: "date", date: {} },
      ...overrides,
    },
  };
}

const iso = (ms: number) => new Date(ms).toISOString();
function page(row: Row) {
  return {
    object: "page", id: row.id, url: `https://www.notion.so/${row.id.replaceAll("-", "")}`, created_time: iso(row.createdMs),
    parent: { type: "data_source_id", data_source_id: row.dataSource ?? dataSourceId },
    properties: {
      "Item Description": { id: "title", type: "title", title: [{ plain_text: row.description }] },
      Status: { id: "st%40t", type: "status", status: { name: row.status ?? "Incomplete Request" } },
      "Orderer/Recipient": { id: "a%3Ab", type: "people", people: row.people.map((id) => ({ object: "user", id, name: "Test Person Name", person: { email: "person@example.test" } })) },
      Created: { id: "cr%3At", type: "created_time", created_time: iso(row.createdMs) },
      "Reminder sent": { id: "r%40m", type: "date", date: row.reminderMs ? { start: iso(row.reminderMs) } : null },
    },
  };
}

type PeopleEntry = { accounts: string[]; memberKey: string; active: boolean };
const peoplePage = (entry: PeopleEntry, index: number) => ({
  object: "page", id: `f0000000-0000-4000-8000-${String(index).padStart(12, "0")}`, url: "https://www.notion.so/person",
  parent: { type: "data_source_id", data_source_id: peopleSource },
  properties: {
    Name: { id: "title", type: "title", title: [{ plain_text: "Test Student Name" }] },
    "Notion account": { id: "acc", type: "people", people: entry.accounts.map((id) => ({ object: "user", id })) },
    "LancerLogin member ID": { id: "mid", type: "rich_text", rich_text: [{ plain_text: entry.memberKey }] },
    Active: { id: "act", type: "checkbox", checkbox: entry.active },
  },
});
const peopleSourceJson = (overrides: Record<string, unknown> = {}) => ({
  object: "data_source", id: peopleSource, title: [{ plain_text: "People" }], parent: { type: "database_id", database_id: peopleDb },
  properties: { "Notion account": { id: "acc", type: "people", people: {} }, "LancerLogin member ID": { id: "mid", type: "rich_text", rich_text: {} }, Active: { id: "act", type: "checkbox", checkbox: {} }, Name: { id: "title", type: "title", title: {} }, ...overrides },
});

type Answer = (call: Call) => Response | Promise<Response>;
/** Notion for the ordering database and People, as state the test changes. */
function reminderNotion(stub: Stub) {
  const state = { rows: [] as Row[], people: [] as PeopleEntry[], peopleSource: peopleSourceJson() as any, comment: undefined as Answer | undefined, patch: undefined as Answer | undefined, query: undefined as Answer | undefined, pageRead: undefined as Answer | undefined };
  stub.source = orderingWithReminders();
  stub.on(new RegExp(`^GET /data_sources/${peopleSource}$`), () => notionResponse(state.peopleSource));
  stub.on(new RegExp(`^POST /data_sources/${dataSourceId}/query$`), (call) => {
    if (state.query) return state.query(call);
    const start = Number(call.body.start_cursor ?? 0); const size = call.body.page_size;
    const rows = state.rows.slice(start, start + size);
    const more = start + size < state.rows.length;
    return notionResponse({ object: "list", results: rows.map(page), has_more: more, next_cursor: more ? String(start + size) : null });
  });
  stub.on(new RegExp(`^POST /data_sources/${peopleSource}/query$`), () => notionResponse({ object: "list", results: state.people.map(peoplePage), has_more: false, next_cursor: null }));
  // Core's page-in-database check.
  stub.on(/^GET \/pages\//, (call) => {
    if (state.pageRead) return state.pageRead(call);
    const id = call.url.split("/pages/")[1]!;
    const row = state.rows.find((item) => item.id === id);
    return row ? notionResponse(page(row)) : notionResponse({ object: "error", status: 404 }, 404);
  });
  stub.on(/^POST \/comments$/, (call) => state.comment ? state.comment(call) : notionResponse({ object: "comment", id: crypto.randomUUID() }));
  stub.on(/^PATCH \/pages\//, (call) => {
    if (state.patch) return state.patch(call);
    const id = call.url.split("/pages/")[1]!;
    const row = state.rows.find((item) => item.id === id);
    if (row) row.reminderMs = Date.parse(call.body.properties["r@m"].date.start);
    return notionResponse({ object: "page", id });
  });
  return state;
}

function fakeDiscord() {
  const calls: { path: string; body: any }[] = [];
  const control = { ready: true, fail: undefined as undefined | (() => unknown) };
  const service = {
    ready: async () => control.ready,
    client: async () => ({ guildId: "400000000000000001", request: async (path: string, init: RequestInit) => {
      calls.push({ path, body: JSON.parse(String(init.body)) });
      if (control.fail) throw control.fail();
      return { id: "500000000000000001" };
    } }),
    providerStatus: (error: any) => error?.status,
    retryAfterMs: (error: any) => error?.retryAfterMs,
  };
  return { calls, control, service };
}

let stub: Stub; let h: Harness; let notion: ReturnType<typeof reminderNotion>; let discord: ReturnType<typeof fakeDiscord>;
beforeEach(async () => {
  stub = stubNotion(); notion = reminderNotion(stub); discord = fakeDiscord(); h = createHarness(api);
  await h.connect();
  h.test.run("INSERT INTO organization_settings(installation_id,time_zone) VALUES ('primary','America/New_York')");
  // The fallback: Test Student A chose memberPerson as their default recipient.
  h.test.run("INSERT INTO part_requests_member_recipients(installation_id,member_id,notion_user_id,updated_ms) VALUES ('primary','m-a',?,0)", memberPerson);
  stub.calls.length = 0;
});
afterEach(() => { stub.restore(); });

const admin = (method: string, path: string, body?: unknown) => h.call(method, `/admin/part-requests/reminders${path}`, { body, origin: "https://site.example.test" });
const context = (steps = true) => ({ db: h.db, services: { ...h.services(), discord: discord.service }, scheduler: { steps } });
const runJob = () => api.jobs["part-requests.reminders"](context());
const settingsBody = (overrides: Record<string, unknown> = {}) => ({ enabled: true, weekdays: [1, 3, 5], runTime: "15:00", staleMinutes: 2880, cooldownMinutes: 2880, discordChannelId: channel, peopleKey: "external_id", ...overrides });

async function setUp(overrides: Record<string, unknown> = {}) {
  const verified = await admin("POST", "/verify", {});
  assert.equal(verified.status, 200, verified.text);
  const saved = await admin("PUT", "/settings", { revision: verified.body.settings.revision, ...settingsBody(overrides) });
  assert.equal(saved.status, 200, saved.text);
  stub.calls.length = 0;
  return saved.body;
}
async function usePeople() {
  h.core.bind({ databaseId: peopleDb, dataSourceId: peopleSource, name: "People" }, "people");
  const people = await admin("POST", "/people/verify", {});
  assert.equal(people.status, 200, people.text);
  stub.calls.length = 0;
  return people.body;
}

/** The job, one slice per call as the scheduler runs it, until it stops. */
async function drain(limit = 400) {
  const outcomes: any[] = [];
  for (let index = 0; index < limit; index++) {
    const outcome = await runJob();
    outcomes.push(outcome);
    if (!outcome?.more) break;
  }
  return outcomes;
}

/** Slices with an explicit clock, moving it forward whenever the run waits for a retry. */
async function drive(start: number, limit = 400) {
  let now = start; const outcomes: any[] = [];
  for (let index = 0; index < limit; index++) {
    const slice = await reminders.reminderSlice(context(), now);
    outcomes.push(slice.result);
    if (slice.more) continue;
    if (slice.result.waiting !== undefined || slice.result.retry !== undefined || slice.result.skipped === "waiting") { now += 16 * 60_000; continue; }
    break;
  }
  return { outcomes, now };
}

const sendNow = async () => { const run = await admin("POST", "/run"); assert.equal(run.status, 202, run.text); return run.body.runKey as string; };
const items = () => h.test.rows<any>("SELECT * FROM part_requests_reminder_items ORDER BY seq");
const runs = () => h.test.rows<any>("SELECT * FROM part_requests_reminder_runs ORDER BY created_ms");
const calls = (line: RegExp) => stub.calls.filter((call) => line.test(`${call.method} ${call.url.slice("https://api.notion.com/v1".length)}`));
const old = (days = 3) => Date.now() - days * day;
const id = (n: number) => `90000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

// ---- The message

test("the reminder is the team's exact wording, in Notion and in Discord", () => {
  assert.equal(reminders.reminderText("Test bracket", 2880), "Your part request 'Test bracket' has been in Incomplete Request for more than 2 days, so it has not been ordered. Finish the details and change the Status to NORMAL, RUSH or SLOW Request, or delete the request if you no longer need it.");
  assert.equal(reminders.reminderText("Test bracket", 4320), exactText("Test bracket", "3 days"));
  assert.equal(reminders.reminderText("Test bracket", 5), exactText("Test bracket", "5 minutes"), "a testing threshold reads in minutes");
  const body = reminders.discordBody([discordA], "Test bracket", 2880, "https://www.notion.so/abc", "n");
  assert.equal(body.content, `<@${discordA}> ${exactText("Test bracket")}\nhttps://www.notion.so/abc`);
  assert.deepEqual(remindersNotion.commentRichText([memberPerson], exactText("Test bracket")), [
    { type: "mention", mention: { type: "user", user: { id: memberPerson } } }, { type: "text", text: { content: " " } }, { type: "text", text: { content: exactText("Test bracket") } },
  ]);
});

// ---- Switch, target and settings

test("off by default and while unchecked: the job skips with one read and no provider call", async () => {
  assert.deepEqual(await runJob(), { skipped: "disabled" });
  const view = await admin("GET", "");
  assert.equal(view.body.settings.enabled, false);
  assert.equal(view.body.settings.peopleKey, "external_id", "the People column holds the member ID people type, by default");
  assert.equal(view.body.core.ordersBound, true);
  const refused = await admin("PUT", "/settings", { revision: 0, ...settingsBody() });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.code, "target_unverified");
  await setUp();
  h.test.run("UPDATE part_requests_reminder_settings SET schema_error='changed'");
  const before = h.state.queries; const coreBefore = h.coreCost.d1;
  assert.deepEqual(await runJob(), { skipped: "unverified" });
  assert.equal(h.state.queries - before, 1, "the fast exit is one coalesced read");
  assert.equal(h.coreCost.d1 - coreBefore, 0, "and nothing from Core's Notion connection");
  assert.equal(stub.calls.length, 0);
});

test("checking the ordering database: through Core's orders binding, with the four statuses; a failure saves nothing", async () => {
  stub.source = orderingWithReminders({ Status: { id: "st%40t", type: "status", status: { options: [{ id: "incomplete", name: "Incomplete Request" }, { id: "normal", name: "NORMAL Request" }] } } });
  const missing = await admin("POST", "/verify", {});
  assert.equal(missing.status, 422);
  assert.match(missing.body.error, /RUSH Request/);
  assert.equal(h.test.rows("SELECT * FROM part_requests_reminder_settings").length, 0, "a failed check saves nothing");
  stub.source = orderingWithReminders();
  const body = await admin("POST", "/verify", { databaseUrl: "https://www.notion.so/elsewhere" });
  assert.equal(body.status, 400, "reminders never take a database of their own");
  stub.calls.length = 0;
  const checked = await admin("POST", "/verify", {});
  assert.equal(checked.status, 200, checked.text);
  assert.deepEqual(checked.body.target.statuses, { incomplete: "Incomplete Request", normal: "NORMAL Request", rush: "RUSH Request", slow: "SLOW Request" });
  assert.equal(checked.body.target.current, true);
  assert.deepEqual(calls(/./).map((call) => `${call.method} ${call.url.slice("https://api.notion.com/v1".length)}`), [`GET /data_sources/${dataSourceId}`]);
  // Core now points `orders` somewhere else: the saved layout no longer counts.
  h.core.bind({ databaseId, dataSourceId: otherDataSourceId, name: "Other" });
  const moved = await admin("GET", "");
  assert.equal(moved.body.target.current, false);
  assert.equal(moved.body.targetVerified, false);
  assert.equal(h.test.rows<any>("SELECT COUNT(*) AS n FROM audit_log WHERE action='part_requests.reminders_target_verified'")[0].n, 1);
});

test("settings: minutes, a required Discord channel while on, revision conflicts", async () => {
  await admin("POST", "/verify", {});
  const bad = await admin("PUT", "/settings", { revision: 0, ...settingsBody({ staleMinutes: 0 }) });
  assert.equal(bad.status, 400);
  assert.ok(bad.body.errors.staleMinutes);
  const noChannel = await admin("PUT", "/settings", { revision: 0, ...settingsBody({ discordChannelId: null }) });
  assert.equal(noChannel.status, 400);
  assert.ok(noChannel.body.errors.discordChannelId);
  const off = await admin("PUT", "/settings", { revision: 0, ...settingsBody({ enabled: false, discordChannelId: null }) });
  assert.equal(off.status, 200, "off, the channel may be empty");
  const saved = await admin("PUT", "/settings", { revision: 1, ...settingsBody({ staleMinutes: 1 }) });
  assert.equal(saved.status, 200, saved.text);
  assert.equal(saved.body.settings.staleMinutes, 1);
  const stale = await admin("PUT", "/settings", { revision: 1, ...settingsBody() });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.code, "revision_conflict");
  assert.equal(h.test.rows<any>("SELECT COUNT(*) AS n FROM audit_log WHERE action='part_requests.reminders_saved'")[0].n, 2);
  const unknown = await admin("PUT", "/settings", { revision: 2, ...settingsBody(), extra: true });
  assert.equal(unknown.status, 400);
});

test("the routes are Admin only, and changes must come from the dashboard", async () => {
  assert.equal((await h.call("GET", "/admin/part-requests/reminders", { role: "operator" })).status, 403);
  assert.equal((await h.call("POST", "/admin/part-requests/reminders/run", { role: "admin" })).status, 403, "no dashboard origin");
});

test("send now: refused while off or while a run is active", async () => {
  assert.equal((await admin("POST", "/run")).body.code, "reminders_off");
  await setUp();
  await sendNow();
  const again = await admin("POST", "/run");
  assert.equal(again.status, 409);
  assert.equal(again.body.code, "run_active");
});

// ---- A run

test("a full run: comment with mentions, Discord with exactly the pinged IDs, then Reminder sent", async () => {
  await setUp();
  notion.rows = [
    { id: id(1), description: "Test bracket", people: [memberPerson, guestPerson], createdMs: old() },
    { id: id(2), description: "Fresh request", people: [memberPerson], createdMs: Date.now() - 60_000 },
    { id: id(3), description: "Normal one", people: [memberPerson], status: "NORMAL Request", createdMs: old() },
  ];
  await sendNow();
  const outcomes = await drain();
  assert.equal(outcomes.at(-1).done, true);
  assert.equal(outcomes.at(-1).reminded, 1);
  const [item] = items();
  assert.equal(items().length, 1, "only the stale Incomplete Request");
  assert.deepEqual([item.comment_state, item.discord_state, item.mark_state], ["sent", "sent", "set"]);
  assert.deepEqual(JSON.parse(item.unpinged_json), [{ person: guestPerson, reason: "no_member" }]);

  const [comment] = calls(/^POST \/comments$/);
  assert.deepEqual(comment!.body.parent, { page_id: id(1) });
  assert.deepEqual(comment!.body.rich_text.filter((part: any) => part.type === "mention").map((part: any) => part.mention.user.id), [memberPerson, guestPerson]);
  assert.equal(comment!.body.rich_text.at(-1).text.content, exactText("Test bracket"), "the exact wording");
  assert.deepEqual(Object.keys(comment!.body), ["parent", "rich_text"]);

  const [message] = discord.calls;
  assert.equal(message!.path, `/channels/${channel}/messages`);
  assert.deepEqual(message!.body.allowed_mentions, { parse: [], users: [discordA] });
  assert.equal(message!.body.content, `<@${discordA}> ${exactText("Test bracket")}\nhttps://www.notion.so/${id(1).replaceAll("-", "")}`);
  assert.equal(message!.body.enforce_nonce, true);
  assert.equal(message!.body.nonce.length, 25);
  assert.equal(message!.body.flags, 4, "embeds suppressed");

  const [patch] = calls(/^PATCH /);
  assert.equal(patch!.url, `https://api.notion.com/v1/pages/${id(1)}`);
  assert.deepEqual(patch!.body, { properties: { "r@m": { date: { start: patch!.body.properties["r@m"].date.start } } } }, "only Reminder sent, nothing else");
  // Each comment and mark is checked by Core first: the page is read to prove it is in the ordering database.
  assert.equal(calls(new RegExp(`^GET /pages/${id(1)}$`)).length, 2);

  const text = JSON.stringify(outcomes);
  for (const secret of ["Test Student", "example.test", "Test bracket", memberPerson, discordA]) assert.ok(!text.includes(secret), `job results never carry ${secret}`);
  assert.equal(runs()[0].state, "done");

  // Repeated slices after the run do nothing, and the next run finds the mark.
  stub.calls.length = 0;
  assert.deepEqual(await runJob(), { skipped: "not due" });
  await sendNow(); await drain();
  assert.equal(calls(/^POST \/comments$/).length, 0, "Reminder sent holds the cooldown");
});

test("Discord content: the description is escaped and cannot ping, and only the allowed IDs are mentioned", async () => {
  await setUp();
  notion.rows = [{ id: id(1), description: "Bolts <@everyone> **bold** https://x.example.test", people: [memberPerson], createdMs: old() }];
  await sendNow(); await drain();
  const [message] = discord.calls;
  assert.deepEqual([...message!.body.content.matchAll(/<@(\d+)>/g)].map((match) => match[1]), [discordA]);
  assert.doesNotMatch(message!.body.content, /<@everyone>|\*\*bold\*\*|https:\/\/x\.example/);
  assert.equal(calls(/^POST \/comments$/)[0]!.body.rich_text.at(-1).text.content, exactText("Bolts <@everyone> **bold** https://x.example.test"), "Notion gets the text as typed");
});

test("nobody assigned is listed and skipped; no Discord ID and an ambiguous match still get the Notion comment", async () => {
  h.test.run("INSERT INTO members(id,installation_id,external_id,first_name,last_name,email,discord_user_id) VALUES ('m-c','primary','9003','Test Student','C','student.c@example.test',NULL)");
  h.test.run("INSERT INTO part_requests_member_recipients(installation_id,member_id,notion_user_id,updated_ms) VALUES ('primary','m-c',?,0)", thirdPerson);
  // Two members chose guestPerson: ambiguous.
  h.test.run("INSERT INTO part_requests_member_recipients(installation_id,member_id,notion_user_id,updated_ms) VALUES ('primary','m-b',?,0)", guestPerson);
  h.test.run("UPDATE part_requests_member_recipients SET notion_user_id=? WHERE member_id='m-a'", guestPerson);
  await setUp();
  notion.rows = [
    { id: id(1), description: "Nobody", people: [], createdMs: old(4) },
    { id: id(2), description: "No Discord", people: [thirdPerson], createdMs: old(4) },
    { id: id(3), description: "Ambiguous", people: [guestPerson], createdMs: old(4) },
  ];
  await sendNow(); await drain();
  const [nobody, noDiscord, ambiguous] = items();
  assert.deepEqual([nobody.skip_reason, nobody.comment_state, nobody.mark_state], ["no_people", "skipped", "skipped"]);
  assert.deepEqual(JSON.parse(noDiscord.unpinged_json), [{ person: thirdPerson, reason: "no_discord_id" }]);
  assert.deepEqual([noDiscord.comment_state, noDiscord.discord_state, noDiscord.discord_note, noDiscord.mark_state], ["sent", "skipped", "no_ids", "set"]);
  assert.deepEqual(JSON.parse(ambiguous.unpinged_json), [{ person: guestPerson, reason: "ambiguous" }]);
  assert.equal(ambiguous.comment_state, "sent");
  assert.equal(discord.calls.length, 0, "no ping without a Discord ID");
  assert.equal(calls(/^POST \/comments$/).length, 2);
  const view = await admin("GET", "");
  assert.deepEqual(view.body.lastRun.nobody, [{ description: "Nobody", pageUrl: `https://www.notion.so/${id(1).replaceAll("-", "")}` }]);
  assert.deepEqual(view.body.lastRun.pingSkipped.map((row: any) => row.people[0].reason), ["no_discord_id", "ambiguous"]);
  assert.equal(view.body.lastRun.counts.reminded, 2);
});

// ---- People

test("People database: checked through Core's people binding, read only; match, inactive ignored, duplicates ambiguous, key switch", async () => {
  h.test.run("INSERT INTO members(id,installation_id,external_id,first_name,last_name,email,discord_user_id) VALUES ('m-c','primary','9003','Test Student','C','student.c@example.test','100000000000000003')");
  await setUp();
  assert.equal((await admin("POST", "/people/verify", {})).body.code, "people_unbound");
  const people = await usePeople();
  assert.equal(people.people.current, true);
  assert.equal(people.people.dataSourceName, "People");
  notion.people = [
    { accounts: [memberPerson], memberKey: "9002", active: true },
    { accounts: [guestPerson], memberKey: "9001", active: false },
    { accounts: [thirdPerson], memberKey: "9003", active: true },
    { accounts: [crypto.randomUUID()], memberKey: "9003", active: true },
  ];
  notion.rows = [{ id: id(1), description: "Several", people: [memberPerson, guestPerson, thirdPerson], createdMs: old() }];
  await sendNow(); await drain();
  const [item] = items();
  assert.deepEqual(JSON.parse(item.mentions_json), [discordB], "memberPerson is Test Student B in People, whatever the default recipients say");
  assert.deepEqual(JSON.parse(item.unpinged_json), [{ person: guestPerson, reason: "no_member" }, { person: thirdPerson, reason: "ambiguous" }]);
  assert.deepEqual(discord.calls[0]!.body.allowed_mentions.users, [discordB]);
  assert.equal(JSON.parse(runs()[0].mentions_json).source, "people");
  const peopleQuery = calls(new RegExp(`^POST /data_sources/${peopleSource}/query$`))[0]!;
  assert.deepEqual(peopleQuery.body.filter, { property: "act", checkbox: { equals: true } });
  assert.equal(calls(new RegExp(`${peopleSource}|f0000000`)).filter((call) => call.method !== "GET" && !call.url.endsWith("/query")).length, 0, "nothing is ever written to People");
  assert.ok(!runs()[0].config_json.includes("Test Student Name"), "People's names are never read or stored");

  // The same rows keyed by the internal member ID, after switching the column.
  const view = await admin("GET", "");
  await admin("PUT", "/settings", { revision: view.body.settings.revision, ...settingsBody({ peopleKey: "id" }) });
  notion.people = [{ accounts: [memberPerson], memberKey: "m-a", active: true }];
  notion.rows = [{ id: id(2), description: "Keyed by id", people: [memberPerson], createdMs: old() }];
  await sendNow(); await drain();
  assert.deepEqual(JSON.parse(items().find((row) => row.page_id === id(2)).mentions_json), [discordA]);
});

test("People with no active rows, or cleared in Core, falls back to default recipients", async () => {
  await setUp();
  await usePeople();
  notion.people = [{ accounts: [memberPerson], memberKey: "9002", active: false }];
  notion.rows = [{ id: id(1), description: "Fallback", people: [memberPerson], createdMs: old() }];
  await sendNow(); await drain();
  assert.deepEqual(JSON.parse(items()[0].mentions_json), [discordA]);
  assert.equal(JSON.parse(runs()[0].mentions_json).source, "fallback");

  h.core.state.bindings.delete("people");
  notion.rows = [{ id: id(2), description: "People cleared", people: [memberPerson], createdMs: old() }];
  stub.calls.length = 0;
  await sendNow(); await drain();
  assert.equal(calls(new RegExp(peopleSource)).length, 0, "People is not read once Core no longer binds it");
  assert.deepEqual(JSON.parse(items().find((row) => row.page_id === id(2)).mentions_json), [discordA]);
  assert.equal((await admin("GET", "")).body.people.current, false);
});

test("a People layout that no longer fits stops the run before anything is sent", async () => {
  await setUp();
  await usePeople();
  const { Active: _, ...rest } = peopleSourceJson().properties;
  notion.peopleSource = { ...peopleSourceJson(), properties: rest };
  notion.rows = [{ id: id(1), description: "People broken", people: [memberPerson], createdMs: old() }];
  await sendNow();
  assert.deepEqual((await drain()).at(-1), { failed: "people_schema" });
  assert.equal(calls(/^POST \/comments$/).length, 0);
  const view = await admin("GET", "");
  assert.match(view.body.people.error, /Active/);
  assert.equal(view.body.problem, "people_schema");
});

test("the resolver on its own: key column, inactive members and duplicates", () => {
  const members = [
    { id: "m-a", memberId: "9001", discordUserId: discordA, active: 1 },
    { id: "m-b", memberId: "9002", discordUserId: null, active: 1 },
    { id: "m-x", memberId: "9009", discordUserId: discordB, active: 0 },
  ];
  assert.equal(reminders.memberKey(members[0]!, "external_id"), "9001");
  assert.equal(reminders.memberKey(members[0]!, "id"), "m-a");
  const roster = reminders.rosterIndex(members, "external_id");
  assert.deepEqual(roster, { "9001": discordA, "9002": "" });
  const map = reminders.resolveByPeople([
    { accounts: ["u1"], memberKey: "9001", active: true },
    { accounts: ["u2"], memberKey: "9002", active: true },
    { accounts: ["u3"], memberKey: "9009", active: true },
    { accounts: ["u4"], memberKey: "9001", active: false },
    { accounts: ["u5", "u6"], memberKey: "4242", active: true },
    { accounts: ["u5"], memberKey: "4243", active: true },
  ], roster);
  assert.deepEqual(map, { u1: discordA, u2: "!no_discord_id", u3: "!no_member", u5: "!ambiguous", u6: "!no_member" });
  assert.deepEqual(reminders.pings(["u1", "u2", "u7"], map), { ids: [discordA], unpinged: [{ person: "u2", reason: "no_discord_id" }, { person: "u7", reason: "no_member" }] });
});

// ---- Failures, step by step

test("a comment refused with 400 is retried, then failed: no Discord and no mark", async () => {
  await setUp();
  notion.rows = [{ id: id(1), description: "Refused", people: [memberPerson], createdMs: old() }];
  notion.comment = () => notionResponse({ object: "error", status: 400 }, 400);
  await sendNow();
  await drive(Date.now());
  const [item] = items();
  assert.deepEqual([item.comment_state, item.discord_state, item.mark_state, item.error_code], ["failed", "skipped", "skipped", "notion_400"]);
  assert.equal(calls(/^POST \/comments$/).length, 3);
  assert.equal(discord.calls.length, 0);
  assert.equal(calls(/^PATCH /).length, 0);
  assert.equal(item.comment_ms, null, "a refused comment does not count for the cooldown");
});

test("a comment refused with 403 fails the run with the Insert comments code; the rest are skipped; ordering is untouched", async () => {
  await setUp();
  notion.rows = [{ id: id(1), description: "First", people: [memberPerson], createdMs: old(5) }, { id: id(2), description: "Second", people: [memberPerson], createdMs: old(4) }];
  notion.comment = () => notionResponse({ object: "error", status: 403, code: "restricted_resource" }, 403);
  await sendNow();
  const outcomes = await drain();
  assert.deepEqual(outcomes.at(-1), { failed: "notion_comment_403" });
  assert.deepEqual(items().map((row) => row.comment_state), ["failed", "skipped"]);
  assert.equal(calls(/^POST \/comments$/).length, 1);
  const view = await admin("GET", "");
  assert.equal(view.body.problem, "notion_comment_403");
  assert.equal(view.body.core.capabilities.comment, "refused", "Core marks Insert comments refused too");
  assert.equal(view.body.lastRun.state, "failed");
  assert.equal(h.test.rows<any>("SELECT rejection_code FROM part_requests_notion")[0].rejection_code, null);
});

test("a page outside the ordering database is refused by Core before any comment", async () => {
  await setUp();
  notion.rows = [{ id: id(1), description: "Moved away", people: [memberPerson], createdMs: old() }];
  notion.pageRead = (call) => notionResponse({ object: "page", id: call.url.split("/pages/")[1], parent: { type: "data_source_id", data_source_id: otherDataSourceId } });
  await sendNow();
  assert.deepEqual((await drain()).at(-1), { failed: "notion_out_of_scope" });
  assert.equal(calls(/^POST \/comments$/).length, 0);
  assert.deepEqual(h.core.state.refusals, [{ binding: "orders", operation: "comments.create" }]);
});

test("an uncertain comment is never retried, skips Discord and the mark, and blocks a second comment within the cooldown", async () => {
  await setUp();
  notion.rows = [{ id: id(1), description: "Uncertain", people: [memberPerson], createdMs: old() }];
  notion.comment = () => notionResponse({ object: "error", status: 502 }, 502);
  await sendNow();
  await drive(Date.now());
  assert.deepEqual([items()[0].comment_state, items()[0].discord_state, items()[0].mark_state], ["uncertain", "skipped", "skipped"]);
  assert.equal(calls(/^POST \/comments$/).length, 1);
  // Notion's "Reminder sent" was never set, so only the local record holds the cooldown.
  notion.comment = undefined;
  await sendNow(); await drain();
  const second = items().filter((row) => row.run_key !== items()[0].run_key);
  assert.equal(second[0].skip_reason, "recently_reminded");
  assert.equal(calls(/^POST \/comments$/).length, 1);
  assert.deepEqual((await admin("GET", "")).body.lastRun.counts.recent, 1);
});

test("network failures on a comment are uncertain too, and a slice that stopped mid-comment never resends", async () => {
  await setUp();
  notion.rows = [{ id: id(1), description: "Crashed", people: [memberPerson], createdMs: old() }];
  notion.comment = () => { throw new TypeError("network down"); };
  await sendNow(); await drain();
  assert.deepEqual([items()[0].comment_state, items()[0].error_code], ["uncertain", "notion_network"]);

  notion.comment = undefined;
  notion.rows = [{ id: id(2), description: "Stopped", people: [memberPerson], createdMs: old() }];
  h.test.run("UPDATE part_requests_reminder_items SET comment_ms=0");
  await sendNow();
  for (let index = 0; index < 10 && items().length < 2; index++) await runJob();
  h.test.run("UPDATE part_requests_reminder_items SET comment_state='sending',comment_ms=? WHERE page_id=?", Date.now(), id(2));
  stub.calls.length = 0;
  await drain();
  const stopped = items().find((row) => row.page_id === id(2));
  assert.deepEqual([stopped.comment_state, stopped.error_code], ["uncertain", "interrupted"]);
  assert.equal(calls(/^POST \/comments$/).length, 0);
});

test("Discord failing twice is recorded and the mark is still set", async () => {
  await setUp();
  notion.rows = [{ id: id(1), description: "Discord down", people: [memberPerson], createdMs: old() }];
  discord.control.fail = () => Object.assign(new Error("Discord is rate limiting requests"), { status: 429, retryAfterMs: 2000 });
  await sendNow();
  await drive(Date.now());
  const [item] = items();
  assert.deepEqual([item.comment_state, item.discord_state, item.discord_note, item.mark_state], ["sent", "failed", "discord_429", "set"]);
  assert.equal(discord.calls.length, 2, "retried once");
  assert.equal(discord.calls[0]!.body.nonce, discord.calls[1]!.body.nonce, "the same nonce, so Discord posts once");
});

test("Discord not ready is recorded as unavailable and the mark still runs", async () => {
  await setUp();
  notion.rows = [{ id: id(1), description: "Not ready", people: [memberPerson], createdMs: old() }];
  discord.control.ready = false;
  await sendNow(); await drain();
  assert.deepEqual([items()[0].discord_state, items()[0].discord_note, items()[0].mark_state], ["failed", "discord_unavailable", "set"]);
});

test("a failed mark is retried without a second comment; Update content missing fails the run", async () => {
  await setUp();
  notion.rows = [{ id: id(1), description: "Mark retry", people: [memberPerson], createdMs: old() }];
  let failures = 1;
  notion.patch = (call) => failures-- > 0 ? notionResponse({ object: "error", status: 500 }, 500) : notionResponse({ object: "page", id: call.url.split("/pages/")[1] });
  await sendNow();
  await drive(Date.now());
  assert.equal(items()[0].mark_state, "set");
  assert.equal(calls(/^PATCH /).length, 2);
  assert.equal(calls(/^POST \/comments$/).length, 1);

  notion.rows = [{ id: id(2), description: "No update capability", people: [memberPerson], createdMs: old() }];
  notion.patch = () => notionResponse({ object: "error", status: 403 }, 403);
  await sendNow();
  const outcomes = await drain();
  assert.deepEqual(outcomes.at(-1), { failed: "notion_update_403" });
  const view = await admin("GET", "");
  assert.equal(view.body.problem, "notion_update_403");
  assert.equal(view.body.core.capabilities.update, "refused");
  // The comment went, so the local record keeps the next run from commenting again.
  notion.patch = undefined;
  await sendNow(); await drain();
  assert.equal(calls(/^POST \/comments$/).length, 2);
});

// ---- Core's connection

test("while Core holds deliveries (after a restore) the run waits and sends nothing, then carries on", async () => {
  await setUp();
  notion.rows = [{ id: id(1), description: "Paused", people: [memberPerson], createdMs: old() }];
  await sendNow();
  for (let index = 0; index < 10 && runs()[0].state !== "send"; index++) await runJob();
  h.core.state.deliveryPausedUntil = Date.now() + 3_600_000;
  stub.calls.length = 0;
  const now = Date.now();
  const waiting = await reminders.reminderSlice(context(), now);
  assert.deepEqual(waiting, { more: false, result: { waiting: reminders.pausedWaitMs } });
  assert.equal(stub.calls.length, 0);
  assert.equal(items()[0].comment_state, "pending");
  h.core.state.deliveryPausedUntil = null;
  await drive(now + reminders.pausedWaitMs + 1);
  assert.equal(items()[0].mark_state, "set");
});

test("Core's rate-limit pause makes the run wait until it ends; Core's per-invocation cap is not an attempt", async () => {
  await setUp();
  notion.rows = [{ id: id(1), description: "Rate limited", people: [memberPerson], createdMs: old() }];
  await sendNow();
  for (let index = 0; index < 10 && runs()[0].state !== "send"; index++) await runJob();
  h.core.state.pausedUntilMs = Date.now() + 30_000;
  const slice = await reminders.reminderSlice(context(), Date.now());
  assert.equal(slice.more, false);
  assert.ok(slice.result.waiting > 0 && slice.result.waiting <= 30_000);
  assert.equal(calls(/^POST \/comments$/).length, 0);
  h.core.state.pausedUntilMs = 0;
  await drive(Date.now() + 31_000);
  assert.equal(items()[0].attempts, 0);
  assert.equal(items()[0].mark_state, "set");
});

test("without Core's connection or the orders binding, the run fails and says why", async () => {
  await setUp();
  notion.rows = [{ id: id(1), description: "Disconnected", people: [memberPerson], createdMs: old() }];
  await sendNow();
  h.core.state.connection!.enabled = false;
  assert.deepEqual((await drain()).at(-1), { failed: "notion_not_connected" });
  assert.equal((await admin("GET", "")).body.problem, "notion_not_connected");
  h.core.state.connection!.enabled = true;
  h.core.state.bindings.delete("orders");
  await sendNow();
  assert.deepEqual((await drain()).at(-1), { failed: "notion_unbound" });
});

test("Core pointing orders at another database stops the run until the layout is checked again", async () => {
  await setUp();
  notion.rows = [{ id: id(1), description: "Moved", people: [memberPerson], createdMs: old() }];
  h.core.bind({ databaseId, dataSourceId: otherDataSourceId, name: "Other" });
  await sendNow();
  assert.deepEqual((await drain()).at(-1), { failed: "target_changed" });
  assert.equal(items().length, 0);
  const view = await admin("GET", "");
  assert.equal(view.body.targetVerified, false);
  assert.equal((await admin("POST", "/run")).body.code, "target_unverified");
});

// ---- Cooldown, idempotency and limits

test("cooldown: Notion's Reminder sent within the cooldown skips the row; an older one is reminded again", async () => {
  await setUp();
  notion.rows = [
    { id: id(1), description: "Recently reminded", people: [memberPerson], createdMs: old(10), reminderMs: Date.now() - 3_600_000 },
    { id: id(2), description: "Reminded long ago", people: [memberPerson], createdMs: old(10), reminderMs: old(3) },
  ];
  await sendNow(); await drain();
  assert.deepEqual(items().map((row) => row.page_id), [id(2)]);
  const filter = calls(new RegExp(`^POST /data_sources/${dataSourceId}/query$`))[0]!.body.filter;
  assert.deepEqual(filter.and[0], { property: "st%40t", status: { equals: "Incomplete Request" } });
  assert.deepEqual(Object.keys(filter.and[1]), ["property", "created_time"]);
  assert.deepEqual(filter.and[2].or.map((part: any) => Object.keys(part.date)[0]), ["is_empty", "before"]);
});

test("the staleness threshold in minutes, for testing", async () => {
  await setUp({ staleMinutes: 5 });
  notion.rows = [
    { id: id(1), description: "Ten minutes old", people: [memberPerson], createdMs: Date.now() - 10 * 60_000 },
    { id: id(2), description: "Two minutes old", people: [memberPerson], createdMs: Date.now() - 2 * 60_000 },
  ];
  await sendNow(); await drain();
  assert.deepEqual(items().map((row) => row.page_id), [id(1)]);
  assert.equal(calls(/^POST \/comments$/)[0]!.body.rich_text.at(-1).text.content, exactText("Ten minutes old", "5 minutes"));
});

test("a held lease makes another slice wait without any provider call", async () => {
  await setUp();
  notion.rows = [{ id: id(1), description: "Lease", people: [memberPerson], createdMs: old() }];
  await sendNow();
  h.test.run("UPDATE part_requests_reminder_runs SET lease_token='other',lease_until_ms=?", Date.now() + 60_000);
  assert.deepEqual(await runJob(), { skipped: "busy" });
  assert.equal(stub.calls.length, 0);
  h.test.run("UPDATE part_requests_reminder_runs SET lease_token='other',lease_until_ms=0");
  await drain();
  assert.equal(items().length, 1);
  assert.equal(calls(/^POST \/comments$/).length, 1);
});

/**
 * What a slice costs Core's scheduler: the plugin's own D1 queries, Core's Notion connection (one read when loaded, and one
 * read and one external request per Notion request, page checks included), and per Discord request one external request
 * plus two reads (its authority check and its configuration).
 */
async function measured(steps: boolean) {
  const queries = h.state.queries; const discordBefore = discord.calls.length; const notionBefore = stub.calls.length;
  const outcome = await api.jobs["part-requests.reminders"](context(steps));
  const discordCalls = discord.calls.length - discordBefore;
  const cost = h.coreCost.last;
  const d1 = h.state.queries - queries + cost.d1 + discordCalls * 2;
  const external = cost.external + discordCalls;
  return { outcome, d1, external, total: d1 + external, notion: stub.calls.length - notionBefore };
}

test("budget: every slice of a run, People included, fits the scheduler's slice limits and Core's Notion cap", async () => {
  h.test.run("INSERT INTO members(id,installation_id,external_id,first_name,last_name,email,discord_user_id) VALUES ('m-c','primary','9003','Test Student','C','student.c@example.test','100000000000000003')");
  await setUp();
  await usePeople();
  notion.people = [{ accounts: [memberPerson], memberKey: "9001", active: true }, { accounts: [guestPerson], memberKey: "9003", active: true }];
  notion.rows = Array.from({ length: 25 }, (_, index) => ({ id: id(index + 1), description: `Row ${index}`, people: [memberPerson, guestPerson], createdMs: old() }));
  await sendNow();
  const worst = { d1: 0, external: 0, total: 0, notion: 0 };
  for (let index = 0; index < 200; index++) {
    const slice = await measured(true);
    // Core's slice limits: 30 D1 queries, 12 external requests, 40 in all less a reserve of 2; 8 Notion requests per invocation.
    assert.ok(slice.d1 <= 30 && slice.external <= 12 && slice.total <= 38 && slice.notion <= 8, `${JSON.stringify(slice)}`);
    for (const key of ["d1", "external", "total", "notion"] as const) worst[key] = Math.max(worst[key], slice[key]);
    if (!slice.outcome?.more) break;
  }
  assert.equal(items().filter((row) => row.mark_state === "set").length, 25);
  assert.ok(worst.notion <= reminders.maximumSliceNotionCalls, `at most ${reminders.maximumSliceNotionCalls} Notion requests per slice: ${JSON.stringify(worst)}`);
  console.log(`reminder slice worst case: ${JSON.stringify(worst)}`);
});

test("the cron fallback runs a few slices per pass, within Core's Notion cap and the pass budget", async () => {
  await setUp();
  notion.rows = Array.from({ length: 4 }, (_, index) => ({ id: id(index + 1), description: `Row ${index}`, people: [memberPerson], createdMs: old() }));
  await sendNow();
  const worst = { d1: 0, external: 0, total: 0, notion: 0 };
  for (let index = 0; index < 40; index++) {
    const pass = await measured(false);
    // Core's cron pass: 46 in all less a reserve of 2, shared with other jobs; 8 Notion requests per invocation.
    assert.ok(pass.notion <= 8 && pass.total <= 44, JSON.stringify(pass));
    for (const key of ["d1", "external", "total", "notion"] as const) worst[key] = Math.max(worst[key], pass[key]);
    if (!pass.outcome?.more) break;
  }
  assert.equal(items().filter((row) => row.mark_state === "set").length, 4);
  console.log(`reminder cron pass worst case: ${JSON.stringify(worst)}`);
});

test("a run stops at 200 requests and says it was truncated", async () => {
  await setUp();
  notion.rows = Array.from({ length: 205 }, (_, index) => ({ id: id(index + 1), description: `Row ${index}`, people: [memberPerson], createdMs: old() }));
  await sendNow();
  for (let index = 0; index < 20 && runs()[0].state !== "send"; index++) await runJob();
  assert.equal(items().length, 200);
  assert.equal(runs()[0].truncated, 1);
  assert.equal(calls(new RegExp(`^POST /data_sources/${dataSourceId}/query$`)).length, 10);
});

test("a schema change fails the run before anything is sent and stops later runs until checked again", async () => {
  await setUp();
  notion.rows = [{ id: id(1), description: "Schema", people: [memberPerson], createdMs: old() }];
  const { "Reminder sent": _, ...rest } = orderingWithReminders().properties;
  stub.source = { ...orderingWithReminders(), properties: rest };
  await sendNow();
  assert.deepEqual((await drain()).at(-1), { failed: "schema" });
  assert.equal(items().length, 0);
  assert.equal(calls(/^POST \/comments$/).length + calls(/^PATCH /).length, 0);
  const view = await admin("GET", "");
  assert.equal(view.body.targetVerified, false);
  assert.match(view.body.target.schemaError, /Reminder sent/);
  assert.equal((await admin("POST", "/run")).body.code, "target_unverified");
});

test("turning reminders off cancels the run in progress", async () => {
  await setUp();
  notion.rows = [{ id: id(1), description: "Cancelled", people: [memberPerson], createdMs: old() }];
  await sendNow();
  for (let index = 0; index < 10 && !items().length; index++) await runJob();
  const view = await admin("GET", "");
  await admin("PUT", "/settings", { revision: view.body.settings.revision, ...settingsBody({ enabled: false }) });
  assert.deepEqual([runs()[0].state, runs()[0].error_code], ["failed", "disabled"]);
  assert.deepEqual(await runJob(), { skipped: "disabled" });
  assert.equal(calls(/^POST \/comments$/).length, 0);
});

test("the schedule: a run per due slot, keyed by its local date, never twice; no time zone fails", async () => {
  await setUp();
  const wednesday = Date.UTC(2026, 2, 11, 19, 5); // 15:05 EDT
  h.test.run("UPDATE part_requests_reminder_settings SET schedule_since_ms=?", wednesday - 60 * 60_000);
  assert.deepEqual((await reminders.reminderSlice(context(), wednesday - 10 * 60_000)).result, { skipped: "not due" });
  assert.deepEqual((await reminders.reminderSlice(context(), wednesday)).result, { started: "scheduled" });
  assert.deepEqual(runs().map((row) => [row.run_key, row.kind, row.state]), [["2026-03-11", "scheduled", "schema"]]);
  h.test.run("UPDATE part_requests_reminder_runs SET state='done'");
  assert.deepEqual((await reminders.reminderSlice(context(), wednesday + 60_000)).result, { skipped: "not due" });
  h.test.run("DELETE FROM organization_settings");
  h.test.run("DELETE FROM part_requests_reminder_runs");
  assert.deepEqual((await reminders.reminderSlice(context(), wednesday)).result, { failed: "time_zone_missing" });
  assert.equal((await admin("GET", "")).body.problem, "time_zone_missing");
});

test("history older than 30 days is pruned when a run finishes", async () => {
  await setUp();
  h.test.run("INSERT INTO part_requests_reminder_runs(installation_id,run_key,kind,state,config_json,created_ms,finished_ms) VALUES ('primary','2026-01-05','scheduled','done','{}',?,?)", old(40), old(40));
  h.test.run("INSERT INTO part_requests_reminder_items(installation_id,run_key,page_id,seq,page_url,description,people_json,mentions_json,unpinged_json,comment_state,discord_state,mark_state) VALUES ('primary','2026-01-05',?,0,'https://www.notion.so/x','Old','[]','[]','[]','sent','sent','set')", id(99));
  notion.rows = [];
  await sendNow(); await drain();
  assert.deepEqual(runs().map((row) => row.state), ["done"]);
  assert.equal(h.test.rows("SELECT * FROM part_requests_reminder_items").length, 0);
});

// ---- Preview, and isolation from requests

test("preview is a dry run: it lists requests, pings and skips, and writes nothing anywhere", async () => {
  await setUp();
  notion.rows = [
    { id: id(1), description: "Preview me", people: [memberPerson, guestPerson], createdMs: old() },
    { id: id(2), description: "Nobody", people: [], createdMs: old() },
  ];
  const tables = ["part_requests_reminder_settings", "part_requests_reminder_runs", "part_requests_reminder_items", "audit_log", "part_requests_notion"];
  const snapshot = () => tables.map((table) => JSON.stringify(h.test.rows(`SELECT * FROM ${table}`)));
  const before = snapshot();
  const preview = await admin("POST", "/preview");
  assert.equal(preview.status, 200, preview.text);
  assert.deepEqual(snapshot(), before);
  assert.equal(calls(/^POST \/comments$|^PATCH /).length, 0);
  assert.equal(discord.calls.length, 0);
  assert.equal(calls(new RegExp(`^POST /data_sources/${dataSourceId}/query$`))[0]!.body.page_size, 50);
  assert.ok(h.coreCost.last.notion <= 3, "at most 3 Notion requests");
  assert.deepEqual(preview.body.requests.map((row: any) => [row.description, row.skipReason, row.pings]), [["Preview me", null, 1], ["Nobody", "no_people", 0]]);
  assert.deepEqual(preview.body.requests[0].people, [{ name: "Test Member", ping: true, reason: null }, { name: "Unknown person", ping: false, reason: "no_member" }]);
  assert.equal(preview.body.source, "fallback");
});

test("a Notion outage during reminders does not affect POST /requests", async () => {
  await setUp();
  notion.rows = [{ id: id(1), description: "Outage", people: [memberPerson], createdMs: old() }];
  notion.query = () => { throw new TypeError("network down"); };
  await sendNow();
  await drain();
  assert.equal(runs()[0].state, "collect", "waiting to try again");
  const key = await h.pair();
  const created = await h.call("POST", "/public/part-requests/requests", { key, body: { submissionId: crypto.randomUUID(), draft: goodDraft() } });
  assert.equal(created.status, 201, created.text);
  const connection = h.test.rows<any>("SELECT rejection_code,schema_error FROM part_requests_notion")[0];
  assert.deepEqual([connection.rejection_code, connection.schema_error], [null, null]);
});

test("job results and stored reminder data carry no names, emails or check-in data", async () => {
  await setUp();
  notion.rows = [{ id: id(1), description: "Private check", people: [memberPerson], createdMs: old() }];
  await sendNow();
  const text = JSON.stringify(await drain());
  for (const value of ["Test Student", "Test Member", "Test Person Name", "example.test"]) assert.ok(!text.includes(value));
  const stored = JSON.stringify([runs(), h.test.rows("SELECT people_json,mentions_json,unpinged_json FROM part_requests_reminder_items")]);
  for (const value of ["Test Student", "Test Member", "Test Person Name", "example.test"]) assert.ok(!stored.includes(value), value);
});
