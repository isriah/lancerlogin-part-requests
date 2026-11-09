// Carts: the team's open orders from Notion, and who has already built a cart for them.
//
// The orders are a short-lived copy in plugin tables, shared by every device, so the number of Notion calls does not grow with
// the number of devices. A request that finds the copy out of date reads ONE Notion page of 50 rows, because an unfiltered row
// from Notion is large and Workers Free allows 10 ms of CPU. With more than one page, the old copy keeps being served and each
// further request reads the next page until the new copy is complete. Nothing reads Notion for Carts when nobody is using it.
//
// This is the one GET route that writes and calls Notion. It can run during Core's maintenance, which only stops other methods.
// Its writes are the rate limit and this copy, neither of which travels in a backup, and a failed write serves the old copy.
import { connectionProblem, parseSchema, readCartsEnabled, readConnection, savedToken } from "./connection.ts";
import { json, object, refuse } from "./http.ts";
import { AppError, decodedId, NotionClient, validPageUrl, type Choice, type PropertyMapping, type Schema } from "./notion.ts";
import { deviceKeyHash, deviceRefusedMessage, installationId, readDevice, type AuthenticatedDevice, type Database } from "./pairing.ts";
import { consumeGeneral, countStatement, maximumGeneral, rateLimited, type Count, type DeviceRequest } from "./requests.ts";
import { vendorForUrl } from "./vendors.ts";

/** How long the copy counts as current. */
export const ordersFreshMs = 60_000;
/** A device's Refresh button reads Notion again only when the copy is at least this old. */
export const ordersRefreshFloorMs = 15_000;
/** When Notion is failing, a copy up to this old is served and labelled stale. Older than this, the failure is the answer. */
export const ordersStaleLimitMs = 15 * 60_000;
/** Rows per Notion call, the same as the recipient job. One call per request. */
export const ordersPageSize = 50;
/** 500 rows at most per refresh. Beyond that the answer says `truncated`. */
export const maximumOrderPages = 10;
/** Longer than the Notion timeout, so a lease this old has no request still working on it. */
const leaseMs = 45_000;
/** A half-read list older than this starts again, rather than joining an old read to a new one. */
const buildLimitMs = 5 * 60_000;
const failureBackoffMs = 30_000;
const longestBackoffMs = 120_000;
/** How soon a client should ask again while a list is being read. */
const pollSeconds = 1;

export const cartMarkLifetimeMs = 14 * 24 * 60 * 60_000;
export const maximumMarksPerRequest = 100;
/** More than one refresh can return, so a device cannot fill the table however it calls this. */
export const maximumMarksPerDevice = 500;

const unnamedPerson = "Unnamed Notion user";
const orderIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const largestNumber = 1_000_000_000;

export const cartsDisabledMessage = "An Admin has turned Carts off for this team. Requests still work.";
const pairAgain = () => refuse(401, "pair_again", deviceRefusedMessage);
const cartsDisabled = () => refuse(403, "carts_disabled", cartsDisabledMessage);

// ---- Which statuses are open

export type StatusGroup = "NORMAL" | "RUSH" | "SLOW";
export type OpenStatus = Choice & { readonly group: StatusGroup };

/**
 * The saved schema's options that count as open: NORMAL, RUSH or SLOW, on their own or followed by "Request", in any case.
 * The exact match is deliberate, so an option such as "SLOW - ordered" is not read as open. An option the database does not have
 * returns nothing, and it is picked up when the refresh job next saves the schema.
 */
export function openStatuses(schema: Schema): readonly OpenStatus[] {
  const open: OpenStatus[] = [];
  for (const option of schema.properties.status.options ?? []) {
    const group = /^(NORMAL|RUSH|SLOW)(?: REQUEST)?$/.exec(option.name.trim().toUpperCase())?.[1] as StatusGroup | undefined;
    if (group) open.push({ ...option, group });
  }
  return open;
}

