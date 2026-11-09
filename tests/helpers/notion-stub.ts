// A stand-in for Notion at the fetch boundary, with responses shaped like the ones recorded from the live API. It also behaves
// as the two runtimes do where mocks usually hide bugs: it throws "Illegal invocation" when called with a receiver, as Chrome
// does for a stored native fetch, and it throws on `redirect: "error"` and `credentials`, as Cloudflare Workers do.
import { vendors } from "../../src/vendors.ts";

export const testToken = "ntn_TESTtokenNEVERrealABCDEFGHIJKLMNOPQRSTUV0123456789";
export const databaseId = "11111111-2222-4333-8444-555555555555";
export const dataSourceId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
export const otherDataSourceId = "bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee";
export const memberPerson = "c0000000-0000-4000-8000-00000000000a";
export const guestPerson = "c0000000-0000-4000-8000-00000000000b";
export const namelessGuest = "c0000000-0000-4000-8000-00000000000c";
const recipientPropertyId = "a%3Ab";

export type Call = { readonly url: string; readonly method: string; readonly headers: Record<string, string>; readonly body: any };
const response = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

const select = (id: string, options: string[]) => ({ id, type: "select", select: { options: options.map((name, index) => ({ id: `${id}-${index}`, name, color: "gray" })) } });
export function dataSource(id = dataSourceId): any {
  return {
    object: "data_source", id, title: [{ plain_text: "Ordering" }], parent: { type: "database_id", database_id: databaseId },
    properties: {
      "Item Description": { id: "title", type: "title", title: {} },
      Status: { id: "st%40t", type: "status", status: { options: [{ id: "normal", name: "NORMAL Request", color: "blue" }, { id: "incomplete", name: "Incomplete Request", color: "gray" }, { id: "rush", name: "RUSH", color: "red" }], groups: [] } },
      Vendor: select("v3nd", vendors.map((vendor) => vendor.label)),
      Team: { id: "t3am", type: "multi_select", multi_select: { options: [{ id: "team-1", name: "Test Team One", color: "green" }, { id: "team-2", name: "Test Team Two", color: "red" }] } },
      "Orderer/Recipient": { id: "a:b", type: "people", people: {} },
      SKU: { id: "skuu", type: "rich_text", rich_text: {} },
      "Product URL": { id: "urll", type: "url", url: {} },
      Qty: { id: "qtyy", type: "number", number: { format: "number" } },
      "Unit Price": { id: "pric", type: "number", number: { format: "dollar" } },
      Extension: { id: "extn", type: "formula", formula: { expression: "" } },
    },
  };
}

export function requestRow(...people: unknown[]) {
  return {
    object: "page", id: crypto.randomUUID(), url: "https://www.notion.so/row",
    properties: {
      "Item Description": { id: "title", type: "title", title: [{ plain_text: "Old request" }] },
      // Rows report this ID encoded while the data source reports it plain: compare decoded.
      "Orderer/Recipient": { id: recipientPropertyId, type: "people", people },
    },
  };
}

export type Stub = {
  readonly calls: Call[];
  /** Replace the answer to matching calls, or let them throw as a network failure would. */
  on(match: RegExp, answer: (call: Call) => Response | Promise<Response>): void;
  dataSources: { id: string; name: string }[];
  source: any;
  restore(): void;
};

export function stubNotion(): Stub {
  const original = globalThis.fetch;
  const overrides: { match: RegExp; answer: (call: Call) => Response | Promise<Response> }[] = [];
  const stub: Stub = {
    calls: [], dataSources: [{ id: dataSourceId, name: "Ordering" }], source: dataSource(),
    on(match, answer) { overrides.unshift({ match, answer }); },
    restore() { globalThis.fetch = original; },
  };
  globalThis.fetch = async function (this: unknown, input: unknown, init?: RequestInit) {
    if (this !== undefined && this !== globalThis) throw new TypeError("Illegal invocation");
    if (init?.redirect === "error") throw new TypeError('Invalid redirect value, must be one of "follow" or "manual"');
    if (init?.credentials !== undefined) throw new Error("The 'credentials' field on 'RequestInitializerDict' is not implemented.");
    const url = String(input);
    if (!url.startsWith("https://api.notion.com/v1/")) throw new Error(`Unexpected request to ${url}`);
    const headers = init?.headers as Record<string, string>;
    const call: Call = { url, method: init?.method ?? "GET", headers, body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined };
    stub.calls.push(call);
    const path = url.slice("https://api.notion.com/v1".length);
    const line = `${call.method} ${path}`;
    const override = overrides.find((item) => item.match.test(line));
    if (override) return override.answer(call);
    if (headers.Authorization !== `Bearer ${testToken}`) return response({ object: "error", status: 401, code: "unauthorized", message: "API token is invalid." }, 401);
    if (headers["Notion-Version"] !== "2026-03-11") return response({ object: "error", status: 400, code: "invalid_version" }, 400);
    if (line === "GET /users/me") return response({ object: "user", id: "b0000000-0000-4000-8000-000000000000", type: "bot", name: "Part Requests Test", bot: {} });
    if (line === `GET /databases/${databaseId}`) return response({ object: "database", id: databaseId, data_sources: stub.dataSources });
    if (line.startsWith("GET /databases/")) return response({ object: "error", status: 404, code: "object_not_found" }, 404);
    if (line.startsWith("GET /data_sources/")) return response({ ...stub.source, id: path.split("/")[2] });
    if (line.startsWith("GET /users?")) return response({ object: "list", results: [{ object: "user", id: memberPerson, type: "person", name: "Test Member", person: {} }, { object: "user", id: "b0000000-0000-4000-8000-000000000000", type: "bot", name: "A bot", bot: {} }], has_more: false, next_cursor: null });
    if (line === `POST /data_sources/${dataSourceId}/query`) {
      if (call.body.filter_properties) throw new Error("filter_properties must not be used");
      return call.body.start_cursor
        ? response({ object: "list", results: [requestRow({ object: "user", id: namelessGuest })], has_more: false, next_cursor: null })
        : response({ object: "list", results: [requestRow({ object: "user", id: guestPerson, type: "person", name: "Test Guest" }, { object: "user", id: "b1", type: "bot", name: "Automation" }), requestRow()], has_more: true, next_cursor: "next-page" });
    }
    if (line === `GET /users/${namelessGuest}`) return response({ object: "user", id: namelessGuest, type: "person", name: "Test Guest Looked Up", person: {} });
    if (line === "POST /pages") return response({ object: "page", id: crypto.randomUUID(), url: "https://app.notion.com/p/created-request" });
    return response({ object: "error", status: 404, code: "object_not_found" }, 404);
  } as typeof fetch;
  return stub;
}

export const notionResponse = response;
