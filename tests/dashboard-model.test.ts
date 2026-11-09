// What the Admin pages show for each state. The pages themselves are driven in a real browser against a local preview.
import test from "node:test";
import assert from "node:assert/strict";
import {
  adminSection, adminSections, connectionProblem, databaseLink, formatDate, formatDateTime, formatShortDate, formatTime, deviceSummary, emptyMembersText, inactiveNote, inFilter, memberFilters, memberFlag, memberLastUsed, memberRows, notionPageLink, offRosterNote, searchMatches, visibleMembers, pairingNotice, refreshNotice, requestRow, revokeMessage, uncertainBanner, uncertainNote, type Device, type MemberFilter,
} from "../src/dashboard/part-requests-model.ts";

const zone = "America/Los_Angeles";
const at = Date.UTC(2026, 10, 8, 22, 14);
const databaseId = "11111111-2222-4333-8444-555555555555";

test("the settings page has three tabs, and old Setup and Status links land on Connection", () => {
  assert.deepEqual(adminSections.map(([, title]) => title), ["Connection", "Requests log", "Paired devices"]);
  for (const old of ["setup", "status"]) assert.equal(adminSection(old), "connection", old);
  assert.equal(adminSection(null), "connection");
  assert.equal(adminSection("nonsense"), "connection");
  assert.equal(adminSection("requests"), "requests");
  assert.equal(adminSection("devices"), "devices");
});

test("dates read as the approved pages show them", () => {
  assert.equal(formatDateTime(at, zone), "Nov 8, 2:14 PM");
  assert.equal(formatDate(at, zone), "Nov 8, 2026");
  assert.equal(formatShortDate(at, zone), "Nov 8");
  assert.equal(formatTime(at, zone), "2:14 PM");
});

test("request rows: each state has its pill, note and link", () => {
  assert.deepEqual(requestRow({ state: "created", pageUrl: "https://app.notion.com/p/abc", failureMessage: null }, databaseId), { badge: { label: "Created", tone: "success" }, link: { href: "https://app.notion.com/p/abc", label: "Open page" } });
  assert.deepEqual(requestRow({ state: "uncertain", pageUrl: null, failureMessage: null }, databaseId), { badge: { label: "Uncertain", tone: "warning" }, note: uncertainNote, link: { href: databaseLink(databaseId), label: "Check database" } });
  assert.equal(requestRow({ state: "uncertain", pageUrl: null, failureMessage: null }, null).link, undefined);
  assert.deepEqual(requestRow({ state: "failed", pageUrl: null, failureMessage: "Notion said no." }, databaseId), { badge: { label: "Failed", tone: "error" }, note: "Nothing was created. Notion said no." });
  assert.deepEqual(requestRow({ state: "pending", pageUrl: null, failureMessage: null }, databaseId), { badge: { label: "Pending", tone: "neutral" } });
});

test("only https links on Notion's own hosts are offered", () => {
  assert.equal(databaseLink(databaseId), "https://app.notion.com/p/11111111222243338444555555555555");
  assert.equal(notionPageLink("https://www.notion.so/x"), "https://www.notion.so/x");
  for (const bad of [null, "", "not a link", "http://app.notion.com/p/x", "javascript:alert(1)", "https://notion.so.example.test/x", "https://evilnotion.so/x"]) assert.equal(notionPageLink(bad), undefined, String(bad));
});

test("the uncertain banner counts, and is absent at zero", () => {
  assert.equal(uncertainBanner(0), undefined);
  assert.match(uncertainBanner(1)!, /^1 request has an uncertain result\. Notion may or may not have created it\./);
  assert.match(uncertainBanner(3)!, /^3 requests have uncertain results\. Notion may or may not have created them\./);
});

const device = (id: string, memberId: string, memberName: string, overrides: Partial<Device> = {}): Device => ({ id, label: `Laptop ${id}`, memberId, memberName, memberActive: true, createdMs: Number(id), lastUsedMs: null, revokedMs: null, ...overrides });

const now = Date.UTC(2026, 10, 9, 12);
const day = 86_400_000;
const list = (devices: Device[], roster: { id: string; name: string }[] = []) => ({ devices, roster });

test("members: everyone on the roster gets a row by name, with working devices first and anyone off the roster included", () => {
  const rows = memberRows(list([
    device("1", "e", "Test Student E", { memberActive: false }),
    device("9", "b", "Test Student B", { revokedMs: 5 }),
    device("8", "b", "Test Student B", { lastUsedMs: now - day }),
  ], [{ id: "b", name: "Test Student B" }, { id: "c", name: "Test Student C" }]), now);
  assert.deepEqual(rows.map((row) => row.name), ["Test Student B", "Test Student C", "Test Student E"]);
  assert.deepEqual(rows[0]!.devices.map((item) => item.id), ["8", "9"], "revoked devices come last");
  assert.equal(rows[0]!.working.length, 1);
  assert.deepEqual(rows[1]!.devices, [], "a member with no devices is listed");
  assert.equal(rows[1]!.active, true);
  assert.equal(rows[2]!.active, false);
  assert.deepEqual(memberRows(list([]), now), []);
});

