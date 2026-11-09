// Carts through the route handlers: real migrations on SQLite, Notion stubbed at the fetch boundary. The stub throws "Illegal
// invocation" if fetch is called with a receiver, so every test here also guards that trap.
import test, { afterEach, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { createHarness, dashboard, discordB, testCredentials, type Harness } from "./helpers/harness.ts";
import { dataSource, dataSourceId, databaseId, guestPerson, namelessGuest, notionResponse, otherDataSourceId, stubNotion, testToken, type Call, type Stub } from "./helpers/notion-stub.ts";
import manifest from "../src/manifest.ts";
import { NotionClient, type Schema } from "../src/notion.ts";
import { cartMarkLifetimeMs, cartsDisabledMessage, maximumMarksPerDevice, maximumMarksPerRequest, maximumOrderPages, openStatuses, ordersFreshMs, ordersPageSize, ordersRefreshFloorMs, ordersStaleLimitMs, orderFromRow } from "../src/orders.ts";
import { maximumGeneral } from "../src/requests.ts";

const sdk = new URL("./helpers/module-sdk-stub.ts", import.meta.url).href;
registerHooks({ resolve: (specifier, context, next) => specifier === "@lancerlogin/module-sdk/api" ? { url: sdk, shortCircuit: true } : next(specifier, context) });
const { default: api } = await import("../src/api.ts") as { default: any };

let stub: Stub;
let h: Harness;
beforeEach(() => { stub = stubNotion(); h = createHarness(api); });
afterEach(() => { stub.restore(); });

const orderId = (n: number) => `0d000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const queryPath = /^POST \/data_sources\/.*\/query$/;
const queries = () => stub.calls.filter((call) => call.url.endsWith("/query"));
const get = (key: string, query = "") => h.call("GET", `/public/part-requests/orders${query}`, { key });
const mark = (key: string, marks: unknown) => h.call("POST", "/public/part-requests/orders/marks", { key, body: { marks } });
const clear = (key: string, body: unknown = {}) => h.call("POST", "/public/part-requests/orders/marks/clear", { key, body });
const carts = (enabled: unknown, init: { role?: "admin" | "operator"; origin?: string } = { origin: dashboard }) => h.call("PUT", "/module-setup/part-requests/carts", { body: { enabled }, ...init });
const ageCopy = (ms: number) => h.test.run("UPDATE part_requests_orders_state SET published_ms=published_ms-?", ms);
const noBackoff = () => h.test.run("UPDATE part_requests_orders_state SET lease_until_ms=0");

/** A row as Notion sends it. Property IDs are reported differently from the schema on purpose: "st@t" against "st%40t". */
function row(n: number, values: Record<string, unknown> = {}): any {
  const given = { title: `Test part ${n}`, status: { id: "normal", name: "NORMAL Request" }, vendor: { id: "v3nd-13", name: "REV" }, team: [{ id: "team-1", name: "Test Team One" }], people: [{ object: "user", id: guestPerson, type: "person", name: "Test Guest" }], sku: `TEST-${n}`, url: `https://www.revrobotics.com/test-${n}/`, qty: 2, price: 12.5, ...values };
  return {
    object: "page", id: orderId(n), url: `https://app.notion.com/p/row${n}`,
    properties: {
      "Item Description": { id: "title", type: "title", title: given.title === null ? [] : [{ plain_text: given.title }] },
      Status: { id: "st@t", type: "status", status: given.status },
      Vendor: { id: "v3nd", type: "select", select: given.vendor },
      Team: { id: "t3am", type: "multi_select", multi_select: given.team },
      "Orderer/Recipient": { id: "a%3Ab", type: "people", people: given.people },
      SKU: { id: "skuu", type: "rich_text", rich_text: given.sku === null ? [] : [{ plain_text: given.sku }] },
      "Product URL": { id: "urll", type: "url", url: given.url },
      Qty: { id: "qtyy", type: "number", number: given.qty },
      "Unit Price": { id: "pric", type: "number", number: given.price },
      Extension: { id: "extn", type: "formula", formula: { type: "number", number: 25 } },
    },
  };
}
const list = (rows: unknown[], next: string | null = null) => notionResponse({ object: "list", results: rows, has_more: next !== null, next_cursor: next });
const answerWith = (...rows: unknown[]) => stub.on(queryPath, () => list(rows));
/** Pages by cursor: the first page has no cursor, then "c1", "c2"... */
const answerPages = (pages: unknown[][]) => stub.on(queryPath, (call: Call) => {
  const index = call.body.start_cursor ? Number(String(call.body.start_cursor).slice(1)) : 0;
  return list(pages[index]!, index + 1 < pages.length ? `c${index + 1}` : null);
});
async function ready() {
  await h.connect();
  stub.calls.length = 0;
  return h.pair();
}

// ---- Asking Notion

test("the query goes to the data source with a status filter on the mapped property, and no filter_properties", async () => {
  const key = await ready();
  answerWith(row(1));
  assert.equal((await get(key)).status, 200);
  assert.equal(stub.calls.length, 1);
  const call = stub.calls[0]!;
  assert.equal(call.method, "POST");
  assert.equal(call.url, `https://api.notion.com/v1/data_sources/${dataSourceId}/query`);
  assert.equal(call.headers["Notion-Version"], "2026-03-11");
  assert.deepEqual(call.body, {
    page_size: ordersPageSize,
    // Names from the saved schema. Incomplete is open, shown unticked; this schema has no SLOW option, so it is not asked for.
    filter: { or: [{ property: "st%40t", status: { equals: "NORMAL Request" } }, { property: "st%40t", status: { equals: "Incomplete Request" } }, { property: "st%40t", status: { equals: "RUSH" } }] },
    sorts: [{ timestamp: "created_time", direction: "ascending" }],
  });
  assert.ok(!("filter_properties" in call.body));
  assert.ok(!call.url.includes("filter_properties"));
});

