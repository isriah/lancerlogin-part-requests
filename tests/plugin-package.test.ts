// Fast checks of the declarations Core validates when it composes the plugin, so mistakes show up before Verify runs.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
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
  assert.equal(pkg.lancerlogin.core, ">=2.1.0-beta.7 <3.0.0");
  assert.equal(pkg.peerDependencies["@lancerlogin/module-sdk"], "^1.6.0");
  assert.equal(release.core.tag, "v2.1.0-beta.7");
  assert.match(release.core.commit, /^[0-9a-f]{40}$/);
});

test("the only route is the public family, and there are no pages yet", () => {
  assert.deepEqual(manifest.apiRoutes, [{ path: "/public/part-requests", match: "prefix", access: "service" }]);
  assert.deepEqual(manifest.navigation, []);
  assert.deepEqual(manifest.settings, []);
  assert.equal(pkg.lancerlogin.entries.dashboard, undefined);
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
  for (const secret of ["part_requests_pairing_pins", "part_requests_devices"]) assert.ok((manifest.backup.nonPortableTables as readonly string[]).includes(secret));
});

test("PINs and device keys have no plaintext column", () => {
  const sql = read("migrations/0001_create_pairing_tables.sql");
  assert.match(sql, /pin_hash TEXT NOT NULL/);
  assert.match(sql, /key_hash TEXT NOT NULL/);
  assert.doesNotMatch(sql, /^\s*(pin|device_key|key|token)\s+TEXT/m);
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
