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

test("setup: Core's connection, then the ordering database, then verify; the site address comes from the dashboard origin", async () => {
  const first = await h.admin("GET", "/status");
  assert.equal(first.body.problem, "notion_not_configured");
  assert.equal(first.body.core.saved, false);
  assert.equal(first.body.binding, null);
  assert.equal(first.body.siteAddress, null);
  assert.equal((await h.admin("POST", "/verify", {})).body.code, "notion_not_configured");
  await h.core.connect();
  assert.equal((await h.admin("GET", "/status")).body.problem, "orders_unbound", "a connection alone is not a database");
  assert.equal((await h.admin("POST", "/verify", {})).body.code, "notion_unbound");
  h.core.bind({ databaseId, dataSourceId, name: "Ordering" });
  const unverified = await h.admin("GET", "/status");
  assert.equal(unverified.body.problem, "not_verified");
  assert.deepEqual(unverified.body.binding, { databaseId, dataSourceId, name: "Ordering" });
  assert.equal(await api.setup.stepValid(h.db, "notion-connection"), false);
  stub.calls.length = 0;
  const verified = await h.admin("POST", "/verify", {});
  assert.equal(verified.status, 200);
  assert.equal(verified.body.problem, null);
  assert.equal(verified.body.siteAddress, dashboard);
  assert.equal(verified.body.dataSourceName, "Ordering");
  assert.equal(verified.body.core.connected, true);
  assert.deepEqual(verified.body.teams.map((team: { name: string }) => team.name), ["Test Team One", "Test Team Two"]);
  assert.deepEqual(stub.calls.map((call) => `${call.method} ${call.url}`), [`GET https://api.notion.com/v1/data_sources/${dataSourceId}`], "one read of the bound data source, through Core");
  assert.equal(stub.calls[0]!.headers.Authorization, `Bearer ${testToken}`, "with Core's token");
  assert.equal(await api.setup.stepValid(h.db, "notion-connection"), true);
  assert.equal(await api.setup.stepValid(h.db, "something-else"), false);
  assert.equal(h.test.rows("SELECT * FROM audit_log WHERE action='part_requests.connection_verified' AND actor_user_id='u-admin'").length, 1);
});

test("setup's predicate is the same check Core runs inside its own SQL, and needs no token in the plugin", async () => {
  const predicate = api.setup.predicates["notion-connection"]("primary");
  const holds = () => Object.values(h.test.rows(`SELECT (${predicate.sql}) AS ok`, ...predicate.bindings)[0] as object)[0];
  assert.equal(holds(), 0);
  await h.connect();
  assert.equal(holds(), 1);
  assert.equal(h.test.rows("SELECT * FROM part_requests_notion WHERE ciphertext IS NOT NULL").length, 0);
  // Core keeps a module open once setup is complete, so a problem in Core's connection shows on every request instead.
  h.core.state.connection = null;
  assert.equal(holds(), 1);
  assert.equal((await h.admin("GET", "/status")).body.problem, "notion_not_configured");
});

test("setup: Core's turned-off or unreadable connection, and a database Core's token can't open, are refused with what to fix", async () => {
  await h.connect();
  h.core.state.connection!.enabled = false;
  assert.equal((await h.admin("POST", "/verify", {})).body.code, "notion_disabled");
  assert.equal((await h.admin("GET", "/status")).body.problem, "notion_disabled");
  h.core.state.connection!.enabled = true; h.core.state.connection!.readable = false;
  const unreadable = await h.admin("POST", "/verify", {});
  assert.equal(unreadable.status, 409);
  assert.equal(unreadable.body.code, "notion_unreadable");
  assert.match(unreadable.body.error, /Settings > Integrations > Notion/);
  h.core.state.connection!.readable = true;
  stub.on(/^GET \/data_sources/, () => notionResponse({ code: "object_not_found" }, 404));
  assert.equal((await h.admin("POST", "/verify", {})).body.code, "notion_404");
  stub.on(/^GET \/data_sources/, () => notionResponse({ code: "unauthorized" }, 401));
  assert.equal((await h.admin("POST", "/verify", {})).body.code, "notion_token_rejected");
  stub.on(/^GET \/data_sources/, () => notionResponse({}, 429, { "retry-after": "2" }));
  assert.equal((await h.admin("POST", "/verify", {})).body.code, "notion_rate_limited");
});

