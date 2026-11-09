// Phase 0 end-to-end test: a real Manifest V3 extension in a real browser against a local preview. Everything is local.
//
// What is real: Core's Worker and D1 (npm run plugins:dev), Core's signature check and command dispatch, the plugin's
// composed code, Core's generated Pages proxy running on workerd, the service worker's fetch, Edge's permission prompt.
// TEST SEAMS, all in this file: (1) the Discord integration row is written straight to the local database with a throwaway
// key pair, and this file signs interactions itself, because real Discord is tested on dev; (2) part_requests_settings is
// written with SQL, because the Admin setup page is a later phase; (3) expiry and the end of a pause are simulated by moving
// timestamps in the local database with SQL. No request leaves this computer: the Worker makes no Discord call for these.
//
// Run: npm run e2e    starts a fresh preview on 8807/5193 and the proxy on 5194, and stops them afterwards.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, createWriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

// Core's composer scans every source file in a plugin repository, composed or not: each import must be a declared
// dependency and each import() a string literal. This file is never composed, Playwright is installed only in this folder,
// and Core's helpers are at a run-time path, so it loads them with createRequire, which that scan does not read.
const load = createRequire(import.meta.url);
const { chromium } = load("playwright");

const here = dirname(fileURLToPath(import.meta.url));
const plugin = resolve(here, "../..");
const core = resolve(process.env.PART_REQUESTS_CORE ?? join(plugin, "../../modular-dev/.local/part-requests-core"));
const apiPort = 8807, dashboardPort = 5193, proxyPort = 5194;
const worker = `http://localhost:${apiPort}`, dashboard = `http://localhost:${dashboardPort}`, proxy = `http://localhost:${proxyPort}`;
const guildId = "300000000000000001";
const discord = { a: "100000000000000001", b: "100000000000000002", unlinked: "100000000000000009" };
const work = mkdtempSync(join(tmpdir(), "part-requests-spike-"));
const previewLog = join(work, "preview.log");
const state = join(core, ".provision", "plugin-dev");

