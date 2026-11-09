// Notion: reading a database's layout, checking a request and calling the API. Ported from the browser extension's client,
// which was tested live. Traps it records, all kept here: Notion links redirect to app.notion.com; `fetch` must not be stored
// and called as a method; property IDs must be compared decoded; `filter_properties` silently returns rows without the
// property; `/users` leaves out guests; a page is created with properties only.
//
// Differences from the extension, because this runs on Cloudflare Workers: `redirect: "error"` throws a TypeError there, so
// redirects are "manual" and treated as failures, and there is no `credentials` option to send.
import { vendorForUrl, vendors } from "./vendors.ts";

export const notionVersion = "2026-03-11";
export const notionApiOrigin = "https://api.notion.com";
const notionTimeoutMs = 20_000;

export const statusNormal = "NORMAL Request";
export const statusIncomplete = "Incomplete Request";

export class AppError extends Error {
  readonly code: string;
  /** True when Notion may have created the page. An uncertain create is never sent again automatically. */
  readonly uncertain: boolean;
  readonly details: unknown;
  constructor(message: string, code = "validation", uncertain = false, details?: unknown) {
    super(message);
    this.code = code; this.uncertain = uncertain; this.details = details;
  }
}

type Json = Record<string, any>;
export type Person = { readonly id: string; readonly name: string };
export type Choice = { readonly id: string; readonly name: string };
export type PropertyMapping = { readonly id: string; readonly type: string; readonly options?: readonly Choice[] };
export type Field = "description" | "status" | "vendor" | "team" | "recipient" | "sku" | "url" | "quantity" | "price" | "total";
export type Schema = { readonly dataSourceId: string; readonly dataSourceName?: string; readonly databaseId: string; readonly properties: Readonly<Record<Field, PropertyMapping>> };
export type RequestDraft = {
  readonly description: string; readonly status: string; readonly url: string; readonly sku: string; readonly team: string;
  readonly recipient: string; readonly quantity: number | null; readonly price: number | null; readonly currencyConfirmed: boolean;
};

const fields: Readonly<Record<Field, { readonly name: string; readonly types: readonly string[] }>> = {
  description: { name: "Item Description", types: ["title"] },
  status: { name: "Status", types: ["status", "select"] },
  vendor: { name: "Vendor", types: ["select"] },
  team: { name: "Team", types: ["select", "multi_select"] },
  recipient: { name: "Orderer/Recipient", types: ["people"] },
  sku: { name: "SKU", types: ["rich_text"] },
  url: { name: "Product URL", types: ["url"] },
  quantity: { name: "Qty", types: ["number"] },
  price: { name: "Unit Price", types: ["number"] },
  total: { name: "Extension", types: ["formula", "rollup"] },
};

const notionHosts = ["notion.so", "notion.com", "notion.site"];
const onNotionHost = (hostname: string) => notionHosts.some((host) => hostname === host || hostname.endsWith(`.${host}`));

/** Notion reports the same property ID encoded in some places and plain in others. */
export function decodedId(id: unknown): string {
  try { return decodeURIComponent(String(id)); } catch { return String(id); }
}

/** The database or page ID in a Notion link or a bare ID. A `?v=` value identifies a view and is ignored. */
export function notionId(input: string): string {
  let path = input.trim();
  if (/^https?:/i.test(path)) {
    let url: URL;
    try { url = new URL(path); } catch { throw new AppError("Enter a valid Notion URL or ID."); }
    if (url.protocol !== "https:" || url.username || url.password || !onNotionHost(url.hostname)) throw new AppError("Use a Notion page or database URL.");
    path = url.pathname;
  }
  const match = path.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{32})(?:\/)?$/i)?.[1];
  if (!match) throw new AppError("The URL must contain a Notion page or database ID. Copy its full link from Notion.");
  const hex = match.replaceAll("-", "").toLowerCase();
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** A data source's own title, which is rich text. The database lists the same name, and either may be missing. */
const sourceTitle = (source: Json): string => Array.isArray(source.title) ? source.title.map((part: Json) => String(part?.plain_text ?? "")).join("") : "";