test("setup: a schema mismatch is refused, says what is wrong, and leaves the connection unverified", async () => {
  await h.core.connect();
  h.core.bind({ databaseId, dataSourceId, name: "Ordering" });
  delete stub.source.properties.SKU;
  const refused = await h.admin("POST", "/verify", {});
  assert.equal(refused.status, 422);
  assert.equal(refused.body.code, "schema_mismatch");
  assert.match(refused.body.error, /SKU/);
  assert.equal(await api.setup.stepValid(h.db, "notion-connection"), false);
  assert.equal(h.test.rows("SELECT * FROM part_requests_settings").length, 0, "a failed check saves nothing, not even the site address");
});

test("setup: verify takes no token, link or data source; those are chosen in Core", async () => {
  await h.connect();
  for (const body of [{ token: testToken }, { databaseUrl: databaseId }, { dataSourceId }]) {
    const refused = await h.admin("POST", "/verify", body);
    assert.equal(refused.status, 400, JSON.stringify(body));
    assert.equal(refused.body.code, "validation");
  }
  for (const [method, path] of [["PUT", "/token"], ["DELETE", "/token"], ["POST", "/database"], ["POST", "/connection"]] as const) {
    assert.equal((await h.admin(method, path, { token: testToken })).status, 404, `${method} ${path} is gone`);
  }
});

test("Admin only: Operators, signed-out visitors and other origins are refused on every setup and Admin route", async () => {
  await h.connect();
  stub.calls.length = 0;
  const routes = [
    ["GET", "/module-setup/part-requests/status"], ["POST", "/module-setup/part-requests/verify"], ["PUT", "/module-setup/part-requests/carts"],
    ["GET", "/admin/part-requests/requests"], ["GET", "/admin/part-requests/devices"], ["POST", "/admin/part-requests/devices/revoke"], ["POST", "/admin/part-requests/recipients/refresh"], ["POST", "/admin/part-requests/pins"],
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
  assert.equal(h.test.rows("SELECT * FROM part_requests_notion WHERE verified_ms IS NOT NULL").length, 1);
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
    // A 1.1 installation, so the token passes through the plugin's table once, on its way to Core.
    await h.asVersion11();
    await record(h.admin("GET", "/status"));
    await record(h.admin("POST", "/verify", {}));
    const key = await h.pair();
    await h.runJob();
    await record(h.call("GET", "/public/part-requests/options", { key }));
    await record(send(key, uuid()));
    for (const failure of [401, 500]) { stub.on(/^POST \/pages$/, () => notionResponse({ message: `echo ${testToken}` }, failure)); await record(send(key, uuid())); }
    stub.on(/^POST \/pages$/, () => { throw new Error(`network failure ${testToken}`); });
    await record(send(key, uuid()));
    stub.on(/^GET \/data_sources/, () => notionResponse({ message: testToken }, 401));
    await record(h.admin("POST", "/verify", {}));
    await record(h.call("GET", "/admin/part-requests/requests"));
    await record(h.call("GET", "/admin/part-requests/devices"));
    await h.runJob();
  } finally { Object.assign(console, saved); }
  assert.ok(seen.length >= 10);
  for (const text of [...seen, ...lines]) { assert.ok(!text.includes(testToken), text.slice(0, 200)); assert.ok(!text.includes("ciphertext"), text.slice(0, 200)); }
  const stored = JSON.stringify(h.test.sqlite.prepare("SELECT * FROM part_requests_notion").all()) + JSON.stringify(h.test.rows("SELECT * FROM part_requests_submissions")) + JSON.stringify(h.test.rows("SELECT * FROM part_requests_recipient_refresh")) + JSON.stringify(h.test.rows("SELECT * FROM audit_log"));
  assert.ok(!stored.includes(testToken));
  assert.equal(h.test.rows("SELECT * FROM part_requests_notion WHERE ciphertext IS NOT NULL OR iv IS NOT NULL").length, 0, "the 1.1 copy is gone");
  assert.ok(stub.calls.some((call) => call.headers.Authorization === `Bearer ${testToken}`), "it does reach Notion, in the header Core sets");
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
  stub.on(/^POST \/pages$/, async () => { await held; return notionResponse({ object: "page", id: crypto.randomUUID(), url: "https://www.notion.so/one" }); });
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
  stub.on(/^POST \/pages$/, () => { assert.equal(row(id).state, "pending"); return notionResponse({ object: "page", id: crypto.randomUUID(), url: "https://www.notion.so/one" }); });
  assert.equal((await send(key, id)).status, 201);
  h.state.failing = /INSERT INTO part_requests_submissions/;
  await assert.rejects(send(key, uuid()), /D1_ERROR/);
  h.state.failing = undefined;
  assert.equal(pageCalls(), 1);
});

