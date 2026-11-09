// What the Admin pages show, worked out from what the Worker returned. It imports nothing, so the plugin's unit tests can run it.

export type Tone = "success" | "warning" | "error" | "neutral";
export type Badge = { readonly label: string; readonly tone: Tone };

export type SetupStatus = {
  readonly tokenSaved: boolean; readonly canSaveToken: boolean; readonly siteAddress: string | null;
  readonly databaseId: string | null; readonly dataSourceId: string | null; readonly dataSourceName: string | null;
  readonly verifiedMs: number | null; readonly schemaError: string | null; readonly problem: string | null; readonly rejectedMs: number | null;
  readonly recipients: number; readonly refresh: { readonly step: string; readonly finishedMs: number | null; readonly lastError: string | null } | null;
  readonly pairingPausedUntilMs: number | null; readonly pairedDevices: number; readonly deviceLimit: number; readonly cartsEnabled: boolean;
};
export type LoggedRequest = {
  readonly id: string; readonly memberName: string; readonly deviceLabel: string; readonly state: string; readonly vendor: string; readonly description: string;
  readonly pageUrl: string | null; readonly failureMessage: string | null; readonly createdMs: number;
};
export type RequestLogPage = { readonly requests: readonly LoggedRequest[]; readonly nextBefore: number | null; readonly uncertainCount: number };
export type Device = {
  readonly id: string; readonly label: string; readonly memberId: string; readonly memberName: string; readonly memberActive: boolean;
  readonly createdMs: number; readonly lastUsedMs: number | null; readonly revokedMs: number | null;
};
export type RosterPerson = { readonly id: string; readonly name: string };
export type DeviceList = { readonly devices: readonly Device[]; readonly limitPerMember: number; readonly roster: readonly RosterPerson[]; readonly rosterLimited: boolean };

// ---- Sections of the settings page
export const adminSections = [["connection", "Connection"], ["requests", "Requests log"], ["devices", "Paired devices"]] as const;
export type AdminSection = (typeof adminSections)[number][0];

/** The section a link asks for. Anything else opens Connection, which includes `setup` and `status`, the tabs it replaced. */
export const adminSection = (requested: string | null): AdminSection => adminSections.find(([id]) => id === requested)?.[0] ?? "connection";

// ---- Dates, in the viewer's own time zone unless a test names one.
const format = (options: Intl.DateTimeFormatOptions, ms: number, timeZone?: string) =>
  new Intl.DateTimeFormat("en-US", { ...options, ...(timeZone ? { timeZone } : {}) }).format(ms).replace(/ /g, " ");
export const formatDateTime = (ms: number, timeZone?: string) => format({ month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }, ms, timeZone);
export const formatDate = (ms: number, timeZone?: string) => format({ month: "short", day: "numeric", year: "numeric" }, ms, timeZone);
export const formatShortDate = (ms: number, timeZone?: string) => format({ month: "short", day: "numeric" }, ms, timeZone);
export const formatTime = (ms: number, timeZone?: string) => format({ hour: "numeric", minute: "2-digit" }, ms, timeZone);

// ---- Links
/** The link to a database from its ID. Notion finds it from the ID alone. */
export const databaseLink = (databaseId: string) => `https://app.notion.com/p/${databaseId.replaceAll("-", "")}`;

