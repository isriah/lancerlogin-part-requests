// Generate pairing PIN from the Admin page: POST /admin/part-requests/pins. It shares issuePinForMember with /ordering-pin,
// so these tests also hold the Discord path to exactly what it did before the two were joined.
import test, { afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { createHarness, dashboard, discordA, type Harness } from "./helpers/harness.ts";
import { stubNotion, type Stub } from "./helpers/notion-stub.ts";
import { authenticateDevice, deviceLimitMessage, exchangePin, issuePin, maximumDevicesPerMember, normalizePin, notActiveMessage, notLinkedMessage, pinLifetimeMs, sha256Hex } from "../src/pairing.ts";

const sdk = new URL("./helpers/module-sdk-stub.ts", import.meta.url).href;
registerHooks({ resolve: (specifier, context, next) => specifier === "@lancerlogin/module-sdk/api" ? { url: sdk, shortCircuit: true } : next(specifier, context) });
const { default: api } = await import("../src/api.ts") as { default: any };
const { adminPinRefusals, maximumAdminPins } = await import("../src/admin.ts");

let stub: Stub;
let h: Harness;
beforeEach(async () => {
  stub = stubNotion(); h = createHarness(api);
  await h.connect();
  // A member with no Discord account, the case this route is for.
  h.test.run("INSERT INTO members(id,installation_id,external_id,first_name,last_name,email,discord_user_id) VALUES ('m-c','primary','9003','Test Student','C','student.c@example.test',NULL)");
});
afterEach(() => { stub.restore(); });

const issue = (memberId: unknown, init: { role?: "admin" | "operator" | null; origin?: string } = {}) =>
  h.call("POST", "/admin/part-requests/pins", { body: { memberId }, origin: dashboard, ...init });
const audits = () => h.test.rows<any>("SELECT * FROM audit_log WHERE action='part_requests.pin_issued'");
const pins = () => h.test.rows<any>("SELECT * FROM part_requests_pairing_pins");
const fill = async (memberId: string) => {
  for (let index = 0; index < maximumDevicesPerMember; index++) {
    const { body } = await issue(memberId);
    assert.equal((await exchangePin(h.db, body.pin, Date.now(), { label: `Test laptop ${index + 1}` })).status, 201);
  }
};

test("an Admin gets a PIN for a member without Discord, with its expiry and the site address /ordering-pin sends", async () => {
  const before = Date.now();
  const result = await issue("m-c");
  assert.equal(result.status, 201);
  assert.deepEqual(Object.keys(result.body).sort(), ["expiresMs", "memberId", "memberName", "pairedDevices", "pin", "siteAddress"]);
  assert.match(result.body.pin, /^[2-9A-HJKMNP-Z]{4}-[2-9A-HJKMNP-Z]{4}$/);
  assert.equal(result.body.memberId, "m-c");
  assert.equal(result.body.memberName, "Test Student C");
  assert.equal(result.body.siteAddress, dashboard);
  assert.equal(result.body.pairedDevices, 0);
  assert.ok(result.body.expiresMs >= before + pinLifetimeMs && result.body.expiresMs <= Date.now() + pinLifetimeMs);
  assert.equal(result.headers.get("cache-control"), "no-store");
  // The same address the command sends.
  assert.match(await issuePin(h.db, discordA, Date.now()), new RegExp(`Site address: ${dashboard.replace(/\./g, "\\.")}\n`));
});

test("only the PIN's hash is stored, with the same 10-minute life as the command's", async () => {
  const { body } = await issue("m-c");
  const rows = pins();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].member_id, "m-c");
  assert.equal(rows[0].pin_hash, await sha256Hex(normalizePin(body.pin)!));
  assert.equal(rows[0].expires_ms - rows[0].created_ms, pinLifetimeMs);
  assert.equal(rows[0].expires_ms, body.expiresMs);
  const everything = JSON.stringify(h.test.rows("SELECT * FROM part_requests_pairing_pins")) + JSON.stringify(h.test.rows("SELECT * FROM audit_log"));
  assert.ok(!everything.includes(normalizePin(body.pin)!) && !everything.includes(body.pin));
});

test("the PIN works once with the extension's exchange, and the device belongs to that member", async () => {
  const { body } = await issue("m-c");
  const first = await exchangePin(h.db, body.pin, Date.now(), { label: "Test Chromebook" });
  assert.equal(first.status, 201);
  assert.equal((first as { memberName: string }).memberName, "Test Student C");
  const device = await authenticateDevice(h.db, `Bearer ${(first as { deviceKey: string }).deviceKey}`);
  assert.equal(device?.memberId, "m-c");
  assert.equal(device?.deviceLabel, "Test Chromebook");
  assert.equal((await exchangePin(h.db, body.pin, Date.now())).status, 401, "a second use is refused");
  assert.equal(h.test.rows("SELECT * FROM part_requests_devices WHERE member_id='m-c'").length, 1);
});

