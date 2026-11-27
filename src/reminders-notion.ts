// Notion for stale-request reminders, through Core's shared connection (`services.notion`). Reminders use two bindings:
// `orders`, the ordering database students send requests to (queried for stale requests, commented on, and "Reminder sent"
// set), and the optional, read-only `people` (Notion account to LancerLogin member ID). This plugin never sees the token and
// never names a database: Core supplies both from the bindings an Admin chose, and refuses a page outside them.
import type { NotionService } from "@lancerlogin/module-sdk/api";
import { AppError, decodedId, notionFailure, ordersBinding, sameId, validPageUrl, type Choice, type PropertyMapping } from "./notion.ts";

/** The read-only People database: each row is one member, keyed by their LancerLogin member ID. Chores is its only writer. */
export const peopleBinding = "people";

type Json = Record<string, any>;

/** The four status options reminders need, as the ordering database spells them. */
export type ReminderStatuses = { readonly incomplete: string; readonly normal: string; readonly rush: string; readonly slow: string };
export type ReminderField = "description" | "status" | "people" | "created" | "reminderSent";
export type ReminderSchema = {
  readonly dataSourceId: string; readonly databaseId: string; readonly dataSourceName?: string;
  readonly properties: Readonly<Record<ReminderField, PropertyMapping>>; readonly statuses: ReminderStatuses;
};
export type PeopleField = "account" | "memberId" | "active";
export type PeopleSchema = { readonly dataSourceId: string; readonly databaseId: string; readonly dataSourceName?: string; readonly properties: Readonly<Record<PeopleField, PropertyMapping>> };

type Expected = { readonly name: string; readonly types: readonly string[] };
const reminderFields: Readonly<Record<ReminderField, Expected>> = {
  description: { name: "Item Description", types: ["title"] },
  status: { name: "Status", types: ["status", "select"] },
  people: { name: "Orderer/Recipient", types: ["people"] },
  created: { name: "Created", types: ["created_time"] },
  reminderSent: { name: "Reminder sent", types: ["date"] },
};
const peopleFields: Readonly<Record<PeopleField, Expected>> = {
  account: { name: "Notion account", types: ["people"] },
  memberId: { name: "LancerLogin member ID", types: ["rich_text", "title", "number"] },
  active: { name: "Active", types: ["checkbox"] },
};

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const isUuid = (value: unknown): value is string => typeof value === "string" && uuidPattern.test(value);

const sourceTitle = (source: Json): string => Array.isArray(source.title) ? source.title.map((part: Json) => String(part?.plain_text ?? "")).join("") : "";

/** Only the listed properties are required; any others are ignored and never written. */
function mapFields<F extends string>(source: Json, expected: Readonly<Record<F, Expected>>, previous?: Readonly<Record<F, PropertyMapping>>): Record<F, PropertyMapping> {
  const properties = {} as Record<F, PropertyMapping>;
  const values = Object.values(source.properties ?? {}) as Json[];
  for (const [field, want] of Object.entries(expected) as [F, Expected][]) {
    const old = previous?.[field];
    const property = (old && values.find((item) => decodedId(item.id) === decodedId(old.id))) || source.properties?.[want.name];
    if (!property || !want.types.includes(property.type)) throw new AppError(`Notion property "${want.name}" must exist with type ${want.types.join(" or ").replaceAll("_", " ")}. Check the database; no properties were changed.`, "schema");
    const options = property[property.type]?.options?.map((option: Json) => ({ id: String(option.id), name: String(option.name) })) as Choice[] | undefined;
    properties[field] = { id: String(property.id), type: String(property.type), ...(options ? { options } : {}) };
  }
  return properties;
}

/** The option for one status group: "RUSH Request" before "RUSH", and undefined when the database has neither. */
export function statusOption(options: readonly Choice[] | undefined, group: keyof ReminderStatuses): string | undefined {
  const matches = (options ?? []).filter((option) => new RegExp(`^${group}(?: request)?$`, "i").test(option.name.trim()));
  return (matches.find((option) => / request$/i.test(option.name.trim())) ?? matches[0])?.name;
}

export function mapReminderSchema(source: Json, databaseId: string, previous?: ReminderSchema, listedName?: string): ReminderSchema {
  const properties = mapFields(source, reminderFields, previous && sameId(previous.dataSourceId, source.id) ? previous.properties : undefined);
  const labels = { incomplete: "Incomplete Request", normal: "NORMAL Request", rush: "RUSH Request", slow: "SLOW Request" } as const;
  const statuses = {} as Record<keyof ReminderStatuses, string>;
  for (const [group, label] of Object.entries(labels) as [keyof ReminderStatuses, string][]) {
    const name = statusOption(properties.status.options, group);
    if (!name) throw new AppError(`Add or restore the "${label}" status in Notion. Reminders need it, so they do not run without it.`, "schema");
    statuses[group] = name;
  }
  const name = (listedName || sourceTitle(source) || previous?.dataSourceName || "").trim().slice(0, 200);
  return { dataSourceId: String(source.id), databaseId, ...(name ? { dataSourceName: name } : {}), properties, statuses };
}