const notionHosts = ["notion.so", "notion.com", "notion.site"];
/** A link safe to open: https on Notion's own hosts, as the Worker checked when it saved it. */
export function notionPageLink(value: string | null): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && notionHosts.some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`)) ? url.href : undefined;
  } catch { return undefined; }
}

// ---- Requests log
export const uncertainNote = "Notion may or may not have created this request. Check the database before making a new request.";

export function uncertainBanner(count: number): string | undefined {
  if (count <= 0) return undefined;
  return count === 1
    ? "1 request has an uncertain result. Notion may or may not have created it. Check the database before anyone makes a new request."
    : `${count} requests have uncertain results. Notion may or may not have created them. Check the database before anyone makes a new request.`;
}

export type RequestRow = { readonly badge: Badge; readonly note?: string; readonly link?: { readonly href: string; readonly label: string } };

export function requestRow(request: Pick<LoggedRequest, "state" | "pageUrl" | "failureMessage">, databaseId: string | null): RequestRow {
  if (request.state === "created") {
    const href = notionPageLink(request.pageUrl);
    return { badge: { label: "Created", tone: "success" }, ...(href ? { link: { href, label: "Open page" } } : {}) };
  }
  if (request.state === "uncertain") return { badge: { label: "Uncertain", tone: "warning" }, note: uncertainNote, ...(databaseId ? { link: { href: databaseLink(databaseId), label: "Check database" } } : {}) };
  if (request.state === "failed") return { badge: { label: "Failed", tone: "error" }, note: `Nothing was created.${request.failureMessage ? ` ${request.failureMessage}` : ""}` };
  return { badge: { label: "Pending", tone: "neutral" } };
}

// ---- Paired devices
export type MemberRow = {
  readonly id: string; readonly name: string; readonly active: boolean;
  /** Working devices first, oldest first, then revoked ones. */
  readonly devices: readonly Device[]; readonly working: readonly Device[];
  /** Latest use of a working device, or of any device when none is working. 0 for never. */
  readonly lastUsedMs: number;
  /** Days since a working device was last used, or paired if never used. 0 for a member with no working device or off the roster. */
  readonly idleDays: number;
};

const dayMs = 86_400_000;
export const inactiveDays = 30;

/** One row per member, by name: everyone on the active roster, and anyone else with a device, such as a member who left it. */
export function memberRows(list: Pick<DeviceList, "devices" | "roster">, now: number): readonly MemberRow[] {
  const people = new Map<string, { name: string; active: boolean; devices: Device[] }>();
  for (const person of list.roster) people.set(person.id, { name: person.name, active: true, devices: [] });
  for (const device of list.devices) {
    const person = people.get(device.memberId);
    if (person) { person.devices.push(device); person.active = device.memberActive; }
    else people.set(device.memberId, { name: device.memberName, active: device.memberActive, devices: [device] });
  }
  return [...people].map(([id, { name, active, devices }]) => {
    const ordered = [...devices].sort((a, b) => Number(a.revokedMs !== null) - Number(b.revokedMs !== null) || a.createdMs - b.createdMs);
    const working = ordered.filter((device) => device.revokedMs === null);
    const lastUsedMs = Math.max(0, ...(working.length ? working : ordered).map((device) => device.lastUsedMs ?? 0));
    const idleFrom = lastUsedMs || Math.max(0, ...working.map((device) => device.createdMs));
    return { id, name, active, devices: ordered, working, lastUsedMs, idleDays: active && working.length ? Math.floor((now - idleFrom) / dayMs) : 0 };
  }).sort((a, b) => a.name.localeCompare(b.name));
}

export const memberFilters = [["all", "All"], ["none", "No devices"], ["limit", "At the limit"], ["idle", `Inactive ${inactiveDays}+ days`], ["off", "Off roster"]] as const;
export type MemberFilter = (typeof memberFilters)[number][0];

export function inFilter(row: MemberRow, filter: MemberFilter, limit: number): boolean {
  if (filter === "none") return row.active && !row.working.length;
  if (filter === "limit") return row.active && row.working.length >= limit;
  if (filter === "idle") return row.idleDays >= inactiveDays;
  return filter === "off" ? !row.active : true;
}

const includes = (value: string, text: string) => value.toLowerCase().includes(text);

/** The rows a filter and search leave: by name so they stay put when a device is revoked, except Inactive, longest idle first. */
export function visibleMembers(rows: readonly MemberRow[], filter: MemberFilter, search: string, limit: number): readonly MemberRow[] {
  const text = search.trim().toLowerCase();
  const found = rows.filter((row) => inFilter(row, filter, limit) && (!text || includes(row.name, text) || row.devices.some((device) => includes(device.label, text))));
  return filter === "idle" ? [...found].sort((a, b) => b.idleDays - a.idleDays) : found;
}

/** The devices a search found on a member whose name it did not match, so the row says why it is there. */
export function searchMatches(row: MemberRow, search: string): readonly string[] {
  const text = search.trim().toLowerCase();
  return !text || includes(row.name, text) ? [] : row.devices.filter((device) => includes(device.label, text)).map((device) => device.label);
}

/** Devices counts working devices, the same number as the Pairing card, so it includes off roster devices that have no access. */
export function deviceSummary(rows: readonly MemberRow[]) {
  const onRoster = rows.filter((row) => row.active);
  const paired = onRoster.filter((row) => row.working.length).length;
  const devices = rows.reduce((total, row) => total + row.working.length, 0);
  const offRosterDevices = rows.reduce((total, row) => total + (row.active ? 0 : row.working.length), 0);
  return { paired, onRoster: onRoster.length, none: onRoster.length - paired, devices, offRosterDevices };
}

export function memberFlag(row: MemberRow, limit: number): Badge | undefined {
  if (!row.active) return { label: "Off roster", tone: "neutral" };
  if (!row.working.length) return { label: "No devices", tone: "neutral" };
  if (row.working.length >= limit) return { label: "At the limit", tone: "warning" };
  return row.idleDays >= inactiveDays ? { label: `Inactive ${row.idleDays} days`, tone: "neutral" } : undefined;
}

export const memberLastUsed = (row: MemberRow, timeZone?: string) => row.lastUsedMs ? `Last used ${formatShortDate(row.lastUsedMs, timeZone)}` : row.devices.length ? "Never used" : "Not paired";

export const offRosterNote = (row: MemberRow) => `Not on the active roster, so ${row.working.length === 1 ? "this device has" : "these devices have"} no access.`;

export const inactiveNote = "Inactive is a prompt to look, not a reason to revoke. Last used only changes when a device sends a request or marks a cart item, so a member who needed no parts reads as inactive, and everyone will in the off-season.";

export const rosterLimitedNote = "The roster stops at 500 members, and this team has at least that many, so the No devices list and the roster counts may be incomplete.";

export function emptyMembersText(filter: MemberFilter, search: string, limit: number): string {
  const label = memberFilters.find(([id]) => id === filter)![1];
  if (search.trim()) return `No members match "${search.trim()}"${filter === "all" ? "." : ` in ${label}.`}`;
  if (filter === "none") return "Every member on the roster has a working device.";
  if (filter === "limit") return `No members are at the limit of ${limit} devices.`;
  if (filter === "idle") return `No members have gone ${inactiveDays} days without using a device.`;
  return filter === "off" ? "No devices belong to members off the roster." : "No members yet. They appear here once they are on the roster.";
}

export const revokeMessage = (device: Pick<Device, "label" | "memberName">) =>
  `${device.memberName}'s ${device.label} loses access at once. Its past requests stay in the log. To use it again, ${device.memberName} runs /ordering-pin and pairs it again.`;