// ---- One Notion row as an order. Rows are written by people in Notion too, so any field can be blank or the wrong shape.

type Json = Record<string, any>;
type Person = { readonly id: string; readonly name: string };
type RawOrder = Omit<Order, "requesters" | "cartMarks"> & { readonly people: readonly Person[] };
export type Order = {
  readonly id: string; readonly url: string; readonly description: string | null; readonly vendor: string | null; readonly urlVendor: string | null;
  readonly sku: string | null; readonly productUrl: string | null; readonly quantity: number | null; readonly unitPrice: number | null;
  readonly status: string; readonly statusGroup: StatusGroup; readonly teams: readonly string[]; readonly requesters: readonly string[];
};

const isObject = (value: unknown): value is Json => Boolean(value) && typeof value === "object" && !Array.isArray(value);

const text = (parts: unknown, limit: number): string | null => {
  if (!Array.isArray(parts)) return null;
  const joined = parts.map((part) => isObject(part) ? String(part.plain_text ?? part.text?.content ?? "") : "").join("").trim();
  return joined ? joined.slice(0, limit) : null;
};

const numberAtLeast = (value: unknown, least: number, inclusive: boolean): number | null =>
  typeof value === "number" && Number.isFinite(value) && value <= largestNumber && (inclusive ? value >= least : value > least) ? value : null;

/** Only an ordinary web address, because the extension shows this as a link. Notion's url property takes any text. */
function webAddress(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim() || value.length > 2000) return null;
  try {
    const url = new URL(value.trim());
    return (url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password ? value.trim() : null;
  } catch { return null; }
}

const safeVendor = (url: string | null) => {
  try { return url ? vendorForUrl(url)?.label ?? null : null; } catch { return null; }
};

/** The option's name in the saved schema. A row can hold an option added since the schema was saved, so its own name is the fallback. */
function optionName(value: unknown, mapping: PropertyMapping): string | null {
  if (!isObject(value)) return null;
  const known = mapping.options?.find((option) => option.id === value.id);
  const name = known?.name ?? (typeof value.name === "string" ? value.name.trim().slice(0, 200) : "");
  return name || null;
}

/** An order, or undefined for a row that cannot be one: not a page, trashed, or not in an open status. */
export function orderFromRow(row: unknown, schema: Schema, open: readonly OpenStatus[]): RawOrder | undefined {
  if (!isObject(row) || (row.object !== undefined && row.object !== "page") || row.in_trash === true || row.archived === true) return undefined;
  const id = typeof row.id === "string" ? row.id.toLowerCase() : "";
  if (!orderIdPattern.test(id) || !isObject(row.properties)) return undefined;
  const byId = new Map<string, Json>();
  for (const property of Object.values(row.properties)) if (isObject(property)) byId.set(decodedId(property.id), property);
  const map = schema.properties;
  const property = (mapping: PropertyMapping) => byId.get(decodedId(mapping.id)) ?? {};

  const statusValue = property(map.status)[map.status.type];
  const status = isObject(statusValue) ? open.find((option) => option.id === statusValue.id) ?? open.find((option) => option.name === statusValue.name) : undefined;
  if (!status) return undefined;

  const teamProperty = property(map.team);
  const teamValues: unknown[] = Array.isArray(teamProperty.multi_select) ? teamProperty.multi_select : teamProperty.select ? [teamProperty.select] : [];
  const people: Person[] = [];
  const named = property(map.recipient).people;
  if (Array.isArray(named)) {
    for (const user of named.slice(0, 20)) {
      if (!isObject(user) || !user.id || user.type === "bot") continue;
      people.push({ id: String(user.id), name: typeof user.name === "string" ? user.name.trim().slice(0, 200) : "" });
    }
  }
  const productUrl = webAddress(property(map.url).url);
  return {
    id, url: validPageUrl(row.url) ?? `https://www.notion.so/${id.replaceAll("-", "")}`,
    description: text(property(map.description).title, 2000),
    vendor: optionName(property(map.vendor).select, map.vendor), urlVendor: safeVendor(productUrl),
    sku: text(property(map.sku).rich_text, 500), productUrl,
    quantity: numberAtLeast(property(map.quantity).number, 0, false), unitPrice: numberAtLeast(property(map.price).number, 0, true),
    status: status.name, statusGroup: status.group,
    teams: teamValues.map((value) => optionName(value, map.team)).filter((name): name is string => name !== null),
    people,
  };
}

