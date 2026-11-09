// Pairing rules against the real migrations on an in-memory SQLite, and the command handler called directly, as Core calls
// it: `(db, interaction, now)`. Core's signature check, guild check and private reply are covered by the spike's browser run.
import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { createTestDatabase, type TestDatabase } from "./helpers/d1.ts";
import {
  authenticateDevice, bearerDeviceKey, deviceLimitMessage, exchangePin, formatPin, generateDeviceKey, generatePin, maximumDevicesPerMember, maximumWrongPins, normalizePin, notActiveMessage, notLinkedMessage,
  pairingPauseMs, pinAlphabet, pinLifetimeMs, sha256Hex, wrongPinWindowMs, type Database,
} from "../src/pairing.ts";

const stub = new URL("./helpers/module-sdk-stub.ts", import.meta.url).href;
registerHooks({ resolve: (specifier, context, next) => specifier === "@lancerlogin/module-sdk/api" ? { url: stub, shortCircuit: true } : next(specifier, context) });
const { default: api } = await import("../src/api.ts") as { default: { discord: Record<string, (db: unknown, interaction: unknown, now: number) => Promise<string>>; routes: Record<string, (context: unknown) => Promise<Response | undefined>>; setup: { stepValid(db: unknown, step: string): Promise<boolean>; predicates: Record<string, (installation: string) => { sql: string; bindings: unknown[] }> } } };

const discordA = "100000000000000001";
const discordB = "100000000000000002";
const start = Date.UTC(2026, 10, 8, 12);

function setup(): { db: TestDatabase; d1: Database } {
  const db = createTestDatabase();
  db.run("INSERT INTO members(id,installation_id,external_id,first_name,last_name,email,discord_user_id) VALUES ('m-a','primary','9001','Test Student','A','student.a@example.test',?)", discordA);
  db.run("INSERT INTO members(id,installation_id,external_id,first_name,last_name,email,discord_user_id) VALUES ('m-b','primary','9002','Test Student','B','student.b@example.test',?)", discordB);
  db.run("INSERT INTO members(id,installation_id,external_id,first_name,last_name,email,discord_user_id) VALUES ('m-c','primary','9003','Test Student','C','student.c@example.test',NULL)");
  db.run("INSERT INTO part_requests_settings(installation_id,site_address,updated_ms) VALUES ('primary','https://site.example.test',?)", start);
  db.run("INSERT INTO part_requests_notion(installation_id,ciphertext,iv,address_salt,schema_json,verified_ms,updated_ms) VALUES ('primary','c','i',?,'{}',?,?)", "0".repeat(64), start, start);
  return { db, d1: db as unknown as Database };
}
const command = (d1: Database, discordId: string | undefined, now = start, viaUser = false) =>
  api.discord["ordering-pin"]!(d1, { id: "200000000000000001", type: 2, data: { name: "ordering-pin" }, ...(viaUser ? { user: { id: discordId } } : { member: { user: { id: discordId } } }) }, now);
const pinIn = (reply: string) => { const match = /\*\*([A-Z0-9]{4}-[A-Z0-9]{4})\*\*/.exec(reply); assert.ok(match, reply); return match[1]!; };
async function pair(d1: Database, discordId = discordA, now = start) {
  const result = await exchangePin(d1, pinIn(await command(d1, discordId, now)), now + 1);
  assert.equal(result.status, 201);
  return (result as { deviceKey: string }).deviceKey;
}
const works = async (d1: Database, key: string) => Boolean(await authenticateDevice(d1, `Bearer ${key}`));

test("PINs look like K7M2-9QXP, use only unambiguous characters, and normalize what people type", () => {
  for (let index = 0; index < 200; index++) {
    const pin = generatePin();
    assert.match(pin, new RegExp(`^[${pinAlphabet}]{8}$`));
    assert.doesNotMatch(pin, /[01OIL]/);
  }
  assert.equal(formatPin("K7M29QXP"), "K7M2-9QXP");
  assert.equal(normalizePin(" k7m2-9qxp "), "K7M29QXP");
  for (const bad of ["K7M2-9QX", "K7M2-9QXPP", "O0O0-O0O0", "", 12345678, null, "K".repeat(40)]) assert.equal(normalizePin(bad), undefined, String(bad));
});