test("members: inactive counts from last use, or from pairing if never used, and never for someone with nothing to use", () => {
  const rows = memberRows(list([
    device("1", "a", "A", { lastUsedMs: now - 40 * day, createdMs: now - 90 * day }),
    device("2", "b", "B", { lastUsedMs: null, createdMs: now - 31 * day }),
    device("3", "c", "C", { lastUsedMs: now - 29 * day }),
    device("4", "d", "D", { lastUsedMs: now - 90 * day, memberActive: false }),
    device("5", "e", "E", { lastUsedMs: now - 90 * day, revokedMs: now - 80 * day }),
  ]), now);
  assert.deepEqual(rows.map((row) => row.idleDays), [40, 31, 29, 0, 0]);
  assert.deepEqual(rows.map((row) => memberFlag(row, 5)?.label), ["Inactive 40 days", "Inactive 31 days", undefined, "Off roster", "No devices"]);
  assert.equal(memberLastUsed(rows[1]!), "Never used");
  assert.equal(memberLastUsed(memberRows(list([], [{ id: "z", name: "Z" }]), now)[0]!), "Not paired");
  assert.equal(memberLastUsed(rows[4]!, zone).startsWith("Last used "), true, "a member whose devices were all revoked still shows the last use");
  assert.match(inactiveNote, /a prompt to look, not a reason to revoke/);
});

test("members: each chip counts its own, off roster and the limit stay apart, and Inactive sorts longest idle first", () => {
  const rows = memberRows(list([
    ...["1", "2"].map((id) => device(id, "a", "Test Student A", { lastUsedMs: now })),
    device("3", "b", "Test Student B", { lastUsedMs: now - 31 * day }),
    device("4", "c", "Test Student C", { lastUsedMs: now - 60 * day }),
    ...["5", "6"].map((id) => device(id, "e", "Test Student E", { memberActive: false, lastUsedMs: now })),
  ], [{ id: "a", name: "Test Student A" }, { id: "b", name: "Test Student B" }, { id: "c", name: "Test Student C" }, { id: "d", name: "Test Student D" }]), now);
  const names = (filter: MemberFilter, search = "") => visibleMembers(rows, filter, search, 2).map((row) => row.name.slice(-1)).join("");
  assert.equal(names("all"), "ABCDE");
  assert.equal(names("none"), "D");
  assert.equal(names("limit"), "A", "off roster devices do not count toward the limit chip");
  assert.equal(names("idle"), "CB");
  assert.equal(names("off"), "E");
  assert.deepEqual(memberFilters.map(([, label]) => label), ["All", "No devices", "At the limit", "Inactive 30+ days", "Off roster"]);
  assert.equal(inFilter(rows[0]!, "all", 2), true);
  assert.deepEqual(deviceSummary(rows), { paired: 3, onRoster: 4, none: 1, devices: 6, offRosterDevices: 2 });
});

test("members: search finds a name or a device, says which device, and an empty result says why", () => {
  const rows = memberRows(list([device("1", "a", "Test Student A", { label: "School Chromebook" }), device("2", "b", "Test Student B", { label: "Home laptop" })]), now);
  assert.deepEqual(visibleMembers(rows, "all", " student b ", 5).map((row) => row.id), ["b"]);
  assert.deepEqual(visibleMembers(rows, "all", "CHROME", 5).map((row) => row.id), ["a"]);
  assert.deepEqual(searchMatches(rows[0]!, "chrome"), ["School Chromebook"]);
  assert.deepEqual(searchMatches(rows[0]!, "student"), [], "a name match needs no note");
  assert.equal(emptyMembersText("all", "zzz", 5), 'No members match "zzz".');
  assert.equal(emptyMembersText("off", "zzz", 5), 'No members match "zzz" in Off roster.');
  assert.equal(emptyMembersText("limit", "", 5), "No members are at the limit of 5 devices.");
  assert.equal(offRosterNote(memberRows(list([device("1", "e", "E", { memberActive: false })]), now)[0]!), "Not on the active roster, so this device has no access.");
});

test("the revoke message says what happens and how to undo it", () => {
  assert.equal(revokeMessage({ label: "School Chromebook", memberName: "Test Student A" }), "Test Student A's School Chromebook loses access at once. Its past requests stay in the log. To use it again, Test Student A runs /ordering-pin and pairs it again.");
});

test("the Connection tab's problem line says what stopped and what to do", () => {
  assert.equal(connectionProblem({ tokenSaved: true, problem: null, schemaError: null }), undefined);
  assert.match(connectionProblem({ tokenSaved: true, problem: "notion_schema_changed", schemaError: 'Notion property "SKU" is wrong.' })!, /no longer matches.*"SKU" is wrong/);
  assert.match(connectionProblem({ tokenSaved: false, problem: "notion_not_connected", schemaError: null })!, /^No Notion token is saved.*after a restore/);
  assert.match(connectionProblem({ tokenSaved: true, problem: "notion_not_connected", schemaError: null })!, /has not been verified/);
});

test("the Connection tab's pairing and recipient notices", () => {
  assert.equal(pairingNotice(null), undefined);
  assert.match(pairingNotice(at, zone)!, /reopens by itself at 2:14 PM\. Devices that are already paired keep working\./);
  assert.equal(refreshNotice(null), undefined);
  assert.equal(refreshNotice({ step: "idle", finishedMs: at, lastError: null }), undefined);
  assert.match(refreshNotice({ step: "idle", finishedMs: at, lastError: "notion_500" }, zone)!, /could not finish.*The list from Nov 8, 2:14 PM is still in use/);
  assert.doesNotMatch(refreshNotice({ step: "idle", finishedMs: null, lastError: "notion_500" }, zone)!, /still in use/);
});