// ---- The copy

type OrdersState = {
  readonly publishedGeneration: number; readonly publishedMs: number | null; readonly publishedTruncated: number; readonly publishedSkipped: number;
  readonly buildGeneration: number | null; readonly buildPages: number; readonly leaseUntilMs: number; readonly lastError: string | null;
};
type Build = { readonly publishedGeneration: number; readonly buildGeneration: number | null; readonly buildCursor: string | null; readonly buildPages: number; readonly buildStartedMs: number | null; readonly buildSkipped: number };
type Snapshot = { readonly generation: number; readonly fetchedMs: number; readonly truncated: boolean; readonly skipped: number };

const readState = (db: Database) => db.prepare(`SELECT published_generation AS publishedGeneration,published_ms AS publishedMs,published_truncated AS publishedTruncated,published_skipped AS publishedSkipped,
  build_generation AS buildGeneration,build_pages AS buildPages,lease_until_ms AS leaseUntilMs,last_error AS lastError FROM part_requests_orders_state WHERE installation_id=?`).bind(installationId).first<OrdersState>();

/** A copy old enough to be useless is not offered, even as stale. */
const snapshotOf = (state: OrdersState | null, now: number): Snapshot | undefined =>
  state?.publishedMs && now - state.publishedMs <= ordersStaleLimitMs
    ? { generation: state.publishedGeneration, fetchedMs: state.publishedMs, truncated: state.publishedTruncated === 1, skipped: state.publishedSkipped }
    : undefined;

/** People with no name in the row, from the recipient list. No Notion call: one per person would not fit in a request. */
async function finishOrders(db: Database, raw: readonly RawOrder[]): Promise<readonly Omit<Order, "cartMarks">[]> {
  const nameless = [...new Set(raw.flatMap((order) => order.people.filter((person) => !person.name).map((person) => person.id)))].slice(0, 50);
  const known = new Map<string, string>();
  if (nameless.length) {
    const rows = await db.prepare(`SELECT notion_user_id AS id,name FROM part_requests_recipients WHERE installation_id=? AND notion_user_id IN (${nameless.map(() => "?").join(",")})`)
      .bind(installationId, ...nameless).all<{ id: string; name: string }>();
    for (const row of rows.results ?? []) if (row.name) known.set(row.id, row.name);
  }
  return raw.map(({ people, ...order }) => ({ ...order, requesters: people.map((person) => person.name || known.get(person.id) || unnamedPerson) }));
}

type Slice =
  | { readonly kind: "published"; readonly snapshot: Snapshot }
  | { readonly kind: "more" }
  | { readonly kind: "busy" }
  | { readonly kind: "limited"; readonly count: Count }
  | { readonly kind: "failed"; readonly code: string; readonly retryAfterSeconds: number };

const backoffSeconds = (error: unknown) => {
  const asked = error instanceof AppError ? Number(object(error.details).retryAfterSeconds) : NaN;
  return Math.ceil(Math.min(longestBackoffMs, Math.max(failureBackoffMs, Number.isFinite(asked) ? asked * 1000 : 0)) / 1000);
};

