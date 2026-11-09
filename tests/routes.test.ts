// The routes end to end through their handlers: real migrations on SQLite, Notion stubbed at the fetch boundary.
import test, { afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { createHarness, dashboard, discordA, discordB, goodDraft, testCredentials, type Harness } from "./helpers/harness.ts";
import { dataSource, dataSourceId, databaseId, guestPerson, memberPerson, namelessGuest, notionResponse, otherDataSourceId, stubNotion, testToken, type Stub } from "./helpers/notion-stub.ts";
import { connectionProblem, isConnected, memberRows, refreshNotice } from "../src/dashboard/part-requests-model.ts";
import { maximumCreates, maximumGeneral, minimumExtensionVersion, pendingLimitMs, repeatWindowMs } from "../src/requests.ts";
import { clientAddress, deviceLimitMessage, exchangePin, issuePin, maximumDevicesPerMember, maximumWrongPins, maximumWrongPinsPerAddress, pairingPauseMs, workerSubrequestAddress } from "../src/pairing.ts";

const sdk = new URL("./helpers/module-sdk-stub.ts", import.meta.url).href;
registerHooks({ resolve: (specifier, context, next) => specifier === "@lancerlogin/module-sdk/api" ? { url: sdk, shortCircuit: true } : next(specifier, context) });
const { default: api } = await import("../src/api.ts") as { default: any };

let stub: Stub;
let h: Harness;
beforeEach(() => { stub = stubNotion(); h = createHarness(api); });
afterEach(() => { stub.restore(); });

const uuid = () => crypto.randomUUID();
const send = (key: string, submissionId: string, draft: Record<string, unknown> = goodDraft()) => h.call("POST", "/public/part-requests/requests", { key, body: { submissionId, draft } });
const revoke = (key: string) => h.call("POST", "/public/part-requests/devices/self/revoke", { key });
const pageCalls = () => stub.calls.filter((call) => call.url.endsWith("/pages")).length;
const ready = async () => { await h.connect(); stub.calls.length = 0; return h.pair(); };
const row = (id: string) => h.test.rows<any>("SELECT * FROM part_requests_submissions WHERE id=?", id)[0];

// ---- Setup, Admin only

test("setup: token, then database, then connection; the site address comes from the dashboard origin", async () => {
  assert.equal((await h.admin("GET", "/status")).body.problem, "notion_not_connected");
  const saved = await h.admin("PUT", "/token", { token: testToken });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.tokenSaved, true);
  assert.equal(saved.body.siteAddress, dashboard);
  assert.equal(saved.body.problem, "notion_not_connected", "a saved token alone is not a connection");
  const sources = await h.admin("POST", "/database", { databaseUrl: `https://app.notion.com/p/${databaseId.replaceAll("-", "")}` });
  assert.deepEqual(sources.body, { databaseId, dataSources: [{ id: dataSourceId, name: "Ordering" }] });
  assert.equal(await api.setup.stepValid(h.db, "notion-connection"), false);
  const connected = await h.admin("POST", "/connection", { databaseUrl: databaseId, dataSourceId });
  assert.equal(connected.status, 200);
  assert.equal(connected.body.problem, null);
  assert.deepEqual(connected.body.teams.map((team: { name: string }) => team.name), ["Test Team One", "Test Team Two"]);
  assert.equal(await api.setup.stepValid(h.db, "notion-connection"), true);
  assert.equal(await api.setup.stepValid(h.db, "something-else"), false);
});

test("setup's predicate is the same check Core runs inside its own SQL", async () => {
  const predicate = api.setup.predicates["notion-connection"]("primary");
  const holds = () => Object.values(h.test.rows(`SELECT (${predicate.sql}) AS ok`, ...predicate.bindings)[0] as object)[0];
  assert.equal(holds(), 0);
  await h.connect();
  assert.equal(holds(), 1);
  await h.admin("PUT", "/token", { token: testToken });
  assert.equal(holds(), 0, "a replaced token must be verified against the database again");
});

test("setup: several data sources need a choice and offer the list", async () => {
  stub.dataSources = [{ id: dataSourceId, name: "Ordering" }, { id: otherDataSourceId, name: "Archive" }];
  await h.admin("PUT", "/token", { token: testToken });
  const refused = await h.admin("POST", "/connection", { databaseUrl: databaseId });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.code, "data_source_required");
  assert.equal(refused.body.dataSources.length, 2);
  assert.equal((await h.admin("POST", "/connection", { databaseUrl: databaseId, dataSourceId: otherDataSourceId })).status, 200);
});

test("setup: a schema mismatch is refused, says what is wrong, and leaves the connection unverified", async () => {
  await h.admin("PUT", "/token", { token: testToken });
  delete stub.source.properties.SKU;
  const refused = await h.admin("POST", "/connection", { databaseUrl: databaseId, dataSourceId });
  assert.equal(refused.status, 422);
  assert.equal(refused.body.code, "schema_mismatch");
  assert.match(refused.body.error, /SKU/);
  assert.equal(await api.setup.stepValid(h.db, "notion-connection"), false);
});

test("setup: a rejected token is not saved; a bad token, a lookalike link and an unshared database get clear refusals", async () => {
  stub.on(/^GET \/users\/me$/, () => notionResponse({ code: "unauthorized" }, 401));
  const rejected = await h.admin("PUT", "/token", { token: "ntn_aDifferentTokenThatNotionRejects000000" });
  assert.equal(rejected.body.code, "notion_token_rejected");
  assert.equal(h.test.rows("SELECT * FROM part_requests_notion").length, 0);
  for (const bad of [{ token: "short" }, { token: "has spaces in it which is not a token" }, { token: 5 }, { token: testToken, extra: 1 }, {}]) assert.equal((await h.admin("PUT", "/token", bad)).body.code, "invalid_token", JSON.stringify(bad));
  stub = (stub.restore(), stubNotion());
  await h.admin("PUT", "/token", { token: testToken });
  assert.equal((await h.admin("POST", "/connection", { databaseUrl: `https://notion.so.evil.example.test/${databaseId.replaceAll("-", "")}` })).body.code, "invalid_link");
  assert.equal((await h.admin("POST", "/connection", { databaseUrl: "99999999-2222-4333-8444-555555555555" })).body.code, "notion_404");
});

test("setup: credential encryption being unavailable stops a save", async () => {
  h = createHarness(api, { credentials: testCredentials(false) });
  const refused = await h.admin("PUT", "/token", { token: testToken });
  assert.equal(refused.status, 503);
  assert.equal(refused.body.code, "credentials_unavailable");
});

test("Admin only: Operators, signed-out visitors and other origins are refused on every setup and Admin route", async () => {
  await h.connect();
  stub.calls.length = 0;
  const routes = [
    ["GET", "/module-setup/part-requests/status"], ["PUT", "/module-setup/part-requests/token"], ["DELETE", "/module-setup/part-requests/token"], ["POST", "/module-setup/part-requests/database"], ["POST", "/module-setup/part-requests/connection"],
    ["GET", "/admin/part-requests/requests"], ["GET", "/admin/part-requests/devices"], ["POST", "/admin/part-requests/devices/revoke"], ["POST", "/admin/part-requests/recipients/refresh"],
  ] as const;
  for (const [method, path] of routes) {
    assert.equal((await h.call(method, path, { role: "operator", origin: dashboard, body: {} })).status, 403, `${method} ${path} as an Operator`);
    assert.equal((await h.call(method, path, { role: null, origin: dashboard, body: {} })).status, 401, `${method} ${path} signed out`);
    if (method !== "GET") {
      assert.equal((await h.call(method, path, { body: {} })).status, 403, `${method} ${path} from no origin`);
      assert.equal((await h.call(method, path, { origin: "https://evil.example.test", body: {} })).status, 403, `${method} ${path} from another origin`);
    }
  }
  assert.equal(stub.calls.length, 0);
  assert.equal(h.test.rows("SELECT * FROM part_requests_notion WHERE ciphertext IS NOT NULL").length, 1);
});

test("the manifest declares the Operator capability Core needs for /admin routes, and the routes it serves", async () => {
  const { default: manifest } = await import("../src/manifest.ts");
  assert.ok(manifest.capabilities.some((capability) => capability.operator));
  assert.equal(manifest.setup.version, 1);
  assert.deepEqual(Object.keys(api.routes).sort(), manifest.apiRoutes.map((route) => route.path).sort());
  assert.deepEqual(Object.keys(api.jobs), manifest.jobs.map((job) => job.id));
  assert.deepEqual(Object.keys(api.setup.predicates), manifest.setup.steps.map((step) => step.id));
});

// ---- The token never comes back

test("the token never appears in a response, a log line, the database, or an error, on any path", async () => {
  const lines: string[] = [];
  const saved = { log: console.log, warn: console.warn, error: console.error, info: console.info, debug: console.debug };
  for (const name of Object.keys(saved) as (keyof typeof saved)[]) console[name] = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
  const seen: string[] = [];
  const record = async (work: Promise<{ text: string }>) => { const result = await work; seen.push(result.text); return result; };
  try {
    await record(h.admin("PUT", "/token", { token: testToken }));
    await record(h.admin("POST", "/database", { databaseUrl: databaseId }));
    await record(h.admin("POST", "/connection", { databaseUrl: databaseId, dataSourceId }));
    await record(h.admin("GET", "/status"));
    const key = await h.pair();
    await h.runJob();
    await record(h.call("GET", "/public/part-requests/options", { key }));
    await record(send(key, uuid()));
    for (const failure of [401, 500]) { stub.on(/^POST \/pages$/, () => notionResponse({ message: `echo ${testToken}` }, failure)); await record(send(key, uuid())); }
    stub.on(/^POST \/pages$/, () => { throw new Error(`network failure ${testToken}`); });
    await record(send(key, uuid()));
    stub.on(/^GET \/data_sources/, () => notionResponse({ message: testToken }, 401));
    await record(h.admin("POST", "/connection", { databaseUrl: databaseId, dataSourceId }));
    await record(h.call("GET", "/admin/part-requests/requests"));
    await record(h.call("GET", "/admin/part-requests/devices"));
    await h.admin("PUT", "/token", { token: "bad token with spaces" });
    await h.runJob();
  } finally { Object.assign(console, saved); }
  assert.ok(seen.length >= 10);
  for (const text of [...seen, ...lines]) { assert.ok(!text.includes(testToken), text.slice(0, 200)); assert.ok(!text.includes("ciphertext"), text.slice(0, 200)); }
  const stored = JSON.stringify(h.test.sqlite.prepare("SELECT * FROM part_requests_notion").all()) + JSON.stringify(h.test.rows("SELECT * FROM part_requests_submissions")) + JSON.stringify(h.test.rows("SELECT * FROM part_requests_recipient_refresh"));
  assert.ok(!stored.includes(testToken));
  assert.ok(stub.calls.some((call) => call.headers.Authorization === `Bearer ${testToken}`), "it does reach Notion, in the header");
});