/**
 * Match a data source's properties to the expected layout. `previous` keeps a field mapped across a rename in Notion, and
 * `listedName` is the name the database gave this data source, for the Admin pages.
 */
export function mapSchema(source: Json, databaseId: string, previous?: Schema, listedName?: string): Schema {
  const properties = {} as Record<Field, PropertyMapping>;
  const values = Object.values(source.properties ?? {}) as Json[];
  for (const [field, expected] of Object.entries(fields) as [Field, (typeof fields)[Field]][]) {
    const old = previous?.properties[field];
    const property = (old && values.find((item) => decodedId(item.id) === decodedId(old.id))) || source.properties?.[expected.name];
    if (!property || !expected.types.includes(property.type)) throw new AppError(`Notion property "${expected.name}" must exist with type ${expected.types.join(" or ")}. Check the source database; no properties were changed.`, "schema");
    const options = property[property.type]?.options?.map((option: Json) => ({ id: String(option.id), name: String(option.name) })) as Choice[] | undefined;
    properties[field] = { id: String(property.id), type: String(property.type), ...(options ? { options } : {}) };
  }
  for (const status of [statusNormal, statusIncomplete]) if (!properties.status.options?.some((option) => option.name === status)) throw new AppError(`Add or restore the existing "${status}" status in Notion before connecting.`, "schema");
  const missing = vendors.filter((vendor) => !properties.vendor.options?.some((option) => option.name === vendor.label));
  if (missing.length) throw new AppError(`Vendor options missing from Notion: ${missing.map((vendor) => vendor.label).join(", ")}. Select the team's ordering database with all ${vendors.length} vendor options.`, "schema");
  if (!properties.team.options?.length) throw new AppError("The Team property needs at least one existing option.", "schema");
  const name = (listedName || sourceTitle(source) || previous?.dataSourceName || "").trim().slice(0, 200);
  return { dataSourceId: String(source.id), ...(name ? { dataSourceName: name } : {}), databaseId, properties };
}

const draftKeys = new Set(["description", "status", "url", "sku", "team", "recipient", "quantity", "price", "currencyConfirmed"]);

/** The request as sent, if it has exactly the expected fields of the expected kinds. Values are checked by validateDraft. */
export function parseDraft(value: unknown): RequestDraft | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const draft = value as Record<string, unknown>;
  if (Object.keys(draft).some((key) => !draftKeys.has(key))) return undefined;
  for (const key of ["description", "status", "url", "sku", "team", "recipient"]) if (typeof draft[key] !== "string") return undefined;
  for (const key of ["quantity", "price"]) if (draft[key] !== null && typeof draft[key] !== "number") return undefined;
  if (typeof draft.currencyConfirmed !== "boolean") return undefined;
  return draft as unknown as RequestDraft;
}

const largestNumber = 1_000_000_000;

/** Every problem with a request, in words a student can act on. An empty list means it can be sent. */
export function validateDraft(draft: RequestDraft, schema: Schema, recipientKnown: boolean): string[] {
  const errors: string[] = [];
  if (!vendorForUrl(draft.url)) errors.push(`Use a product URL from one of the ${vendors.length} supported stores.`);
  if (!draft.description.trim()) errors.push("Enter an item description.");
  if (draft.status !== statusNormal && draft.status !== statusIncomplete) errors.push("Choose NORMAL Request or Incomplete Request.");
  for (const [label, value] of [["Description", draft.description], ["SKU", draft.sku], ["URL", draft.url]] as const) {
    if (value.length > 2000) errors.push(`${label} must be text of at most 2,000 characters.`);
  }
  const full = draft.status === statusNormal;
  if (full && !draft.team) errors.push("Choose a team.");
  if (draft.team && !schema.properties.team.options?.some((team) => team.id === draft.team)) errors.push("The selected team is no longer available. Refresh and choose again.");
  if (full && !draft.recipient) errors.push("Choose an orderer/recipient.");
  if (draft.recipient && !recipientKnown) errors.push("Choose a person from the list.");
  if (full && draft.quantity === null) errors.push("Enter a quantity.");
  if (draft.quantity !== null && (!Number.isFinite(draft.quantity) || draft.quantity <= 0 || draft.quantity > largestNumber)) errors.push("Quantity must be greater than zero.");
  if (full && draft.price === null) errors.push("Enter a unit price in USD.");
  if (draft.price !== null && (!Number.isFinite(draft.price) || draft.price < 0 || draft.price > largestNumber)) errors.push("Unit price must be zero or greater.");
  if (draft.price !== null && draft.currencyConfirmed !== true) errors.push("Confirm that the unit price you entered is in USD.");
  return errors;
}