/** One step of a refresh: claim it, read one Notion page, and save it. */
async function refreshSlice(db: Database, state: OrdersState | null, device: AuthenticatedDevice, client: NotionClient, schema: Schema, open: readonly OpenStatus[], now: number): Promise<Slice> {
  try {
    // The count and the claim commit together. An over-limit device or a held lease claims nothing, and neither does a request
    // that read the state before another request moved it on, which would read the same page again.
    const results = await db.batch([
      countStatement(db, device.deviceId, "general", now),
      db.prepare(`INSERT INTO part_requests_orders_state(installation_id,lease_until_ms)
        SELECT ?1,?2 WHERE (SELECT requests FROM part_requests_device_limits WHERE installation_id=?1 AND device_id=?3 AND bucket='general')<=?4
        ON CONFLICT(installation_id) DO UPDATE SET lease_until_ms=excluded.lease_until_ms WHERE part_requests_orders_state.lease_until_ms<=?5 AND part_requests_orders_state.published_generation=?6 AND part_requests_orders_state.build_pages=?7
        RETURNING published_generation AS publishedGeneration,build_generation AS buildGeneration,build_cursor AS buildCursor,build_pages AS buildPages,build_started_ms AS buildStartedMs,build_skipped AS buildSkipped`)
        .bind(installationId, now + leaseMs, device.deviceId, maximumGeneral, now, state?.publishedGeneration ?? 0, state?.buildPages ?? 0),
    ]);
    const count = results[0]?.results?.[0] as Count | undefined;
    if (count && Number(count.requests) > maximumGeneral) return { kind: "limited", count };
    const claimed = results[1]?.results?.[0] as Build | undefined;
    if (!claimed) return { kind: "busy" };

    const carryOn = claimed.buildGeneration !== null && claimed.buildStartedMs !== null && now - claimed.buildStartedMs < buildLimitMs;
    const generation = carryOn ? claimed.buildGeneration! : Math.max(claimed.publishedGeneration, claimed.buildGeneration ?? 0) + 1;
    const startedMs = carryOn ? claimed.buildStartedMs! : now;
    const pages = carryOn ? claimed.buildPages : 0;
    const cursor = carryOn ? claimed.buildCursor ?? undefined : undefined;

    const page = await client.openOrdersPage(schema, open, ordersPageSize, cursor);
    const raw = page.rows.map((row) => orderFromRow(row, schema, open)).filter((order): order is RawOrder => order !== undefined);
    const orders = await finishOrders(db, raw);
    const skipped = (carryOn ? claimed.buildSkipped : 0) + page.rows.length - raw.length;
    const save = db.prepare("INSERT OR REPLACE INTO part_requests_orders_cache(installation_id,generation,page,orders_json) VALUES (?,?,?,?)").bind(installationId, generation, pages, JSON.stringify(orders));
    const nextPages = pages + 1;
    if (page.next && nextPages < maximumOrderPages) {
      await db.batch([save, db.prepare("UPDATE part_requests_orders_state SET build_generation=?,build_cursor=?,build_pages=?,build_started_ms=?,build_skipped=?,lease_until_ms=0,last_error=NULL WHERE installation_id=?")
        .bind(generation, page.next, nextPages, startedMs, skipped, installationId)]);
      return { kind: "more" };
    }
    const truncated = Boolean(page.next);
    await db.batch([
      save,
      db.prepare(`UPDATE part_requests_orders_state SET published_generation=?,published_ms=?,published_truncated=?,published_skipped=?,build_generation=NULL,build_cursor=NULL,build_pages=0,build_started_ms=NULL,build_skipped=0,lease_until_ms=0,last_error=NULL WHERE installation_id=?`)
        .bind(generation, now, truncated ? 1 : 0, skipped, installationId),
      db.prepare("DELETE FROM part_requests_orders_cache WHERE installation_id=? AND generation<>?").bind(installationId, generation),
    ]);
    return { kind: "published", snapshot: { generation, fetchedMs: now, truncated, skipped } };
  } catch (error) {
    // Only a code is kept. The saved cursor is dropped too, in case that is what Notion refused.
    const code = error instanceof AppError ? error.code : "orders_unexpected";
    const seconds = backoffSeconds(error);
    await db.prepare("UPDATE part_requests_orders_state SET build_generation=NULL,build_cursor=NULL,build_pages=0,build_started_ms=NULL,build_skipped=0,lease_until_ms=?,last_error=? WHERE installation_id=?")
      .bind(now + seconds * 1000, code, installationId).run().catch(() => undefined);
    return { kind: "failed", code, retryAfterSeconds: seconds };
  }
}

