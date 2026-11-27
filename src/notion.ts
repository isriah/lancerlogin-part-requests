// Notion: reading a database's layout, checking a request and calling Notion through Core's shared connection
// (`services.notion`, SDK 1.8.0). Core holds the token and sends every request; this plugin names its `orders` binding and
// never sees the token. Traps the extension's live-tested client recorded, still kept here: property IDs must be compared
// decoded; `filter_properties` silently returns rows without the property; `/users` leaves out guests; a page is created
// with properties only.
import type { NotionService } from "@lancerlogin/module-sdk/api";
import { vendorForUrl, vendors } from "./vendors.ts";

/** The one Notion database this plugin uses, as declared in the manifest's `notion.bindings`. */
export const ordersBinding = "orders";

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

/** A link to the database from its saved ID. Notion redirects it to wherever the workspace lives. */
export const databaseLink = (databaseId: string) => `https://www.notion.so/${databaseId.replaceAll("-", "")}`;

/** Notion reports the same property ID encoded in some places and plain in others. */
export function decodedId(id: unknown): string {
  try { return decodeURIComponent(String(id)); } catch { return String(id); }
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

/**
 * The properties of a new page, with no body blocks and no template. Core adds the parent from the `orders` binding, so
 * nothing here can name another database. The formula is never written.
 */
export function pageProperties(draft: RequestDraft, schema: Schema): Json {
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
  return properties;
}

export const validPageUrl = (value: unknown) => {
  try {
    const url = new URL(String(value));
    return url.protocol === "https:" && onNotionHost(url.hostname) ? url.href : undefined;
  } catch { return undefined; }
};

/** Notion IDs compared as Notion does: case and hyphens do not matter. */
export const sameId = (a: unknown, b: unknown) => typeof a === "string" && typeof b === "string" && a.replaceAll("-", "").toLowerCase() === b.replaceAll("-", "").toLowerCase();

// ---- Core's Notion connection

/** What a failed call says, by Notion's status. Fixed text only: nothing from Notion's reply, and Core never shares the token. */
const statusMessage = (status: number) => status === 401 ? "Notion rejected the token saved in Core. An Admin needs to replace it in Settings > Integrations > Notion."
  : status === 403 ? "The connection lacks permission. Check its content and user capabilities."
  : status === 404 ? "Notion cannot access that database or page. Add Core's Notion connection to the database and check its link."
  : status === 429 ? "Notion is rate limiting requests. Wait a moment before trying again."
  : status === 400 ? "Notion rejected the request. Check the fields, or ask an Admin to check the connection."
  : status === 409 ? "Notion reported a conflict. Check the database before trying again."
  : "Notion did not confirm the operation. Check the database before trying again.";

/** What Core's own codes say: no answer, an unreadable one, or a refusal made before anything was sent. */
const codeMessages: Readonly<Record<string, string>> = {
  notion_network: "Could not confirm the Notion response.",
  notion_response: "Notion returned an unreadable response.",
  notion_not_configured: "Core's Notion connection is not set up. An Admin can connect it in Settings > Integrations > Notion.",
  notion_disabled: "Core's Notion connection is turned off. An Admin can turn it on in Settings > Integrations > Notion.",
  notion_unreadable: "The Notion token saved in Core can't be read. An Admin needs to save it again in Settings > Integrations > Notion.",
  notion_unbound: "An Admin has not chosen the ordering database for Part Requests yet.",
  notion_call_limit: "This request reached its limit of Notion calls. Try again in a moment.",
  notion_not_declared: "Part Requests asked Notion for something it did not declare. Nothing was sent.",
  notion_out_of_scope: "That Notion page is not in the ordering database. Nothing was changed.",
};

/**
 * A failure from `services.notion` as this plugin's AppError, with the codes it has always used: `notion_<status>` for an
 * answer from Notion (Core's shared pause after a rate limit is a 429 too), and Core's own code otherwise. Undefined for an
 * error that did not come from Notion or Core's Notion checks, which the caller rethrows.
 */
export function notionFailure(notion: NotionService, error: unknown): AppError | undefined {
  if (error instanceof AppError) return error;
  const code = notion.errorCode(error);
  if (code === undefined) return undefined;
  const status = notion.providerStatus(error);
  const retryAfterMs = notion.retryAfterMs(error);
  // An answer that arrived but could not be read carries Notion's 2xx status; its code says more than the status.
  const answered = status !== undefined && (status < 200 || status >= 300);
  const normalized = answered ? `notion_${status}` : code;
  const message = answered ? statusMessage(status) : codeMessages[code] ?? "Notion could not be reached through Core. Try again in a moment.";
  return new AppError(message, normalized, notion.uncertain(error), retryAfterMs && retryAfterMs > 0 ? { retryAfterSeconds: Math.ceil(retryAfterMs / 1000) } : undefined);
}

/**
 * The ordering database through Core's `orders` binding. Each method is at most one Notion request, which Core counts against
 * the request's or the scheduler slice's budget. Failures are AppErrors (see notionFailure); an uncertain create is never
 * sent again automatically.
 */
export class OrdersNotion {
  readonly #notion: NotionService;
  constructor(notion: NotionService) { this.#notion = notion; }

  async #call<T>(work: () => Promise<T>): Promise<T> {
    try { return await work(); }
    catch (error) { throw notionFailure(this.#notion, error) ?? error; }
  }

  /**
   * The bound data source's layout, checked against what requests need. `previous` keeps a field mapped across a rename in
   * Notion, and only applies when it describes the same data source.
   */
  async readSchema(previous?: Schema): Promise<Schema> {
    const source = await this.#call(() => this.#notion.dataSource(ordersBinding));
    const bound = await this.#call(() => this.#notion.binding(ordersBinding));
    if (!bound) throw new AppError(codeMessages.notion_unbound!, "notion_unbound");
    return mapSchema(source, bound.databaseId, previous && sameId(previous.dataSourceId, source.id) ? previous : undefined, bound.name);
  }

  /** One page of workspace members. Bots are left out. */
  async usersPage(cursor?: string): Promise<{ readonly people: readonly Person[]; readonly next?: string }> {
    const page = await this.#call(() => this.#notion.users.list({ pageSize: 100, ...(cursor ? { cursor } : {}) }));
    const people = page.users.filter((user) => user.type === "person" && user.id).map((user) => ({ id: String(user.id), name: String(user.name ?? "") }));
    return { people, ...(page.nextCursor ? { next: page.nextCursor } : {}) };
  }

  /** One page of people named on existing requests, which is the only way to find guests. A name may be empty. */
  async requestPeoplePage(schema: Schema, pageSize: number, cursor?: string): Promise<{ readonly people: readonly Person[]; readonly next?: string }> {
    const recipientId = decodedId(schema.properties.recipient.id);
    const page = await this.#call(() => this.#notion.query(ordersBinding, { pageSize, ...(cursor ? { cursor } : {}) }));
    const found = new Map<string, string>();
    for (const row of page.results as Json[]) {
      const property = (Object.values(row?.properties ?? {}) as Json[]).find((item) => decodedId(item.id) === recipientId);
      for (const user of (property?.people ?? []) as Json[]) if (user.id && user.type !== "bot" && !found.get(String(user.id))) found.set(String(user.id), String(user.name ?? ""));
    }
    return { people: [...found].map(([id, name]) => ({ id, name })), ...(page.nextCursor ? { next: page.nextCursor } : {}) };
  }

  /**
   * One page of rows in the given statuses, by the mapped property's ID as Notion reported it. Rows carry every property: asking
   * for fewer with `filter_properties` silently returned rows without them. Oldest first, so paging stays stable as rows are added.
   */
  async openOrdersPage(schema: Schema, statuses: readonly Choice[], pageSize: number, cursor?: string): Promise<{ readonly rows: readonly unknown[]; readonly next?: string }> {
    const property = schema.properties.status;
    const page = await this.#call(() => this.#notion.query(ordersBinding, {
      pageSize, ...(cursor ? { cursor } : {}),
      filter: { or: statuses.map((status) => ({ property: property.id, [property.type]: { equals: status.name } })) },
      sorts: [{ timestamp: "created_time", direction: "ascending" }],
    }));
    // Core refuses a reply without a results list too. Either way a malformed reply must not read as "no open orders".
    if (!Array.isArray(page.results)) throw new AppError("Notion returned an unreadable response.", "notion_response");
    return { rows: page.results, ...(page.nextCursor ? { next: page.nextCursor } : {}) };
  }

  async userName(id: string): Promise<string> { return String((await this.#call(() => this.#notion.users.get(id))).name ?? ""); }

  /** Create one page. Throws an uncertain AppError when Notion may have created it without confirming. */
  async create(properties: Json): Promise<string> {
    const page = await this.#call(() => this.#notion.createPage(ordersBinding, { properties }));
    const url = validPageUrl(page.url);
    if (!url) throw new AppError("Notion accepted the request, but did not return a valid page link. Check the database.", "notion_response", true);
    return url;
  }
}