test("the PIN expires after 10 minutes", async () => {
  const { body } = await issue("m-c");
  assert.equal((await exchangePin(h.db, body.pin, body.expiresMs)).status, 401, "at the expiry it no longer works");
  const again = await issue("m-c");
  assert.equal((await exchangePin(h.db, again.body.pin, again.body.expiresMs - 1)).status, 201, "just before it, it does");
});

test("a new PIN cancels the member's earlier unused one, from either path, and leaves other members' PINs alone", async () => {
  const fromAdmin = (await issue("m-a")).body.pin;
  const other = (await issue("m-b")).body.pin;
  const fromDiscord = /\*\*([A-Z0-9-]{9})\*\*/.exec(await issuePin(h.db, discordA, Date.now()))![1]!;
  assert.equal((await exchangePin(h.db, fromAdmin, Date.now())).status, 401, "the command cancelled the Admin's PIN");
  const latest = (await issue("m-a")).body.pin;
  assert.equal((await exchangePin(h.db, fromDiscord, Date.now())).status, 401, "the Admin's PIN cancelled the command's");
  assert.equal((await exchangePin(h.db, latest, Date.now())).status, 201);
  assert.equal((await exchangePin(h.db, other, Date.now())).status, 201);
});

test("the device limit applies: at the limit the Admin is told to remove a device first, and nothing is stored or audited", async () => {
  await fill("m-c");
  const pinsBefore = pins().length; const auditsBefore = audits().length;
  const result = await issue("m-c");
  assert.equal(result.status, 409);
  assert.deepEqual(result.body, { code: "device_limit", error: `That member already has ${maximumDevicesPerMember} paired devices, the most allowed. Remove one of their devices first, then generate a PIN.` });
  assert.equal(pins().length, pinsBefore);
  assert.equal(audits().length, auditsBefore);
  const device = h.test.rows<{ id: string }>("SELECT id FROM part_requests_devices WHERE member_id='m-c' LIMIT 1")[0]!;
  assert.equal((await h.call("POST", "/admin/part-requests/devices/revoke", { body: { deviceId: device.id }, origin: dashboard })).status, 200);
  const freed = await issue("m-c");
  assert.equal(freed.status, 201, "removing a device frees a slot");
  assert.equal(freed.body.pairedDevices, maximumDevicesPerMember - 1);
});

test("an unknown member, a member off the roster and a bad body are refused with clear messages", async () => {
  assert.deepEqual(await issue("m-nobody").then((r) => [r.status, r.body]), [404, { code: "unknown_member", error: "That member is not on the roster. Choose someone else." }]);
  h.test.run("UPDATE members SET active=0 WHERE id='m-c'");
  assert.deepEqual(await issue("m-c").then((r) => [r.status, r.body]), [409, { code: "not_active", error: "That member is not on the active roster, so they cannot pair a device." }]);
  for (const bad of [undefined, "", 42, null, "x".repeat(65)]) assert.deepEqual(await issue(bad).then((r) => [r.status, r.body]), [400, { code: "validation", error: "Choose a member." }], String(bad));
  assert.equal(pins().length, 0);
  assert.equal(audits().length, 0);
});

test("before setup has saved the site address, the Admin is told to finish setup, as the command is", async () => {
  h.test.run("DELETE FROM part_requests_settings");
  assert.deepEqual(await issue("m-c").then((r) => [r.status, r.body]), [409, { code: "not_set_up", error: "Part Requests is not set up yet. Finish the Notion connection first." }]);
  assert.equal(await issuePin(h.db, discordA, Date.now()), "Part Requests is not set up yet. Ask an Admin to finish its setup.");
});

test("only an Admin from the dashboard can generate a PIN", async () => {
  assert.equal((await issue("m-c", { role: "operator" })).status, 403, "an Operator");
  assert.equal((await issue("m-c", { role: null })).status, 401, "signed out");
  assert.equal((await h.call("POST", "/admin/part-requests/pins", { body: { memberId: "m-c" } })).status, 403, "no origin");
  assert.equal((await issue("m-c", { origin: "https://evil.example.test" })).status, 403, "another origin");
  assert.equal((await h.call("GET", "/admin/part-requests/pins", { origin: dashboard })).status, 404, "GET is not a route");
  assert.equal(pins().length, 0);
  assert.equal(audits().length, 0);
});