// ---- Device API

test("options: teams, recipients and the member's default, only for a paired device", async () => {
  const key = await ready();
  await h.runJob();
  const options = await h.call("GET", "/public/part-requests/options", { key });
  assert.equal(options.status, 200);
  assert.deepEqual(options.body.teams, [{ id: "team-1", name: "Test Team One" }, { id: "team-2", name: "Test Team Two" }]);
  assert.deepEqual(options.body.recipients.map((person: { name: string }) => person.name), ["Test Guest", "Test Guest Looked Up", "Test Member"]);
  assert.equal(options.body.defaultRecipientId, null);
  assert.deepEqual(options.body.statuses, ["NORMAL Request", "Incomplete Request"]);
  assert.equal(options.body.vendors.length, 20);
  assert.equal(options.text.includes("student.a@example.test"), false);
  for (const init of [{}, { key: "x".repeat(43) }]) assert.equal((await h.call("GET", "/public/part-requests/options", init)).body.code, "pair_again");
});

test("options: the extension's minimum version, its update link and the database link, built from the saved ID", async () => {
  const key = await ready();
  const { body, text } = await h.call("GET", "/public/part-requests/options", { key });
  assert.equal(body.minimumExtensionVersion, "0.2.0");
  assert.equal(body.minimumExtensionVersion, minimumExtensionVersion);
  assert.equal(body.updateUrl, "https://github.com/isriah/lancerlogin-part-requests-extension/releases");
  assert.equal(body.databaseLink, `https://www.notion.so/${databaseId.replaceAll("-", "")}`);
  assert.equal(new URL(body.databaseLink).hostname, "www.notion.so");
  assert.ok(!text.includes(testToken));
});

test("self-revoke: frees one of the 5 slots, and leaves the member's other devices and other members alone", async () => {
  const keys = [await ready()];
  for (let index = 2; index <= maximumDevicesPerMember; index++) keys.push(await h.pair(undefined, `Test laptop ${index}`));
  const other = await h.pair(discordB);
  const atLimit = await issuePin(h.db, discordA, Date.now());
  assert.equal(atLimit, deviceLimitMessage);
  const result = await revoke(keys[0]!);
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { revoked: true });
  assert.match(await issuePin(h.db, discordA, Date.now()), /\*\*[A-Z0-9]{4}-[A-Z0-9]{4}\*\*/, "a slot is free again");
  assert.ok(await h.pair(undefined, "Test replacement"));
  assert.equal(await issuePin(h.db, discordA, Date.now()), deviceLimitMessage, "and it was only one slot");
  for (const key of keys.slice(1)) assert.equal((await h.call("GET", "/public/part-requests/options", { key })).status, 200, "the member's other devices still work");
  assert.equal((await h.call("GET", "/public/part-requests/options", { key: other })).status, 200, "another member's device still works");
  assert.equal(h.test.rows("SELECT * FROM part_requests_devices WHERE revoked_ms IS NOT NULL").length, 1);
});

test("self-revoke: a revoked key gets pair_again on every other route, and nothing reaches Notion", async () => {
  const key = await ready();
  await revoke(key);
  const results = await Promise.all([
    h.call("GET", "/public/part-requests/options", { key }), send(key, uuid()),
    h.call("POST", "/public/part-requests/check", { key, body: { url: goodDraft().url } }),
    h.call("POST", "/public/part-requests/recipient", { key, body: { notionUserId: null } }),
    h.call("GET", `/public/part-requests/requests/${uuid()}`, { key }),
    h.call("POST", "/public/part-requests/ping", { key, body: {} }),
  ]);
  for (const result of results) { assert.equal(result.status, 401); assert.equal(result.body.code, "pair_again"); }
  assert.equal(pageCalls(), 0);
});

test("self-revoke: repeating it gives the same answer and keeps the first time, one audit row and one slot", async () => {
  const key = await ready();
  assert.equal((await revoke(key)).status, 200);
  h.test.run("UPDATE part_requests_devices SET revoked_ms=12345");
  const again = await revoke(key);
  assert.equal(again.status, 200);
  assert.deepEqual(again.body, { revoked: true });
  assert.equal(h.test.rows<{ revoked_ms: number }>("SELECT revoked_ms FROM part_requests_devices")[0]!.revoked_ms, 12345);
  const audit = h.test.rows<{ actor_user_id: string | null; target_id: string }>("SELECT actor_user_id,target_id FROM audit_log WHERE action='part_requests.device_self_revoked'");
  assert.equal(audit.length, 1);
  assert.equal(audit[0]!.actor_user_id, null);
  assert.equal(audit[0]!.target_id, h.test.rows<{ id: string }>("SELECT id FROM part_requests_devices")[0]!.id);
});

test("self-revoke: needs a key, an unknown key changes nothing, and other methods are not routes", async () => {
  const key = await ready();
  for (const init of [{}, { key: "x".repeat(43) }, { headers: { authorization: "Bearer short" } }]) {
    const refused = await h.call("POST", "/public/part-requests/devices/self/revoke", init);
    assert.equal(refused.status, 401);
    assert.equal(refused.body.code, "pair_again");
  }
  assert.equal((await h.call("GET", "/public/part-requests/devices/self/revoke", { key })).status, 404);
  assert.equal(h.test.rows("SELECT * FROM part_requests_devices WHERE revoked_ms IS NOT NULL").length, 0);
  assert.equal(h.test.rows("SELECT * FROM part_requests_device_limits").length, 0, "nothing is counted for a key that is not a device");
});

test("self-revoke: a member off the roster can still give up the slot, which stays free when they rejoin", async () => {
  const key = await ready();
  h.test.run("UPDATE members SET active=0 WHERE id='m-a'");
  assert.equal((await revoke(key)).status, 200);
  h.test.run("UPDATE members SET active=1 WHERE id='m-a'");
  assert.equal((await h.call("GET", "/public/part-requests/options", { key })).body.code, "pair_again", "rejoining restores other devices, not this one");
});

test("self-revoke: counts in the device's general write limit, without touching another device's", async () => {
  const key = await ready();
  const second = await h.pair(undefined, "Test second laptop");
  h.test.run("INSERT INTO part_requests_device_limits(installation_id,device_id,bucket,window_start_ms,requests) SELECT installation_id,id,'general',?,? FROM part_requests_devices WHERE label='Browser extension'", Date.now(), maximumGeneral);
  const limited = await revoke(key);
  assert.equal(limited.status, 429);
  assert.equal(limited.body.code, "rate_limited");
  assert.ok(Number(limited.headers.get("retry-after")) > 0);
  assert.equal((await h.call("GET", "/public/part-requests/options", { key })).status, 200, "a limited call revokes nothing");
  assert.equal((await revoke(second)).status, 200);
  h.test.run("UPDATE part_requests_device_limits SET window_start_ms=window_start_ms-600000");
  assert.equal((await revoke(key)).status, 200, "it works after the window");
});

test("self-revoke: the Admin devices tab shows it as revoked like any other, and the slot is free in its count", async () => {
  const key = await ready();
  const other = await h.pair(undefined, "Test other laptop");
  const started = Date.now();
  await revoke(key);
  const { body } = await h.call("GET", "/admin/part-requests/devices");
  assert.equal(body.devices.length, 2);
  const [member] = memberRows(body, Date.now());
  assert.equal(member!.working.length, 1);
  assert.equal(member!.devices.at(-1)!.label, "Browser extension", "revoked devices sort last");
  assert.ok(member!.devices.at(-1)!.revokedMs! >= started);
  assert.equal(member!.devices[0]!.revokedMs, null);
  assert.equal((await h.admin("GET", "/status")).body.pairedDevices, 1);
  const deviceId = member!.devices.at(-1)!.id;
  assert.equal((await h.call("POST", "/admin/part-requests/devices/revoke", { origin: dashboard, body: { deviceId } })).status, 404, "an Admin page opened earlier gets the existing answer");
  assert.equal((await h.call("GET", "/public/part-requests/options", { key: other })).status, 200);
});

test("query counts: self-revoke is a read, a count and one batch; repeating it skips the batch", async () => {
  const key = await ready();
  h.state.queries = 0;
  assert.equal((await revoke(key)).status, 200);
  assert.equal(h.state.queries, 3);
  h.state.queries = 0;
  assert.equal((await revoke(key)).status, 200);
  assert.equal(h.state.queries, 2);
});

test("a member's chosen person becomes their default, only for themselves, and must be on the list", async () => {
  const key = await ready();
  await h.runJob();
  const choose = (id: unknown, device = key) => h.call("POST", "/public/part-requests/recipient", { key: device, body: { notionUserId: id } });
  assert.equal((await choose("not-on-the-list")).status, 400);
  assert.equal((await choose(guestPerson)).body.defaultRecipientId, guestPerson);
  assert.equal((await h.call("GET", "/public/part-requests/options", { key })).body.defaultRecipientId, guestPerson);
  assert.equal((await choose(memberPerson)).body.defaultRecipientId, memberPerson, "it can be changed");
  const other = await h.pair(discordB);
  assert.equal((await h.call("GET", "/public/part-requests/options", { key: other })).body.defaultRecipientId, null);
  assert.equal((await choose(null)).body.defaultRecipientId, null);
  assert.equal((await h.call("GET", "/public/part-requests/options", { key })).body.defaultRecipientId, null);
});

