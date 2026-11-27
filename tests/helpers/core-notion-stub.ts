// A stand-in for Core's `services.notion` (SDK 1.8.0), modelled on Core's apps/api/src/module-notion.ts and notion-client.ts.
// It sends real requests through `fetch`, so the fetch-boundary Notion stub (notion-stub.ts) still sees and answers every
// call, with Core's token in the Authorization header. Like Core it refuses undeclared operations and unbound databases
// before any request, caps each invocation at 8 requests, holds every call after a rate limit, refuses writes while
// deliveries are paused, strips email addresses, and implements importLegacyConnection's rules. Each Notion request
// charges `cost` with one external request and one D1 read (Core's authority check), and the first use in an invocation
// one more D1 read (Core loading its connection and bindings).
import manifest from "../../src/manifest.ts";
import type { Credentials } from "../../src/connection.ts";
import { testToken } from "./notion-stub.ts";

type Json = Record<string, any>;
export class CoreNotionError extends Error {
  readonly code: string; readonly status: number; readonly providerStatus: number | undefined; readonly uncertain: boolean; readonly retryAfterMs: number | undefined;
  constructor(message: string, code: string, options: { status?: number; providerStatus?: number; uncertain?: boolean; retryAfterMs?: number } = {}) {
    super(message);
    this.code = code; this.status = options.status ?? 502; this.providerStatus = options.providerStatus; this.uncertain = options.uncertain === true; this.retryAfterMs = options.retryAfterMs;
  }
}
/** Core's HttpError: thrown for bad input and paused deliveries, before anything is sent. Not a Notion failure. */
export class CoreHttpError extends Error { readonly status: number; constructor(status: number, message: string) { super(message); this.status = status; } }

export type CoreConnection = { token: string; ciphertext: string; enabled: boolean; readable: boolean };
export type CoreBinding = { databaseId: string; dataSourceId: string; name: string };
export type CoreNotionState = {
  connection: CoreConnection | null;
  bindings: Map<string, CoreBinding>;
  capabilities: Record<string, "ok" | "refused" | "unknown">;
  pausedUntilMs: number;
  deliveryPausedUntil: number | null;
  imports: { outcome: string; bindings: string[] }[];
  /** Make the next import throw, as a network failure or a D1 failure inside Core would. */
  importFails: boolean;
};
export type Cost = { d1: number; external: number; notion: number };

const callsPerInvocation = 8;
const format = (value: unknown) => {
  const hex = typeof value === "string" ? value.replaceAll("-", "").toLowerCase() : "";
  return /^[0-9a-f]{32}$/.test(hex) ? `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}` : undefined;
};
const same = (a: unknown, b: unknown) => format(a) !== undefined && format(a) === format(b);
const withoutEmails = (value: any): any => Array.isArray(value) ? value.map(withoutEmails) : value && typeof value === "object"
  ? Object.fromEntries(Object.entries(value).filter(([key]) => !(value.object === "user" && key === "person")).map(([key, item]) => [key, withoutEmails(item)])) : value;