test("a Status property of type select filters as select", async () => {
  const source = dataSource();
  const options = [...source.properties.Status.status.options, { id: "slow", name: "SLOW Request" }];
  source.properties.Status = { id: "st4t", type: "select", select: { options } };
  stub.source = source;
  const key = await ready();
  const seen = row(1); seen.properties.Status = { id: "st4t", type: "select", select: { id: "slow", name: "SLOW Request" } };
  answerWith(seen);
  const answer = await get(key);
  assert.deepEqual(stub.calls[0]!.body.filter.or, [
    { property: "st4t", select: { equals: "NORMAL Request" } }, { property: "st4t", select: { equals: "Incomplete Request" } }, { property: "st4t", select: { equals: "RUSH" } }, { property: "st4t", select: { equals: "SLOW Request" } },
  ]);
  assert.equal(answer.body.orders[0].status, "SLOW Request");
  assert.equal(answer.body.orders[0].statusGroup, "SLOW");
});

test("open statuses are exact names from the schema: lookalikes are not open", () => {
  const schema = { properties: { status: { id: "s", type: "status", options: ["NORMAL Request", "Normal", "RUSH", "rush request", "SLOW", "SLOW - ordered", "RUSHED", "Not RUSH", "Incomplete Request", "Ordered"].map((name) => ({ id: name, name })) } } } as unknown as Schema;
  assert.deepEqual(openStatuses(schema).map(({ name, group }) => [name, group]), [["NORMAL Request", "NORMAL"], ["Normal", "NORMAL"], ["RUSH", "RUSH"], ["rush request", "RUSH"], ["SLOW", "SLOW"], ["Incomplete Request", "INCOMPLETE"]]);
});