/** What a failed read means to the person looking at Carts. Only fixed messages: nothing from Notion's reply or the token. */
function ordersFailure(code: string, retryAfterSeconds: number): Response {
  if (code === "notion_429") return refuse(503, "notion_rate_limited", "Notion is busy. Try again in a moment.", {}, retryAfterSeconds);
  if (code === "notion_401" || code === "notion_403" || code === "notion_404") return refuse(503, "notion_access_lost", "Part Requests cannot read the Notion database. Ask an Admin to check the connection.", {}, retryAfterSeconds);
  return refuse(502, "notion_unavailable", "Open orders could not be read from Notion. Try again in a moment.", {}, retryAfterSeconds);
}

type CartMark = { readonly memberName: string; readonly deviceLabel: string; readonly quantity: number; readonly markedMs: number; readonly expiresMs: number; readonly ownDevice: boolean };

/** The answer from a copy. The marks are always read fresh, so a mark shows at once whatever the age of the copy. */
async function ordersAnswer(db: Database, device: AuthenticatedDevice, snapshot: Snapshot, open: readonly OpenStatus[], now: number, flags: { readonly refreshing?: boolean; readonly refreshError?: string } = {}): Promise<Response> {
  const [pages, marks] = await Promise.all([
    db.prepare("SELECT orders_json AS ordersJson FROM part_requests_orders_cache WHERE installation_id=? AND generation=? ORDER BY page").bind(installationId, snapshot.generation).all<{ ordersJson: string }>(),
    db.prepare(`SELECT k.order_id AS orderId,k.device_id AS deviceId,k.quantity,k.marked_ms AS markedMs,k.expires_ms AS expiresMs,d.label AS deviceLabel,m.first_name AS firstName,m.last_name AS lastName
      FROM part_requests_cart_marks k
      JOIN part_requests_devices d ON d.installation_id=k.installation_id AND d.id=k.device_id
      JOIN members m ON m.installation_id=k.installation_id AND m.id=k.member_id
      WHERE k.installation_id=? AND k.expires_ms>? ORDER BY k.marked_ms DESC LIMIT 2000`).bind(installationId, now)
      .all<{ orderId: string; deviceId: string; quantity: number; markedMs: number; expiresMs: number; deviceLabel: string; firstName: string; lastName: string }>(),
  ]);
  const byOrder = new Map<string, CartMark[]>();
  for (const mark of marks.results ?? []) {
    const list = byOrder.get(mark.orderId) ?? [];
    list.push({ memberName: `${mark.firstName} ${mark.lastName}`.trim(), deviceLabel: mark.deviceLabel, quantity: mark.quantity, markedMs: mark.markedMs, expiresMs: mark.expiresMs, ownDevice: mark.deviceId === device.deviceId });
    byOrder.set(mark.orderId, list);
  }
  const orders = (pages.results ?? []).flatMap((page) => JSON.parse(page.ordersJson) as Order[]).map((order) => ({ ...order, cartMarks: byOrder.get(order.id) ?? [] }));
  return json({
    orders, fetchedMs: snapshot.fetchedMs, stale: now - snapshot.fetchedMs >= ordersFreshMs, refreshing: flags.refreshing === true, refreshError: flags.refreshError ?? null,
    truncated: snapshot.truncated, skippedRows: snapshot.skipped, statuses: open.map(({ name, group }) => ({ name, group })),
  });
}

/** The list is still being read and there is nothing to show yet. Not an empty list, so it must not be shown as one. */
const stillReading = () => json({ state: "refreshing", orders: [], refreshing: true, retryAfterSeconds: pollSeconds }, 202, pollSeconds);