/** Core's client: one request, fixed messages by status, uncertain rules for creates, Retry-After, no retries. */
async function send(token: string, path: string, method = "GET", body?: unknown, creates = false): Promise<Json> {
  let response: Response;
  try {
    response = await fetch(`https://api.notion.com/v1${path}`, {
      method, headers: { Authorization: `Bearer ${token}`, "Notion-Version": "2026-03-11", "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: "manual", signal: AbortSignal.timeout(20_000),
    });
  } catch { throw new CoreNotionError("Could not confirm the Notion response.", "notion_network", { uncertain: creates }); }
  if (!response.ok) {
    const status = response.status;
    const seconds = Number(response.headers.get("retry-after"));
    const retryAfterMs = status === 429 ? (Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds * 1000) : 1000) : undefined;
    throw new CoreNotionError(`Notion answered ${status}.`, `notion_${status}`, { status: status === 429 ? 429 : 502, providerStatus: status, uncertain: creates && (status >= 500 || status === 409 || status < 400), ...(retryAfterMs ? { retryAfterMs } : {}) });
  }
  let parsed: unknown;
  try { parsed = await response.json(); } catch { parsed = undefined; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new CoreNotionError("Notion returned an unreadable response.", "notion_response", { providerStatus: response.status, uncertain: creates });
  return parsed as Json;
}

export function createCoreNotion(credentials: Credentials) {
  const state: CoreNotionState = { connection: null, bindings: new Map(), capabilities: {}, pausedUntilMs: 0, deliveryPausedUntil: null, imports: [], importFails: false };
  const declared = (manifest as any).notion as { users?: string[]; bindings: { id: string; required: boolean; operations: string[] }[] } | undefined;

  /** Core's connection, as an Admin saving a token in Settings > Integrations > Notion leaves it. */
  async function connect(token = testToken) { state.connection = { token, ...await credentials.encrypt({ token }), enabled: true, readable: true }; }
  function bind(binding: CoreBinding) { state.bindings.set("orders", binding); }

  /** `services.notion` for one invocation (a route request or one job run). */
  function service(cost: Cost) {
    let loaded = false; let calls = 0;
    const load = () => { if (!loaded) { loaded = true; cost.d1 += 1; } };
    const refusal = (code: string, status: number) => new CoreNotionError(code, code, { status });
    const usable = () => Boolean(state.connection && state.connection.enabled && state.connection.readable);
    async function request(capability: string | undefined, path: string, method = "GET", body?: unknown, creates = false, token?: string) {
      load();
      if (token === undefined) {
        if (!state.connection) throw refusal("notion_not_configured", 503);
        if (!state.connection.enabled) throw refusal("notion_disabled", 503);
        if (!state.connection.readable) throw refusal("notion_unreadable", 503);
      }
      const now = Date.now();
      if (state.pausedUntilMs > now) throw new CoreNotionError("paused", "notion_paused", { status: 429, providerStatus: 429, retryAfterMs: state.pausedUntilMs - now });
      if (calls >= callsPerInvocation) throw refusal("notion_call_limit", 429);
      calls += 1; cost.d1 += 1; cost.external += 1; cost.notion += 1;
      try {
        const result = await send(token ?? state.connection!.token, path, method, body, creates);
        if (capability && token === undefined) state.capabilities[capability] = "ok";
        return result;
      } catch (error) {
        if (error instanceof CoreNotionError && error.providerStatus === 429) state.pausedUntilMs = Date.now() + (error.retryAfterMs ?? 1000);
        if (error instanceof CoreNotionError && error.providerStatus === 403 && capability && token === undefined) state.capabilities[capability] = "refused";
        throw error;
      }
    }
    function bound(bindingId: string, operation: string): CoreBinding {
      const binding = declared?.bindings.find((item) => item.id === bindingId);
      if (!binding || !binding.operations.includes(operation)) throw refusal("notion_not_declared", 403);
      load();
      const row = state.bindings.get(bindingId);
      if (!row) throw refusal("notion_unbound", 409);
      return row;
    }
    const pageList = (page: Json) => {
      if (!Array.isArray(page.results)) throw new CoreNotionError("Notion returned an unreadable response.", "notion_response", { providerStatus: 200 });
      return page;
    };
    return Object.freeze({
      async ready() { load(); return state.deliveryPausedUntil === null && usable() && (declared?.bindings ?? []).every((binding) => !binding.required || state.bindings.has(binding.id)); },
      async status() {
        load();
        return { connected: usable(), saved: Boolean(state.connection), enabled: Boolean(state.connection?.enabled), readable: Boolean(state.connection?.readable),
          pausedUntilMs: state.pausedUntilMs > Date.now() ? state.pausedUntilMs : null,
          capabilities: { read: "unknown", insert: "unknown", update: "unknown", comment: "unknown", users: "unknown", email: "unknown", ...state.capabilities },
          bindings: (declared?.bindings ?? []).map((binding) => ({ id: binding.id, required: binding.required, bound: state.bindings.has(binding.id) })) };
      },
      async binding(bindingId: string) {
        if (!declared?.bindings.some((item) => item.id === bindingId)) throw refusal("notion_not_declared", 403);
        load();
        const row = state.bindings.get(bindingId);
        return row ? { id: bindingId, ...row } : undefined;
      },
      async dataSource(bindingId: string) { const row = bound(bindingId, "retrieve"); return withoutEmails(await request("read", `/data_sources/${row.dataSourceId}`)); },
      async query(bindingId: string, query: { filter?: unknown; sorts?: unknown[]; pageSize?: number; cursor?: string } = {}) {
        const row = bound(bindingId, "query");
        if (Object.keys(query).some((key) => !["filter", "sorts", "pageSize", "cursor"].includes(key))) throw new CoreHttpError(400, "A Notion query takes only filter, sorts, pageSize and cursor");
        const pageSize = query.pageSize ?? 100;
        if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) throw new CoreHttpError(400, "A Notion page size is 1 to 100");
        const page = pageList(await request("read", `/data_sources/${row.dataSourceId}/query`, "POST", { page_size: pageSize, ...(query.cursor ? { start_cursor: query.cursor } : {}), ...(query.filter === undefined ? {} : { filter: query.filter }), ...(query.sorts === undefined ? {} : { sorts: query.sorts }) }));
        return { results: withoutEmails(page.results), ...(page.has_more && page.next_cursor ? { nextCursor: String(page.next_cursor) } : {}) };
      },
      async createPage(bindingId: string, input: { properties: Record<string, unknown> }) {
        if (!declared?.bindings.find((item) => item.id === bindingId)?.operations.includes("pages.create")) throw refusal("notion_not_declared", 403);
        if (!input?.properties || typeof input.properties !== "object" || !Object.keys(input.properties).length) throw new CoreHttpError(400, "Notion properties must be a non-empty object");
        if (state.deliveryPausedUntil !== null) throw new CoreHttpError(409, "Outbound delivery is paused, so nothing was sent to Notion.");
        const row = bound(bindingId, "pages.create");
        const page = await request("insert", "/pages", "POST", { parent: { type: "data_source_id", data_source_id: row.dataSourceId }, properties: input.properties }, true);
        const id = format(page.id);
        if (!id) throw new CoreNotionError("Notion accepted the request, but did not return the new page.", "notion_response", { providerStatus: 200, uncertain: true });
        let url: string | null = null;
        try { const parsed = new URL(String(page.url)); url = parsed.protocol === "https:" && /(^|\.)notion\.(so|com|site)$/.test(parsed.hostname) ? parsed.href : null; } catch { url = null; }
        return { id, url, page: withoutEmails(page) };
      },
      async page() { throw refusal("notion_not_declared", 403); },
      async updatePage() { throw refusal("notion_not_declared", 403); },
      async trashPage() { throw refusal("notion_not_declared", 403); },
      async createComment() { throw refusal("notion_not_declared", 403); },
      users: Object.freeze({
        async list(input: { cursor?: string; pageSize?: number } = {}) {
          if (!declared?.users?.includes("list")) throw refusal("notion_not_declared", 403);
          const page = pageList(await request("users", `/users?page_size=${input.pageSize ?? 100}${input.cursor ? `&start_cursor=${encodeURIComponent(input.cursor)}` : ""}`));
          return { users: (page.results as Json[]).filter((user) => user?.id).map((user) => ({ id: String(user.id), type: user.type === "bot" ? "bot" : "person", name: String(user.name ?? "") })), ...(page.has_more && page.next_cursor ? { nextCursor: String(page.next_cursor) } : {}) };
        },
        async get(userId: string) {
          if (!declared?.users?.includes("retrieve")) throw refusal("notion_not_declared", 403);
          const user = await request("users", `/users/${userId}`);
          return { id: String(user.id ?? ""), type: user.type === "bot" ? "bot" : "person", name: String(user.name ?? "") };
        },
      }),
      providerStatus: (error: unknown) => error instanceof CoreNotionError ? error.providerStatus : undefined,
      retryAfterMs: (error: unknown) => error instanceof CoreNotionError ? error.retryAfterMs : undefined,
      uncertain: (error: unknown) => error instanceof CoreNotionError && error.uncertain,
      errorCode: (error: unknown) => error instanceof CoreNotionError ? error.code : undefined,
      async importLegacyConnection(input: { ciphertext: string; iv: string; bindings?: { id: string; databaseId: string; dataSourceId: string; name: string }[] }) {
        if (state.importFails) throw new CoreNotionError("Could not confirm the Notion response.", "notion_network");
        if (typeof input?.ciphertext !== "string" || !input.ciphertext || typeof input.iv !== "string" || !input.iv) throw new CoreHttpError(400, "The Notion connection to import is incomplete");
        for (const item of input.bindings ?? []) if (!declared?.bindings.some((binding) => binding.id === item.id) || !format(item.databaseId) || !format(item.dataSourceId)) throw new CoreHttpError(400, "The Notion connection to import is incomplete");
        let token: string | undefined;
        if (credentials.available) { try { token = (await credentials.decrypt(input.ciphertext, input.iv)).token || undefined; } catch { token = undefined; } }
        if (!token) { state.imports.push({ outcome: "unreadable", bindings: [] }); return "unreadable"; }
        load();
        if (state.connection) { state.imports.push({ outcome: "kept-existing", bindings: [] }); cost.d1 += 1; loaded = false; return "kept-existing"; }
        try { await request(undefined, "/users/me", "GET", undefined, false, token); }
        catch (error) { if (error instanceof CoreNotionError && error.providerStatus === 401) { state.imports.push({ outcome: "unreadable", bindings: [] }); return "unreadable"; } throw error; }
        const confirmed: string[] = [];
        for (const item of input.bindings ?? []) {
          let source: Json;
          try { source = await request(undefined, `/data_sources/${format(item.dataSourceId)}`, "GET", undefined, false, token); }
          catch (error) { if (error instanceof CoreNotionError && error.providerStatus !== undefined && error.providerStatus >= 400 && error.providerStatus < 500 && error.providerStatus !== 429) continue; throw error; }
          if (source.parent?.type === "database_id" && same(source.parent.database_id, item.databaseId)) confirmed.push(item.id);
        }
        const encrypted = await credentials.encrypt({ token });
        // Core inserts with ON CONFLICT DO NOTHING: an import racing this one may have filled the connection meanwhile.
        if (state.connection) { state.imports.push({ outcome: "kept-existing", bindings: [] }); cost.d1 += 2; loaded = false; return "kept-existing"; }
        state.connection = { token, ...encrypted, enabled: true, readable: true };
        cost.d1 += 3; // the connection insert, the bindings batch and the audit entry
        // A database an Admin had already chosen is left alone and not reported.
        const written = confirmed.filter((id) => !state.bindings.has(id));
        for (const item of input.bindings ?? []) if (written.includes(item.id)) state.bindings.set(item.id, { databaseId: format(item.databaseId)!, dataSourceId: format(item.dataSourceId)!, name: item.name });
        state.imports.push({ outcome: "imported", bindings: written });
        loaded = false;
        return "imported";
      },
    });
  }
  return { state, connect, bind, service };
}
export type CoreNotion = ReturnType<typeof createCoreNotion>;