/** The body of `POST /pages`: a parent and properties, with no body blocks and no template. The formula is never written. */
export function pagePayload(draft: RequestDraft, schema: Schema): Json {
  const map = schema.properties;
  const rich = (value: string) => [{ type: "text", text: { content: value.trim() } }];
  const choice = (property: PropertyMapping, id: string) => ({ [property.type]: property.type === "multi_select" ? [{ id }] : { id } });
  const vendor = vendorForUrl(draft.url);
  const vendorOption = map.vendor.options?.find((option) => option.name === vendor?.label);
  const status = map.status.options?.find((option) => option.name === draft.status);
  if (!vendorOption || !status) throw new AppError("Notion options changed. An Admin needs to check the connection.", "schema");
  const properties: Json = {
    [map.description.id]: { title: rich(draft.description) },
    [map.status.id]: choice(map.status, status.id),
    [map.vendor.id]: choice(map.vendor, vendorOption.id),
    [map.url.id]: { url: draft.url.trim() },
  };
  if (draft.team) properties[map.team.id] = choice(map.team, draft.team);
  if (draft.recipient) properties[map.recipient.id] = { people: [{ object: "user", id: draft.recipient }] };
  if (draft.sku.trim()) properties[map.sku.id] = { rich_text: rich(draft.sku) };
  if (draft.quantity !== null) properties[map.quantity.id] = { number: draft.quantity };
  if (draft.price !== null) properties[map.price.id] = { number: draft.price };
  return { parent: { type: "data_source_id", data_source_id: schema.dataSourceId }, properties };
}

const validPageUrl = (value: unknown) => {
  try {
    const url = new URL(String(value));
    return url.protocol === "https:" && onNotionHost(url.hostname) ? url.href : undefined;
  } catch { return undefined; }
};