test("only a well-formed bearer header carries a key", () => {
  const key = generateDeviceKey();
  assert.match(key, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(bearerDeviceKey(`Bearer ${key}`), key);
  for (const header of [null, "", key, `bearer ${key}`, `Bearer ${key}x`, `Basic ${key}`]) assert.equal(bearerDeviceKey(header), undefined, String(header));
});

test("the command replies with the site address and a PIN, and stores only hashes", async () => {
  const { db, d1 } = setup();
  const reply = await command(d1, discordA);
  const pin = pinIn(reply);
  assert.match(reply, /https:\/\/site\.example\.test/);
  assert.match(reply, /10 minutes/);
  const rows = db.rows<{ pin_hash: string; member_id: string; expires_ms: number }>("SELECT * FROM part_requests_pairing_pins");
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.member_id, "m-a");
  assert.equal(rows[0]!.pin_hash, await sha256Hex(pin.replace("-", "")));
  assert.equal(rows[0]!.expires_ms, start + pinLifetimeMs);
  const key = (await exchangePin(d1, pin, start + 1) as { deviceKey: string }).deviceKey;
  const devices = db.rows<{ key_hash: string }>("SELECT key_hash FROM part_requests_devices");
  assert.equal(devices[0]!.key_hash, await sha256Hex(key));
  assert.ok(!JSON.stringify(db.rows("SELECT * FROM part_requests_pairing_pins")).includes(pin.replace("-", "")));
  assert.ok(!JSON.stringify(devices).includes(key));
});

test("the command also reads the sender from interaction.user", async () => {
  const { d1 } = setup();
  pinIn(await command(d1, discordA, start, true));
});

test("no linked Discord, a malformed ID and an inactive member each get a clear message and no PIN", async () => {
  const { db, d1 } = setup();
  assert.equal(await command(d1, "999999999999999999"), notLinkedMessage);
  assert.equal(await command(d1, undefined), notLinkedMessage);
  assert.equal(await command(d1, "not-a-snowflake"), notLinkedMessage);
  db.run("UPDATE members SET active=0 WHERE id='m-a'");
  assert.equal(await command(d1, discordA), notActiveMessage);
  assert.equal(db.rows("SELECT * FROM part_requests_pairing_pins").length, 0);
});

test("two PINs paired in turn give two working device keys, and a re-run leaves paired devices working", async () => {
  const { d1 } = setup();
  const first = await pair(d1);
  const second = await pair(d1, discordA, start + 1000);
  assert.notEqual(first, second);
  assert.ok(await works(d1, first));
  assert.ok(await works(d1, second));
  const reply = await command(d1, discordA, start + 2000);
  pinIn(reply);
  assert.match(reply, /2 of 5 devices paired/);
  assert.ok(await works(d1, first));
  assert.ok(await works(d1, second));
  assert.equal((await authenticateDevice(d1, `Bearer ${first}`))!.pairedDevices, 2);
  assert.equal((await authenticateDevice(d1, `Bearer ${first}`))!.memberName, "Test Student A");
});

test("running the command again cancels the earlier unused PIN", async () => {
  const { d1 } = setup();
  const earlier = pinIn(await command(d1, discordA, start));
  const later = pinIn(await command(d1, discordA, start + 1000));
  assert.equal((await exchangePin(d1, earlier, start + 2000)).status, 401);
  assert.equal((await exchangePin(d1, later, start + 2000)).status, 201);
});

test("a re-run for one member leaves another member's PIN alone", async () => {
  const { d1 } = setup();
  const pinB = pinIn(await command(d1, discordB, start));
  await command(d1, discordA, start + 1);
  assert.equal((await exchangePin(d1, pinB, start + 2)).status, 201);
});