test("uncertain results are recorded, returned on repeats, and never sent again", async () => {
  const key = await ready();
  for (const [label, answer] of [["5xx", () => notionResponse({}, 500)], ["409", () => notionResponse({}, 409)], ["timeout", () => { throw new DOMException("timed out", "TimeoutError"); }], ["unreadable", () => new Response("{bad")], ["bad link", () => notionResponse({ object: "page", id: crypto.randomUUID(), url: "https://notion.so.evil.example.test/x" })]] as const) {
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
  // Core holds every module's Notion calls for the 7 seconds Notion named, so a new ID fails at once without a call.
  const held = await send(key, uuid());
  assert.equal(held.body.state, "failed");
  assert.equal(held.body.code, "notion_429");
  assert.ok(held.body.retryAfterSeconds >= 1 && held.body.retryAfterSeconds <= 7);
  assert.equal(pageCalls(), 0);
  h.core.state.pausedUntilMs = 0; // the wait is over
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

test("a connection that is missing, rebound or out of step stops requests with a clear 503, but recorded results still answer", async () => {
  const key = await ready();
  const id = uuid();
  await send(key, id);
  // Core's binding now points at another data source, whose layout Part Requests has not checked.
  h.core.bind({ databaseId, dataSourceId: otherDataSourceId, name: "Archive" });
  const unverified = await send(key, uuid());
  assert.equal(unverified.status, 503);
  assert.equal(unverified.body.code, "notion_not_connected");
  assert.equal((await send(key, id)).body.state, "created");
  assert.equal((await h.call("GET", "/public/part-requests/options", { key })).body.code, "notion_not_connected");
  assert.equal((await h.admin("GET", "/status")).body.problem, "not_verified");
  for (const change of [() => { h.core.state.connection = null; }, () => { h.core.state.bindings.clear(); }]) {
    await h.connect();
    change();
    assert.equal((await send(key, uuid())).body.code, "notion_not_connected");
    assert.equal(pageCalls(), 1, "no Notion call");
  }
  await h.connect();
  stub.calls.length = 0;
  delete stub.source.properties.Qty;
  await h.runJob();
  const changed = await send(key, uuid());
  assert.equal(changed.body.code, "notion_schema_changed");
  assert.equal(pageCalls(), 0);
  assert.match((await h.admin("GET", "/status")).body.schemaError, /Qty/);
  stub.source = dataSource();
  await h.admin("POST", "/verify", {});
  assert.equal((await send(key, uuid())).status, 201);
});

test("after a restore (no plugin row, setup still marked done) requests stop until the Admin verifies again", async () => {
  const key = await ready();
  // Core's connection and binding come back with Core's part of the backup; the plugin's checked layout does not.
  h.test.run("DELETE FROM part_requests_notion");
  assert.equal((await send(key, uuid())).body.code, "notion_not_connected");
  assert.equal((await h.admin("GET", "/status")).body.problem, "not_verified");
  assert.equal(await api.setup.stepValid(h.db, "notion-connection"), false);
  assert.equal((await h.admin("POST", "/verify", {})).status, 200);
  assert.equal((await send(key, uuid())).status, 201);
});

test("Core holding deliveries (an Admin's Stop or a restore) stops a request before anything is recorded, and the same ID works later", async () => {
  const key = await ready();
  h.core.state.deliveryPausedUntil = Date.now() + 60_000;
  const id = uuid();
  const held = await send(key, id);
  assert.equal(held.status, 503);
  assert.equal(held.body.code, "delivery_paused");
  assert.equal(held.headers.get("retry-after"), "60");
  assert.equal(row(id), undefined, "nothing recorded");
  assert.equal(pageCalls(), 0);
  // Reads still work while deliveries are held.
  assert.equal((await h.call("GET", "/public/part-requests/options", { key })).status, 200);
  h.core.state.deliveryPausedUntil = null;
  assert.equal((await send(key, id)).status, 201);
});

test("a write Core refuses after the check (deliveries paused in between) is failed, not uncertain, since nothing was sent", async () => {
  const key = await ready();
  const realService = h.core.service;
  // ready() passes, then Core refuses the create itself, as it would if deliveries were paused between the two.
  h.core.service = (cost) => { const service = realService(cost); return { ...service, ready: async () => true }; };
  h.core.state.deliveryPausedUntil = Date.now() + 60_000;
  const id = uuid();
  const result = await send(key, id);
  assert.equal(result.status, 502);
  assert.equal(result.body.state, "failed");
  assert.equal(result.body.code, "notion_not_sent");
  assert.equal(row(id).state, "failed");
  assert.equal(pageCalls(), 0);
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
  assert.deepEqual(await api.jobs["part-requests.recipients"]({ db: h.db, services: h.services(), scheduler: { steps: true } }), { skipped: "not due" });
  assert.equal(stub.calls.length, 0);
  assert.equal(h.state.queries, 1);
  assert.equal((await h.call("POST", "/admin/part-requests/recipients/refresh", { origin: dashboard })).status, 202);
  await h.runJob();
  assert.ok(stub.calls.length >= 4, "an Admin can ask for a refresh");
});

// Core's scheduler limits (apps/api/src/scheduler-budget.ts): one Durable Object slice may spend 40 subrequests, at most
// 30 of them D1 queries and 12 provider requests, with 2 kept for its closing write. The cron fallback's pass has 46 in all,
// shared by every due job. Each Notion request costs Core one provider request and one D1 read; Core reads its connection
// once per invocation; and Core caps an invocation at 8 Notion requests.
const sliceLimits = { total: 38, d1: 30, external: 12 };
const cronPassTotal = 44;

test("the job stays within a scheduler slice's budget, Core's Notion costs included, also on the run that moves a 1.1 token", async () => {
  await h.asVersion11();
  const slices: { d1: number; external: number; notion: number }[] = [];
  for (let run = 0; run < 20; run++) {
    h.state.queries = 0;
    const outcome = await api.jobs["part-requests.recipients"]({ db: h.db, services: h.services(), scheduler: { steps: true } }) as { more?: boolean };
    slices.push({ d1: h.state.queries + h.coreCost.last.d1, external: h.coreCost.last.external, notion: h.coreCost.last.notion });
    if (!outcome.more) break;
  }
  assert.equal(h.core.state.imports[0]?.outcome, "imported");
  for (const slice of slices) assert.ok(slice.d1 <= sliceLimits.d1 && slice.external <= sliceLimits.external && slice.d1 + slice.external <= sliceLimits.total, JSON.stringify(slice));
  // The first slice moves the token (Core checks it and the data source: two requests) and reads the layout.
  assert.deepEqual(slices[0], { d1: 12, external: 3, notion: 3 });
  // Every later slice sends one Notion request at most and stays small.
  for (const slice of slices.slice(1)) assert.ok(slice.notion <= 1 && slice.d1 + slice.external <= 10, JSON.stringify(slice));
});

test("the job under Core's cron fallback stays within the pass and Core's 8 Notion requests, also on the run that moves a 1.1 token", async () => {
  await h.asVersion11();
  const outcomes = [];
  for (let run = 0; run < 20; run++) {
    h.state.queries = 0;
    const outcome = await api.jobs["part-requests.recipients"]({ db: h.db, services: h.services(), scheduler: { steps: false } }) as { more?: boolean };
    outcomes.push(outcome);
    const total = h.state.queries + h.coreCost.last.d1 + h.coreCost.last.external;
    assert.ok(total <= cronPassTotal, `run ${run} used ${total} of the pass`);
    assert.ok(h.coreCost.last.notion <= 8, `run ${run} sent ${h.coreCost.last.notion} Notion requests`);
    if (!outcome.more) break;
  }
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
  assert.deepEqual(await api.jobs["part-requests.recipients"]({ db: h.db, services: h.services(), scheduler: { steps: true } }), { skipped: "not due" });
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
  assert.deepEqual(await api.jobs["part-requests.recipients"]({ db: h.db, services: h.services() }), { skipped: "not connected" });
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

// ---- Moving a 1.1 token into Core

const link = `https://app.notion.com/p/${databaseId.replaceAll("-", "")}`;
const notionRow = () => h.test.rows<any>("SELECT * FROM part_requests_notion")[0];
const movedAudit = () => h.test.rows<{ metadata_json: string; actor_user_id: string | null }>("SELECT metadata_json,actor_user_id FROM audit_log WHERE action='part_requests.token_moved_to_core'");

test("imported: the first request hands the 1.1 token to Core, which keeps the ordering database, and requests carry on untouched", async () => {
  await h.asVersion11();
  const key = await h.pair();
  stub.calls.length = 0;
  const created = await send(key, uuid());
  assert.equal(created.status, 201, created.text);
  assert.deepEqual(h.core.state.imports, [{ outcome: "imported", bindings: ["orders"] }]);
  assert.equal(h.core.state.connection?.token, testToken, "Core holds the same token");
  assert.deepEqual(h.core.state.bindings.get("orders"), { databaseId, dataSourceId, name: "Ordering" });
  // Core checked the token and that the data source belongs to the database, then the request went out.
  assert.deepEqual(stub.calls.map((call) => `${call.method} ${call.url.replace("https://api.notion.com/v1", "")}`), ["GET /users/me", `GET /data_sources/${dataSourceId}`, "POST /pages"]);
  const row = notionRow();
  assert.equal(row.ciphertext, null, "the plugin's copy is cleared at once");
  assert.equal(row.iv, null);
  assert.equal(row.schema_json !== null && row.verified_ms !== null, true, "the checked layout stays, so nothing needs verifying again");
  assert.deepEqual(movedAudit().map((entry) => [JSON.parse(entry.metadata_json).outcome, entry.actor_user_id]), [["imported", null]]);
  stub.calls.length = 0;
  assert.equal((await send(key, uuid())).status, 201);
  assert.equal(h.core.state.imports.length, 1, "only once");
  assert.equal((await h.admin("GET", "/status")).body.problem, null);
});

test("imported: the job, Carts, options and the setup page each move it too, whichever comes first", async () => {
  for (const first of ["job", "orders", "options", "status"] as const) {
    stub.restore(); stub = stubNotion(); h = createHarness(api);
    await h.asVersion11();
    const key = await h.pair();
    if (first === "job") await h.runJob();
    else if (first === "orders") assert.ok((await h.call("GET", "/public/part-requests/orders", { key })).status < 300, first);
    else if (first === "options") assert.equal((await h.call("GET", "/public/part-requests/options", { key })).status, 200, first);
    else assert.equal((await h.admin("GET", "/status")).body.problem, null, first);
    assert.deepEqual(h.core.state.imports.map((entry) => entry.outcome), ["imported"], first);
    assert.equal(notionRow().ciphertext, null, first);
  }
});

test("kept-existing: Core's own connection wins, the 1.1 copy is cleared, and the Admin binds the ordering database once", async () => {
  await h.asVersion11("ntn_TESTtheOLDpluginTOKENstillWORKS0000000000000000");
  await h.core.connect(); // An Admin already saved a token in Core, and chose no database for Part Requests.
  const key = await h.pair();
  stub.calls.length = 0;
  const refused = await send(key, uuid());
  assert.equal(refused.status, 503);
  assert.equal(refused.body.code, "notion_not_connected");
  assert.deepEqual(h.core.state.imports.map((entry) => entry.outcome), ["kept-existing"]);
  assert.equal(h.core.state.connection?.token, testToken, "Core's token is not replaced");
  assert.equal(notionRow().ciphertext, null);
  assert.equal(stub.calls.length, 0, "Core made no Notion request, and nor did the plugin");
  const status = await h.admin("GET", "/status");
  assert.equal(status.body.problem, "orders_unbound");
  assert.equal(status.body.binding, null);
  assert.equal(status.body.databaseId, databaseId, "the page can offer the database 1.1 used");
  assert.equal(status.body.dataSourceId, dataSourceId);
  assert.equal(h.core.state.imports.length, 1, "not tried again");
  // The page's "Use the previous ordering database" asks Core to bind it; Core checks its own token can read it.
  h.core.bind({ databaseId, dataSourceId, name: "Ordering" });
  assert.equal((await send(key, uuid())).status, 201, "the same data source needs no new check");
});

test("kept-existing: when Core already has the same database bound, nothing at all changes for students", async () => {
  await h.asVersion11();
  await h.core.connect();
  h.core.bind({ databaseId, dataSourceId, name: "Ordering" });
  const key = await h.pair();
  assert.equal((await send(key, uuid())).status, 201);
  assert.deepEqual(h.core.state.imports.map((entry) => entry.outcome), ["kept-existing"]);
  assert.equal(notionRow().ciphertext, null);
});

test("unreadable: a copy nobody can decrypt, or a token Notion refuses, is cleared, and the Admin saves a token in Core", async () => {
  await h.asVersion11();
  h.test.run("UPDATE part_requests_notion SET ciphertext='AAAA',iv='BBBB'");
  const key = await h.pair();
  assert.equal((await send(key, uuid())).body.code, "notion_not_connected");
  assert.deepEqual(h.core.state.imports.map((entry) => entry.outcome), ["unreadable"]);
  assert.equal(notionRow().ciphertext, null);
  const status = await h.admin("GET", "/status");
  assert.equal(status.body.problem, "notion_not_configured");
  assert.match(connectionProblem(status.body)!, /Settings > Integrations > Notion/);

  stub.restore(); stub = stubNotion(); h = createHarness(api);
  await h.asVersion11("ntn_TESTaTOKENnotionNOlongerACCEPTS000000000000000");
  stub.calls.length = 0;
  assert.equal((await h.admin("GET", "/status")).body.problem, "notion_not_configured");
  assert.deepEqual(h.core.state.imports.map((entry) => entry.outcome), ["unreadable"]);
  assert.deepEqual(stub.calls.map((call) => call.url), ["https://api.notion.com/v1/users/me"], "Core checked it once and kept nothing");
  assert.equal(h.core.state.connection, null);
  assert.equal(notionRow().ciphertext, null);
});

test("imported without the database: a data source Notion does not confirm is left for the Admin to choose", async () => {
  await h.asVersion11();
  stub.on(/^GET \/data_sources\//, () => notionResponse({ object: "error", status: 404 }, 404));
  assert.equal((await h.admin("GET", "/status")).body.problem, "orders_unbound");
  assert.deepEqual(h.core.state.imports, [{ outcome: "imported", bindings: [] }]);
  assert.equal(h.core.state.connection?.token, testToken);
  assert.equal(notionRow().ciphertext, null);
});

test("no 1.1 token: nothing is imported on any path", async () => {
  const key = await ready();
  await send(key, uuid());
  await h.call("GET", "/public/part-requests/orders", { key });
  await h.call("GET", "/public/part-requests/options", { key });
  await h.admin("GET", "/status");
  await h.runJob();
  assert.deepEqual(h.core.state.imports, []);
  assert.equal(movedAudit().length, 0);
});

test("a failed import keeps the copy and tries again next time; without encryption it waits and says so", async () => {
  await h.asVersion11();
  h.core.state.importFails = true;
  const key = await h.pair();
  assert.equal((await send(key, uuid())).body.code, "notion_not_connected");
  assert.notEqual(notionRow().ciphertext, null, "kept, since nothing changed in Core");
  h.core.state.importFails = false;
  assert.equal((await send(key, uuid())).status, 201);
  assert.equal(notionRow().ciphertext, null);

  stub.restore(); stub = stubNotion(); h = createHarness(api);
  await h.asVersion11();
  const locked = createHarness(api, { credentials: testCredentials(false) });
  // The same database, read with encryption unavailable: nothing is attempted, and the page says the copy is waiting.
  locked.test.run("DELETE FROM part_requests_notion");
  const row = notionRow();
  locked.test.run("INSERT INTO part_requests_notion(installation_id,ciphertext,iv,address_salt,database_id,data_source_id,schema_json,verified_ms,updated_ms) VALUES ('primary',?,?,?,?,?,?,?,?)", row.ciphertext, row.iv, row.address_salt, row.database_id, row.data_source_id, row.schema_json, row.verified_ms, row.updated_ms);
  const waiting = await locked.admin("GET", "/status");
  assert.equal(waiting.body.legacyTokenSaved, true);
  assert.equal(waiting.body.problem, "notion_not_configured");
  assert.deepEqual(locked.core.state.imports, []);
});

test("two requests moving the token at once: Core keeps one, and one audit entry is written", async () => {
  await h.asVersion11();
  const key = await h.pair();
  const results = await Promise.all([send(key, uuid()), send(key, uuid())]);
  assert.deepEqual(h.core.state.imports.map((entry) => entry.outcome).sort(), ["imported", "kept-existing"]);
  assert.equal(movedAudit().length, 1);
  assert.equal(notionRow().ciphertext, null);
  assert.ok(results.some((result) => result.status === 201));
});

test("verify: the Admin page's check saves the layout of Core's bound database, and asks Core again only for that read", async () => {
  await h.core.connect();
  h.core.bind({ databaseId, dataSourceId: otherDataSourceId, name: "Archive" });
  const done = await h.admin("POST", "/verify", {});
  assert.equal(done.status, 200, done.text);
  assert.equal(done.body.dataSourceName, "Archive");
  assert.equal(done.body.dataSourceId, otherDataSourceId);
  assert.equal(done.body.databaseId, databaseId);
  assert.equal(notionRow().ciphertext, null);
  const actions = h.test.rows<{ action: string }>("SELECT action FROM audit_log").map((row) => row.action);
  assert.deepEqual(actions, ["part_requests.connection_verified"]);
});

test("verify: a failed check saves nothing, so nothing has to be undone", async () => {
  await h.core.connect();
  h.core.bind({ databaseId, dataSourceId, name: "Ordering" });
  stub.on(/^GET \/data_sources\//, () => notionResponse({ code: "object_not_found" }, 404));
  const unshared = await h.admin("POST", "/verify", {});
  assert.equal(unshared.status, 422);
  assert.equal(unshared.body.code, "notion_404");
  assert.match(unshared.body.error, /Add Core's Notion connection to the database/);
  assert.equal(notionRow(), undefined);
  assert.equal(h.test.rows("SELECT * FROM part_requests_settings").length, 0);
  assert.equal(h.test.rows("SELECT * FROM audit_log").length, 0);
});

test("status: Core's state, the binding and the last verified database are reported, never a token", async () => {
  await h.connect();
  const status = await h.admin("GET", "/status");
  assert.deepEqual(status.body.core, { saved: true, enabled: true, readable: true, connected: true, pausedUntilMs: null, capabilities: { read: "ok", insert: "unknown", update: "unknown", comment: "unknown", users: "unknown", email: "unknown" } });
  assert.deepEqual(status.body.binding, { databaseId, dataSourceId, name: "Ordering" });
  assert.equal(status.body.legacyTokenSaved, false);
  assert.ok(!("tokenSaved" in status.body) && !("canSaveToken" in status.body));
  assert.ok(!status.text.includes(testToken));
  h.core.state.connection = null;
  const removed = await h.admin("GET", "/status");
  assert.equal(removed.body.problem, "notion_not_configured");
  assert.equal(removed.body.databaseId, databaseId, "the database and its name stay for when Core is connected again");
  assert.equal(removed.body.dataSourceName, "Ordering");
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

test("insert content: verifying the same database keeps it; a request that goes through or verifying another database clears it", async () => {
  const key = await ready();
  insertRefused();
  await send(key, uuid());
  assert.equal((await h.admin("POST", "/verify", {})).body.problem, "notion_insert_refused", "verify only reads, so it cannot prove inserting works");
  healthyNotion();
  assert.equal((await send(key, uuid())).status, 201);
  assert.equal((await statusOf()).problem, null);
  insertRefused();
  await send(key, uuid());
  healthyNotion();
  h.core.bind({ databaseId, dataSourceId: otherDataSourceId, name: "Archive" });
  assert.equal((await h.admin("POST", "/verify", {})).body.problem, null, "another database may allow it");
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

test("refused: a successful verify clears it, and Core's connection going away is reported ahead of it", async () => {
  const key = await ready();
  notionAnswers(/^POST \/pages$/, 401);
  await send(key, uuid());
  healthyNotion();
  const verified = await h.admin("POST", "/verify", {});
  assert.equal(verified.body.problem, null);
  assert.equal(verified.body.rejectedMs, null);
  notionAnswers(/^POST \/pages$/, 401);
  await send(key, uuid());
  h.core.state.connection = null;
  assert.equal((await statusOf()).problem, "notion_not_configured");
});

test("refused: a failed verify changes nothing, and a problem that stops requests is reported ahead of it", async () => {
  const key = await ready();
  notionAnswers(/^POST \/pages$/, 401);
  await send(key, uuid());
  notionAnswers(/^GET \/data_sources\//, 401);
  assert.equal((await h.admin("POST", "/verify", {})).status, 422);
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

test("refused: a slow call made before the Admin verified another database cannot mark the new one", async () => {
  await ready();
  const { readConnection, recordRefusal } = await import("../src/connection.ts");
  const old = (await readConnection(h.db))!;
  h.core.bind({ databaseId, dataSourceId: otherDataSourceId, name: "Archive" });
  assert.equal((await h.admin("POST", "/verify", {})).status, 200);
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

test("query counts: the routes stay small enough for Workers Free", async () => {
  await h.connect();
  await h.runJob();
  const key = await h.pair();
  const id = uuid();
  const measure = async (work: () => Promise<{ status: number }>, status: number) => { h.state.queries = 0; assert.equal((await work()).status, status); return h.state.queries; };
  assert.equal(await measure(() => send(key, id, goodDraft({ recipient: guestPerson })), 201), 3, "create: reads, record, result");
  assert.equal(h.coreCost.last.notion, 1, "create: one Notion request through Core");
  assert.ok(h.coreCost.last.d1 <= 2, `create: Core read ${h.coreCost.last.d1} times`);
  assert.equal(await measure(() => send(key, id, goodDraft({ recipient: guestPerson })), 200), 1, "repeat: reads only");
  assert.equal(await measure(() => send(key, uuid(), goodDraft({ team: "team-unknown" })), 400), 1, "refused: reads only");
  assert.equal(await measure(() => h.call("GET", "/public/part-requests/options", { key }), 200), 2);
  assert.deepEqual([h.coreCost.last.notion, h.coreCost.last.d1], [0, 1], "options: Core reads its connection once and calls nothing");
  assert.equal(await measure(() => h.call("POST", "/public/part-requests/check", { key, body: { url: goodDraft().url } }), 200), 3);
});