const results = [];
function check(id, name, ok, detail = "") {
  results.push({ id, name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  [${id}] ${name}${detail ? `  -> ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
}
const note = (id, text) => console.log(`NOTE  [${id}] ${text}`);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
async function until(probe, timeout, label) {
  const end = Date.now() + timeout;
  for (;;) {
    const value = await probe().catch(() => undefined);
    if (value) return value;
    if (Date.now() > end) throw new Error(`Timed out: ${label}`);
    await sleep(300);
  }
}

// ---- Servers. Only the processes started here are ever stopped.
const started = [];
function startServer(command, args, options, log) {
  const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false });
  started.push(child);
  return child;
}
function stopServers() {
  for (const child of started) if (child.exitCode === null) spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore", windowsHide: true });
  spawnSync(process.execPath, ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", join(core, "scripts/compose-modules.mjs"), "--restore"], { cwd: core, stdio: "ignore" });
  if (existsSync(join(state, "active.json"))) rmSync(join(state, "active.json"), { force: true });
}
const portBusy = async (url) => { try { await fetch(url, { signal: AbortSignal.timeout(1000) }); return true; } catch { return false; } };

async function startPreview() {
  for (const url of [`${worker}/health`, dashboard, proxy]) if (await portBusy(url)) throw new Error(`${url} is already answering. This test starts a fresh database, so stop that server first.`);
  rmSync(join(state, "state"), { recursive: true, force: true });
  const log = createWriteStream(previewLog);
  startServer(process.execPath, ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", "scripts/plugin-dev.mjs", "--plugin", plugin, "--no-watch", "--api-port", String(apiPort), "--dashboard-port", String(dashboardPort)], { cwd: core }, log);
  await until(async () => (await fetch(`${worker}/health`)).ok, 240_000, "the Worker to answer");
  await until(async () => (await fetch(dashboard)).ok, 60_000, "the dashboard to answer");
  // The real generated proxy. buildPagesProxy accepts only HTTPS, so the upstream constant is swapped for the local Worker.
  const { buildPagesProxy } = load(join(core, "scripts/prepare-pages-proxy.mjs"));
  const source = buildPagesProxy("https://upstream.example.test/", "2.1.0-beta.7").replace('"https://upstream.example.test"', JSON.stringify(worker));
  const site = join(work, "pages"); mkdirSync(site, { recursive: true });
  writeFileSync(join(site, "_worker.js"), source);
  writeFileSync(join(site, "index.html"), "<!doctype html><title>Proxy site</title><p>Local stand-in for the dashboard site.</p>");
  const wrangler = join(core, "node_modules/wrangler/bin/wrangler.js");
  startServer(process.execPath, [wrangler, "pages", "dev", site, "--port", String(proxyPort), "--ip", "localhost", "--compatibility-date", "2026-08-01", "--persist-to", join(work, "pages-state")], { cwd: work, env: { ...process.env, WRANGLER_SEND_METRICS: "false" } }, createWriteStream(join(work, "proxy.log")));
  await until(async () => (await fetch(`${proxy}/__lancerlogin-release`)).ok, 90_000, "the Pages proxy to answer");
}

// ---- Local database, through wrangler, as the seams above describe.
function sql(command) {
  const wrangler = join(core, "node_modules/wrangler/bin/wrangler.js");
  const output = execFileSync(process.execPath, [wrangler, "d1", "execute", "lancerlogin-plugin-dev", "--local", "--config", join(state, "wrangler.json"), "--persist-to", join(state, "state"), "--json", "--command", command], { cwd: core, encoding: "utf8", env: { ...process.env, CI: "true", WRANGLER_SEND_METRICS: "false" }, maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
  return JSON.parse(output)[0].results;
}
const quote = (text) => `'${String(text).replaceAll("'", "''")}'`;

// ---- Core's own routes, signed in as a synthetic Admin.
let cookie = "";
async function admin(method, path, body) {
  const response = await fetch(`${worker}${path}`, { method, headers: { origin: dashboard, ...(cookie ? { cookie } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  if (!response.ok) throw new Error(`${method} ${path} -> ${response.status} ${text.slice(0, 300)}`);
  const set = response.headers.get("set-cookie");
  if (set?.startsWith("lancerlogin_session=")) cookie = set.split(";")[0];
  return json;
}
async function bootstrapInstallation() {
  const keys = load(join(core, "packages/shared/src/password-key.mjs"));
  const password = randomBytes(18).toString("base64url"); // Generated for this run and never stored.
  const setupCode = readFileSync(join(state, "setup-code.txt"), "utf8").trim();
  await admin("POST", "/setup/bootstrap", { setupCode, organizationName: "Synthetic Test Team", timeZone: "America/Los_Angeles", authMode: "local", localUsername: "test-admin", localPasswordKey: await keys.newPasswordCredential(password) });
  const params = await admin("POST", "/auth/local/params", { username: "test-admin" });
  await admin("POST", "/auth/local", { username: "test-admin", ...await keys.passwordProof(password, params) });
}
const roster = async () => (await admin("GET", "/admin/members")).members;
async function setActive(memberId, active) {
  const preview = await admin("POST", "/admin/members/bulk/preview", { memberIds: [memberId], active });
  await admin("POST", "/admin/members/bulk/apply", { memberIds: [memberId], active, previewToken: preview.previewToken });
}

// ---- Signed Discord interactions: the seam for real Discord, through Core's real /discord/interactions route.
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const publicKeyHex = publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("hex");
let interactionNumber = 0;
async function orderingPin(discordUserId, overrides = {}) {
  const body = JSON.stringify({ id: String(200000000000000000n + BigInt(++interactionNumber)), type: 2, guild_id: guildId, data: { name: "ordering-pin" }, member: { user: { id: discordUserId } }, ...overrides });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = sign(null, Buffer.from(timestamp + body), privateKey).toString("hex");
  const response = await fetch(`${worker}/discord/interactions`, { method: "POST", headers: { "content-type": "application/json", "x-signature-ed25519": signature, "x-signature-timestamp": timestamp }, body });
  return { status: response.status, json: await response.json() };
}
const pinFrom = (reply) => /\*\*([A-Z0-9]{4}-[A-Z0-9]{4})\*\*/.exec(reply?.json?.data?.content ?? "")?.[1];
const content = (reply) => reply?.json?.data?.content ?? "";
const isPrivate = (reply) => reply?.json?.data?.flags === 64;
const direct = async (path, init) => { const response = await fetch(`${worker}${path}`, init); let body = null; try { body = await response.json(); } catch {} return { status: response.status, body, headers: response.headers }; };
const pairDirect = (pin) => direct("/public/part-requests/pair", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pin }) });
const pingDirect = (key, echo = "direct") => direct("/public/part-requests/ping", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${key}` }, body: JSON.stringify({ echo }) });

async function encryptDiscordRow() {
  const vars = readFileSync(join(state, ".dev.vars"), "utf8");
  const integrationKey = /^INTEGRATION_KEY=(.+)$/m.exec(vars)?.[1]?.trim();
  if (!integrationKey) throw new Error("No local INTEGRATION_KEY");
  const { encryptIntegration } = load(join(core, "apps/api/src/integration-crypto.ts"));
  // publicKey is the throwaway key above; the bot token is a placeholder that is never sent anywhere.
  const encrypted = await encryptIntegration({ publicKey: publicKeyHex, guildId, applicationId: "300000000000000002", botToken: "local-test-placeholder" }, integrationKey);
  const now = new Date().toISOString();
  sql(`INSERT INTO encrypted_integrations (id, installation_id, provider, ciphertext, iv, updated_at, verified_at) VALUES ('spike-discord', 'primary', 'discord', ${quote(encrypted.ciphertext)}, ${quote(encrypted.iv)}, ${quote(now)}, ${quote(now)}); UPDATE installations SET discord_enabled = 1 WHERE id = 'primary';`);
}

// ---- Extension builds. "granted" holds exact host permissions from install; "optional" holds none until the prompt.
function buildExtension(name, change) {
  const target = join(work, name);
  cpSync(join(here, "extension"), target, { recursive: true });
  const manifest = JSON.parse(readFileSync(join(target, "manifest.json"), "utf8"));
  change(manifest);
  writeFileSync(join(target, "manifest.json"), JSON.stringify(manifest, null, 2));
  return target;
}
async function launch(name, extension, headed) {
  const context = await chromium.launchPersistentContext(join(work, `${name}-profile`), {
    channel: "msedge", headless: !headed,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`, "--no-first-run", "--no-default-browser-check"],
  });
  const worker = context.serviceWorkers()[0] ?? await context.waitForEvent("serviceworker", { timeout: 20_000 });
  const id = new URL(worker.url()).host;
  const page = await context.newPage();
  await page.goto(`chrome-extension://${id}/pair.html`);
  // waitForFunction is refused by the extension's CSP; page.evaluate is not.
  const send = (message) => page.evaluate((value) => chrome.runtime.sendMessage(value), message);
  return { context, id, page, send };
}
async function restartWorker(extension) {
  const session = await extension.context.newCDPSession(extension.page);
  await session.send("ServiceWorker.enable");
  await session.send("ServiceWorker.stopAllWorkers");
  await session.detach();
  await sleep(500);
}
const logCount = (pattern) => (readFileSync(previewLog, "utf8").match(pattern) ?? []).length;

async function acceptPrompt(extension, button) {
  // The browser process is the parent of this page's renderer; Playwright exposes no PID, so find Edge by its unique profile folder.
  const marker = join(work, `${extension.name}-profile`);
  const listed = execFileSync("powershell.exe", ["-NoProfile", "-Command", `(Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | Where-Object { $_.CommandLine -like '*${marker.replaceAll("'", "''")}*' -and $_.CommandLine -notlike '*--type=*' } | Select-Object -First 1).ProcessId`], { encoding: "utf8" }).trim();
  if (!/^\d+$/.test(listed)) return `no browser process found for the test profile (${listed})`;
  const clicked = spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(here, "accept-prompt.ps1"), "-RootPid", listed, "-Button", button], { encoding: "utf8" });
  return clicked.stdout.trim() || clicked.stderr.trim();
}