/** GET /public/part-requests/orders. `?refresh=1` is the Refresh button. See the README for each answer. */
export async function readOrders({ db, authorization, credentials, now }: DeviceRequest, refreshAsked: boolean): Promise<Response> {
  const keyHash = await deviceKeyHash(authorization);
  if (!keyHash) return pairAgain();
  // One D1 round trip: these all start in the same tick.
  const [device, connection, enabled, state] = await Promise.all([readDevice(db, keyHash), readConnection(db), readCartsEnabled(db), readState(db)]);
  if (!device) return pairAgain();
  if (!enabled) return cartsDisabled();
  const problem = connectionProblem(connection);
  const schema = parseSchema(connection);
  if (problem || !schema) return refuse(503, problem?.code ?? "notion_not_connected", problem?.error ?? "Part Requests is not connected to Notion. Ask an Admin to finish its setup.");

  const open = openStatuses(schema);
  const snapshot = snapshotOf(state, now);
  const age = snapshot ? now - snapshot.fetchedMs : Infinity;
  const wanted = age >= ordersFreshMs || state?.buildGeneration != null || refreshAsked && age >= ordersRefreshFloorMs;
  if (!wanted) return ordersAnswer(db, device, snapshot!, open, now);

  // The database has no open status at all, so there is nothing to ask Notion.
  if (!open.length) return json({ orders: [], fetchedMs: now, stale: false, refreshing: false, refreshError: null, truncated: false, skippedRows: 0, statuses: [] });

  // Someone else is reading, or a failure is waiting out its backoff. No write and no Notion call.
  if (state && state.leaseUntilMs > now) {
    const seconds = Math.max(1, Math.ceil((state.leaseUntilMs - now) / 1000));
    if (state.lastError) return snapshot ? ordersAnswer(db, device, snapshot, open, now, { refreshError: state.lastError }) : ordersFailure(state.lastError, seconds);
    return snapshot ? ordersAnswer(db, device, snapshot, open, now, { refreshing: true }) : stillReading();
  }

  let token: string;
  try { token = await savedToken(connection, credentials); }
  catch (error) {
    if (!(error instanceof AppError)) throw error;
    return refuse(503, error.code, error.message);
  }
  const slice = await refreshSlice(db, state, device, new NotionClient(token), schema, open, now);
  if (slice.kind === "published") return ordersAnswer(db, device, slice.snapshot, open, now);
  if (slice.kind === "more" || slice.kind === "busy") return snapshot ? ordersAnswer(db, device, snapshot, open, now, { refreshing: true }) : stillReading();
  if (slice.kind === "limited") return snapshot ? ordersAnswer(db, device, snapshot, open, now, { refreshError: "rate_limited" }) : rateLimited(slice.count, now);
  return snapshot ? ordersAnswer(db, device, snapshot, open, now, { refreshError: slice.code }) : ordersFailure(slice.code, slice.retryAfterSeconds);
}

// ---- Cart marks

/** The marks to save, or undefined when any of them is not an order ID and a quantity. All or nothing. */
function parseMarks(value: unknown): { readonly id: string; readonly quantity: number }[] | undefined {
  if (!Array.isArray(value) || !value.length || value.length > maximumMarksPerRequest) return undefined;
  const marks: { id: string; quantity: number }[] = [];
  for (const item of value) {
    if (!isObject(item) || Object.keys(item).some((key) => key !== "orderId" && key !== "quantity")) return undefined;
    const quantity = numberAtLeast(item.quantity, 0, false);
    if (typeof item.orderId !== "string" || !orderIdPattern.test(item.orderId) || quantity === null) return undefined;
    marks.push({ id: item.orderId, quantity });
  }
  return marks;
}