export class NotionClient {
  readonly #token: string;
  constructor(token: string) { this.#token = token; }

  async #request(path: string, method = "GET", body?: unknown): Promise<Json> {
    if (!/^\/(?:databases|data_sources|pages|users)(?:\/|\?|$)/.test(path)) throw new AppError("Unsupported Notion operation.");
    const creating = method === "POST" && path === "/pages";
    let response: Response;
    try {
      // Called as a plain function on purpose: a stored `fetch` called as a method throws "Illegal invocation".
      response = await fetch(`${notionApiOrigin}/v1${path}`, {
        method, headers: { Authorization: `Bearer ${this.#token}`, "Notion-Version": notionVersion, "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: "manual", signal: AbortSignal.timeout(notionTimeoutMs),
      });
    } catch {
      throw new AppError("Could not confirm the Notion response.", "notion_network", creating);
    }
    if (!response.ok) {
      const status = response.status;
      const retryAfter = Number(response.headers.get("retry-after"));
      const message = status === 401 ? "The Notion token is invalid or expired. An Admin needs to replace it."
        : status === 403 ? "The connection lacks permission. Check its content and user capabilities."
        : status === 404 ? "Notion cannot access that database or page. Add the connection to the database and check its link."
        : status === 429 ? "Notion is rate limiting requests. Wait a moment before trying again."
        : status === 400 ? "Notion rejected the request. Check the fields, or ask an Admin to check the connection."
        : status === 409 ? "Notion reported a conflict. Check the database before trying again."
        : "Notion did not confirm the operation. Check the database before trying again.";
      throw new AppError(message, `notion_${status}`, creating && (status >= 500 || status === 409 || status < 400), Number.isFinite(retryAfter) && retryAfter > 0 ? { retryAfterSeconds: Math.ceil(retryAfter) } : undefined);
    }
    try { return await response.json() as Json; }
    catch { throw new AppError("Notion returned an unreadable response.", "notion_response", creating); }
  }

  /** Proves the token works. Throws for a rejected token. */
  async verifyToken(): Promise<void> { await this.#request("/users/me"); }

  async dataSources(databaseRef: string): Promise<{ readonly databaseId: string; readonly dataSources: readonly Choice[] }> {
    const databaseId = notionId(databaseRef);
    const database = await this.#request(`/databases/${databaseId}`);
    const dataSources = ((database.data_sources ?? []) as Json[]).map((source) => ({ id: String(source.id), name: String(source.name ?? "") }));
    if (!dataSources.length) throw new AppError("No data source was found. Use the original database link, not a page containing a linked view.", "schema");
    return { databaseId, dataSources };
  }

  /** Check one data source of a database. A database with several needs the choice made explicitly. */
  async connect(databaseRef: string, dataSourceId: string | undefined, previous?: Schema): Promise<Schema> {
    const { databaseId, dataSources } = await this.dataSources(databaseRef);
    const selected = dataSourceId ? dataSources.find((source) => source.id === dataSourceId) : dataSources.length === 1 ? dataSources[0] : undefined;
    if (!selected) throw new AppError("This database has multiple data sources. Select the ordering data source.", "data_source_required", false, { dataSources });
    return this.readSchema(selected.id, databaseId, previous, selected.name);
  }

  async readSchema(dataSourceId: string, databaseId: string, previous?: Schema, listedName?: string): Promise<Schema> {
    const source = await this.#request(`/data_sources/${dataSourceId}`);
    return mapSchema(source, databaseId, previous?.dataSourceId === source.id ? previous : undefined, listedName);
  }

  /** One page of workspace members. Bots are left out. */
  async usersPage(cursor?: string): Promise<{ readonly people: readonly Person[]; readonly next?: string }> {
    const page = await this.#request(`/users?page_size=100${cursor ? `&start_cursor=${encodeURIComponent(cursor)}` : ""}`);
    const people = ((page.results ?? []) as Json[]).filter((user) => user.type === "person" && user.id).map((user) => ({ id: String(user.id), name: String(user.name ?? "") }));
    return { people, ...(page.has_more && page.next_cursor ? { next: String(page.next_cursor) } : {}) };
  }

  /** One page of people named on existing requests, which is the only way to find guests. A name may be empty. */
  async requestPeoplePage(schema: Schema, pageSize: number, cursor?: string): Promise<{ readonly people: readonly Person[]; readonly next?: string }> {
    const recipientId = decodedId(schema.properties.recipient.id);
    const page = await this.#request(`/data_sources/${schema.dataSourceId}/query`, "POST", { page_size: pageSize, ...(cursor ? { start_cursor: cursor } : {}) });
    const found = new Map<string, string>();
    for (const row of (page.results ?? []) as Json[]) {
      const property = (Object.values(row.properties ?? {}) as Json[]).find((item) => decodedId(item.id) === recipientId);
      for (const user of (property?.people ?? []) as Json[]) if (user.id && user.type !== "bot" && !found.get(String(user.id))) found.set(String(user.id), String(user.name ?? ""));
    }
    return { people: [...found].map(([id, name]) => ({ id, name })), ...(page.has_more && page.next_cursor ? { next: String(page.next_cursor) } : {}) };
  }

  async userName(id: string): Promise<string> { return String((await this.#request(`/users/${id}`)).name ?? ""); }

  /** Create one page. Throws an uncertain AppError when Notion may have created it without confirming. */
  async create(payload: Json): Promise<string> {
    const page = await this.#request("/pages", "POST", payload);
    const url = validPageUrl(page.url);
    if (!url) throw new AppError("Notion accepted the request, but did not return a valid page link. Check the database.", "notion_response", true);
    return url;
  }
}