test("create: a good request reaches Notion once, with properties only, and the log shows who sent it from which device", async () => {
  await h.connect();
  await h.runJob();
  stub.calls.length = 0;
  const key = await h.pair(undefined, "Test laptop");
  const id = uuid();
  const created = await send(key, id, goodDraft({ recipient: guestPerson }));
  assert.equal(created.status, 201);
  assert.deepEqual(created.body, { submissionId: id, state: "created", pageUrl: "https://app.notion.com/p/created-request", repeats: [] });
  const sent = stub.calls.find((call) => call.url.endsWith("/pages"))!;
  assert.deepEqual(Object.keys(sent.body).sort(), ["parent", "properties"]);
  assert.equal(sent.body.parent.data_source_id, dataSourceId);
  const log = await h.call("GET", "/admin/part-requests/requests");
  assert.equal(log.body.requests[0].memberName, "Test Student A");
  assert.equal(log.body.requests[0].deviceLabel, "Test laptop");
  assert.equal(log.body.requests[0].vendor, "REV");
  assert.equal(log.body.requests[0].recipient, "Test Guest");
  assert.equal(log.body.requests[0].team, "Test Team One");
  assert.equal(log.body.requests[0].state, "created");
});

test("create: strict validation refuses bad requests before anything is recorded or sent", async () => {
  const key = await ready();
  const refusals: [string, unknown][] = [
    ["unsupported vendor", goodDraft({ url: "https://example.test/product" })],
    ["lookalike vendor", goodDraft({ url: "https://www.mcmaster.com.evil.example.test/1" })],
    ["team not in Notion", goodDraft({ team: "team-unknown" })],
    ["status not offered", goodDraft({ status: "RUSH Request" })],
    ["recipient not on the list", goodDraft({ recipient: "c0000000-0000-4000-8000-0000000000ff" })],
    ["quantity zero", goodDraft({ quantity: 0 })],
    ["unconfirmed currency", goodDraft({ currencyConfirmed: false })],
    ["unknown field", { ...goodDraft(), vendor: "REV" }],
    ["wrong type", goodDraft({ quantity: "2" })],
    ["missing", undefined],
  ];
  for (const [label, draft] of refusals) {
    const result = await h.call("POST", "/public/part-requests/requests", { key, body: { submissionId: uuid(), draft } });
    assert.equal(result.status, 400, label);
    assert.equal(result.body.code, "validation", label);
  }
  for (const submissionId of ["short", "", 5, undefined, "AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE"]) assert.equal((await h.call("POST", "/public/part-requests/requests", { key, body: { submissionId, draft: goodDraft() } })).status, 400, String(submissionId));
  assert.equal(h.test.rows("SELECT * FROM part_requests_submissions").length, 0);
  assert.equal(pageCalls(), 0);
});

test("create: an Incomplete request needs only a description and a supported URL", async () => {
  const key = await ready();
  const result = await send(key, uuid(), goodDraft({ status: "Incomplete Request", team: "", recipient: "", quantity: null, price: null, sku: "", currencyConfirmed: false }));
  assert.equal(result.status, 201);
  const properties = stub.calls.find((call) => call.url.endsWith("/pages"))!.body.properties;
  assert.deepEqual(Object.keys(properties).sort(), ["st%40t", "title", "urll", "v3nd"].sort());
});

// ---- Duplicate protection

test("duplicate IDs racing in parallel create one page, and the others do not call Notion", async () => {
  const key = await ready();
  const id = uuid();
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  stub.on(/^POST \/pages$/, async () => { await held; return notionResponse({ url: "https://www.notion.so/one" }); });
  const racing = Array.from({ length: 12 }, () => send(key, id));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(pageCalls(), 1);
  assert.equal(row(id).state, "pending", "recorded before Notion answers");
  release();
  const results = await Promise.all(racing);
  assert.equal(pageCalls(), 1);
  assert.equal(results.filter((result) => result.status === 201).length, 1);
  assert.equal(results.filter((result) => result.status === 202 && result.body.state === "pending").length, 11);
  const after = await send(key, id);
  assert.equal(after.status, 200);
  assert.deepEqual(after.body, { submissionId: id, state: "created", pageUrl: "https://www.notion.so/one", replayed: true });
  assert.equal(pageCalls(), 1);
});

test("the ID is recorded before Notion is called, and if recording fails Notion is not called", async () => {
  const key = await ready();
  const id = uuid();
  stub.on(/^POST \/pages$/, () => { assert.equal(row(id).state, "pending"); return notionResponse({ url: "https://www.notion.so/one" }); });
  assert.equal((await send(key, id)).status, 201);
  h.state.failing = /INSERT INTO part_requests_submissions/;
  await assert.rejects(send(key, uuid()), /D1_ERROR/);
  h.state.failing = undefined;
  assert.equal(pageCalls(), 1);
});

test("uncertain results are recorded, returned on repeats, and never sent again", async () => {
  const key = await ready();
  for (const [label, answer] of [["5xx", () => notionResponse({}, 500)], ["409", () => notionResponse({}, 409)], ["timeout", () => { throw new DOMException("timed out", "TimeoutError"); }], ["unreadable", () => new Response("{bad")], ["bad link", () => notionResponse({ url: "https://notion.so.evil.example.test/x" })]] as const) {
    stub = (stub.restore(), stubNotion());
    stub.on(/^POST \/pages$/, answer);
    const id = uuid();
    const first = await send(key, id);
    assert.equal(first.status, 202, label);
    assert.equal(first.body.state, "uncertain", label);
    assert.equal(row(id).state, "uncertain", label);
    assert.equal((await send(key, id)).body.state, "uncertain", label);
    assert.equal((await h.call("GET", `/public/part-requests/requests/${id}`, { key })).body.state, "uncertain", label);
    assert.equal(pageCalls(), 1, label);
  }
});

test("a certain failure is recorded as failed, repeats return it, and a new ID can try again", async () => {
  const key = await ready();
  stub.on(/^POST \/pages$/, () => notionResponse({}, 429, { "retry-after": "7" }));
  const id = uuid();
  const failed = await send(key, id);
  assert.equal(failed.status, 502);
  assert.equal(failed.body.state, "failed");
  assert.equal(failed.body.code, "notion_429");
  assert.equal(failed.body.retryAfterSeconds, 7);
  assert.equal((await send(key, id)).body.state, "failed");
  assert.equal(pageCalls(), 1);
  stub = (stub.restore(), stubNotion());
  assert.equal((await send(key, uuid())).status, 201);
});

test("a Worker that stopped mid-request leaves a pending row, which turns uncertain and is not sent", async () => {
  const key = await ready();
  const id = uuid();
  assert.equal((await send(key, id)).status, 201);
  h.test.run("UPDATE part_requests_submissions SET state='pending',page_url=NULL,finished_ms=NULL WHERE id=?", id);
  stub.calls.length = 0;
  assert.equal((await send(key, id)).body.state, "pending");
  h.test.run("UPDATE part_requests_submissions SET created_ms=created_ms-? WHERE id=?", pendingLimitMs, id);
  assert.equal((await send(key, id)).body.state, "uncertain");
  assert.equal((await h.call("GET", "/admin/part-requests/requests")).body.requests[0].state, "uncertain");
  assert.equal(pageCalls(), 0);
});

test("if the result cannot be saved after Notion created the page, the student still gets the link and no resend is possible", async () => {
  const key = await ready();
  const id = uuid();
  h.state.failing = /UPDATE part_requests_submissions/;
  assert.equal((await send(key, id)).status, 201);
  h.state.failing = undefined;
  assert.equal(row(id).state, "pending");
  assert.equal((await send(key, id)).status, 202);
  assert.equal(pageCalls(), 1);
});

test("an ID reused with different content, or by another member, is refused and tells them nothing", async () => {
  const key = await ready();
  const other = await h.pair(discordB);
  const id = uuid();
  await send(key, id);
  assert.equal((await send(key, id, goodDraft({ quantity: 3 }))).body.code, "submission_conflict");
  assert.equal((await send(other, id)).body.code, "submission_conflict");
  assert.equal((await h.call("GET", `/public/part-requests/requests/${id}`, { key: other })).status, 404);
  assert.equal(pageCalls(), 1);
});

// ---- Device and roster state

test("a revoked device and a member off the roster are refused on every device route, with a prompt to pair again", async () => {
  const key = await ready();
  const other = await h.pair(discordB);
  const routes = (device: string) => [
    h.call("GET", "/public/part-requests/options", { key: device }), send(device, uuid()),
    h.call("POST", "/public/part-requests/check", { key: device, body: { url: goodDraft().url } }),
    h.call("POST", "/public/part-requests/recipient", { key: device, body: { notionUserId: null } }),
    h.call("GET", `/public/part-requests/requests/${uuid()}`, { key: device }),
  ];
  const deviceId = h.test.rows<{ id: string }>("SELECT id FROM part_requests_devices WHERE member_id='m-a'")[0]!.id;
  assert.equal((await h.call("POST", "/admin/part-requests/devices/revoke", { origin: dashboard, body: { deviceId } })).status, 200);
  for (const result of await Promise.all(routes(key))) { assert.equal(result.status, 401); assert.equal(result.body.code, "pair_again"); }
  assert.equal((await h.call("POST", "/admin/part-requests/devices/revoke", { origin: dashboard, body: { deviceId } })).status, 404, "already revoked");
  h.test.run("UPDATE members SET active=0 WHERE id='m-b'");
  for (const result of await Promise.all(routes(other))) { assert.equal(result.status, 401); assert.equal(result.body.code, "pair_again"); }
  assert.equal(pageCalls(), 0);
  h.test.run("UPDATE members SET active=1 WHERE id='m-b'");
  assert.equal((await h.call("GET", "/public/part-requests/options", { key: other })).status, 200, "rejoining the roster restores it");
});

test("revocation between the first read and recording the ID stops the request before Notion", async () => {
  const key = await ready();
  const realBatch = h.db.batch.bind(h.db);
  let done = false;
  h.db.batch = async (statements) => {
    if (!done) { done = true; h.test.run("UPDATE part_requests_devices SET revoked_ms=1"); }
    return realBatch(statements);
  };
  const id = uuid();
  assert.equal((await send(key, id)).status, 401);
  assert.equal(pageCalls(), 0);
  assert.equal(row(id), undefined);
});