// ---- Connection and status
export const isConnected = (status: Pick<SetupStatus, "problem">) => status.problem === null;

/** What stopped requests, in words an Admin can act on, or undefined when requests can flow. */
export function connectionProblem(status: Pick<SetupStatus, "tokenSaved" | "problem" | "schemaError"> & { readonly rejectedMs?: number | null }, timeZone?: string): string | undefined {
  if (status.problem === null) return undefined;
  const when = status.rejectedMs ? ` on ${formatDateTime(status.rejectedMs, timeZone)}` : "";
  if (status.problem === "notion_token_rejected") return `Notion rejected the saved token${when}, so requests and Carts have stopped. Paired devices stay paired and the log stays. To fix it, copy a new token from Notion's connections page and replace this one.`;
  if (status.problem === "notion_access_lost") return `Notion refused access to the ordering database${when}, so requests and Carts have stopped. Paired devices stay paired and the log stays. To fix it, add the connection to the database in Notion and check its capabilities, then verify the connection again.`;
  if (status.problem === "notion_schema_changed") return `The Notion database no longer matches what Part Requests expects, so requests have stopped.${status.schemaError ? ` ${status.schemaError}` : ""}`;
  if (!status.tokenSaved) return "No Notion token is saved, so requests have stopped. This is expected after a restore: save the token and verify the connection again. Every device also pairs again.";
  return "A Notion token is saved, but the connection has not been verified, so requests have stopped. Verify the connection to turn them back on.";
}

export function pairingNotice(pausedUntilMs: number | null, timeZone?: string): string | undefined {
  return pausedUntilMs === null ? undefined : `Pairing is paused because of repeated wrong PINs. It reopens by itself at ${formatTime(pausedUntilMs, timeZone)}. Devices that are already paired keep working.`;
}

export function refreshNotice(refresh: SetupStatus["refresh"], timeZone?: string): string | undefined {
  if (!refresh?.lastError) return undefined;
  return `The last refresh could not finish. It tries again within an hour.${refresh.finishedMs ? ` The list from ${formatDateTime(refresh.finishedMs, timeZone)} is still in use.` : ""}`;
}