/** POST /public/part-requests/orders/marks: { marks: [{ orderId, quantity }] }. This device built a cart holding these. */
export async function saveMarks({ db, authorization, now }: DeviceRequest, body: unknown): Promise<Response> {
  const keyHash = await deviceKeyHash(authorization);
  if (!keyHash) return pairAgain();
  const [device, enabled] = await Promise.all([readDevice(db, keyHash), readCartsEnabled(db)]);
  if (!device) return pairAgain();
  if (!enabled) return cartsDisabled();
  const marks = parseMarks(object(body).marks);
  if (!marks) return refuse(400, "validation", `Send up to ${maximumMarksPerRequest} marks, each with an order ID and a quantity above zero.`);
  const limited = await consumeGeneral(db, device, now);
  if (limited) return limited;
  const held = await db.prepare("SELECT COUNT(*) AS count FROM part_requests_cart_marks WHERE installation_id=? AND device_id=? AND expires_ms>?").bind(installationId, device.deviceId, now).first<{ count: number }>();
  if (Number(held?.count ?? 0) + marks.length > maximumMarksPerDevice) return refuse(409, "too_many_marks", "This device has too many cart marks. Clear them, then build again.");
  const expiresMs = now + cartMarkLifetimeMs;
  const results = await db.batch([
    db.prepare("DELETE FROM part_requests_cart_marks WHERE installation_id=? AND expires_ms<=?").bind(installationId, now),
    // Rechecks the device and the roster at this moment. Marking an order again replaces this device's earlier mark.
    db.prepare(`INSERT INTO part_requests_cart_marks(installation_id,order_id,device_id,member_id,quantity,marked_ms,expires_ms)
      SELECT d.installation_id,json_extract(j.value,'$.id'),d.id,d.member_id,json_extract(j.value,'$.quantity'),?1,?2
      FROM json_each(?3) j
      JOIN part_requests_devices d ON d.installation_id=?4 AND d.id=?5 AND d.revoked_ms IS NULL
      JOIN members m ON m.installation_id=d.installation_id AND m.id=d.member_id AND m.active=1
      WHERE 1
      ON CONFLICT(installation_id,order_id,device_id) DO UPDATE SET quantity=excluded.quantity,marked_ms=excluded.marked_ms,expires_ms=excluded.expires_ms`)
      .bind(now, expiresMs, JSON.stringify(marks), installationId, device.deviceId),
    db.prepare("UPDATE part_requests_devices SET last_used_ms=? WHERE installation_id=? AND id=?").bind(now, installationId, device.deviceId),
  ]);
  if (!results[1]?.meta?.changes) return pairAgain();
  return json({ marked: new Set(marks.map((mark) => mark.id)).size, markedMs: now, expiresMs }, 201);
}

/** POST /public/part-requests/orders/marks/clear: {} clears this device's marks, { orderIds } only those. Never another device's. */
export async function clearMarks({ db, authorization, now }: DeviceRequest, body: unknown): Promise<Response> {
  const keyHash = await deviceKeyHash(authorization);
  const device = keyHash ? await readDevice(db, keyHash) : null;
  if (!device) return pairAgain();
  const { orderIds } = object(body);
  if (orderIds !== undefined && (!Array.isArray(orderIds) || orderIds.length > maximumMarksPerRequest || orderIds.some((id) => typeof id !== "string" || !orderIdPattern.test(id)))) {
    return refuse(400, "validation", `Send up to ${maximumMarksPerRequest} order IDs, or none to clear all of this device's marks.`);
  }
  const limited = await consumeGeneral(db, device, now);
  if (limited) return limited;
  const result = await db.prepare(`DELETE FROM part_requests_cart_marks WHERE installation_id=?1 AND device_id=?2${orderIds ? " AND order_id IN (SELECT value FROM json_each(?3))" : ""}`)
    .bind(installationId, device.deviceId, ...(orderIds ? [JSON.stringify(orderIds)] : [])).run();
  return json({ cleared: Number(result.meta?.changes ?? 0) });
}