export function mapPeopleSchema(source: Json, databaseId: string, previous?: PeopleSchema, listedName?: string): PeopleSchema {
  const properties = mapFields(source, peopleFields, previous && sameId(previous.dataSourceId, source.id) ? previous.properties : undefined);
  const name = (listedName || sourceTitle(source) || "").trim().slice(0, 200);
  return { dataSourceId: String(source.id), databaseId, ...(name ? { dataSourceName: name } : {}), properties };
}

/** A row's property by the mapped ID. Rows report IDs encoded where data sources report them plain, so compare decoded. */
export function rowProperty(row: Json, mapping: PropertyMapping): Json | undefined {
  const id = decodedId(mapping.id);
  return (Object.values(row?.properties ?? {}) as Json[]).find((item) => decodedId(item?.id) === id);
}

const plainText = (parts: unknown) => Array.isArray(parts) ? parts.map((part: Json) => String(part?.plain_text ?? part?.text?.content ?? "")).join("") : "";

/** The people on a row's people property, bots left out. Only IDs: names Notion sent are dropped here. */
export const rowPeople = (row: Json, mapping: PropertyMapping): string[] =>
  [...new Set(((rowProperty(row, mapping)?.people ?? []) as Json[]).filter((user) => user?.id && user.type !== "bot" && user.object !== "bot").map((user) => String(user.id)))];

export type StaleRow = { readonly pageId: string; readonly pageUrl: string; readonly description: string; readonly people: readonly string[]; readonly status: string; readonly createdMs: number; readonly reminderSentMs: number | null };

/** What reminders need from a row, or undefined when it is not a readable page. */
export function staleRow(row: Json, schema: ReminderSchema): StaleRow | undefined {
  const pageId = String(row?.id ?? "");
  const pageUrl = validPageUrl(row?.url);
  if (!isUuid(pageId) || !pageUrl) return undefined;
  const status = rowProperty(row, schema.properties.status);
  const created = rowProperty(row, schema.properties.created);
  const sent = rowProperty(row, schema.properties.reminderSent);
  const createdMs = Date.parse(String(created?.created_time ?? row?.created_time ?? ""));
  const sentMs = sent?.date?.start ? Date.parse(String(sent.date.start)) : NaN;
  return {
    pageId, pageUrl, description: plainText(rowProperty(row, schema.properties.description)?.title).replace(/\s+/g, " ").trim().slice(0, 200),
    people: rowPeople(row, schema.properties.people), status: String(status?.[status?.type]?.name ?? ""),
    createdMs: Number.isFinite(createdMs) ? createdMs : Number.NaN, reminderSentMs: Number.isFinite(sentMs) ? sentMs : null,
  };
}

/** A People row: its Notion accounts, the member ID it holds, and whether Active is ticked. Names are not read. */
export type PeopleRow = { readonly accounts: readonly string[]; readonly memberKey: string; readonly active: boolean };
export function peopleRow(row: Json, schema: PeopleSchema): PeopleRow {
  const id = rowProperty(row, schema.properties.memberId);
  const memberKey = id?.type === "number" ? (typeof id.number === "number" && Number.isFinite(id.number) ? String(id.number) : "") : plainText(id?.[id?.type]);
  return { accounts: rowPeople(row, schema.properties.account), memberKey: memberKey.trim(), active: rowProperty(row, schema.properties.active)?.checkbox === true };
}

/** Mentions beyond this are left out of a comment; Discord allows 100, and nobody names this many on one request. */
export const maximumMentions = 20;

/** A comment's rich text: a user mention and a space for each person, then the text. Nothing else goes to Notion. */
export function commentRichText(userIds: readonly string[], text: string): Json[] {
  const mentions = userIds.slice(0, maximumMentions).flatMap((id) => [{ type: "mention", mention: { type: "user", user: { id } } }, { type: "text", text: { content: " " } }]);
  return [...mentions, { type: "text", text: { content: text.slice(0, 1900) } }];
}

/** The only properties "Reminder sent" is ever set with: that one date property, nothing else on the page. */
export function reminderSentProperties(propertyId: string, start: string): Json {
  if (typeof propertyId !== "string" || !propertyId || Number.isNaN(Date.parse(start))) throw new AppError("Unsupported Notion operation.");
  return { [propertyId]: { date: { start } } };
}