test("the fetch receiver: Notion is called as a plain function, in every path that reads orders", async () => {
  for (const file of ["../src/notion.ts", "../src/orders.ts"]) {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    assert.doesNotMatch(source, /(?:this|client|#\w+|\w+)\.fetch\(|=\s*(?:globalThis\.)?fetch\b|fetch\.bind/, file);
  }
  const received: unknown[] = [];
  const strict = globalThis.fetch;
  globalThis.fetch = function (this: unknown, input: any, init?: any) { received.push(this); return strict.call(undefined, input, init); } as typeof fetch;
  answerWith(row(1));
  const page = await new NotionClient(testToken).openOrdersPage({ dataSourceId, properties: { status: { id: "s", type: "status" } } } as unknown as Schema, [{ id: "n", name: "NORMAL Request" }], 50);
  assert.equal(page.rows.length, 1);
  assert.deepEqual(received, [undefined]);
});

// ---- What comes back

test("an order: page link, fields, names from the saved schema, requesters and no marks yet", async () => {
  const key = await ready();
  answerWith(row(1, { vendor: { id: "v3nd-13", name: "A stale name in the row" }, team: [{ id: "team-2", name: "Stale" }, { id: "team-1", name: "Stale" }] }));
  const { status, body } = await get(key);
  assert.equal(status, 200);
  assert.deepEqual(body.orders, [{
    id: orderId(1), url: "https://app.notion.com/p/row1", description: "Test part 1", vendor: "REV", urlVendor: "REV", sku: "TEST-1", productUrl: "https://www.revrobotics.com/test-1/",
    quantity: 2, unitPrice: 12.5, status: "NORMAL Request", statusGroup: "NORMAL", teams: ["Test Team Two", "Test Team One"], requesters: ["Test Guest"], cartMarks: [],
  }]);
  assert.equal(body.stale, false);
  assert.equal(body.refreshing, false);
  assert.equal(body.truncated, false);
  assert.equal(body.skippedRows, 0);
  assert.deepEqual(body.statuses, [{ name: "NORMAL Request", group: "NORMAL" }, { name: "Incomplete Request", group: "INCOMPLETE" }, { name: "RUSH", group: "RUSH" }]);
  assert.equal(body.refreshError, null);
  assert.ok(body.fetchedMs > 0);
});

test("rows written outside the extension: blanks come back as null and nothing throws", async () => {
  const key = await ready();
  answerWith(
    row(1, { title: null, vendor: null, team: [], people: [], sku: null, url: null, qty: null, price: null }),
    row(2, { url: "javascript:alert(1)", qty: 0, price: -5 }),
    row(3, { url: "not a link", qty: "2", price: "12.50" }),
    row(4, { url: "https://user:secret@www.revrobotics.com/x", qty: Number.MAX_VALUE }),
    row(5, { vendor: { id: "new-option", name: " Other store " }, url: "https://other.example.test/part", team: [{ id: "new-team", name: "New Team" }] }),
    { object: "page", id: orderId(6), url: "https://evil.example.test/x", properties: { Status: { id: "st%40t", type: "status", status: { id: "normal" } } } },
    { ...row(7), properties: { ...row(7).properties, Team: { id: "t3am", type: "select", select: { id: "team-1", name: "Test Team One" } }, "Item Description": { id: "title", type: "title", title: "not a list" }, SKU: { id: "skuu", type: "rich_text", rich_text: [null, 7, { plain_text: "ok" }] }, "Orderer/Recipient": { id: "a:b", type: "people", people: "nobody" } } },
  );
  const { status, body } = await get(key);
  assert.equal(status, 200);
  const [one, two, three, four, five, six, seven] = body.orders;
  assert.deepEqual([one.description, one.vendor, one.urlVendor, one.sku, one.productUrl, one.quantity, one.unitPrice, one.teams, one.requesters], [null, null, null, null, null, null, null, [], []]);
  assert.deepEqual([two.productUrl, two.quantity, two.unitPrice], [null, null, null]);
  assert.deepEqual([three.productUrl, three.quantity, three.unitPrice], [null, null, null]);
  assert.deepEqual([four.productUrl, four.quantity], [null, null]);
  assert.deepEqual([five.vendor, five.urlVendor, five.productUrl, five.teams], ["Other store", null, "https://other.example.test/part", ["New Team"]]);
  assert.equal(six.url, `https://www.notion.so/${orderId(6).replaceAll("-", "")}`, "a page link off Notion is replaced with one built from the ID");
  assert.equal(six.description, null);
  assert.deepEqual(seven.teams, ["Test Team One"], "a row can hold a select where the schema has a multi-select");
  assert.equal(seven.description, null);
  assert.equal(seven.sku, "ok");
  assert.deepEqual(seven.requesters, []);
  assert.equal(body.skippedRows, 0);
});

test("rows that are not open orders are dropped and counted, even if Notion ignored the filter", async () => {
  const key = await ready();
  answerWith(
    row(1),
    row(2, { status: { id: "ordered", name: "Ordered" } }), // Filter ignored: this must not reach a cart.
    row(3, { status: { id: "gone", name: "Ordered" } }),
    row(4, { status: null }),
    { ...row(5), id: "not-an-id" },
    { ...row(6), in_trash: true },
    { ...row(7), archived: true },
    { ...row(8), object: "data_source" },
    { ...row(9), properties: null },
    null, "text", 7,
    { ...row(10), id: orderId(10).toUpperCase() },
    row(11, { status: { id: "rush", name: "RUSH" } }),
  );
  const { status, body } = await get(key);
  assert.equal(status, 200);
  assert.deepEqual(body.orders.map((order: { id: string; status: string }) => [order.id, order.status]), [[orderId(1), "NORMAL Request"], [orderId(10), "NORMAL Request"], [orderId(11), "RUSH"]]);
  assert.equal(body.skippedRows, 11 - 1 - 1 - 1 + 3);
});

test("a status not in the saved schema returns nothing, by name or by ID", () => {
  const schema = { properties: { ...Object.fromEntries(["description", "vendor", "team", "recipient", "sku", "url", "quantity", "price"].map((field) => [field, { id: field, type: "x" }])), status: { id: "st@t", type: "status", options: [{ id: "normal", name: "NORMAL Request" }, { id: "slowish", name: "SLOW" }] } } } as unknown as Schema;
  const open = openStatuses(schema);
  const shaped = (status: unknown) => ({ object: "page", id: orderId(1), properties: { Status: { id: "st%40t", type: "status", status } } });
  assert.equal(orderFromRow(shaped({ id: "rush", name: "RUSH" }), schema, open), undefined);
  assert.equal(orderFromRow(shaped({ name: "SLOW" }), schema, open)?.status, "SLOW");
  assert.equal(orderFromRow(shaped({ id: "normal", name: "Renamed in the row" }), schema, open)?.status, "NORMAL Request");
});

test("a person with no name in the row comes from the recipient list without a Notion call, and bots are left out", async () => {
  const key = await ready();
  h.test.run("INSERT INTO part_requests_recipients(installation_id,notion_user_id,name,last_seen_ms) VALUES ('primary',?,'Test Looked Up',1)", namelessGuest);
  answerWith(row(1, { people: [{ object: "user", id: namelessGuest }, { object: "user", id: "c0000000-0000-4000-8000-0000000000ff" }, { object: "user", id: "b1", type: "bot", name: "Automation" }, null, { name: "No ID" }] }));
  assert.deepEqual((await get(key)).body.orders[0].requesters, ["Test Looked Up", "Unnamed Notion user"]);
  assert.equal(stub.calls.length, 1, "no call per person");
});

// ---- Pagination

test("pagination: one Notion call per request, each continuing from the last cursor, published only when complete", async () => {
  const key = await ready();
  answerPages([[row(1), row(2)], [row(3)], [row(4)]]);
  const first = await get(key);
  assert.equal(first.status, 202);
  assert.equal(first.body.state, "refreshing");
  assert.deepEqual(first.body.orders, []);
  assert.equal(first.headers.get("retry-after"), "1");
  assert.equal(queries().length, 1);
  assert.equal((await get(key)).status, 202);
  const done = await get(key);
  assert.equal(done.status, 200);
  assert.deepEqual(done.body.orders.map((order: { id: string }) => order.id), [orderId(1), orderId(2), orderId(3), orderId(4)]);
  assert.deepEqual(queries().map((call) => call.body.start_cursor), [undefined, "c1", "c2"]);
  assert.equal(queries().length, 3);
  assert.equal((await get(key)).status, 200);
  assert.equal(queries().length, 3, "the finished list is served from the copy");
  assert.equal(h.test.rows("SELECT * FROM part_requests_orders_cache").length, 3, "one row per Notion page, not per order");
});

test("pagination: the old copy is served while a long refresh runs, and replaced whole", async () => {
  const key = await ready();
  answerWith(row(1));
  await get(key);
  ageCopy(ordersFreshMs);
  answerPages([[row(2)], [row(3)]]);
  const during = await get(key);
  assert.equal(during.status, 200);
  assert.deepEqual(during.body.orders.map((order: { id: string }) => order.id), [orderId(1)]);
  assert.equal(during.body.refreshing, true);
  assert.equal(during.body.stale, true);
  const after = await get(key);
  assert.deepEqual(after.body.orders.map((order: { id: string }) => order.id), [orderId(2), orderId(3)]);
  assert.equal(after.body.refreshing, false);
  assert.equal(after.body.stale, false);
  assert.equal(h.test.rows("SELECT DISTINCT generation FROM part_requests_orders_cache").length, 1, "the old generation is deleted");
});

test("pagination: stops at the page limit and says it is truncated", async () => {
  const key = await ready();
  stub.on(queryPath, (call: Call) => { const index = Number(String(call.body.start_cursor ?? "c0").slice(1)); return list([row(index + 1)], `c${index + 1}`); });
  let answer = await get(key);
  while (answer.status === 202) answer = await get(key);
  assert.equal(queries().length, maximumOrderPages);
  assert.equal(answer.body.truncated, true);
  assert.equal(answer.body.orders.length, maximumOrderPages);
});

test("pagination: has_more with no cursor ends the list rather than looping", async () => {
  const key = await ready();
  stub.on(queryPath, () => notionResponse({ results: [row(1)], has_more: true, next_cursor: null }));
  assert.equal((await get(key)).body.orders.length, 1);
  assert.equal(queries().length, 1);
});

test("pagination: a failure part way starts again from the top, without publishing a partial list", async () => {
  const key = await ready();
  answerPages([[row(1)], [row(2)]]);
  assert.equal((await get(key)).status, 202);
  stub.on(queryPath, () => notionResponse({ code: "validation_error", message: "bad cursor" }, 400));
  const failed = await get(key);
  assert.equal(failed.status, 502);
  assert.equal(failed.body.code, "notion_unavailable");
  noBackoff();
  stub.calls.length = 0;
  answerPages([[row(3)]]);
  const done = await get(key);
  assert.deepEqual(done.body.orders.map((order: { id: string }) => order.id), [orderId(3)]);
  assert.equal(queries()[0]!.body.start_cursor, undefined);
  assert.equal(h.test.rows("SELECT DISTINCT generation FROM part_requests_orders_cache").length, 1, "the abandoned read's rows are gone");
});

test("an abandoned half-read list older than five minutes starts again", async () => {
  const key = await ready();
  answerPages([[row(1)], [row(2)]]);
  await get(key);
  h.test.run("UPDATE part_requests_orders_state SET build_started_ms=build_started_ms-?", 6 * 60_000);
  stub.calls.length = 0;
  assert.equal((await get(key)).status, 202);
  assert.equal(queries()[0]!.body.start_cursor, undefined);
});

// ---- The copy

test("cache: devices share one copy; marks do not wait for it; after a minute it is read again", async () => {
  const key = await ready();
  const other = await h.pair(discordB, "Other device");
  answerWith(row(1));
  await get(key);
  await get(key);
  await get(other);
  assert.equal(queries().length, 1);
  ageCopy(ordersFreshMs - 5000);
  await get(key);
  assert.equal(queries().length, 1, "still current");
  ageCopy(5000);
  answerWith(row(1), row(2));
  const fresh = await get(other);
  assert.equal(queries().length, 2);
  assert.equal(fresh.body.orders.length, 2);
});

test("cache: Refresh reads again, but not within 15 seconds of the last read", async () => {
  const key = await ready();
  answerWith(row(1));
  await get(key);
  await get(key, "?refresh=1");
  assert.equal(queries().length, 1, "too soon");
  ageCopy(ordersRefreshFloorMs);
  await get(key, "?refresh=1");
  assert.equal(queries().length, 2);
});

test("cache: Notion failing serves the copy marked stale, holds off retries, then gives up on a copy that is too old", async () => {
  const key = await ready();
  answerWith(row(1));
  await get(key);
  ageCopy(ordersFreshMs);
  stub.on(queryPath, () => notionResponse({ message: "boom" }, 500));
  const stale = await get(key);
  assert.equal(stale.status, 200);
  assert.equal(stale.body.stale, true);
  assert.equal(stale.body.refreshError, "notion_500");
  assert.equal(stale.body.orders.length, 1);
  assert.equal(queries().length, 2);
  const again = await get(key);
  assert.equal(again.body.refreshError, "notion_500");
  assert.equal(queries().length, 2, "the backoff stops another call");
  ageCopy(ordersStaleLimitMs);
  const expired = await get(key);
  assert.equal(expired.status, 502);
  assert.equal(queries().length, 2, "still inside the backoff");
  noBackoff();
  const retried = await get(key);
  assert.equal(retried.status, 502);
  assert.equal(queries().length, 3);
});

test("cache: failures with nothing to serve say what to do, with only fixed messages", async () => {
  const key = await ready();
  const cases: [number, Record<string, string>, number, string][] = [[401, {}, 503, "notion_access_lost"], [403, {}, 503, "notion_access_lost"], [404, {}, 503, "notion_access_lost"], [429, { "retry-after": "90" }, 503, "notion_rate_limited"], [400, {}, 502, "notion_unavailable"], [500, {}, 502, "notion_unavailable"]];
  for (const [notion, headers, status, code] of cases) {
    noBackoff();
    stub.on(queryPath, () => notionResponse({ message: `private detail ${testToken}` }, notion, headers));
    const answer = await get(key);
    assert.equal(answer.status, status, String(notion));
    assert.equal(answer.body.code, code);
    assert.ok(!answer.text.includes("private detail"));
    assert.ok(!answer.text.includes(testToken));
    if (notion === 429) assert.equal(answer.headers.get("retry-after"), "90");
    assert.match(JSON.stringify(h.test.rows("SELECT last_error FROM part_requests_orders_state")), new RegExp(`notion_${notion}`));
  }
  noBackoff();
  stub.on(queryPath, () => { throw new TypeError(`network ${testToken}`); });
  const network = await get(key);
  assert.equal(network.status, 502);
  assert.ok(!network.text.includes(testToken));
});

test("cache: a reply with no results list is a failure, not an empty list", async () => {
  const key = await ready();
  answerWith(row(1));
  await get(key);
  ageCopy(ordersFreshMs);
  stub.on(queryPath, () => notionResponse({ object: "list", has_more: false }));
  const answer = await get(key);
  assert.equal(answer.body.refreshError, "notion_response");
  assert.equal(answer.body.orders.length, 1, "the copy survives");
  stub.on(queryPath, () => new Response("<html>", { status: 200 }));
  noBackoff();
  assert.equal((await get(key)).body.refreshError, "notion_response");
});

test("cache: only one request reads Notion at a time; the other waits and makes no call", async () => {
  const key = await ready();
  const other = await h.pair(discordB);
  let release = (_: Response) => {};
  stub.on(queryPath, () => new Promise<Response>((resolve) => { release = resolve; }));
  const slow = get(key);
  await new Promise((done) => setTimeout(done, 20));
  const waiting = await get(other);
  assert.equal(waiting.status, 202);
  assert.equal(queries().length, 1);
  release(list([row(1)]));
  assert.equal((await slow).body.orders.length, 1);
});

test("cache: a lost race for the claim is the same wait", async () => {
  const key = await ready();
  const other = await h.pair(discordB);
  answerWith(row(1));
  const answers = await Promise.all([get(key), get(other)]);
  assert.equal(queries().length, 1);
  assert.deepEqual(answers.map((answer) => answer.status).sort(), [200, 202]);
});

test("cache: connecting again and removing the token forget the copy", async () => {
  const key = await ready();
  answerWith(row(1));
  await get(key);
  assert.equal(h.test.rows("SELECT * FROM part_requests_orders_cache").length, 1);
  stub.dataSources = [{ id: dataSourceId, name: "Ordering" }, { id: otherDataSourceId, name: "Archive" }];
  await h.admin("POST", "/connection", { databaseUrl: databaseId, dataSourceId: otherDataSourceId });
  assert.equal(h.test.rows("SELECT * FROM part_requests_orders_cache").length, 0);
  stub.calls.length = 0;
  stub.on(/^POST \/data_sources\//, () => list([row(2)]));
  const moved = await get(key);
  assert.equal(moved.body.orders[0].id, orderId(2));
  assert.ok(stub.calls[0]!.url.includes(otherDataSourceId));
  await h.admin("DELETE", "/token");
  assert.equal(h.test.rows("SELECT * FROM part_requests_orders_cache").length, 0);
  const stopped = await get(key);
  assert.equal(stopped.status, 503);
  assert.equal(stopped.body.code, "notion_not_connected");
});

test("cache: a changed database answers schema_changed, and an unreadable token says so, with no Notion call", async () => {
  const key = await ready();
  h.test.run("UPDATE part_requests_notion SET schema_error='broken'");
  assert.equal((await get(key)).body.code, "notion_schema_changed");
  h.test.run("UPDATE part_requests_notion SET schema_error=NULL,ciphertext='AAAA'");
  const unreadable = await get(key);
  assert.equal(unreadable.status, 503);
  assert.equal(unreadable.body.code, "credentials_unreadable");
  assert.equal(queries().length, 0);
});

test("the job prunes a copy nobody has used for a day, and expired marks", async () => {
  const key = await ready();
  answerWith(row(1));
  await get(key);
  await mark(key, [{ orderId: orderId(1), quantity: 1 }]);
  h.test.run("UPDATE part_requests_cart_marks SET expires_ms=1");
  h.test.run("UPDATE part_requests_orders_state SET published_ms=published_ms-?", 25 * 60 * 60_000);
  await h.runJob();
  assert.equal(h.test.rows("SELECT * FROM part_requests_cart_marks").length, 0);
  assert.equal(h.test.rows("SELECT * FROM part_requests_orders_cache").length, 0);
  assert.equal(h.test.rows<{ published_ms: number | null }>("SELECT published_ms FROM part_requests_orders_state")[0]!.published_ms, null);
  stub.calls.length = 0;
  answerWith(row(1));
  assert.equal((await get(key)).status, 200);
  assert.equal(queries().length, 1, "and it reads afresh");
});

// ---- Rate limits

test("rate limit: Notion reads and mark writes count; cached reads do not", async () => {
  const key = await ready();
  answerWith(row(1));
  await get(key);
  const counted = () => h.test.rows<{ requests: number }>("SELECT requests FROM part_requests_device_limits WHERE bucket='general'")[0]!.requests;
  assert.equal(counted(), 1, "the read that went to Notion");
  await get(key);
  assert.equal(counted(), 1, "no write for a cached read");
  await mark(key, [{ orderId: orderId(1), quantity: 1 }]);
  await clear(key);
  assert.equal(counted(), 3);
  h.test.run("UPDATE part_requests_device_limits SET requests=?", maximumGeneral);
  const limited = await mark(key, [{ orderId: orderId(1), quantity: 1 }]);
  assert.equal(limited.status, 429);
  assert.equal(limited.body.code, "rate_limited");
  assert.ok(Number(limited.headers.get("retry-after")) > 0);
  assert.equal(h.test.rows("SELECT * FROM part_requests_cart_marks").length, 0, "nothing is recorded");
  h.test.run("UPDATE part_requests_device_limits SET requests=?", maximumGeneral);
  assert.equal((await clear(key)).status, 429);
});

test("rate limit: an over-limit device gets the copy, or 429 with none, and no Notion call", async () => {
  const key = await ready();
  answerWith(row(1));
  await get(key);
  ageCopy(ordersFreshMs);
  h.test.run("UPDATE part_requests_device_limits SET requests=?", maximumGeneral);
  stub.calls.length = 0;
  const served = await get(key);
  assert.equal(served.status, 200);
  assert.equal(served.body.refreshError, "rate_limited");
  assert.equal(queries().length, 0);
  const lease = h.test.rows<{ lease_until_ms: number }>("SELECT lease_until_ms FROM part_requests_orders_state")[0]!;
  assert.equal(lease.lease_until_ms, 0, "and it holds no lease");
  await h.admin("POST", "/connection", { databaseUrl: databaseId, dataSourceId });
  stub.calls.length = 0;
  const refused = await get(key);
  assert.equal(refused.status, 429);
  assert.equal(queries().length, 0);
});

// ---- Marks

test("marks: recorded per order with member, device, time and quantity, and shown to everyone with whose it is", async () => {
  const key = await h.connect().then(() => h.pair(undefined, "Workshop laptop"));
  const other = await h.pair(discordB, "Other device");
  answerWith(row(1), row(2));
  const before = Date.now();
  const saved = await mark(key, [{ orderId: orderId(1), quantity: 3 }]);
  assert.equal(saved.status, 201);
  assert.equal(saved.body.marked, 1);
  assert.equal(saved.body.expiresMs - saved.body.markedMs, cartMarkLifetimeMs);
  assert.equal(cartMarkLifetimeMs, 14 * 24 * 60 * 60_000);
  const stored = h.test.rows<any>("SELECT * FROM part_requests_cart_marks")[0];
  assert.equal(stored.order_id, orderId(1));
  assert.equal(stored.member_id, "m-a");
  assert.equal(stored.quantity, 3);
  assert.ok(stored.marked_ms >= before);
  const device = h.test.rows<any>("SELECT id,last_used_ms FROM part_requests_devices WHERE id=?", stored.device_id)[0];
  assert.ok(device.last_used_ms >= before, "it counts as using the device");
  const mine = (await get(key)).body.orders;
  assert.deepEqual(mine[0].cartMarks, [{ memberName: "Test Student A", deviceLabel: "Workshop laptop", quantity: 3, markedMs: saved.body.markedMs, expiresMs: saved.body.expiresMs, ownDevice: true }]);
  assert.deepEqual(mine[1].cartMarks, []);
  assert.equal((await get(other)).body.orders[0].cartMarks[0].ownDevice, false);
  assert.ok(!JSON.stringify(mine).includes(stored.device_id), "device IDs are not handed out");
});

test("marks: show straight away on a cached list; marking again replaces this device's mark; two devices both show", async () => {
  const key = await ready();
  const other = await h.pair(discordB);
  answerWith(row(1));
  await get(key);
  stub.calls.length = 0;
  await mark(key, [{ orderId: orderId(1), quantity: 1 }]);
  await mark(key, [{ orderId: orderId(1), quantity: 4 }]);
  await mark(other, [{ orderId: orderId(1), quantity: 2 }]);
  const marks = (await get(key)).body.orders[0].cartMarks;
  assert.deepEqual(marks.map((item: { quantity: number; ownDevice: boolean }) => [item.quantity, item.ownDevice]).sort(), [[2, false], [4, true]]);
  assert.equal(queries().length, 0, "marks never need Notion");
});

test("marks: expire, and an expired mark is not shown and is removed by the next write", async () => {
  const key = await ready();
  answerWith(row(1));
  await mark(key, [{ orderId: orderId(1), quantity: 1 }]);
  h.test.run("UPDATE part_requests_cart_marks SET expires_ms=?", Date.now() - 1);
  assert.deepEqual((await get(key)).body.orders[0].cartMarks, []);
  assert.equal(h.test.rows("SELECT * FROM part_requests_cart_marks").length, 1);
  await mark(key, [{ orderId: orderId(2), quantity: 1 }]);
  assert.deepEqual(h.test.rows<{ order_id: string }>("SELECT order_id FROM part_requests_cart_marks").map((item) => item.order_id), [orderId(2)]);
});

test("marks: bad input is refused and nothing is saved, so one bad item cannot half-apply", async () => {
  const key = await ready();
  const good = { orderId: orderId(1), quantity: 1 };
  const bad: unknown[] = [undefined, null, "x", {}, [], [null], [{ orderId: "nope", quantity: 1 }], [{ orderId: orderId(1) }], [{ orderId: orderId(1), quantity: 0 }], [{ orderId: orderId(1), quantity: -1 }], [{ orderId: orderId(1), quantity: "2" }], [{ orderId: orderId(1), quantity: 1e12 }], [{ orderId: orderId(1).toUpperCase(), quantity: 1 }], [good, { ...good, memberName: "Someone Else" }], [good, { orderId: "'; DROP TABLE x;--", quantity: 1 }], Array.from({ length: maximumMarksPerRequest + 1 }, (_, index) => ({ orderId: orderId(index), quantity: 1 }))];
  for (const marks of bad) {
    const answer = await mark(key, marks);
    assert.equal(answer.status, 400, JSON.stringify(marks)?.slice(0, 80));
    assert.equal(answer.body.code, "validation");
  }
  assert.equal(h.test.rows("SELECT * FROM part_requests_cart_marks").length, 0);
  assert.equal((await mark(key, Array.from({ length: maximumMarksPerRequest }, (_, index) => ({ orderId: orderId(index), quantity: 1.5 })))).status, 201);
  assert.equal(h.test.rows("SELECT * FROM part_requests_cart_marks").length, maximumMarksPerRequest);
  assert.equal((await mark(key, [good, { ...good, quantity: 9 }])).body.marked, 1, "the same order twice in one request is one mark");
});

test("marks: one device cannot fill the table", async () => {
  const key = await ready();
  h.test.run("INSERT INTO part_requests_cart_marks(installation_id,order_id,device_id,member_id,quantity,marked_ms,expires_ms) WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<?) SELECT 'primary',printf('0e000000-0000-4000-8000-%012d',i),(SELECT id FROM part_requests_devices),'m-a',1,1,? FROM n", maximumMarksPerDevice, Date.now() + 1000);
  const refused = await mark(key, [{ orderId: orderId(1), quantity: 1 }]);
  assert.equal(refused.status, 409);
  assert.equal(refused.body.code, "too_many_marks");
  assert.equal((await clear(key)).body.cleared, maximumMarksPerDevice);
  assert.equal((await mark(key, [{ orderId: orderId(1), quantity: 1 }])).status, 201);
});

test("clearing: only this device's marks, all of them or the ones named", async () => {
  const key = await ready();
  const second = await h.pair(undefined, "Same member, other device");
  const other = await h.pair(discordB);
  await mark(key, [{ orderId: orderId(1), quantity: 1 }, { orderId: orderId(2), quantity: 1 }, { orderId: orderId(3), quantity: 1 }]);
  await mark(second, [{ orderId: orderId(1), quantity: 1 }]);
  await mark(other, [{ orderId: orderId(1), quantity: 1 }]);
  const count = () => h.test.rows("SELECT * FROM part_requests_cart_marks").length;
  assert.equal(count(), 5);
  assert.deepEqual((await clear(key, { orderIds: [orderId(2), orderId(9)] })).body, { cleared: 1 });
  assert.equal(count(), 4);
  assert.deepEqual((await clear(key)).body, { cleared: 2 });
  assert.equal(count(), 2, "the same member's other device and another member's device keep theirs");
  assert.deepEqual((await clear(key)).body, { cleared: 0 });
  for (const orderIds of ["x", ["nope"], [7], Array.from({ length: maximumMarksPerRequest + 1 }, () => orderId(1))]) assert.equal((await clear(second, { orderIds })).status, 400);
  assert.equal(count(), 2);
});

test("marks go with the device's member, and are kept when a device is only revoked", async () => {
  const key = await ready();
  await mark(key, [{ orderId: orderId(1), quantity: 1 }]);
  await h.call("POST", "/public/part-requests/devices/self/revoke", { key });
  assert.equal(h.test.rows("SELECT * FROM part_requests_cart_marks").length, 1, "the cart is still built");
  h.test.run("DELETE FROM members WHERE id='m-a'");
  assert.equal(h.test.rows("SELECT * FROM part_requests_cart_marks").length, 0);
});

// ---- The Admin switch

test("switch: on by default, reported in /options and /status", async () => {
  const key = await ready();
  assert.equal((await h.admin("GET", "/status")).body.cartsEnabled, true);
  assert.equal((await h.call("GET", "/public/part-requests/options", { key })).body.cartsEnabled, true);
});

test("switch: off gives a clear refusal with no Notion call, refuses marks, keeps requests, and clearing still works", async () => {
  const key = await ready();
  answerWith(row(1));
  await get(key);
  await mark(key, [{ orderId: orderId(1), quantity: 1 }]);
  stub.calls.length = 0;
  const off = await carts(false);
  assert.equal(off.status, 200);
  assert.equal(off.body.cartsEnabled, false);
  assert.equal(h.test.rows("SELECT * FROM part_requests_orders_cache").length, 0, "the copy of team data is forgotten");
  const refused = await get(key);
  assert.equal(refused.status, 403);
  assert.deepEqual(refused.body, { error: cartsDisabledMessage, code: "carts_disabled" });
  assert.equal((await get(key, "?refresh=1")).status, 403);
  const marked = await mark(key, [{ orderId: orderId(2), quantity: 1 }]);
  assert.equal(marked.status, 403);
  assert.equal(marked.body.code, "carts_disabled");
  assert.equal(stub.calls.length, 0);
  assert.equal((await clear(key)).body.cleared, 1, "a device can still tidy up");
  const options = await h.call("GET", "/public/part-requests/options", { key });
  assert.equal(options.status, 200);
  assert.equal(options.body.cartsEnabled, false);
  const on = await carts(true);
  assert.equal(on.body.cartsEnabled, true);
  answerWith(row(2));
  assert.equal((await get(key)).body.orders[0].id, orderId(2));
});

test("switch: revoked devices get pair_again before the switch is mentioned", async () => {
  const key = await ready();
  await carts(false);
  await h.call("POST", "/public/part-requests/devices/self/revoke", { key });
  assert.equal((await get(key)).body.code, "pair_again");
});

test("switch: Admin only, from the dashboard, with a boolean, audited, and it can be set before the token", async () => {
  assert.equal((await carts(false, { role: "operator", origin: dashboard })).status, 403);
  assert.equal((await carts(false, {})).status, 403, "not from the dashboard");
  assert.equal(h.test.rows("SELECT * FROM part_requests_settings").length, 0);
  for (const enabled of ["false", 0, null, undefined]) assert.equal((await carts(enabled)).status, 400);
  assert.equal((await h.call("PUT", "/module-setup/part-requests/carts", { origin: dashboard, body: { enabled: true, extra: 1 } })).status, 400);
  const off = await carts(false);
  assert.equal(off.status, 200);
  assert.equal(off.body.cartsEnabled, false);
  assert.equal(off.body.siteAddress, dashboard);
  assert.equal(off.body.problem, "notion_not_connected", "it does not count as setup");
  assert.equal(await api.setup.stepValid(h.db, "notion-connection"), false);
  await h.connect();
  assert.equal((await h.admin("GET", "/status")).body.cartsEnabled, false, "connecting does not turn it back on");
  assert.deepEqual(h.test.rows<{ action: string }>("SELECT action FROM audit_log WHERE action LIKE '%carts%'").map((item) => item.action), ["part_requests.carts_disabled"]);
});

// ---- Who may ask

test("a revoked key, an off-roster member and no key are all pair_again, on every Carts route, with no Notion call", async () => {
  const revoked = await ready();
  const offRoster = await h.pair(discordB);
  await h.call("POST", "/public/part-requests/devices/self/revoke", { key: revoked });
  h.test.run("UPDATE members SET active=0 WHERE id='m-b'");
  stub.calls.length = 0;
  for (const key of [revoked, offRoster, "x".repeat(43), undefined]) {
    for (const answer of [await h.call("GET", "/public/part-requests/orders", { key }), await h.call("POST", "/public/part-requests/orders/marks", { key, body: { marks: [{ orderId: orderId(1), quantity: 1 }] } }), await h.call("POST", "/public/part-requests/orders/marks/clear", { key, body: {} })]) {
      assert.equal(answer.status, 401);
      assert.equal(answer.body.code, "pair_again");
    }
  }
  assert.equal(stub.calls.length, 0);
  assert.equal(h.test.rows("SELECT * FROM part_requests_cart_marks").length, 0);
  h.test.run("UPDATE members SET active=1 WHERE id='m-b'");
  answerWith(row(1));
  assert.equal((await get(offRoster)).status, 200, "rejoining the roster restores the device");
});

test("a device revoked between the check and the write records nothing", async () => {
  const key = await ready();
  const realPrepare = h.db.prepare;
  h.db.prepare = (sql: string) => {
    if (sql.startsWith("INSERT INTO part_requests_cart_marks")) h.test.run("UPDATE part_requests_devices SET revoked_ms=1");
    return realPrepare(sql);
  };
  const answer = await mark(key, [{ orderId: orderId(1), quantity: 1 }]);
  assert.equal(answer.status, 401);
  assert.equal(h.test.rows("SELECT * FROM part_requests_cart_marks").length, 0);
});

test("refused: a 401, 403 or 404 reading orders shows on the Admin page and the next read clears it; a 500 or 429 does not set it", async () => {
  await h.connect();
  const key = await h.pair();
  const status = async () => (await h.admin("GET", "/status")).body.problem;
  for (const [code, problem] of [[401, "notion_token_rejected"], [403, "notion_access_lost"], [404, "notion_access_lost"], [500, null], [429, null]] as const) {
    stub.restore(); stub = stubNotion();
    stub.on(queryPath, () => notionResponse({ code: "stub" }, code));
    noBackoff(); ageCopy(0);
    await get(key);
    assert.equal(await status(), problem, String(code));
    stub.restore(); stub = stubNotion();
    stub.on(queryPath, () => notionResponse({ object: "list", results: [], has_more: false, next_cursor: null }));
    noBackoff();
    assert.equal((await get(key)).status, 200);
    assert.equal(await status(), null, `cleared after ${code}`);
    h.test.run("UPDATE part_requests_orders_state SET published_ms=published_ms-3600000");
  }
});

test("the Notion token is in no answer, no table, and only ever in the Authorization header", async () => {
  const key = await ready();
  answerWith(row(1));
  const answers = [await get(key), await mark(key, [{ orderId: orderId(1), quantity: 1 }]), await get(key), await carts(false), await get(key), await clear(key), await carts(true)];
  for (const answer of answers) assert.ok(!answer.text.includes(testToken));
  stub.on(queryPath, () => notionResponse({ message: testToken }, 500));
  const failing = await get(key);
  assert.ok(!failing.text.includes(testToken));
  for (const table of ["part_requests_orders_state", "part_requests_orders_cache", "part_requests_cart_marks"]) assert.ok(!JSON.stringify(h.test.rows(`SELECT * FROM ${table}`)).includes(testToken));
  for (const call of queries()) { assert.ok(!JSON.stringify(call.body).includes(testToken)); assert.ok(!call.url.includes(testToken)); }
});

test("credentials being unavailable is an Admin's problem, stated plainly, with no Notion call", async () => {
  const shared = testCredentials();
  h = createHarness(api, { credentials: shared });
  const key = await ready();
  (shared as { available: boolean }).available = false;
  const answer = await get(key);
  assert.equal(answer.status, 503);
  assert.equal(answer.body.code, "credentials_unavailable");
  assert.equal(queries().length, 0);
});

// ---- Cost

test("query counts: Workers Free sized", async () => {
  const key = await ready();
  answerWith(row(1), row(2));
  const measure = async (run: () => Promise<unknown>) => { h.state.queries = 0; await run(); return h.state.queries; };
  const refresh = await measure(() => get(key));
  assert.equal(queries().length, 1);
  assert.ok(refresh <= 4, `a refresh of one page: ${refresh}`);
  assert.equal(await measure(() => get(key)), 2, "a cached read: the checks, then the copy and the marks");
  assert.ok(await measure(() => mark(key, [{ orderId: orderId(1), quantity: 1 }])) <= 4);
  assert.ok(await measure(() => clear(key)) <= 3);
  assert.equal(await measure(() => h.call("GET", "/public/part-requests/options", { key })), 2, "/options does not grow");
  h.test.run("UPDATE part_requests_orders_state SET published_ms=1");
  h.test.run("INSERT INTO part_requests_recipients(installation_id,notion_user_id,name,last_seen_ms) VALUES ('primary',?,'Test Looked Up',1)", namelessGuest);
  answerWith(row(1, { people: [{ object: "user", id: namelessGuest }] }));
  assert.ok(await measure(() => get(key)) <= 5, "a refresh that looks a name up");
});

test("a page of the most rows and longest text stays well under D1's row limit", async () => {
  const key = await ready();
  const long = "x".repeat(5000);
  answerWith(...Array.from({ length: ordersPageSize }, (_, index) => row(index + 1, { title: long, sku: long, url: `https://www.revrobotics.com/${"y".repeat(1900)}`, people: Array.from({ length: 30 }, (_, person) => ({ object: "user", id: `p${person}`, type: "person", name: long })) })));
  const { body } = await get(key);
  assert.equal(body.orders[0].description.length, 2000);
  assert.equal(body.orders[0].sku.length, 500);
  assert.equal(body.orders[0].requesters.length, 20);
  const size = h.test.rows<{ size: number }>("SELECT MAX(length(orders_json)) AS size FROM part_requests_orders_cache")[0]!.size;
  assert.ok(size < 2_000_000 * 0.5, `one page is ${size} bytes`);
});

// ---- Declarations

test("the Carts tables are not in backups, are cleaned up, and the setup version stays 1", () => {
  const nonPortable = manifest.backup.nonPortableTables as readonly string[];
  for (const table of ["part_requests_orders_state", "part_requests_orders_cache", "part_requests_cart_marks"]) {
    assert.ok(nonPortable.includes(table), table);
    assert.ok(!(manifest.backup.tables as readonly string[]).includes(table), table);
    assert.ok(api.cleanup.steps.some((step: { table?: string }) => step.table === table), table);
  }
  assert.deepEqual(api.backup, { version: 1, tables: { part_requests_settings: ["installation_id", "site_address", "updated_ms"] } }, "the switch does not change the backup format");
  assert.equal(manifest.setup.version, 1);
});
