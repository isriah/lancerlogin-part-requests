// The Notion client against a fetch-boundary stub. Keeps the intent of the extension's tests and adds its live-tested traps.
import test, { afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { AppError, NotionClient, mapSchema, notionId, notionVersion, pagePayload, parseDraft, statusIncomplete, validateDraft, type RequestDraft, type Schema } from "../src/notion.ts";
import { productSkuKey, productUrlKey, vendorForUrl, vendors } from "../src/vendors.ts";
import { dataSource, dataSourceId, databaseId, guestPerson, memberPerson, namelessGuest, notionResponse, otherDataSourceId, stubNotion, testToken, type Stub } from "./helpers/notion-stub.ts";
import { goodDraft } from "./helpers/harness.ts";

let stub: Stub;
beforeEach(() => { stub = stubNotion(); });
afterEach(() => { stub.restore(); });

const schema = (): Schema => mapSchema(dataSource(), databaseId);
const client = () => new NotionClient(testToken);
const draft = (overrides = {}) => goodDraft(overrides) as RequestDraft;
const rejects = async (work: Promise<unknown>, expected: { code?: string; uncertain?: boolean }) => {
  await assert.rejects(work, (error: unknown) => {
    assert.ok(error instanceof AppError, String(error));
    if (expected.code) assert.equal(error.code, expected.code);
    if (expected.uncertain !== undefined) assert.equal(error.uncertain, expected.uncertain);
    return true;
  });
};

test("Notion links: notion.so, notion.com and notion.site are accepted, the view is ignored, lookalikes are refused", () => {
  const hex = databaseId.replaceAll("-", "");
  for (const link of [`https://app.notion.com/p/${hex}?v=99999999999999999999999999999999`, `https://www.notion.so/${hex}?v=99999999999999999999999999999999`, `https://some-team.notion.site/${hex}`, databaseId, hex]) assert.equal(notionId(link), databaseId, link);
  for (const link of [`https://notion.so.evil.example.test/${hex}`, `https://notion.com.evil.example.test/p/${hex}`, `https://evilnotion.com/p/${hex}`, `https://example.test/?v=${hex}`, `http://www.notion.so/${hex}`, `https://user:pass@www.notion.so/${hex}`]) assert.throws(() => notionId(link), AppError, link);
});

test("native fetch is called without a receiver and with options Workers accepts (Illegal invocation regression)", async () => {
  // The stub throws "Illegal invocation" for a receiver, and a TypeError for redirect "error" and for credentials.
  assert.equal(await client().create(pagePayload(draft(), schema())), "https://app.notion.com/p/created-request");
  const call = stub.calls[0]!;
  assert.equal(call.url, "https://api.notion.com/v1/pages");
  assert.equal(call.headers["Notion-Version"], notionVersion);
  assert.equal(notionVersion, "2026-03-11");
});

test("the database is read, then the data source, by their IDs", async () => {
  const mapped = await client().connect(`https://app.notion.com/p/${databaseId.replaceAll("-", "")}`, undefined);
  assert.equal(mapped.dataSourceId, dataSourceId);
  assert.deepEqual(stub.calls.map((call) => call.url), [`https://api.notion.com/v1/databases/${databaseId}`, `https://api.notion.com/v1/data_sources/${dataSourceId}`]);
});

test("several data sources need an explicit choice, and a choice outside the list is refused", async () => {
  stub.dataSources = [{ id: dataSourceId, name: "Ordering" }, { id: otherDataSourceId, name: "Archive" }];
  await rejects(client().connect(databaseId, undefined), { code: "data_source_required" });
  assert.equal(stub.calls.length, 1);
  await rejects(client().connect(databaseId, "not-one-of-them"), { code: "data_source_required" });
  assert.equal((await client().connect(databaseId, otherDataSourceId)).dataSourceId, otherDataSourceId);
});

test("an unshared database is a clear 404, not an uncertain result", async () => {
  await rejects(client().connect("99999999-2222-4333-8444-555555555555", undefined), { code: "notion_404", uncertain: false });
});

test("schema: wrong types, missing vendors and missing statuses are refused; renames keep their mapping, compared decoded", () => {
  const wrongType = dataSource(); wrongType.properties.Qty.type = "rich_text";
  assert.throws(() => mapSchema(wrongType, databaseId), /Qty/);
  const noVendor = dataSource(); noVendor.properties.Vendor.select.options.shift();
  assert.throws(() => mapSchema(noVendor, databaseId), /Amazon/);
  const noStatus = dataSource(); noStatus.properties.Status.status.options = [];
  assert.throws(() => mapSchema(noStatus, databaseId), /NORMAL/);
  const noTeams = dataSource(); noTeams.properties.Team.multi_select.options = [];
  assert.throws(() => mapSchema(noTeams, databaseId), /Team/);

  const renamed = dataSource();
  renamed.properties.Recipients = { ...renamed.properties["Orderer/Recipient"], id: "a%3Ab" };
  delete renamed.properties["Orderer/Recipient"];
  assert.equal(mapSchema(renamed, databaseId, schema()).properties.recipient.id, "a%3Ab");
  assert.throws(() => mapSchema(renamed, databaseId), /Orderer/);
});

test("validation: a NORMAL request needs every field but SKU; an Incomplete one only a description and URL", () => {
  const map = schema();
  assert.deepEqual(validateDraft(draft({ recipient: memberPerson }), map, true), []);
  const incomplete = draft({ status: statusIncomplete, team: "", recipient: "", quantity: null, price: null, currencyConfirmed: false, sku: "" });
  assert.deepEqual(validateDraft(incomplete, map, false), []);
  assert.equal(validateDraft({ ...incomplete, status: "NORMAL Request" }, map, false).length, 4);
  for (const change of [{ quantity: 0 }, { quantity: -1 }, { quantity: Number.NaN }, { price: -1 }, { price: Number.POSITIVE_INFINITY }, { price: 1, currencyConfirmed: false }, { team: "unknown" }, { url: "https://example.test/x" }, { url: "https://www.mcmaster.com.evil.example.test/1" }, { status: "RUSH" }, { description: " " }, { sku: "x".repeat(2001) }]) {
    assert.ok(validateDraft(draft({ status: statusIncomplete, ...change }), map, true).length > 0, JSON.stringify(change));
  }
  assert.ok(validateDraft(draft({ recipient: "someone" }), map, false).length > 0);
  for (const bad of [null, [], "text", { ...goodDraft(), extra: 1 }, { ...goodDraft(), quantity: "2" }, { ...goodDraft(), team: null }, { ...goodDraft(), currencyConfirmed: 1 }]) assert.equal(parseDraft(bad), undefined, JSON.stringify(bad));
});

test("the page is created with properties only; the vendor comes from the URL; the formula is never written", () => {
  const map = schema();
  const payload = pagePayload(draft({ url: "https://andymark.com/products/test-shaft?variant=123#selected", recipient: guestPerson }), map);
  assert.deepEqual(Object.keys(payload).sort(), ["parent", "properties"]);
  assert.deepEqual(payload.parent, { type: "data_source_id", data_source_id: dataSourceId });
  const properties = payload.properties;
  assert.deepEqual(properties.v3nd.select.id, `v3nd-${vendors.findIndex((vendor) => vendor.label === "AndyMark")}`);
  assert.deepEqual(properties.t3am, { multi_select: [{ id: "team-1" }] });
  assert.deepEqual(properties["st%40t"], { status: { id: "normal" } });
  assert.deepEqual(properties["a:b"], { people: [{ object: "user", id: guestPerson }] });
  assert.equal(properties.extn, undefined);
});

test("create: only Notion's own hosts count as a confirmed page link, including app.notion.com", async () => {
  for (const url of ["https://www.notion.so/new", "https://app.notion.com/p/new"]) {
    stub.on(/^POST \/pages$/, () => notionResponse({ url }));
    assert.equal(await client().create({}), url);
  }
  for (const url of ["https://notion.com.evil.example.test/p/new", "javascript:alert(1)", undefined]) {
    stub.on(/^POST \/pages$/, () => notionResponse({ url }));
    await rejects(client().create({}), { uncertain: true });
  }
});

test("create: each failure is classified as certain or uncertain, and POST is never retried", async () => {
  for (const [status, uncertain] of [[400, false], [401, false], [403, false], [404, false], [429, false], [409, true], [500, true], [503, true], [302, true]] as const) {
    stub = (stub.restore(), stubNotion());
    stub.on(/^POST \/pages$/, () => notionResponse({ message: "secret detail from Notion" }, status, { "retry-after": "3" }));
    await rejects(client().create({}), { code: `notion_${status}`, uncertain });
    assert.equal(stub.calls.length, 1, String(status));
  }
  stub.on(/^POST \/pages$/, () => { throw new TypeError("network"); });
  await rejects(client().create({}), { code: "notion_network", uncertain: true });
  stub.on(/^POST \/pages$/, () => new Response("{bad"));
  await rejects(client().create({}), { code: "notion_response", uncertain: true });
});

test("a read failure is never uncertain", async () => {
  stub.on(/^POST \/data_sources/, () => notionResponse({}, 503));
  await rejects(client().requestPeoplePage(schema(), 50), { code: "notion_503", uncertain: false });
});

test("people: guests come from existing requests, property IDs are compared decoded, bots are left out, no filter_properties", async () => {
  const first = await client().requestPeoplePage(schema(), 50);
  assert.deepEqual(first, { people: [{ id: guestPerson, name: "Test Guest" }], next: "next-page" });
  assert.deepEqual(stub.calls[0]!.body, { page_size: 50 });
  const second = await client().requestPeoplePage(schema(), 50, first.next);
  assert.deepEqual(second, { people: [{ id: namelessGuest, name: "" }] });
  assert.deepEqual(stub.calls[1]!.body, { page_size: 50, start_cursor: "next-page" });
  assert.deepEqual((await client().usersPage()).people, [{ id: memberPerson, name: "Test Member" }]);
});

test("vendors: 20 stores, matched by exact host, with the product key ignoring what does not change the product", () => {
  assert.equal(vendors.length, 20);
  assert.equal(vendorForUrl("https://www.mcmaster.com/91251A537/")?.label, "McMaster");
  assert.equal(vendorForUrl("https://us.store.bambulab.com/products/x")?.label, "BambuLab");
  for (const bad of ["https://mcmaster.com.example.test/1", "https://mcmaster.com:8443/1", "https://user@mcmaster.com/1", "ftp://mcmaster.com/1", "nonsense"]) assert.equal(vendorForUrl(bad), undefined, bad);
  assert.equal(productUrlKey("https://www.revrobotics.com/rev-41-1600/?utm=a#top"), productUrlKey("https://revrobotics.com/REV-41-1600"));
  assert.notEqual(productUrlKey("https://andymark.com/products/x?variant=1"), productUrlKey("https://andymark.com/products/x?variant=2"));
  assert.equal(productSkuKey("https://www.revrobotics.com/a", " rev-1 "), productSkuKey("https://revrobotics.com/b", "REV-1"));
  assert.equal(productSkuKey("https://revrobotics.com/a", " "), "");
});