test("removing a member from the roster keeps their log entries, by name", async () => {
  const key = await ready();
  await send(key, uuid());
  h.test.run("DELETE FROM members WHERE id='m-a'");
  const log = await h.call("GET", "/admin/part-requests/requests");
  assert.equal(log.body.requests[0].memberName, "Test Student A");
  assert.equal(h.test.rows("SELECT * FROM part_requests_devices").length, 0);
});

test("a connection that is missing, replaced or out of step stops requests with a clear 503, but recorded results still answer", async () => {
  const key = await ready();
  const id = uuid();
  await send(key, id);
  await h.admin("PUT", "/token", { token: testToken });
  const unverified = await send(key, uuid());
  assert.equal(unverified.status, 503);
  assert.equal(unverified.body.code, "notion_not_connected");
  assert.equal((await send(key, id)).body.state, "created");
  assert.equal((await h.call("GET", "/public/part-requests/options", { key })).body.code, "notion_not_connected");
  await h.connect();
  stub.calls.length = 0;
  delete stub.source.properties.Qty;
  await h.runJob();
  const changed = await send(key, uuid());
  assert.equal(changed.body.code, "notion_schema_changed");
  assert.equal(pageCalls(), 0);
  assert.match((await h.admin("GET", "/status")).body.schemaError, /Qty/);
  stub.source = dataSource();
  await h.admin("POST", "/connection", { databaseUrl: databaseId, dataSourceId });
  assert.equal((await send(key, uuid())).status, 201);
});

test("after a restore (no connection row, setup still marked done) requests stop and the Admin can reconnect", async () => {
  const key = await ready();
  h.test.run("DELETE FROM part_requests_notion");
  assert.equal((await send(key, uuid())).body.code, "notion_not_connected");
  assert.equal((await h.admin("POST", "/connection", { databaseUrl: databaseId })).body.code, "notion_not_connected");
  assert.equal(await api.setup.stepValid(h.db, "notion-connection"), false);
  await h.connect();
  assert.equal((await send(key, uuid())).status, 201);
});

// ---- Repeat warning

test("repeat warning: same product by anyone within 7 days warns without blocking; older or failed ones do not count", async () => {
  const key = await ready();
  const other = await h.pair(discordB);
  const check = (body: unknown, device = other) => h.call("POST", "/public/part-requests/check", { key: device, body });
  assert.deepEqual((await check({ url: goodDraft().url, sku: goodDraft().sku })).body.repeats, []);
  const firstId = uuid();
  await send(key, firstId);
  const warned = await check({ url: "https://revrobotics.com/rev-41-1600?ref=x" });
  assert.equal(warned.body.repeats.length, 1);
  assert.equal(warned.body.repeats[0].memberName, "Test Student A");
  assert.equal(warned.body.repeats[0].pageUrl, "https://app.notion.com/p/created-request");
  assert.equal((await check({ url: "https://www.revrobotics.com/another-address/", sku: "rev-41-1600" })).body.repeats.length, 1, "matched by SKU");
  assert.equal((await check({ url: "https://www.revrobotics.com/something-else/", sku: "OTHER" })).body.repeats.length, 0);
  assert.equal((await check({ url: "https://andymark.com/rev-41-1600", sku: "REV-41-1600" })).body.repeats.length, 0, "SKUs belong to a store");

  const second = await send(other, uuid(), goodDraft({ quantity: 5 }));
  assert.equal(second.status, 201, "not blocked");
  assert.equal(second.body.repeats.length, 1);
  assert.equal(pageCalls(), 2);

  h.test.run("UPDATE part_requests_submissions SET created_ms=created_ms-?", repeatWindowMs + 1);
  assert.equal((await check({ url: goodDraft().url })).body.repeats.length, 0, "past seven days");
  stub.on(/^POST \/pages$/, () => notionResponse({}, 400));
  await send(key, uuid());
  assert.equal((await check({ url: goodDraft().url })).body.repeats.length, 0, "a failed request created nothing");
  assert.equal((await check({ url: "https://example.test/x" })).status, 400);
});

// ---- Rate limits

test("rate limits: per device, counted before Notion, with Retry-After; other devices and replays are unaffected", async () => {
  const key = await ready();
  const other = await h.pair(discordB);
  const firstId = uuid();
  await send(key, firstId);
  for (let index = 1; index < maximumCreates; index++) assert.equal((await send(key, uuid())).status, 201, `request ${index}`);
  const calls = pageCalls();
  const limitedId = uuid();
  const limited = await send(key, limitedId);
  assert.equal(limited.status, 429);
  assert.equal(limited.body.code, "rate_limited");
  assert.ok(limited.body.retryAfterSeconds > 0 && limited.body.retryAfterSeconds <= 600);
  assert.equal(limited.headers.get("retry-after"), String(limited.body.retryAfterSeconds));
  assert.equal(row(limitedId), undefined, "a refused ID stays free for the retry");
  assert.equal(pageCalls(), calls);
  assert.equal((await send(key, firstId)).status, 200, "a recorded result is still returned");
  assert.equal((await send(other, uuid())).status, 201, "another device has its own count");
  h.test.run("UPDATE part_requests_device_limits SET window_start_ms=window_start_ms-600000");
  assert.equal((await send(key, limitedId)).status, 201, "the same ID succeeds after the window");
});

test("rate limits: repeat checks and choosing a person have their own, higher limit", async () => {
  const key = await ready();
  const check = () => h.call("POST", "/public/part-requests/check", { key, body: { url: goodDraft().url } });
  for (let index = 0; index < maximumGeneral; index++) assert.equal((await check()).status, 200, `check ${index}`);
  assert.equal((await check()).status, 429);
  assert.equal((await send(key, uuid())).status, 201, "does not use up the create limit");
});

// ---- Pairing guesses

const pairRoute = (pin: string, headers: Record<string, string> = {}, deviceLabel?: string) => h.call("POST", "/public/part-requests/pair", { body: { pin, deviceLabel }, headers });

test("client addresses: only a real one counts; a Worker subrequest's fixed address and a missing header do not", () => {
  const get = (values: Record<string, string>) => ({ get: (name: string) => values[name] ?? null });
  assert.equal(clientAddress(get({ "cf-connecting-ip": " 203.0.113.9 " })), "203.0.113.9");
  assert.equal(clientAddress(get({})), undefined);
  assert.equal(clientAddress(get({ "cf-connecting-ip": workerSubrequestAddress })), undefined);
  assert.equal(clientAddress(get({ "cf-connecting-ip": workerSubrequestAddress.toUpperCase() })), undefined);
  assert.equal(clientAddress(get({ "cf-connecting-ip": "203.0.113.9", "cf-worker": "example.test" })), undefined);
});

test("pairing guesses: one address is paused on its own, and everyone else can still pair; only a hash is stored", async () => {
  await h.connect();
  const attacker = { "cf-connecting-ip": "203.0.113.9" };
  const student = { "cf-connecting-ip": "203.0.113.10" };
  for (let index = 1; index < maximumWrongPinsPerAddress; index++) assert.equal((await pairRoute("2222-2222", attacker)).status, 401, `guess ${index}`);
  const paused = await pairRoute("2222-2222", attacker);
  assert.equal(paused.status, 429);
  assert.equal(paused.body.code, "pairing_paused");
  assert.equal(paused.headers.get("retry-after"), String(pairingPauseMs / 1000));
  const reply = await issuePin(h.db, discordB, Date.now());
  const pin = /\*\*(.+)\*\*/.exec(reply)![1]!;
  assert.equal((await pairRoute(pin, attacker)).status, 429, "even a right PIN from the paused address");
  const paired = await pairRoute(pin, student, "Test laptop");
  assert.equal(paired.status, 201);
  assert.equal(h.test.rows<{ label: string }>("SELECT label FROM part_requests_devices")[0]!.label, "Test laptop");
  const stored = JSON.stringify(h.test.rows("SELECT * FROM part_requests_pairing_address_limits"));
  assert.ok(!stored.includes("203.0.113"));
  assert.equal((await h.admin("GET", "/status")).body.pairingAddressesCounted, 1);
});

test("pairing guesses: with no usable address, only the higher shared limit applies, and it pauses everyone", async () => {
  await h.connect();
  const proxied = { "cf-connecting-ip": workerSubrequestAddress };
  const now = Date.now();
  for (let index = 1; index < maximumWrongPins; index++) assert.equal((await exchangePin(h.db, "2222-2222", now + index, { address: clientAddress({ get: (name) => (proxied as Record<string, string>)[name] ?? null }) })).status, 401, `guess ${index}`);
  assert.equal((await exchangePin(h.db, "2222-2222", now + maximumWrongPins)).status, 429);
  assert.equal(h.test.rows("SELECT * FROM part_requests_pairing_address_limits").length, 0);
  assert.equal((await h.admin("GET", "/status")).body.pairingAddressesCounted, 0);
});

test("pairing guesses: many addresses together still reach the shared backstop", async () => {
  await h.connect();
  const now = Date.now();
  for (let index = 1; index < maximumWrongPins; index++) assert.equal((await exchangePin(h.db, "2222-2222", now + index, { address: `198.51.100.${index}` })).status, 401);
  assert.equal((await exchangePin(h.db, "2222-2222", now + maximumWrongPins, { address: "198.51.100.250" })).status, 429);
  assert.equal((await exchangePin(h.db, "2222-2222", now + maximumWrongPins + 1, { address: "198.51.100.251" })).status, 429);
});

test("device labels are cleaned up and default sensibly", async () => {
  await h.connect();
  for (const [label, expected] of [["  Test   laptop\n", "Test laptop"], ["", "Browser extension"], [undefined, "Browser extension"], [5, "Browser extension"], ["x".repeat(100), "x".repeat(60)]] as const) {
    h.test.run("DELETE FROM part_requests_devices");
    const reply = await issuePin(h.db, discordB, Date.now());
    const result = await exchangePin(h.db, /\*\*(.+)\*\*/.exec(reply)![1]!, Date.now(), { label });
    assert.equal(result.status, 201);
    assert.equal(h.test.rows<{ label: string }>("SELECT label FROM part_requests_devices")[0]!.label, expected);
  }
});

