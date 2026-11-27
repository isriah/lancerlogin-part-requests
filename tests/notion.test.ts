// The ordering database through Core's `services.notion` (a stand-in modelled on Core's), with Notion stubbed at the fetch
// boundary. Keeps the intent of the extension's tests and its live-tested traps.
import test, { afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { AppError, OrdersNotion, mapSchema, notionFailure, pageProperties, parseDraft, statusIncomplete, validateDraft, type RequestDraft, type Schema } from "../src/notion.ts";
import { productSkuKey, productUrlKey, vendorForUrl, vendors } from "../src/vendors.ts";
import { dataSource, dataSourceId, databaseId, guestPerson, memberPerson, namelessGuest, notionResponse, otherDataSourceId, stubNotion, testToken, type Stub } from "./helpers/notion-stub.ts";
import { createCoreNotion, CoreHttpError, type CoreNotion, type Cost } from "./helpers/core-notion-stub.ts";
import { goodDraft, testCredentials } from "./helpers/harness.ts";

let stub: Stub;
let core: CoreNotion;
beforeEach(async () => { stub = stubNotion(); core = createCoreNotion(testCredentials()); await core.connect(); core.bind({ databaseId, dataSourceId, name: "Ordering" }); });
afterEach(() => { stub.restore(); });

const schema = (): Schema => mapSchema(dataSource(), databaseId);
const cost = (): Cost => ({ d1: 0, external: 0, notion: 0 });
/** A new invocation each time, as Core gives each request its own `services.notion`. */
const service = () => core.service(cost()) as any;
const client = () => new OrdersNotion(service());
const draft = (overrides = {}) => goodDraft(overrides) as RequestDraft;
const page = (url: unknown) => notionResponse({ object: "page", id: crypto.randomUUID(), url });
const rejects = async (work: Promise<unknown>, expected: { code?: string; uncertain?: boolean }) => {
  await assert.rejects(work, (error: unknown) => {
    assert.ok(error instanceof AppError, String(error));
    if (expected.code) assert.equal(error.code, expected.code);
    if (expected.uncertain !== undefined) assert.equal(error.uncertain, expected.uncertain);
    return true;
  });
};

test("every call names the orders binding: Core sends it to the bound data source with Core's token", async () => {
  assert.equal(await client().create(pageProperties(draft(), schema())), "https://app.notion.com/p/created-request");
  const call = stub.calls[0]!;
  assert.equal(call.url, "https://api.notion.com/v1/pages");
  assert.deepEqual(call.body.parent, { type: "data_source_id", data_source_id: dataSourceId }, "Core adds the parent from the binding");
  assert.equal(call.headers.Authorization, `Bearer ${testToken}`);
  core.bind({ databaseId, dataSourceId: otherDataSourceId, name: "Archive" });
  await client().requestPeoplePage(schema(), 50).catch(() => undefined); // the fetch stub only knows the first data source
  assert.equal(stub.calls[1]!.url, `https://api.notion.com/v1/data_sources/${otherDataSourceId}/query`);
});

test("the layout is read from the bound data source and named after the binding", async () => {
  const mapped = await client().readSchema();
  assert.equal(mapped.dataSourceId, dataSourceId);
  assert.equal(mapped.databaseId, databaseId);
  assert.equal(mapped.dataSourceName, "Ordering");
  assert.deepEqual(stub.calls.map((call) => call.url), [`https://api.notion.com/v1/data_sources/${dataSourceId}`]);
  // A rename in Notion keeps its mapping only for the same data source.
  const renamed = dataSource(); renamed.properties.Recipients = { ...renamed.properties["Orderer/Recipient"], id: "a%3Ab" }; delete renamed.properties["Orderer/Recipient"];
  stub.source = renamed;
  assert.equal((await client().readSchema(schema())).properties.recipient.id, "a%3Ab");
  await rejects(client().readSchema({ ...schema(), dataSourceId: otherDataSourceId }), { code: "schema" });
});

test("an unshared database is a clear 404, not an uncertain result", async () => {
  stub.on(/^GET \/data_sources\//, () => notionResponse({ code: "object_not_found" }, 404));
  await rejects(client().readSchema(), { code: "notion_404", uncertain: false });
});

test("Core's refusals keep their codes and say what to fix; anything that is not Notion's is passed on as it is", async () => {
  core.state.bindings.clear();
  await rejects(client().create({ title: {} }), { code: "notion_unbound", uncertain: false });
  await rejects(client().readSchema(), { code: "notion_unbound" });
  assert.equal(stub.calls.length, 0, "refused before any request");
  core.bind({ databaseId, dataSourceId, name: "Ordering" });
  core.state.connection!.readable = false;
  await assert.rejects(client().usersPage(), (error: unknown) => error instanceof AppError && error.code === "notion_unreadable" && /Settings > Integrations > Notion/.test(error.message));
  core.state.connection!.readable = true;
  core.state.pausedUntilMs = Date.now() + 4_500;
  await assert.rejects(client().usersPage(), (error: unknown) => error instanceof AppError && error.code === "notion_429" && (error.details as { retryAfterSeconds: number }).retryAfterSeconds === 5);
  core.state.pausedUntilMs = 0;
  core.state.deliveryPausedUntil = Date.now() + 1000;
  await assert.rejects(client().create({ title: {} }), CoreHttpError, "deliveries paused: Core's own error, which uncertain() reports as not sent");
  const notion = service();
  assert.equal(notionFailure(notion, new Error("D1 failed")), undefined);
  assert.equal(notion.uncertain(new CoreHttpError(409, "paused")), false);
});

test("Core's cap of 8 Notion requests in one invocation is a refusal with its own code", async () => {
  const shared = new OrdersNotion(service());
  for (let index = 0; index < 8; index++) await shared.usersPage();
  await rejects(shared.usersPage(), { code: "notion_call_limit" });
  assert.equal(stub.calls.length, 8);
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
  const properties = pageProperties(draft({ url: "https://andymark.com/products/test-shaft?variant=123#selected", recipient: guestPerson }), map);
  assert.equal(properties.parent, undefined, "Core adds the parent from the binding");
  assert.deepEqual(properties.v3nd.select.id, `v3nd-${vendors.findIndex((vendor) => vendor.label === "AndyMark")}`);
  assert.deepEqual(properties.t3am, { multi_select: [{ id: "team-1" }] });
  assert.deepEqual(properties["st%40t"], { status: { id: "normal" } });
  assert.deepEqual(properties["a:b"], { people: [{ object: "user", id: guestPerson }] });
  assert.equal(properties.extn, undefined);
});

test("create: only Notion's own hosts count as a confirmed page link, including app.notion.com", async () => {
  for (const url of ["https://www.notion.so/new", "https://app.notion.com/p/new"]) {
    stub.on(/^POST \/pages$/, () => page(url));
    assert.equal(await client().create({ title: {} }), url);
  }
  for (const url of ["https://notion.com.evil.example.test/p/new", "javascript:alert(1)", undefined]) {
    stub.on(/^POST \/pages$/, () => page(url));
    await rejects(client().create({ title: {} }), { uncertain: true });
  }
});

test("create: each failure is classified as certain or uncertain, and POST is never retried", async () => {
  for (const [status, uncertain] of [[400, false], [401, false], [403, false], [404, false], [429, false], [409, true], [500, true], [503, true], [302, true]] as const) {
    stub = (stub.restore(), stubNotion());
    core.state.pausedUntilMs = 0;
    stub.on(/^POST \/pages$/, () => notionResponse({ message: "secret detail from Notion" }, status, { "retry-after": "3" }));
    await rejects(client().create({ title: {} }), { code: `notion_${status}`, uncertain });
    assert.equal(stub.calls.length, 1, String(status));
  }
  core.state.pausedUntilMs = 0;
  stub.on(/^POST \/pages$/, () => { throw new TypeError("network"); });
  await rejects(client().create({ title: {} }), { code: "notion_network", uncertain: true });
  stub.on(/^POST \/pages$/, () => new Response("{bad"));
  await rejects(client().create({ title: {} }), { code: "notion_response", uncertain: true });
});

test("no client error carries the token or Notion's reply, even when Notion echoes them", async () => {
  const failures: (() => Response)[] = [
    () => { throw new Error(`socket closed ${testToken}`); },
    ...[400, 401, 403, 404, 409, 429, 500, 302].map((status) => () => notionResponse({ message: `echo ${testToken}` }, status)),
    () => new Response(`{bad ${testToken}`),
    () => page(`https://evil.example.test/${testToken}`),
  ];
  for (const failure of failures) {
    core.state.pausedUntilMs = 0;
    stub.on(/^POST \/pages$/, failure);
    await assert.rejects(client().create({ title: {} }), (error: unknown) => {
      assert.ok(error instanceof AppError);
      assert.ok(!`${error.message} ${error.code} ${JSON.stringify(error.details)} ${error.stack}`.includes(testToken));
      return true;
    });
  }
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