/**
 * The Notion calls reminders make, through Core. Each method is one call of `services.notion`; Core adds a read of the page
 * before a comment or an update unless it returned that page earlier in the same invocation (the page-in-database check).
 * `calls` counts the requests those may cost, so a job can stop before Core's per-invocation cap.
 */
export class RemindersNotion {
  readonly #notion: NotionService;
  calls = 0;
  constructor(notion: NotionService) { this.#notion = notion; }

  async #call<T>(cost: number, work: () => Promise<T>): Promise<T> {
    this.calls += cost;
    try { return await work(); }
    catch (error) { throw notionFailure(this.#notion, error) ?? error; }
  }

  /** The ordering database's layout as reminders need it. */
  async readReminderSchema(previous?: ReminderSchema): Promise<ReminderSchema> {
    const bound = await this.#call(0, () => this.#notion.binding(ordersBinding));
    if (!bound) throw new AppError("An Admin has not chosen the ordering database for Part Requests yet.", "notion_unbound");
    const source = await this.#call(1, () => this.#notion.dataSource(ordersBinding));
    return mapReminderSchema(source, bound.databaseId, previous, bound.name);
  }

  /** The People database's layout, or undefined while no People database is chosen in Core. */
  async readPeopleSchema(previous?: PeopleSchema): Promise<PeopleSchema | undefined> {
    const bound = await this.#call(0, () => this.#notion.binding(peopleBinding));
    if (!bound) return undefined;
    const source = await this.#call(1, () => this.#notion.dataSource(peopleBinding));
    return mapPeopleSchema(source, bound.databaseId, previous, bound.name);
  }

  /**
   * One page of Incomplete Requests created before `staleBefore` whose "Reminder sent" is empty or before `cooldownBefore`,
   * oldest first. The caller checks every row again, since a filter that Notion read differently must not send a reminder.
   */
  async staleRequestsPage(schema: ReminderSchema, staleBefore: string, cooldownBefore: string, pageSize: number, cursor?: string): Promise<{ readonly rows: readonly Json[]; readonly next?: string }> {
    const { status, created, reminderSent } = schema.properties;
    const page = await this.#call(1, () => this.#notion.query(ordersBinding, {
      pageSize, ...(cursor ? { cursor } : {}),
      filter: { and: [
        { property: status.id, [status.type]: { equals: schema.statuses.incomplete } },
        { property: created.id, created_time: { before: staleBefore } },
        { or: [{ property: reminderSent.id, date: { is_empty: true } }, { property: reminderSent.id, date: { before: cooldownBefore } }] },
      ] },
      sorts: [{ timestamp: "created_time", direction: "ascending" }],
    }));
    if (!Array.isArray(page.results)) throw new AppError("Notion returned an unreadable response.", "notion_response");
    return { rows: page.results, ...(page.nextCursor ? { next: page.nextCursor } : {}) };
  }

  /** One page of People rows with Active ticked. Read only: this plugin never writes to People. */
  async peoplePage(schema: PeopleSchema, pageSize: number, cursor?: string): Promise<{ readonly rows: readonly PeopleRow[]; readonly next?: string }> {
    const active = schema.properties.active;
    const page = await this.#call(1, () => this.#notion.query(peopleBinding, { pageSize, ...(cursor ? { cursor } : {}), filter: { property: active.id, checkbox: { equals: true } } }));
    if (!Array.isArray(page.results)) throw new AppError("Notion returned an unreadable response.", "notion_response");
    return { rows: (page.results as Json[]).map((row) => peopleRow(row, schema)), ...(page.nextCursor ? { next: page.nextCursor } : {}) };
  }

  /**
   * A comment on a request: a mention of each person, then the text. Nothing from Notion's reply is kept. Like creating a
   * page, an answer that does not confirm it is an uncertain AppError, and such a comment is never sent again automatically.
   */
  async createComment(pageId: string, userIds: readonly string[], text: string): Promise<void> {
    if (!isUuid(pageId)) throw new AppError("Unsupported Notion operation.");
    await this.#call(2, () => this.#notion.createComment(ordersBinding, pageId, { richText: commentRichText(userIds, text) }));
  }

  /** Set "Reminder sent" on one request. The properties are exactly that one date (reminderSentProperties). */
  async setReminderSent(pageId: string, propertyId: string, start: string): Promise<void> {
    if (!isUuid(pageId)) throw new AppError("Unsupported Notion operation.");
    const properties = reminderSentProperties(propertyId, start);
    await this.#call(2, () => this.#notion.updatePage(ordersBinding, pageId, { properties }));
  }
}