// ---- Recipient job

test("the job reads the schema, members, requests across pages and missing names, one Notion call per slice", async () => {
  await h.connect();
  stub.calls.length = 0;
  const outcomes = await h.runJob(true);
  assert.deepEqual(outcomes.at(-1), { done: true });
  // Schema, users, two pages of requests, one name, then a slice that finds nothing left.
  assert.equal(stub.calls.length, 5);
  assert.equal(outcomes.length, 6);
  assert.ok(outcomes.slice(0, -1).every((outcome) => outcome.more === true && typeof outcome.cursor === "string"));
  const people = h.test.rows<{ notion_user_id: string; name: string }>("SELECT notion_user_id,name FROM part_requests_recipients ORDER BY name");
  assert.deepEqual(people.map((person) => person.name), ["Test Guest", "Test Guest Looked Up", "Test Member"]);
  assert.ok(people.some((person) => person.notion_user_id === namelessGuest));
  assert.ok(!stub.calls.some((call) => /filter_properties/.test(call.url) || call.body?.filter_properties));
  const refresh = (await h.admin("GET", "/status")).body.refresh;
  assert.equal(refresh.step, "idle");
  assert.ok(refresh.finishedMs);
});

test("the job is cheap when it is not due, because every module write pokes it", async () => {
  await h.connect();
  await h.runJob();
  stub.calls.length = 0;
  h.state.queries = 0;
  assert.deepEqual(await api.jobs["part-requests.recipients"]({ db: h.db, services: { credentials: h.credentials }, scheduler: { steps: true } }), { skipped: "not due" });
  assert.equal(stub.calls.length, 0);
  assert.equal(h.state.queries, 1);
  assert.equal((await h.call("POST", "/admin/part-requests/recipients/refresh", { origin: dashboard })).status, 202);
  await h.runJob();
  assert.ok(stub.calls.length >= 4, "an Admin can ask for a refresh");
});

test("the job stays within the per-slice query budget", async () => {
  await h.connect();
  let most = 0;
  for (let run = 0; run < 20; run++) {
    h.state.queries = 0;
    const outcome = await api.jobs["part-requests.recipients"]({ db: h.db, services: { credentials: h.credentials }, scheduler: { steps: true } }) as { more?: boolean };
    most = Math.max(most, h.state.queries);
    if (!outcome.more) break;
  }
  assert.ok(most <= 4, `a slice used ${most} queries`);
});

test("the job under Core's cron fallback does several steps per run and finishes over several runs", async () => {
  await h.connect();
  stub.calls.length = 0;
  const outcomes = await h.runJob(false);
  assert.deepEqual(outcomes.at(-1), { done: true });
  assert.equal(h.test.rows("SELECT * FROM part_requests_recipients").length, 3);
});

test("a job failure records only a code, waits rather than repeating, and keeps earlier people", async () => {
  await h.connect();
  await h.runJob();
  await h.call("POST", "/admin/part-requests/recipients/refresh", { origin: dashboard });
  stub.on(/^GET \/users\?/, () => notionResponse({ message: `token ${testToken}` }, 429));
  stub.calls.length = 0;
  const outcomes = await h.runJob();
  assert.deepEqual(outcomes.at(-1), { failed: "notion_429" });
  assert.equal((await h.admin("GET", "/status")).body.refresh.lastError, "notion_429");
  assert.equal(h.test.rows("SELECT * FROM part_requests_recipients").length, 3);
  stub.calls.length = 0;
  assert.deepEqual(await api.jobs["part-requests.recipients"]({ db: h.db, services: { credentials: h.credentials }, scheduler: { steps: true } }), { skipped: "not due" });
  assert.equal(stub.calls.length, 0);
});

test("a failed name lookup keeps the person, shown as unnamed, and is not repeated", async () => {
  const key = await ready();
  stub.on(new RegExp(`^GET /users/${namelessGuest}$`), () => notionResponse({}, 404));
  await h.runJob();
  const options = await h.call("GET", "/public/part-requests/options", { key });
  assert.ok(options.body.recipients.some((person: { id: string; name: string }) => person.id === namelessGuest && person.name === "Unnamed Notion user"));
  assert.equal(stub.calls.filter((call) => call.url.endsWith(namelessGuest)).length, 1);
});

test("the job does nothing until connected, and prunes old counters and people after a run", async () => {
  assert.deepEqual(await api.jobs["part-requests.recipients"]({ db: h.db, services: { credentials: h.credentials } }), { skipped: "not connected" });
  assert.equal(stub.calls.length, 0);
  await h.connect();
  const old = Date.now() - 100 * 24 * 60 * 60_000;
  h.test.run("INSERT INTO part_requests_device_limits VALUES ('primary','d-old','create',?,1)", old);
  h.test.run("INSERT INTO part_requests_pairing_address_limits VALUES ('primary',?,?,1,0)", "a".repeat(64), old);
  h.test.run("INSERT INTO part_requests_recipients(installation_id,notion_user_id,name,last_seen_ms) VALUES ('primary','gone','Test Gone',?)", old);
  await h.runJob();
  assert.equal(h.test.rows("SELECT * FROM part_requests_device_limits").length, 0);
  assert.equal(h.test.rows("SELECT * FROM part_requests_pairing_address_limits").length, 0);
  assert.equal(h.test.rows("SELECT * FROM part_requests_recipients WHERE notion_user_id='gone'").length, 0);
});

// ---- The setup page's Verify button

const link = `https://app.notion.com/p/${databaseId.replaceAll("-", "")}`;
const notionRow = () => h.test.rows<any>("SELECT * FROM part_requests_notion")[0];

test("verify: one call saves the token and the connection together, and names the data source", async () => {
  const done = await h.admin("POST", "/verify", { token: testToken, databaseUrl: link });
  assert.equal(done.status, 200, done.text);
  assert.equal(done.body.tokenSaved, true);
  assert.equal(done.body.problem, null);
  assert.equal(done.body.siteAddress, dashboard);
  assert.equal(done.body.dataSourceName, "Ordering");
  assert.equal((await h.admin("GET", "/status")).body.dataSourceName, "Ordering");
  assert.equal(await api.setup.stepValid(h.db, "notion-connection"), true);
  assert.ok(!done.text.includes(testToken));
  assert.ok(!JSON.stringify(notionRow()).includes(testToken), "only ciphertext is stored");
  const actions = h.test.rows<{ action: string }>("SELECT action FROM audit_log").map((row) => row.action);
  assert.ok(actions.includes("part_requests.token_saved") && actions.includes("part_requests.connection_verified"));
});