test("a used PIN and an expired PIN are refused with the same message as an unknown one", async () => {
  const { d1 } = setup();
  const used = pinIn(await command(d1, discordA, start));
  assert.equal((await exchangePin(d1, used, start + 1)).status, 201);
  const refusal = await exchangePin(d1, used, start + 2);
  assert.equal(refusal.status, 401);
  const expired = pinIn(await command(d1, discordB, start));
  const late = await exchangePin(d1, expired, start + pinLifetimeMs);
  assert.equal(late.status, 401);
  assert.equal((await exchangePin(d1, expired, start + pinLifetimeMs - 1)).status, 201);
  const unknown = await exchangePin(d1, "2222-2222", start + 3);
  assert.deepEqual(unknown, refusal);
  assert.deepEqual(late, refusal);
});

test("at the limit of five devices the command says to ask an Admin and creates no PIN", async () => {
  const { db, d1 } = setup();
  assert.equal(maximumDevicesPerMember, 5);
  const keys: string[] = [];
  for (let index = 0; index < 5; index++) keys.push(await pair(d1, discordA, start + index * 1000));
  const before = db.rows("SELECT * FROM part_requests_pairing_pins").length;
  const reply = await command(d1, discordA, start + 10_000);
  assert.equal(reply, deviceLimitMessage);
  assert.match(reply, /ask an Admin to remove a device/i);
  assert.equal(db.rows("SELECT * FROM part_requests_pairing_pins").length, before);
  for (const key of keys) assert.ok(await works(d1, key));
  // A device removed by an Admin frees a place. There is no Admin route yet, so this sets the column the page will set.
  db.run("UPDATE part_requests_devices SET revoked_ms=? WHERE key_hash=?", start, await sha256Hex(keys[0]!));
  assert.equal(await works(d1, keys[0]!), false);
  pinIn(await command(d1, discordA, start + 20_000));
});

test("the exchange itself enforces the limit, without using the PIN", async () => {
  const { db, d1 } = setup();
  const pin = pinIn(await command(d1, discordA, start));
  for (let index = 0; index < 5; index++) db.run("INSERT INTO part_requests_devices(installation_id,id,key_hash,member_id,created_ms) VALUES ('primary',?,?,'m-a',?)", `d${index}`, await sha256Hex(`k${index}`), start);
  const result = await exchangePin(d1, pin, start + 1);
  assert.equal(result.status, 409);
  assert.equal((result as { code: string }).code, "device_limit");
  assert.equal(db.rows("SELECT * FROM part_requests_devices").length, 5);
  assert.equal(db.rows<{ failures: number }>("SELECT failures FROM part_requests_pairing_limits").length, 0);
});

test("leaving the active roster ends every device and refuses an unused PIN", async () => {
  const { db, d1 } = setup();
  const first = await pair(d1);
  const second = await pair(d1, discordA, start + 1000);
  const other = await pair(d1, discordB);
  const unused = pinIn(await command(d1, discordA, start + 2000));
  db.run("UPDATE members SET active=0 WHERE id='m-a'");
  assert.equal(await works(d1, first), false);
  assert.equal(await works(d1, second), false);
  assert.ok(await works(d1, other));
  assert.equal((await exchangePin(d1, unused, start + 3000)).status, 401);
});

test("deleting a member removes their devices and PINs", async () => {
  const { db, d1 } = setup();
  await pair(d1);
  await command(d1, discordA, start + 1);
  db.run("DELETE FROM members WHERE id='m-a'");
  assert.equal(db.rows("SELECT * FROM part_requests_devices").length, 0);
  assert.equal(db.rows("SELECT * FROM part_requests_pairing_pins").length, 0);
});