// ---- The test.
let failed = false;
try {
  await startPreview();
  console.log(`Preview running. Worker ${worker}, dashboard ${dashboard}, Pages proxy ${proxy}. Core ${execFileSync("git", ["-C", core, "rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim()}.`);
  await bootstrapInstallation();

  // Before enabling: Core refuses the plugin's public routes.
  check("setup", "Core refuses the public route while the module is disabled", (await pairDirect("2222-2222")).status === 409);

  const snapshot = await admin("GET", "/platform/modules");
  const moduleIds = snapshot.modules.map((module) => module.id);
  check("setup", "Core registered the plugin's module and applied its migrations", moduleIds.includes("part-requests") && sql("SELECT name FROM sqlite_master WHERE name='part_requests_devices'").length === 1, moduleIds);
  const enabled = await admin("PUT", "/admin/modules", { enabled: ["part-requests"], revision: snapshot.revision });
  const generation = enabled.modules.find((module) => module.id === "part-requests").generation;
  check("setup", "Core still refuses the public route before setup is finished", (await pairDirect("2222-2222")).status === 409);
  // SEAM 2: no Admin page yet. The site address is what a student would type: the dashboard site, here the proxy.
  sql(`INSERT INTO part_requests_settings (installation_id, site_address, updated_ms) VALUES ('primary', ${quote(proxy)}, ${Date.now()})`);
  const setup = await admin("PUT", "/admin/modules/part-requests/setup", { generation, stepId: "site-address", outcome: "completed" });
  check("setup", "Core's setup check accepts the saved site address and opens the module", setup.ready === true);

  await admin("POST", "/admin/members", { mode: "merge", members: [
    { memberId: "9001", firstName: "Test Student", lastName: "A", email: "student.a@example.test", discordUserId: discord.a },
    { memberId: "9002", firstName: "Test Student", lastName: "B", email: "student.b@example.test", discordUserId: discord.b },
    { memberId: "9003", firstName: "Test Student", lastName: "C", email: "student.c@example.test" },
  ] });
  const members = await roster();
  const memberA = members.find((member) => member.memberId === "9001");
  check("setup", "The synthetic roster has linked and unlinked members", members.length === 3 && memberA?.discordUserId === discord.a && !members.find((member) => member.memberId === "9003").discordUserId);
  await encryptDiscordRow(); // SEAM 1.

  // Baseline for Q1: what Core really answers to OPTIONS.
  const preflight = await fetch(`${worker}/public/part-requests/ping`, { method: "OPTIONS", headers: { origin: "chrome-extension://abcdefghijklmnopabcdefghijklmnop", "access-control-request-method": "POST", "access-control-request-headers": "authorization,content-type" } });
  const preflightDashboard = await fetch(`${worker}/public/part-requests/ping`, { method: "OPTIONS", headers: { origin: dashboard, "access-control-request-method": "POST" } });
  check("Q1", "OPTIONS gives an extension origin no allow-origin header", preflight.status === 204 && preflight.headers.get("access-control-allow-origin") === null, `status ${preflight.status}, allow-origin ${preflight.headers.get("access-control-allow-origin")}`);
  check("Q1", "OPTIONS names only the dashboard origin", preflightDashboard.headers.get("access-control-allow-origin") === dashboard, preflightDashboard.headers.get("access-control-allow-origin"));

  // ---- Q1 and Q3: host permissions from install, in the headless browser.
  const grantedBuild = buildExtension("granted", (manifest) => { delete manifest.optional_host_permissions; manifest.host_permissions = [`${worker}/*`, `${proxy}/*`]; });
  const granted = await launch("granted", grantedBuild, false);
  granted.name = "granted";

  // Q3: the handler creates a PIN through Core's signed route, and Core marks the reply private.
  const firstReply = await orderingPin(discord.a);
  check("Q3", "/ordering-pin through Core's signed route replies privately with the PIN and site address", firstReply.status === 200 && isPrivate(firstReply) && Boolean(pinFrom(firstReply)) && content(firstReply).includes(proxy), content(firstReply).replace(/\*\*.*\*\*/, "**(PIN)**"));
  const badSignature = await fetch(`${worker}/discord/interactions`, { method: "POST", headers: { "content-type": "application/json", "x-signature-ed25519": "00".repeat(64), "x-signature-timestamp": String(Math.floor(Date.now() / 1000)) }, body: "{}" });
  check("Q3", "Core refuses an unsigned interaction, so the seam is the key pair and not a bypass", badSignature.status === 401, badSignature.status);
  const wrongGuild = await orderingPin(discord.a, { guild_id: "300000000000000099" });
  check("Q3", "Core refuses the command from another Discord server, without the plugin running", isPrivate(wrongGuild) && !pinFrom(wrongGuild), content(wrongGuild));
  const pinA1 = pinFrom(await orderingPin(discord.a)); // The wrong-server reply made no PIN; this also cancels firstReply's PIN.

  // Q1 and Q3 through the Worker port: the service worker exchanges the PIN.
  const pairedWorker = await granted.send({ type: "pair", base: worker, pin: pinA1 });
  check("Q3", "The service worker exchanged the PIN for a device key on the Worker port", pairedWorker.status === 201 && pairedWorker.body?.memberName === "Test Student A", pairedWorker);
  const keyA1 = (await granted.send({ type: "key" })).deviceKey;
  check("Q3", "The device key is stored as a key, and only its hash is in the database", /^[A-Za-z0-9_-]{43}$/.test(keyA1 ?? "") && sql("SELECT key_hash FROM part_requests_devices").some((row) => row.key_hash === createHash("sha256").update(keyA1).digest("hex")) && !JSON.stringify(sql("SELECT * FROM part_requests_devices")).includes(keyA1));
  const pinStored = sql("SELECT pin_hash FROM part_requests_pairing_pins");
  check("Q3", "PINs are stored only as SHA-256", pinStored.length >= 1 && !JSON.stringify(pinStored).includes(pinA1.replace("-", "")) && pinStored.some((row) => row.pin_hash === createHash("sha256").update(pinA1.replace("-", "")).digest("hex")));

  const optionsBefore = logCount(/OPTIONS \/public\/part-requests/g);
  const viaWorker = await granted.send({ type: "ping", base: worker, echo: "worker-port" });
  check("Q1", "Service worker POST with bearer and JSON body works on the Worker port", viaWorker.status === 200 && viaWorker.body?.ok === true && viaWorker.body?.echo === "worker-port" && viaWorker.body?.memberName === "Test Student A", viaWorker);
  check("Q1", "The response carried no allow-origin header, so CORS did not admit it", viaWorker.cors === null, viaWorker.cors);

  const viaProxy = await granted.send({ type: "ping", base: `${proxy}/api`, echo: "pages-proxy" });
  check("Q1", "The same POST works through Core's generated Pages proxy at /api", viaProxy.status === 200 && viaProxy.body?.echo === "pages-proxy", viaProxy);
  const pairedProxy = await granted.send({ type: "pair", base: `${proxy}/api`, pin: pinFrom(await orderingPin(discord.b)) });
  check("Q3", "The PIN exchange also works through the proxy", pairedProxy.status === 201 && pairedProxy.body?.memberName === "Test Student B", pairedProxy);
  const dashboardApi = await fetch(`${dashboard}/api/health`, { redirect: "manual" });
  const dashboardApiText = await dashboardApi.text();
  note("Q1", `The Vite dashboard on ${dashboardPort} has no /api proxy: GET /api/health gave ${dashboardApi.status} ${dashboardApi.headers.get("content-type")}, ${dashboardApiText.includes("<!doctype") || dashboardApiText.includes("<!DOCTYPE") ? "the app's HTML" : "not HTML"}. So the proxy test ran Core's generated _worker.js under wrangler pages dev on ${proxyPort}.`);
  await sleep(1500);
  const optionsAfter = logCount(/OPTIONS \/public\/part-requests/g);
  const postsLogged = logCount(/POST \/public\/part-requests\/ping/g);
  check("Q1", "The Worker's log shows the POSTs and no preflight from the service worker", postsLogged >= 1 && optionsAfter === optionsBefore, `${postsLogged} POST lines, OPTIONS before ${optionsBefore}, after ${optionsAfter}`);

  const noKey = await granted.send({ type: "ping", base: worker, key: "A".repeat(43), echo: "x" });
  check("Q1", "A wrong key from the service worker gets 401 pair_again", noKey.status === 401 && noKey.body?.code === "pair_again", noKey);
  const nonJson = await direct("/public/part-requests/ping", { method: "POST", headers: { "content-type": "text/plain", authorization: `Bearer ${keyA1}` }, body: "x" });
  check("Q1", "Core still requires application/json", nonJson.status === 415, nonJson.status);

  await restartWorker(granted);
  const afterRestart = await granted.send({ type: "ping", echo: "after-restart" });
  check("Q3", "The key survives the service worker being stopped and restarted", afterRestart.status === 200 && afterRestart.body?.echo === "after-restart", afterRestart);

  // Control: a web page on another origin, with the same request, is blocked. Without this, Q1 proves nothing about host permissions.
  const webPage = await granted.context.newPage();
  await webPage.goto(`${proxy}/`);
  const pageFetch = await webPage.evaluate(async ([url, key]) => { try { const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${key}` }, body: "{}" }); return { reached: true, status: response.status }; } catch (error) { return { reached: false, error: String(error) }; } }, [`${worker}/public/part-requests/ping`, keyA1]);
  check("Q1", "Control: a web page on another origin is blocked by CORS", pageFetch.reached === false, pageFetch);
  await webPage.close();
  await granted.context.close();

  // ---- Q4 against the real Worker. Device keys go straight to the routes the service worker just proved.
  const directPair = async (discordId) => { const pin = pinFrom(await orderingPin(discordId)); const result = await pairDirect(pin); return result.body?.deviceKey; };
  const keyA2 = await directPair(discord.a);
  check("Q4", "Two PINs paired in turn give two working device keys", Boolean(keyA2) && keyA2 !== keyA1 && (await pingDirect(keyA1)).status === 200 && (await pingDirect(keyA2)).status === 200);
  const earlier = pinFrom(await orderingPin(discord.a));
  const rerun = await orderingPin(discord.a);
  const later = pinFrom(rerun);
  check("Q4", "A re-run replies with a new PIN and leaves paired devices working", Boolean(later) && later !== earlier && (await pingDirect(keyA1)).status === 200 && (await pingDirect(keyA2)).status === 200 && content(rerun).includes("2 of 5"), content(rerun).split("\n").pop());
  const cancelled = await pairDirect(earlier);
  check("Q4", "The earlier unused PIN is refused", cancelled.status === 401 && cancelled.body?.code === "pin_refused", cancelled.body);
  const usedOnce = await pairDirect(later);
  const keyA3 = usedOnce.body?.deviceKey;
  const usedAgain = await pairDirect(later);
  check("Q4", "A used PIN is refused", usedOnce.status === 201 && usedAgain.status === 401 && usedAgain.body?.code === "pin_refused", usedAgain.body);
  const racePin = pinFrom(await orderingPin(discord.b));
  const race = await Promise.all(Array.from({ length: 4 }, () => pairDirect(racePin)));
  check("Q4", "Four parallel exchanges of one PIN create exactly one device", race.filter((reply) => reply.status === 201).length === 1 && race.filter((reply) => reply.status === 401).length === 3, race.map((reply) => reply.status));
  const toExpire = pinFrom(await orderingPin(discord.a));
  sql(`UPDATE part_requests_pairing_pins SET expires_ms = ${Date.now() - 1} WHERE used_ms IS NULL AND cancelled_ms IS NULL`); // SEAM 3.
  const expired = await pairDirect(toExpire);
  check("Q4", "An expired PIN is refused", expired.status === 401 && expired.body?.code === "pin_refused", expired.body);
  const unlinked = await orderingPin(discord.unlinked);
  check("Q4", "A Discord account with no linked member gets a clear private message and no PIN", isPrivate(unlinked) && !pinFrom(unlinked) && /not linked/.test(content(unlinked)), content(unlinked));
  const keyA4 = await directPair(discord.a);
  const keyA5 = await directPair(discord.a);
  const allKeys = [keyA1, keyA2, keyA3, keyA4, keyA5];
  const fiveWork = (await Promise.all(allKeys.map((key) => pingDirect(key)))).every((reply) => reply.status === 200);
  const pinsBefore = sql("SELECT COUNT(*) AS count FROM part_requests_pairing_pins")[0].count;
  const limit = await orderingPin(discord.a);
  const pinsAfter = sql("SELECT COUNT(*) AS count FROM part_requests_pairing_pins")[0].count;
  check("Q4", "With five devices the command says to ask an Admin and creates no PIN", fiveWork && isPrivate(limit) && !pinFrom(limit) && /ask an Admin to remove a device/i.test(content(limit)) && pinsBefore === pinsAfter, content(limit));
  check("Q4", "The limit left all five devices working", (await Promise.all(allKeys.map((key) => pingDirect(key)))).every((reply) => reply.status === 200));

  const keyB = sql("SELECT COUNT(*) AS count FROM part_requests_devices d JOIN members m ON m.id = d.member_id WHERE m.external_id = '9002'")[0].count;
  await setActive(memberA.id, false);
  const afterLeaving = await Promise.all(allKeys.map((key) => pingDirect(key)));
  check("Q4", "Leaving the active roster ends all of that member's devices", afterLeaving.every((reply) => reply.status === 401 && reply.body?.code === "pair_again"), afterLeaving.map((reply) => reply.status));
  const inactive = await orderingPin(discord.a);
  check("Q4", "An inactive member's command gets a clear private message and no PIN", isPrivate(inactive) && !pinFrom(inactive) && /not on the active roster/.test(content(inactive)), content(inactive));
  await setActive(memberA.id, true);
  const afterReturning = await pingDirect(keyA1);
  note("Q4", `After rejoining the roster, the old device key answered ${afterReturning.status}. Devices resume because nothing revoked them.`);

  // Pause: wrong PINs across the installation. Paired devices keep working.
  const goodPin = pinFrom(await orderingPin(discord.b));
  sql("DELETE FROM part_requests_pairing_limits"); // The refusals earlier in this run count towards the pause, so start from none.
  const wrong = [];
  for (let index = 0; index < 20; index++) wrong.push((await pairDirect("2222-2222")).status);
  const pausedGood = await pairDirect(goodPin);
  check("Q4", "Repeated wrong PINs pause pairing, and the pause also refuses a correct PIN", wrong.slice(0, 19).every((status) => status === 401) && wrong[19] === 429 && pausedGood.status === 429 && pausedGood.body?.code === "pairing_paused", { wrong: wrong.join(","), correctPinDuringPause: pausedGood.status, retryAfterSeconds: pausedGood.body?.retryAfterSeconds });
  check("Q4", "A paired device keeps working during the pause", (await pingDirect(keyA1)).status === 200);
  sql(`UPDATE part_requests_pairing_limits SET paused_until_ms = ${Date.now() - 1}, window_start_ms = ${Date.now() - 3_600_000}`); // SEAM 3.
  const resumed = await pairDirect(goodPin);
  check("Q4", "Pairing resumes when the pause ends, and the unspent PIN still works", resumed.status === 201, resumed.status);

  // ---- Q2: nothing granted at install. Headed, because the prompt is browser UI.
  const optionalBuild = buildExtension("optional", (manifest) => { manifest.optional_host_permissions = ["https://*/*", "http://localhost/*"]; delete manifest.host_permissions; });
  const optional = await launch("optional", optionalBuild, true);
  optional.name = "optional";
  check("Q2", "A new install holds no permission for the site", (await optional.send({ type: "contains", origin: proxy })).granted === false);
  await optional.page.evaluate(() => chrome.storage.local.set({ pairing: { base: "x", deviceKey: "" } }));
  const before = await optional.send({ type: "ping", base: `${proxy}/api`, key: keyA1, echo: "before" });
  check("Q2", "Control: before the grant the service worker's POST fails with a TypeError", before.reached === false && /TypeError/.test(before.error ?? ""), before);
  await optional.page.evaluate(() => chrome.storage.local.remove("pairing"));
  // Playwright's evaluate carries a user gesture, and the message hands it to the service worker, so the worker waits first.
  const noGesture = await Promise.race([optional.send({ type: "request", origin: proxy }), sleep(8000).then(() => ({ error: "no answer in 8 seconds: a prompt may be showing" }))]);
  check("Q2", "Chrome refuses permissions.request without a user gesture", /gesture/i.test(noGesture.error ?? ""), noGesture);

  const pinQ2 = pinFrom(await orderingPin(discord.b));
  await optional.page.fill("#address", proxy);
  await optional.page.fill("#pin", pinQ2);
  await optional.page.fill("#prefix", "/api");
  const promptState = () => optional.page.evaluate(() => document.body.dataset.prompt);
  const clickPair = async () => { await optional.page.click("#pair"); await sleep(1000); return promptState(); };
  const settled = () => until(async () => (await promptState()) !== "waiting", 10_000, "the prompt to settle").catch(() => undefined);

  // Decline first: this is the first prompt this profile sees.
  const waiting = await clickPair();
  check("Q2", "Clicking Pair shows the prompt: the request waits for the person", waiting === "waiting", waiting);
  const clickedDeny = await acceptPrompt(optional, "Deny");
  note("Q2", `Prompt automation: ${clickedDeny}`);
  await settled();
  const pinRows = () => sql("SELECT COUNT(*) AS count FROM part_requests_pairing_pins WHERE used_ms IS NOT NULL")[0].count;
  const usedBefore = pinRows();
  check("Q2", "Declining leaves the site blocked and sends nothing", /^clicked/.test(clickedDeny) && (await promptState()) === "denied" && (await optional.send({ type: "contains", origin: proxy })).granted === false, await promptState());

  // Then accept, with the same unspent PIN.
  const waitingAgain = await clickPair();
  check("Q2", "Pairing again after declining shows the prompt again", waitingAgain === "waiting", waitingAgain);
  const clickedAllow = await acceptPrompt(optional, "Allow");
  note("Q2", `Prompt automation: ${clickedAllow}`);
  await settled();
  // The prompt settles before the service worker's exchange returns, and the screen still shows the earlier decline until then.
  await until(async () => JSON.parse(await optional.page.textContent("#result") || "{}").status, 10_000, "the exchange to return").catch(() => undefined);
  const shown = JSON.parse(await optional.page.textContent("#result") || "{}");
  check("Q2", "Accepting the real prompt grants that site and pairing completes", /^clicked/.test(clickedAllow) && (await promptState()) === "granted" && shown.status === 201 && pinRows() === usedBefore + 1, shown);
  check("Q2", "Chrome reports the site as granted", (await optional.send({ type: "contains", origin: proxy })).granted === true);
  const allowed = await optional.send({ type: "ping", echo: "after-prompt" });
  check("Q2", "The service worker can now POST to the user-entered site", allowed.status === 200 && allowed.body?.echo === "after-prompt", allowed);
  const otherPort = await optional.send({ type: "ping", base: worker, echo: "other-site" });
  check("Q2", "The grant covers that one site: another port on the same host stays blocked", otherPort.reached === false, otherPort);
  await restartWorker(optional);
  const restarted = await optional.send({ type: "ping", echo: "after-restart" });
  check("Q2", "The grant survives a service worker restart", restarted.status === 200, restarted);
  await optional.send({ type: "remove", origin: proxy });
  check("Q2", "Removing the permission blocks the service worker again", (await optional.send({ type: "ping", echo: "removed" })).reached === false);
  // An observation for the real extension's "pair again" screen, so it is a note and not a check.
  await optional.page.fill("#pin", "short");
  const afterRemoval = await clickPair();
  note("Q2", `After permissions.remove, clicking Pair gave "${afterRemoval}" with no click on any prompt. Granted now: ${(await optional.send({ type: "contains", origin: proxy })).granted}.`);
  if (afterRemoval === "waiting") await acceptPrompt(optional, "Deny");
  await optional.context.close();

} catch (error) {
  failed = true;
  console.error(`STOPPED: ${error?.stack ?? error}`);
  if (existsSync(previewLog)) console.error(readFileSync(previewLog, "utf8").split("\n").slice(-25).join("\n"));
}

const failures = results.filter((result) => !result.ok);
console.log(`\n${results.length - failures.length} of ${results.length} checks passed.${failed ? " The run stopped early." : ""}`);
for (const id of ["setup", "Q1", "Q2", "Q3", "Q4"]) { const group = results.filter((result) => result.id === id); console.log(`  ${id}: ${group.filter((result) => result.ok).length}/${group.length}`); }
stopServers();
try { rmSync(work, { recursive: true, force: true, maxRetries: 3 }); } catch { console.log(`Could not remove ${work}`); }
process.exit(failed || failures.length ? 1 : 0);