test("each PIN writes one audit row: the Admin, the member and the time, and never the PIN", async () => {
  const before = Date.now();
  const { body } = await issue("m-c");
  const rows = audits();
  assert.equal(rows.length, 1);
  const row = rows[0];
  assert.equal(row.actor_user_id, "u-admin");
  assert.equal(row.installation_id, "primary");
  assert.equal(row.target_type, "member");
  assert.equal(row.target_id, "m-c");
  assert.equal(row.metadata_json, null);
  assert.ok(Date.parse(row.created_at) >= before - 1 && Date.parse(row.created_at) <= Date.now());
  assert.ok(!JSON.stringify(rows).includes(body.pin) && !JSON.stringify(rows).includes(normalizePin(body.pin)!));
  assert.ok(!JSON.stringify(rows).includes(await sha256Hex(normalizePin(body.pin)!)), "not even its hash");
});

test("generating PINs is rate limited per Admin, with Retry-After, and the limit leaves devices' counters alone", async () => {
  for (let index = 0; index < maximumAdminPins; index++) assert.equal((await issue(index % 2 ? "m-c" : "m-b")).status, 201, `PIN ${index + 1}`);
  const limited = await issue("m-c");
  assert.equal(limited.status, 429);
  assert.deepEqual({ code: limited.body.code, error: limited.body.error }, { code: "rate_limited", error: adminPinRefusals.rate_limited[1] });
  assert.ok(Number(limited.headers.get("retry-after")) > 0);
  assert.equal(audits().length, maximumAdminPins);
  const counters = h.test.rows<any>("SELECT device_id,bucket FROM part_requests_device_limits");
  assert.deepEqual(counters.map((row) => ({ ...row })), [{ device_id: "admin-pins:u-admin", bucket: "general" }]);
  // The command is not counted against the Admin.
  assert.match(await issuePin(h.db, discordA, Date.now()), /\*\*[A-Z0-9]{4}-[A-Z0-9]{4}\*\*/);
});

test("query counts: a PIN is a count, one read batch and one write batch", async () => {
  const before = h.state.queries;
  assert.equal((await issue("m-c")).status, 201);
  assert.equal(h.state.queries - before, 3);
});

// ---- /ordering-pin, unchanged

const command = (discordId: string | undefined, now = Date.now()) => api.discord["ordering-pin"](h.db, { id: "200000000000000001", type: 2, data: { name: "ordering-pin" }, member: { user: { id: discordId } } }, now);
const zeros = (bytes: Uint8Array) => bytes.fill(0);

test("/ordering-pin replies word for word as before, and costs the same three queries", async () => {
  const before = h.state.queries;
  assert.equal(await issuePin(h.db, discordA, Date.now(), zeros), [
    "Your Part Requests PIN is **2222-2222**. It works once and expires in 10 minutes.",
    `Site address: ${dashboard}`,
    "Enter both in the browser extension. Any earlier unused PIN no longer works.",
  ].join("\n"));
  assert.equal(h.state.queries - before, 3);
  assert.equal((await exchangePin(h.db, "2222-2222", Date.now())).status, 201);
  assert.equal(await issuePin(h.db, discordA, Date.now(), (bytes) => bytes.fill(1)), [
    "Your Part Requests PIN is **3333-3333**. It works once and expires in 10 minutes.",
    `Site address: ${dashboard}`,
    "Enter both in the browser extension. Any earlier unused PIN no longer works.",
    `You have 1 of ${maximumDevicesPerMember} devices paired, and they stay paired.`,
  ].join("\n"));
  assert.equal(audits().length, 0, "the command writes no audit row, as before");
});

test("/ordering-pin keeps every refusal it had", async () => {
  assert.equal(await command(undefined), notLinkedMessage);
  assert.equal(await command("999999999999999999"), notLinkedMessage);
  h.test.run("UPDATE members SET discord_user_id=? WHERE id='m-c'", discordA);
  assert.equal(await command(discordA), "Your Discord account is linked to more than one roster member. Ask an Operator to fix your roster link.");
  h.test.run("UPDATE members SET discord_user_id=NULL WHERE id='m-c'");
  h.test.run("UPDATE members SET active=0 WHERE id='m-a'");
  assert.equal(await command(discordA), notActiveMessage);
  h.test.run("UPDATE members SET active=1 WHERE id='m-a'");
  await fill("m-a");
  assert.equal(await command(discordA), deviceLimitMessage);
  assert.equal(audits().length, maximumDevicesPerMember, "only the Admin's PINs were audited");
});