test("repeated wrong PINs reach the shared backstop and pause pairing, even for a correct PIN, without affecting paired devices", async () => {
  const { d1 } = setup();
  const key = await pair(d1);
  const good = pinIn(await command(d1, discordB, start));
  for (let index = 1; index < maximumWrongPins; index++) assert.equal((await exchangePin(d1, "2222-2222", start + index)).status, 401, `attempt ${index}`);
  const paused = await exchangePin(d1, "2222-2222", start + maximumWrongPins);
  assert.equal(paused.status, 429);
  assert.equal((paused as { retryAfterSeconds: number }).retryAfterSeconds, pairingPauseMs / 1000);
  assert.equal((await exchangePin(d1, good, start + maximumWrongPins + 1)).status, 429);
  assert.ok(await works(d1, key));
  // Pairing works again once the pause has ended.
  const resumed = await exchangePin(d1, pinIn(await command(d1, discordB, start + pairingPauseMs)), start + maximumWrongPins + pairingPauseMs);
  assert.equal(resumed.status, 201);
});

test("wrong PINs spread beyond the window do not pause pairing, and typing mistakes do not count", async () => {
  const { db, d1 } = setup();
  for (let index = 0; index < maximumWrongPins * 2; index++) assert.equal((await exchangePin(d1, "2222-2222", start + index * (wrongPinWindowMs / 100))).status, 401, `attempt ${index}`);
  const failures = db.rows<{ failures: number }>("SELECT failures FROM part_requests_pairing_limits")[0]!.failures;
  for (let index = 0; index < maximumWrongPins * 2; index++) assert.equal((await exchangePin(d1, "short", start + maximumWrongPins * 3 * (wrongPinWindowMs / 100))).status, 400);
  assert.equal(db.rows<{ failures: number }>("SELECT failures FROM part_requests_pairing_limits")[0]!.failures, failures);
});

test("a bad key, a missing key and a revoked device are refused", async () => {
  const { db, d1 } = setup();
  const key = await pair(d1);
  assert.equal(await authenticateDevice(d1, null), null);
  assert.equal(await authenticateDevice(d1, `Bearer ${generateDeviceKey()}`), null);
  db.run("UPDATE part_requests_devices SET revoked_ms=?", start);
  assert.equal(await works(d1, key), false);
});

test("the routes answer as declared, and setup depends on the site address and a verified connection", async () => {
  const { db, d1 } = setup();
  const route = api.routes["/public/part-requests"]!;
  const respond = (body: unknown, status = 200) => Response.json(body, { status });
  const call = (path: string, init: RequestInit, body?: unknown) => { const request = new Request(`http://worker.test${path}`, init); return route({ request, url: new URL(request.url), db: d1, respond, json: async () => body, services: { credentials: { available: false } } }); };
  assert.equal(await call("/public/part-requests/other", { method: "POST" }), undefined);
  assert.equal(await call("/public/part-requests/pair", { method: "GET" }), undefined);
  const pin = pinIn(await command(d1, discordA, Date.now()));
  const paired = await call("/public/part-requests/pair", { method: "POST" }, { pin });
  assert.equal(paired!.status, 201);
  assert.equal(paired!.headers.get("cache-control"), "no-store");
  const { deviceKey, memberName } = await paired!.json() as { deviceKey: string; memberName: string };
  assert.equal(memberName, "Test Student A");
  const refused = await call("/public/part-requests/ping", { method: "POST" }, { echo: "x" });
  assert.equal(refused!.status, 401);
  assert.equal((await refused!.json() as { code: string }).code, "pair_again");
  const ping = await call("/public/part-requests/ping", { method: "POST", headers: { authorization: `Bearer ${deviceKey}` } }, { echo: "hello" });
  assert.deepEqual(await ping!.json(), { ok: true, memberName: "Test Student A", pairedDevices: 1, echo: "hello" });

  assert.equal(await api.setup.stepValid(d1, "notion-connection"), true);
  db.run("DELETE FROM part_requests_settings");
  assert.equal(await api.setup.stepValid(d1, "notion-connection"), false);
  assert.match(await command(d1, discordB), /not set up/);
});
