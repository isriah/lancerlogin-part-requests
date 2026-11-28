// Fast checks of the declarations Core validates when it composes the plugin, so mistakes show up before Verify runs.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import manifest from "../src/manifest.ts";

const root = new URL("../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), "utf8");
const pkg = JSON.parse(read("package.json"));
const release = JSON.parse(read(".github/plugin-release.json"));

test("package.json, the manifest and plugin-release.json agree", () => {
  assert.equal(manifest.id, "part-requests");
  assert.equal(manifest.id, pkg.lancerlogin.moduleId);
  assert.equal(manifest.contractVersion, pkg.lancerlogin.contract);
  assert.equal(pkg.lancerlogin.contract, 1);
  assert.equal(manifest.tablePrefix, "part_requests_");
  assert.equal(manifest.tablePrefix, pkg.lancerlogin.tablePrefix);
  assert.equal(pkg.name, `lancerlogin-module-${manifest.id}`);
  assert.equal(pkg.version, "1.4.0");
  assert.equal(pkg.lancerlogin.core, ">=2.1.0-beta.13 <3.0.0", "the first Core that stores a module's Notion comment name");
  assert.equal(pkg.peerDependencies["@lancerlogin/module-sdk"], "^1.10.0", "services.notion, NotionBindingField, NotionCommentNameField and listNotionPeopleAccounts");
  assert.equal(release.core.tag, "v2.1.0-beta.13");
  assert.match(release.core.commit, /^[0-9a-f]{40}$/);
});

test("Notion: only the required ordering database, with only the operations this version calls, no People binding and no email", () => {
  assert.deepEqual(manifest.notion, {
    users: ["list", "retrieve"],
    bindings: [
      { id: "orders", label: "Ordering database", reason: "Part requests from the browser extension are added here, Carts and the recipient list read it, and stale-request reminders comment on requests and set their Reminder sent date.", required: true, kind: "data_source", operations: ["retrieve", "query", "pages.create", "comments.create", "pages.update"] },
    ],
  });
  // As Core validates them: plain text within its lengths.
  for (const binding of manifest.notion.bindings) {
    assert.ok(binding.label.length <= 80 && binding.label.trim() === binding.label);
    assert.ok(binding.reason.length <= 200 && binding.reason.trim() === binding.reason, `${binding.id} reason is ${binding.reason.length} characters`);
  }
  // People matching is Core's: nothing in the plugin names a People binding or reads a People layout any more.
  for (const name of readdirSync(new URL("src/", root), { recursive: true }).map(String).filter((file) => /\.tsx?$/.test(file))) {
    assert.doesNotMatch(read(`src/${name.replaceAll("\\", "/")}`), /peopleBinding|bindingId="people"|binding\("people"\)|people_key|people_schema_json|peopleKey/, name);
  }
  // No Notion request leaves the plugin except through Core: no fetch, no API host, no Notion headers.
  for (const name of readdirSync(new URL("src/", root)).filter((file) => file.endsWith(".ts"))) {
    const source = read(`src/${name}`);
    assert.doesNotMatch(source, /\bfetch\(|api\.notion\.com|Notion-Version/, name);
  }
});

test("the Reminders tab places Core's Notion comment name field for part-requests, once, between Settings and the last run", () => {
  // The dashboard is not rendered in these tests (no React here), so this reads the tab's source as Core's composer would see it.
  const source = read("src/dashboard/part-requests-reminders.tsx");
  // Matched as text, without a quoted specifier after "from": Core's composer checks every import it finds, tests included.
  const sdkImport = source.split(/\r?\n/).find((line) => line.startsWith("import {") && line.endsWith(`"@lancerlogin/module-sdk/dashboard";`));
  assert.match(sdkImport ?? "", /\bNotionCommentNameField\b/, "imported from the module SDK's dashboard entry");
  assert.deepEqual([...source.matchAll(/<NotionCommentNameField\b[^>]*\/>/g)].map((match) => match[0]), ['<NotionCommentNameField moduleId="part-requests" />']);
  const card = source.slice(source.indexOf("function CommentNameCard()"), source.indexOf("function LastRunCard("));
  assert.match(card, /<NotionCommentNameField moduleId="part-requests" \/>/, "inside the comment name card");
  const tab = source.slice(source.indexOf("export function RemindersTab()"), source.indexOf("function RequestList("));
  const order = ["<StatusCard", "<SettingsCard", "<CommentNameCard />", "<LastRunCard"].map((tag) => tab.indexOf(tag));
  assert.ok(order.every((position) => position >= 0), "every card is on the tab");
  assert.deepEqual(order, [...order].sort((a, b) => a - b));
  // No People card or picker: one line on the status card says whether Core's people matching is in use, linking to where it is set up.
  assert.ok(!source.includes("PeopleCard") && !source.includes("NotionBindingField"), "the tab no longer chooses, checks or removes a People database");
  const status = source.slice(source.indexOf("function StatusCard("), source.indexOf("function PreviewList("));
  assert.match(status, /<p className="field-help pr-notice">Who to ping comes from LancerLogin's people matching, set up in <a href=\{integrationsPath\}>\{integrationsLabel\}<\/a>: \{peopleMatchingState\(view\.people\)\}\.<\/p>/);
  // The tab is reached only through the Admin settings page; the manifest declares no other page that could place it.
  assert.deepEqual(readdirSync(new URL("src/dashboard/", root)).filter((name) => read(`src/dashboard/${name}`).includes("<RemindersTab")), ["part-requests-settings.tsx"]);
});

test("the route families and the one Admin settings page are declared", () => {
  assert.deepEqual(manifest.apiRoutes, [
    { path: "/public/part-requests", match: "prefix", access: "service" },
    { path: "/admin/part-requests", match: "prefix", access: "workspace" },
    { path: "/module-setup/part-requests", match: "prefix", access: "setup" },
  ]);
  assert.deepEqual(manifest.navigation, []);
  assert.deepEqual(manifest.settings, [{ label: "Part Requests", path: "/settings/part-requests" }]);
  assert.equal(pkg.lancerlogin.entries.dashboard, "./src/dashboard.tsx");
  assert.equal(manifest.setup.version, 1, "Core cannot update an installed module's setup version, so raising it locks setup");
});

test("every table is prefixed, declared and classified for backup and cleanup", () => {
  const sql = readdirSync(new URL("migrations/", root)).filter((name) => name.endsWith(".sql")).map((name) => read(`migrations/${name}`)).join("\n");
  const created = [...sql.matchAll(/CREATE TABLE (\w+)/g)].map((match) => match[1]!);
  assert.deepEqual(created, [...manifest.persistence.tables]);
  for (const table of created) {
    assert.ok(table.startsWith(manifest.tablePrefix), table);
    const portable = (manifest.backup.tables as readonly string[]).includes(table);
    const nonPortable = (manifest.backup.nonPortableTables as readonly string[]).includes(table);
    assert.ok(portable !== nonPortable, `${table} is either backed up or non-portable`);
    assert.ok((manifest.lifecycle.cleanupTargets as readonly string[]).includes(table), `${table} is cleaned up`);
  }
  for (const secret of ["part_requests_pairing_pins", "part_requests_devices", "part_requests_notion", "part_requests_submissions", "part_requests_recipients"]) assert.ok((manifest.backup.nonPortableTables as readonly string[]).includes(secret));
});

test("PINs, device keys and the Notion token have no plaintext column", () => {
  const sql = read("migrations/0001_create_pairing_tables.sql") + read("migrations/0002_notion_and_requests.sql");
  assert.match(sql, /pin_hash TEXT NOT NULL/);
  assert.match(sql, /key_hash TEXT NOT NULL/);
  assert.doesNotMatch(sql, /^\s*(pin|device_key|key|token)\s+TEXT/m);
});

test("0006 drops the People columns in place from a populated 1.4 database, and keeps everything else", () => {
  const db = new DatabaseSync(":memory:", { enableForeignKeyConstraints: true });
  db.exec(`CREATE TABLE installations (id TEXT PRIMARY KEY NOT NULL); INSERT INTO installations(id) VALUES ('primary');
    CREATE TABLE members (id TEXT PRIMARY KEY, installation_id TEXT NOT NULL REFERENCES installations(id), external_id TEXT NOT NULL, first_name TEXT NOT NULL, last_name TEXT NOT NULL, email TEXT, discord_user_id TEXT, active INTEGER NOT NULL DEFAULT 1);`);
  const files = readdirSync(new URL("migrations/", root)).filter((name) => name.endsWith(".sql")).sort();
  for (const name of files.filter((file) => file < "0006")) db.exec(read(`migrations/${name}`));
  // As 1.4 leaves it with a checked People database, the member ID column switched to `id`, and a run left in the People step.
  db.exec(`INSERT INTO part_requests_reminder_settings(installation_id,enabled,discord_channel_id,data_source_id,schema_json,verified_ms,people_data_source_id,people_schema_json,
      people_verified_ms,people_error,people_key,schedule_since_ms,last_error,revision,updated_ms)
    VALUES ('primary',1,'300000000000000001','ds-test','{}',1,'people-ds-test','{}',2,'Test error','id',3,'people_schema',4,5);
    INSERT INTO part_requests_reminder_runs(installation_id,run_key,kind,state,config_json,people_json,created_ms) VALUES ('primary','manual:1','manual','people','{}','[]',1);`);
  assert.throws(() => db.exec("UPDATE part_requests_reminder_settings SET people_key='email'"), /CHECK constraint failed/, "the column CHECKs are in force before");
  assert.throws(() => db.exec("UPDATE part_requests_reminder_settings SET people_verified_ms='soon'"), /CHECK constraint failed/);
  const columns = () => db.prepare("PRAGMA table_info(part_requests_reminder_settings)").all().map((row) => String(row.name));
  const kept = columns().filter((name) => !name.startsWith("people_"));
  const values = () => ({ ...db.prepare(`SELECT ${kept.join(",")} FROM part_requests_reminder_settings`).get() });
  const before = values();
  db.exec("BEGIN"); db.exec(read("migrations/0006_reminders_people_from_core.sql")); db.exec("COMMIT");
  assert.deepEqual(columns(), kept);
  assert.deepEqual(values(), before);
  assert.doesNotMatch(String(db.prepare("SELECT sql FROM sqlite_schema WHERE name='part_requests_reminder_settings'").get()!.sql), /people_/);
  assert.throws(() => db.exec("UPDATE part_requests_reminder_settings SET enabled=2"), /CHECK constraint failed/, "the other CHECKs still hold");
  assert.equal(db.prepare("SELECT state FROM part_requests_reminder_runs").get()!.state, "people", "a run's own columns are untouched; the job takes a 'people' run back to its schema step");
  assert.equal(db.prepare("PRAGMA integrity_check").get()!.integrity_check, "ok");
});

test("migrations are numbered from 0001 and match their reviewed hashes", () => {
  const files = readdirSync(new URL("migrations/", root)).filter((name) => name.endsWith(".sql")).sort();
  const reviewed = JSON.parse(read("migrations/reviewed.json")) as { name: string; sha256: string }[];
  assert.deepEqual(reviewed.map((entry) => entry.name), files);
  files.forEach((name, index) => {
    assert.match(name, new RegExp(`^${String(index + 1).padStart(4, "0")}_[a-z0-9_]+\\.sql$`));
    const hash = createHash("sha256").update(read(`migrations/${name}`).replaceAll("\r\n", "\n")).digest("hex");
    assert.equal(reviewed[index]!.sha256, hash, `${name} changed after review; released migrations are never edited`);
  });
});