test("verify: a failed check saves nothing, so nothing has to be undone", async () => {
  stub.on(/\/users\/me$/, () => notionResponse({ code: "unauthorized" }, 401));
  const rejected = await h.admin("POST", "/verify", { token: testToken, databaseUrl: link });
  assert.equal(rejected.body.code, "notion_token_rejected");
  assert.equal(notionRow(), undefined);
  stub.restore(); stub = stubNotion();
  stub.on(/\/databases\//, () => notionResponse({ code: "object_not_found" }, 404));
  const unshared = await h.admin("POST", "/verify", { token: testToken, databaseUrl: link });
  assert.equal(unshared.status, 422);
  assert.equal(unshared.body.code, "notion_404");
  assert.match(unshared.body.error, /Add the connection to the database/);
  assert.equal(notionRow(), undefined);
  assert.equal(h.test.rows("SELECT * FROM part_requests_settings").length, 0);
  stub.restore(); stub = stubNotion();
  stub.source = dataSource();
  delete stub.source.properties.SKU;
  const mismatch = await h.admin("POST", "/verify", { token: testToken, databaseUrl: link });
  assert.equal(mismatch.body.code, "schema_mismatch");
  assert.match(mismatch.body.error, /"SKU" must exist with type rich_text/);
  assert.equal(notionRow(), undefined);
  assert.equal(h.test.rows("SELECT * FROM audit_log").length, 0);
});

test("verify: several data sources save the proven token and ask for the choice, which then needs no token", async () => {
  stub.dataSources = [{ id: dataSourceId, name: "Ordering" }, { id: otherDataSourceId, name: "Archive" }];
  const asked = await h.admin("POST", "/verify", { token: testToken, databaseUrl: link });
  assert.equal(asked.status, 409);
  assert.equal(asked.body.code, "data_source_required");
  assert.deepEqual(asked.body.dataSources.map((source: { name: string }) => source.name), ["Ordering", "Archive"]);
  const waiting = await h.admin("GET", "/status");
  assert.equal(waiting.body.tokenSaved, true);
  assert.equal(waiting.body.problem, "notion_not_connected");
  assert.equal(await api.setup.stepValid(h.db, "notion-connection"), false);
  const chosen = await h.admin("POST", "/verify", { databaseUrl: link, dataSourceId: otherDataSourceId });
  assert.equal(chosen.status, 200, chosen.text);
  assert.equal(chosen.body.dataSourceName, "Archive");
  assert.equal(chosen.body.dataSourceId, otherDataSourceId);
});

test("verify: bad input is refused, no token saved is a clear answer, and it is Admin only from the dashboard", async () => {
  assert.equal((await h.admin("POST", "/verify", { token: "short", databaseUrl: link })).body.code, "invalid_token");
  assert.equal((await h.admin("POST", "/verify", { token: testToken, databaseUrl: " " })).body.code, "invalid_link");
  assert.equal((await h.admin("POST", "/verify", { token: testToken, databaseUrl: "https://notion.evil.example.test/p/x" })).body.code, "invalid_link");
  assert.equal((await h.admin("POST", "/verify", { token: testToken, databaseUrl: link, extra: 1 })).status, 400);
  assert.equal((await h.admin("POST", "/verify", { databaseUrl: link })).body.code, "notion_not_connected");
  assert.equal(stub.calls.filter((call) => call.url.includes("/databases/")).length, 0, "no Notion call without a token");
  const path = "/module-setup/part-requests/verify";
  assert.equal((await h.call("POST", path, { role: "operator", origin: dashboard, body: { token: testToken, databaseUrl: link } })).status, 403);
  assert.equal((await h.call("POST", path, { role: null, origin: dashboard, body: { token: testToken, databaseUrl: link } })).status, 401);
  assert.equal((await h.call("POST", path, { origin: "https://elsewhere.example.test", body: { token: testToken, databaseUrl: link } })).status, 403);
  assert.equal(notionRow(), undefined);
  const unavailable = createHarness(api, { credentials: testCredentials(false) });
  assert.equal((await unavailable.admin("POST", "/verify", { token: testToken, databaseUrl: link })).body.code, "credentials_unavailable");
});

test("status: replacing the token and removing it keep the data source's name and stop requests until verified again", async () => {
  await h.connect();
  const replaced = await h.admin("PUT", "/token", { token: testToken });
  assert.equal(replaced.body.problem, "notion_not_connected");
  assert.equal(replaced.body.dataSourceName, "Ordering");
  assert.equal(replaced.body.databaseId, databaseId);
  const again = await h.admin("POST", "/verify", { databaseUrl: link, dataSourceId: replaced.body.dataSourceId });
  assert.equal(again.body.problem, null);
  const removed = await h.admin("DELETE", "/token");
  assert.equal(removed.body.tokenSaved, false);
  assert.equal(removed.body.problem, "notion_not_connected");
  assert.equal(removed.body.databaseId, databaseId);
});

test("status: the refresh job keeps the data source's name, and a connection saved before names were kept reads as null", async () => {
  await h.connect();
  await h.runJob();
  assert.equal((await h.admin("GET", "/status")).body.dataSourceName, "Ordering");
  const schema = JSON.parse(notionRow().schema_json);
  delete schema.dataSourceName;
  h.test.run("UPDATE part_requests_notion SET schema_json=?", JSON.stringify(schema));
  assert.equal((await h.admin("GET", "/status")).body.dataSourceName, null);
});

test("status: reports the shared pairing pause and when it ends, then clears it by itself", async () => {
  await h.connect();
  const first = await h.admin("GET", "/status");
  assert.equal(first.body.pairingPausedUntilMs, null);
  assert.equal(first.body.pairedDevices, 0);
  assert.equal(first.body.deviceLimit, 5);
  const now = Date.now();
  for (let index = 0; index < maximumWrongPins; index++) await exchangePin(h.db, "2222-2222", now);
  const paused = await h.admin("GET", "/status");
  assert.equal(paused.body.pairingPausedUntilMs, now + pairingPauseMs);
  h.test.run("UPDATE part_requests_pairing_limits SET paused_until_ms=?", Date.now() - 1);
  assert.equal((await h.admin("GET", "/status")).body.pairingPausedUntilMs, null);
});

test("status: one address's pause is not reported as pairing being paused for everyone", async () => {
  await h.connect();
  const now = Date.now();
  for (let index = 0; index < maximumWrongPinsPerAddress; index++) await exchangePin(h.db, "2222-2222", now, { address: "203.0.113.9" });
  assert.equal((await exchangePin(h.db, "2222-2222", now, { address: "203.0.113.9" })).status, 429);
  assert.equal((await h.admin("GET", "/status")).body.pairingPausedUntilMs, null);
});

test("status: counts working devices, off-roster ones included, not revoked ones", async () => {
  await h.connect();
  await h.pair();
  await h.pair(undefined, "Second");
  await h.pair(discordB);
  const devices = await h.call("GET", "/admin/part-requests/devices");
  assert.equal(devices.body.limitPerMember, 5);
  assert.equal((await h.call("POST", "/admin/part-requests/devices/revoke", { origin: dashboard, body: { deviceId: devices.body.devices[0].id } })).status, 200);
  h.test.run("UPDATE members SET active=0 WHERE id='m-b'");
  assert.equal((await h.admin("GET", "/status")).body.pairedDevices, 2);
});

test("the request log counts uncertain requests across every page, overdue pending ones included", async () => {
  await ready();
  const key = await h.pair(discordB);
  stub.on(/\/pages$/, () => notionResponse({ message: "stub" }, 500));
  for (const description of ["Test old uncertain", "Test newer uncertain"]) await send(key, uuid(), goodDraft({ description }));
  stub.on(/\/pages$/, () => notionResponse({ message: "stub" }, 400));
  await send(key, uuid(), goodDraft({ description: "Test failed" }));
  h.test.run("UPDATE part_requests_submissions SET created_ms=created_ms-1000 WHERE description='Test newer uncertain'");
  h.test.run("UPDATE part_requests_submissions SET created_ms=created_ms-2000 WHERE description='Test old uncertain'");
  const onePage = await h.call("GET", "/admin/part-requests/requests?limit=1");
  assert.equal(onePage.body.requests[0].description, "Test failed");
  assert.equal(onePage.body.uncertainCount, 2, "both are older than this page");
  h.test.run("UPDATE part_requests_submissions SET state='pending',finished_ms=NULL,created_ms=? WHERE description='Test failed'", Date.now());
  assert.equal((await h.call("GET", "/admin/part-requests/requests")).body.uncertainCount, 2, "a request still inside its time limit is pending");
  h.test.run("UPDATE part_requests_submissions SET created_ms=? WHERE description='Test failed'", Date.now() - pendingLimitMs - 1);
  const overdue = await h.call("GET", "/admin/part-requests/requests");
  assert.equal(overdue.body.uncertainCount, 3);
  assert.equal(overdue.body.requests.filter((request: { state: string }) => request.state === "uncertain").length, 3);
});

test("query counts: status and the log are one batch of reads each", async () => {
  await h.connect();
  h.state.queries = 0;
  assert.equal((await h.admin("GET", "/status")).status, 200);
  assert.equal(h.state.queries, 1);
  h.state.queries = 0;
  assert.equal((await h.call("GET", "/admin/part-requests/requests")).status, 200);
  assert.equal(h.state.queries, 1);
});

// ---- Admin data and cost

test("Admin data: the log pages newest first; devices show labels and no key material", async () => {
  await h.connect();
  stub.calls.length = 0;
  const key = await h.pair(undefined, "Test laptop");
  for (let index = 0; index < 3; index++) { await send(key, uuid(), goodDraft({ description: `Test part ${index}` })); h.test.run("UPDATE part_requests_submissions SET created_ms=created_ms-? WHERE description=?", (3 - index) * 1000, `Test part ${index}`); }
  const page = await h.call("GET", "/admin/part-requests/requests?limit=2");
  assert.deepEqual(page.body.requests.map((request: { description: string }) => request.description), ["Test part 2", "Test part 1"]);
  const next = await h.call("GET", `/admin/part-requests/requests?limit=2&before=${page.body.nextBefore}`);
  assert.deepEqual(next.body.requests.map((request: { description: string }) => request.description), ["Test part 0"]);
  assert.equal(next.body.nextBefore, null);
  const devices = await h.call("GET", "/admin/part-requests/devices");
  assert.equal(devices.body.devices[0].label, "Test laptop");
  assert.equal(devices.body.devices[0].memberName, "Test Student A");
  assert.equal(devices.body.devices[0].memberActive, true);
  assert.ok(devices.body.devices[0].lastUsedMs);
  assert.ok(!/key_hash|keyHash/.test(devices.text));
  assert.ok(!h.test.rows<{ key_hash: string }>("SELECT key_hash FROM part_requests_devices").some((row) => devices.text.includes(row.key_hash)));
  assert.ok(h.test.rows<{ action: string }>("SELECT action FROM audit_log").some((row) => row.action === "part_requests.connection_verified"));
});

test("devices: the active roster comes back with only an ID and a name, so a member with no device can be listed", async () => {
  await h.connect();
  await h.pair();
  const { status, body, text } = await h.call("GET", "/admin/part-requests/devices");
  assert.equal(status, 200);
  assert.deepEqual(body.roster, [{ id: "m-a", name: "Test Student A" }, { id: "m-b", name: "Test Student B" }]);
  assert.equal(body.rosterLimited, false);
  for (const secret of ["student.a@example.test", "student.b@example.test", "9001", "9002", "externalId", "email"]) assert.ok(!text.includes(secret), secret);
  assert.deepEqual(memberRows(body, Date.now()).map((member) => member.devices.length), [1, 0]);
  h.test.run("UPDATE members SET active=0 WHERE id='m-b'");
  assert.deepEqual((await h.call("GET", "/admin/part-requests/devices")).body.roster, [{ id: "m-a", name: "Test Student A" }], "only active members");
});

test("devices: exactly 500 on the roster raises the flag, because Core's projection stops there", async () => {
  const add = (from: number, to: number) => { for (let index = from; index < to; index++) h.test.run("INSERT INTO members(id,installation_id,external_id,first_name,last_name) VALUES (?,'primary',?,'Test','Bulk')", `bulk-${index}`, `ext-${index}`); };
  add(0, 497);
  const under = await h.call("GET", "/admin/part-requests/devices");
  assert.equal(under.body.roster.length, 499);
  assert.equal(under.body.rosterLimited, false);
  add(497, 498);
  const full = await h.call("GET", "/admin/part-requests/devices");
  assert.equal(full.body.roster.length, 500);
  assert.equal(full.body.rosterLimited, true);
  assert.ok(!full.text.includes("ext-"));
});

// ---- A token Notion refuses after it was verified.
const statusOf = async () => (await h.admin("GET", "/status")).body;
const notionAnswers = (match: RegExp, code: number) => stub.on(match, () => notionResponse({ code: "stub", message: `echo ${testToken}` }, code));
const healthyNotion = () => { stub.restore(); stub = stubNotion(); };
const databaseLinkBody = { databaseUrl: databaseId, dataSourceId };

for (const [code, problem, stored] of [[401, "notion_token_rejected", "notion_401"], [403, "notion_insert_refused", "notion_insert_403"], [404, "notion_access_lost", "notion_404"]] as const) {
  test(`refused: a ${code} from a request shows ${problem}, keeps the student's answer, and the next call that works clears it`, async () => {
    const key = await ready();
    assert.equal((await statusOf()).problem, null);
    notionAnswers(/^POST \/pages$/, code);
    const before = Date.now();
    const refused = await send(key, uuid());
    assert.equal(refused.status, 502);
    assert.equal(refused.body.code, `notion_${code}`, "what the student is told does not change");
    const status = await statusOf();
    assert.equal(status.problem, problem);
    assert.ok(status.rejectedMs >= before);
    assert.equal(status.tokenSaved, true);
    assert.equal(status.verifiedMs !== null, true, "the connection itself stays");
    assert.equal(h.test.rows<any>("SELECT rejection_code FROM part_requests_notion")[0].rejection_code, stored);
    healthyNotion();
    assert.equal((await send(key, uuid())).status, 201, "requests keep trying, so a glitch can clear itself");
    const after = await statusOf();
    assert.equal(after.problem, null);
    assert.equal(after.rejectedMs, null);
  });
}

// ---- A connection without Insert content: Notion answers reads but refuses to create a page with a 403.
const insertRefused = () => notionAnswers(/^POST \/pages$/, 403);

test("insert content: a 403 creating a page reads as the missing capability, and a working Carts read does not flip it back", async () => {
  const key = await ready();
  await h.runJob();
  insertRefused();
  await send(key, uuid());
  const refused = await statusOf();
  assert.equal(isConnected(refused), false);
  // Carts reads the database, which this connection can still do.
  stub.calls.length = 0;
  const carts = await h.call("GET", "/public/part-requests/orders", { key });
  assert.ok(carts.status === 200 || carts.status === 202, carts.text);
  assert.ok(stub.calls.some((call) => call.method === "POST" && call.url.includes("/data_sources/")), "Carts read the database");
  const after = await statusOf();
  assert.equal(isConnected(after), false, "a successful read says nothing about inserting");
  assert.equal(refused.problem, "notion_insert_refused");
  assert.equal(after.problem, "notion_insert_refused");
  assert.match(connectionProblem(after)!, /Insert content/);
  assert.equal(after.rejectedMs, refused.rejectedMs);
});

test("insert content: a refresh run that reads the database does not flip it back either, in either scheduler mode", async () => {
  const key = await ready();
  insertRefused();
  await send(key, uuid());
  for (const steps of [true, false]) {
    jobDue();
    await h.runJob(steps);
    assert.equal((await statusOf()).problem, "notion_insert_refused", `steps=${steps}`);
  }
});

test("insert content: verifying with the saved token keeps it; a request that goes through or a new token clears it", async () => {
  const key = await ready();
  insertRefused();
  await send(key, uuid());
  assert.equal((await h.admin("POST", "/verify", databaseLinkBody)).body.problem, "notion_insert_refused", "verify only reads, so it cannot prove inserting works");
  healthyNotion();
  assert.equal((await send(key, uuid())).status, 201);
  assert.equal((await statusOf()).problem, null);
  insertRefused();
  await send(key, uuid());
  healthyNotion();
  assert.equal((await h.admin("POST", "/verify", { ...databaseLinkBody, token: testToken })).body.problem, null, "a new token may be a different connection");
});

test("insert content: a 401 still reads as a rejected token, and a read refusal still reads as lost access", async () => {
  const key = await ready();
  insertRefused();
  await send(key, uuid());
  notionAnswers(/^GET \/data_sources\//, 401);
  jobDue();
  await h.runJob();
  assert.equal((await statusOf()).problem, "notion_token_rejected");
  healthyNotion();
  insertRefused();
  await send(key, uuid());
  assert.equal((await statusOf()).problem, "notion_insert_refused");
  notionAnswers(/^GET \/data_sources\//, 403);
  jobDue();
  await h.runJob();
  assert.equal((await statusOf()).problem, "notion_access_lost");
});

for (const code of [500, 429, 400, 409]) {
  test(`refused: a passing ${code} says nothing about the token`, async () => {
    const key = await ready();
    notionAnswers(/^POST \/pages$/, code);
    await send(key, uuid());
    assert.equal((await statusOf()).problem, null);
    assert.equal(h.test.rows<any>("SELECT rejected_ms FROM part_requests_notion")[0].rejected_ms, null);
  });
}

test("refused: a passing 500 neither sets it nor clears one already recorded, and the first time stands", async () => {
  const key = await ready();
  notionAnswers(/^POST \/pages$/, 401);
  await send(key, uuid());
  const first = (await statusOf()).rejectedMs;
  h.test.run("UPDATE part_requests_notion SET rejected_ms=?", first - 5000);
  await send(key, uuid());
  assert.equal((await statusOf()).rejectedMs, first - 5000, "the same refusal keeps its first time");
  notionAnswers(/^POST \/pages$/, 500);
  await send(key, uuid());
  assert.equal((await statusOf()).problem, "notion_token_rejected");
});

test("refused: a successful verify clears it, with the saved token or a new one, and so does removing the token", async () => {
  const key = await ready();
  notionAnswers(/^POST \/pages$/, 401);
  await send(key, uuid());
  healthyNotion();
  assert.equal((await h.admin("POST", "/verify", databaseLinkBody)).body.problem, null);
  notionAnswers(/^POST \/pages$/, 403);
  await send(key, uuid());
  healthyNotion();
  assert.equal((await h.admin("POST", "/verify", { ...databaseLinkBody, token: testToken })).body.problem, null);
  notionAnswers(/^POST \/pages$/, 401);
  await send(key, uuid());
  const removed = await h.admin("DELETE", "/token");
  assert.equal(removed.body.problem, "notion_not_connected");
  assert.equal(removed.body.rejectedMs, null);
});

test("refused: a failed verify changes nothing, and a problem that stops requests is reported ahead of it", async () => {
  const key = await ready();
  notionAnswers(/^POST \/pages$/, 401);
  await send(key, uuid());
  notionAnswers(/^GET \/databases\//, 401);
  assert.equal((await h.admin("POST", "/verify", databaseLinkBody)).status, 422);
  assert.equal((await statusOf()).problem, "notion_token_rejected");
  h.test.run("UPDATE part_requests_notion SET schema_error='Changed'");
  assert.equal((await statusOf()).problem, "notion_schema_changed");
});

test("refused: the refresh job records it and clears it, and one person's name lookup does neither", async () => {
  await h.connect();
  await h.runJob();
  notionAnswers(/^GET \/data_sources\//, 401);
  h.test.run("UPDATE part_requests_recipient_refresh SET next_due_ms=0,step='idle'");
  assert.deepEqual((await h.runJob()).at(-1), { failed: "notion_401" });
  assert.equal((await statusOf()).problem, "notion_token_rejected");
  healthyNotion();
  h.test.run("UPDATE part_requests_recipient_refresh SET next_due_ms=0,step='idle'");
  await h.runJob();
  assert.equal((await statusOf()).problem, null);
  // Cron mode runs several slices with one read of the row: a clear then a refusal in the same run must still be recorded.
  notionAnswers(/^POST \/data_sources\//, 403);
  h.test.run("UPDATE part_requests_notion SET rejection_code='notion_401',rejected_ms=1");
  h.test.run("UPDATE part_requests_recipient_refresh SET next_due_ms=0,step='idle'");
  await h.runJob(false);
  assert.equal((await statusOf()).problem, "notion_access_lost");
  healthyNotion();
  stub.on(new RegExp(`^GET /users/${namelessGuest}$`), () => notionResponse({ code: "object_not_found" }, 404));
  h.test.run("UPDATE part_requests_recipient_refresh SET next_due_ms=0,step='idle'");
  h.test.run("UPDATE part_requests_recipients SET name_checked=0 WHERE name=''");
  await h.runJob();
  assert.equal((await statusOf()).problem, null);
});

const refreshRow = () => h.test.rows<any>("SELECT step,last_error,finished_ms,next_due_ms FROM part_requests_recipient_refresh")[0];
const jobDue = (step = "idle") => h.test.run("UPDATE part_requests_recipient_refresh SET next_due_ms=0,step=?,cursor=NULL,pages=0", step);

test("recipients: a 403 listing users is not lost access, and the refresh carries on from the people on requests", async () => {
  await h.connect();
  notionAnswers(/^GET \/users\?/, 403);
  const started = Date.now();
  const outcomes = await h.runJob();
  assert.deepEqual(outcomes.at(-1), { done: true }, "the run finishes");
  assert.equal((await statusOf()).problem, null);
  assert.equal(h.test.rows<any>("SELECT rejection_code,rejected_ms FROM part_requests_notion")[0].rejection_code, null);
  assert.ok(h.test.rows("SELECT 1 FROM part_requests_recipients WHERE notion_user_id=?", guestPerson).length === 1, "people on requests are still found");
  const row = refreshRow();
  assert.equal(row.step, "idle");
  assert.equal(row.last_error, "notion_users_403", "kept for the notice");
  assert.ok(row.finished_ms >= started, "it counts as a finished refresh");
  assert.ok(row.next_due_ms > started + 60 * 60_000, "the normal interval, not the failure retry");
  const status = await statusOf();
  assert.match(refreshNotice(status.refresh)!, /^Workspace members could not be listed.*Read user information capability\.$/);
  assert.ok(!JSON.stringify(status).includes("Authorization"));
});

test("recipients: the users notice goes when users can be listed again, and a later failure is reported as a failure", async () => {
  await h.connect();
  notionAnswers(/^GET \/users\?/, 403);
  await h.runJob();
  assert.equal(refreshRow().last_error, "notion_users_403");
  healthyNotion();
  jobDue();
  await h.runJob();
  assert.equal(refreshRow().last_error, null);
  notionAnswers(/^GET \/users\?/, 403);
  notionAnswers(/^POST \/data_sources\//, 500);
  jobDue();
  await h.runJob();
  assert.equal(refreshRow().last_error, "notion_500", "the run failed, so that is what it says");
  assert.equal((await statusOf()).problem, null);
});

test("recipients: a 401 listing users is a rejected token; a 404 or a 500 there fails the run but records no refusal", async () => {
  await h.connect();
  notionAnswers(/^GET \/users\?/, 401);
  assert.deepEqual((await h.runJob()).at(-1), { failed: "notion_401" });
  assert.equal((await statusOf()).problem, "notion_token_rejected");
  for (const code of [404, 500]) {
    healthyNotion();
    jobDue();
    await h.runJob();
    assert.equal((await statusOf()).problem, null);
    notionAnswers(/^GET \/users\?/, code);
    jobDue();
    assert.deepEqual((await h.runJob()).at(-1), { failed: `notion_${code}` });
    assert.equal((await statusOf()).problem, null, String(code));
  }
});

test("recipients: success listing users does not clear a refusal the database still gets", async () => {
  await h.connect();
  await h.runJob();
  // Only the users step runs here, with a refusal already recorded.
  h.test.run("UPDATE part_requests_notion SET rejection_code='notion_403',rejected_ms=5");
  jobDue("users");
  assert.equal((await h.runJob(true, 1)).at(-1).more, true);
  assert.equal(refreshRow().step, "requests", "the step ran");
  assert.equal((await statusOf()).problem, "notion_access_lost");
  assert.equal((await statusOf()).rejectedMs, 5);
  // The whole run: users answer, and the query the database gets is refused, so it ends recorded.
  for (const code of [403, 404]) {
    healthyNotion();
    notionAnswers(/^POST \/data_sources\//, code);
    jobDue();
    assert.deepEqual((await h.runJob()).at(-1), { failed: `notion_${code}` });
    assert.equal((await statusOf()).problem, "notion_access_lost", String(code));
  }
  // Then the database answers, with users still forbidden, and that does clear it.
  healthyNotion();
  notionAnswers(/^GET \/users\?/, 403);
  jobDue();
  await h.runJob();
  assert.equal((await statusOf()).problem, null);
});

test("recipients: a 403 or 404 reading the schema is lost access", async () => {
  for (const code of [403, 404]) {
    stub.restore(); stub = stubNotion(); h = createHarness(api);
    await h.connect();
    notionAnswers(/^GET \/data_sources\//, code);
    assert.deepEqual((await h.runJob()).at(-1), { failed: `notion_${code}` });
    assert.equal((await statusOf()).problem, "notion_access_lost", String(code));
  }
});

test("recipients: a 401 looking up one name is a rejected token, and that person is looked up again; a 404 there is neither", async () => {
  await h.connect();
  await h.runJob();
  h.test.run("INSERT OR REPLACE INTO part_requests_recipients(installation_id,notion_user_id,name,last_seen_ms,name_checked) VALUES ('primary',?,'',?,0)", namelessGuest, Date.now());
  const checked = () => h.test.rows<any>("SELECT name_checked FROM part_requests_recipients WHERE notion_user_id=?", namelessGuest)[0].name_checked;
  notionAnswers(new RegExp(`^GET /users/${namelessGuest}$`), 404);
  jobDue("names");
  await h.runJob();
  assert.equal((await statusOf()).problem, null);
  assert.equal(checked(), 1);
  h.test.run("UPDATE part_requests_recipients SET name_checked=0 WHERE notion_user_id=?", namelessGuest);
  notionAnswers(new RegExp(`^GET /users/${namelessGuest}$`), 401);
  jobDue("names");
  assert.deepEqual((await h.runJob()).at(-1), { failed: "notion_401" });
  assert.equal((await statusOf()).problem, "notion_token_rejected");
  assert.equal(checked(), 0);
});

test("refused: a slow call made with a replaced token cannot mark the new one", async () => {
  await ready();
  const { readConnection, recordRefusal } = await import("../src/connection.ts");
  const old = (await readConnection(h.db))!;
  assert.equal((await h.admin("POST", "/verify", { ...databaseLinkBody, token: testToken })).status, 200);
  await recordRefusal(h.db, old, "notion_401", Date.now());
  assert.equal((await statusOf()).problem, null);
});

test("insert content: a read that started before the refusal was recorded cannot clear it", async () => {
  const key = await ready();
  const { readConnection, clearRefusal } = await import("../src/connection.ts");
  h.test.run("UPDATE part_requests_notion SET rejection_code='notion_404',rejected_ms=1");
  const stale = (await readConnection(h.db))!;
  insertRefused();
  await send(key, uuid());
  await clearRefusal(h.db, stale);
  assert.equal((await statusOf()).problem, "notion_insert_refused");
});

test("refused: the token stays out of every answer, the database and the logs, and setup stays complete", async () => {
  const seen: string[] = [];
  const saved = { log: console.log, error: console.error, warn: console.warn };
  for (const name of ["log", "error", "warn"] as const) console[name] = (...args: unknown[]) => { seen.push(args.join(" ")); };
  try {
    const key = await ready();
    notionAnswers(/^POST \/pages$/, 401);
    seen.push((await send(key, uuid())).text);
    seen.push((await h.admin("GET", "/status")).text);
    seen.push(JSON.stringify(h.test.rows("SELECT rejection_code,rejected_ms FROM part_requests_notion")));
  } finally { Object.assign(console, saved); }
  assert.ok(seen.length >= 3);
  for (const text of seen) { assert.ok(!text.includes(testToken)); assert.ok(!text.includes("echo")); }
  assert.equal(await api.setup.stepValid(h.db, "notion-connection"), true, "a refusal must not lock the module");
});

// ---- Replacing a token, as the page does it: one POST /verify with the saved data source.
const newToken = "ntn_TESTreplacementTokenNEVERreal0123456789ABCDEFGHIJ";
const cipher = () => h.test.rows<any>("SELECT ciphertext,verified_ms,data_source_id FROM part_requests_notion")[0];
const replace = () => h.admin("POST", "/verify", { token: newToken, databaseUrl: `https://app.notion.com/p/${databaseId.replaceAll("-", "")}`, dataSourceId });
const acceptNewToken = () => { for (const match of [/^GET \/users\/me$/, /^GET \/databases\//, /^GET \/data_sources\//]) stub.on(match, (call) => call.headers.Authorization === `Bearer ${newToken}` ? fetchAsTestToken(call) : notionResponse({ code: "unauthorized" }, 401)); };
const fetchAsTestToken = (call: { url: string }) => call.url.includes("/users/me") ? notionResponse({ object: "user", id: "b0000000-0000-4000-8000-000000000000", type: "bot", bot: {} })
  : call.url.includes("/databases/") ? notionResponse({ object: "database", id: databaseId, data_sources: stub.dataSources }) : notionResponse({ ...stub.source, id: dataSourceId });

test("replace: one call saves and verifies, with no moment when requests stay stopped, and the old token is gone", async () => {
  await ready();
  const before = cipher();
  acceptNewToken();
  const replaced = await replace();
  assert.equal(replaced.status, 200, replaced.text);
  assert.equal(replaced.body.problem, null);
  assert.equal(replaced.body.dataSourceId, dataSourceId);
  assert.notEqual(cipher().ciphertext, before.ciphertext);
  assert.ok(cipher().verified_ms >= before.verified_ms);
  assert.ok(!replaced.text.includes(newToken));
  assert.equal(h.test.rows("SELECT 1 FROM audit_log WHERE action='part_requests.token_saved'").length, 2);
});

test("replace: each failure saves nothing, and the old token stays verified and working", async () => {
  const key = await ready();
  const before = cipher();
  const unchanged = () => assert.deepEqual(cipher(), before);
  // Rejected by Notion.
  assert.equal((await replace()).body.code, "notion_token_rejected");
  unchanged();
  // Accepted, but it cannot reach the database.
  stub.on(/^GET \/users\/me$/, () => notionResponse({ object: "user", id: "b", type: "bot", bot: {} }));
  stub.on(/^GET \/databases\//, () => notionResponse({ code: "object_not_found" }, 404));
  assert.equal((await replace()).body.code, "notion_404");
  unchanged();
  // Reaches it, but the layout no longer fits.
  healthyNotion(); acceptNewToken();
  delete stub.source.properties.SKU;
  assert.equal((await replace()).body.code, "schema_mismatch");
  unchanged();
  // The saved data source has gone from the database: a choice is needed, and the old token still is not replaced.
  healthyNotion(); acceptNewToken();
  stub.dataSources = [{ id: otherDataSourceId, name: "Other" }, { id: "cccccccc-bbbb-4ccc-8ddd-eeeeeeeeeeee", name: "Another" }];
  assert.equal((await replace()).body.code, "data_source_required");
  unchanged();
  // Notion is down.
  healthyNotion();
  stub.on(/^GET \/users\/me$/, () => notionResponse({ message: "stub" }, 500));
  assert.equal((await replace()).status, 502);
  unchanged();
  healthyNotion();
  assert.equal((await send(key, uuid())).status, 201, "requests still work with the old token");
});

test("replace: first-time setup with several data sources still keeps the proven token and asks for the choice", async () => {
  stub.dataSources = [{ id: dataSourceId, name: "Ordering" }, { id: otherDataSourceId, name: "Archive" }];
  const refused = await h.admin("POST", "/verify", { token: testToken, databaseUrl: databaseId });
  assert.equal(refused.body.code, "data_source_required");
  assert.equal(h.test.rows<any>("SELECT ciphertext IS NOT NULL AS saved FROM part_requests_notion")[0].saved, 1);
});

test("replace: fixes a rejected token in the same step", async () => {
  const key = await ready();
  notionAnswers(/^POST \/pages$/, 401);
  await send(key, uuid());
  assert.equal((await statusOf()).problem, "notion_token_rejected");
  healthyNotion(); acceptNewToken();
  const replaced = await replace();
  assert.equal(replaced.body.problem, null);
  assert.equal(replaced.body.rejectedMs, null);
});

test("query counts: the routes stay small enough for Workers Free", async () => {
  await h.connect();
  await h.runJob();
  const key = await h.pair();
  const id = uuid();
  const measure = async (work: () => Promise<{ status: number }>, status: number) => { h.state.queries = 0; assert.equal((await work()).status, status); return h.state.queries; };
  assert.equal(await measure(() => send(key, id, goodDraft({ recipient: guestPerson })), 201), 3, "create: reads, record, result");
  assert.equal(await measure(() => send(key, id, goodDraft({ recipient: guestPerson })), 200), 1, "repeat: reads only");
  assert.equal(await measure(() => send(key, uuid(), goodDraft({ team: "team-unknown" })), 400), 1, "refused: reads only");
  assert.equal(await measure(() => h.call("GET", "/public/part-requests/options", { key }), 200), 2);
  assert.equal(await measure(() => h.call("POST", "/public/part-requests/check", { key, body: { url: goodDraft().url } }), 200), 3);
});
