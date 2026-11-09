// What the Admin pages show, worked out from what the Worker returned. It imports nothing, so the plugin's unit tests can run it.

export type Tone = "success" | "warning" | "error" | "neutral";
export type Badge = { readonly label: string; readonly tone: Tone };

export type SetupStatus = {
  readonly tokenSaved: boolean; readonly canSaveToken: boolean; readonly siteAddress: string | null;
  readonly databaseId: string | null; readonly dataSourceId: string | null; readonly dataSourceName: string | null;
  readonly verifiedMs: number | null; readonly schemaError: string | null; readonly problem: string | null;
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
export type DeviceList = { readonly devices: readonly Device[]; readonly limitPerMember: number };

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
export type MemberDevices = { readonly memberId: string; readonly memberName: string; readonly badge: Badge; readonly devices: readonly Device[] };

/** Devices grouped by member, by name. Within a member, working devices come first, oldest first. */
export function groupDevices(devices: readonly Device[], limit: number): readonly MemberDevices[] {
  const members = new Map<string, Device[]>();
  for (const device of devices) { const group = members.get(device.memberId); if (group) group.push(device); else members.set(device.memberId, [device]); }
  return [...members.values()].map((group) => {
    const first = group[0]!;
    const open = group.filter((device) => device.revokedMs === null).length;
    const badge: Badge = !first.memberActive ? { label: `Not on the active roster, so ${open === 1 ? "this device has" : "these devices have"} no access`, tone: "neutral" }
      : open >= limit ? { label: `${open} of ${limit} devices, at the limit`, tone: "warning" }
      : { label: `${open} of ${limit} devices`, tone: "neutral" };
    const ordered = [...group].sort((a, b) => Number(a.revokedMs !== null) - Number(b.revokedMs !== null) || a.createdMs - b.createdMs);
    return { memberId: first.memberId, memberName: first.memberName, badge, devices: ordered };
  }).sort((a, b) => a.memberName.localeCompare(b.memberName));
}

export const revokeMessage = (device: Pick<Device, "label" | "memberName">) =>
  `${device.memberName}'s ${device.label} loses access at once. Its past requests stay in the log. To use it again, ${device.memberName} runs /ordering-pin and pairs it again.`;

// ---- Connection and status
export const isConnected = (status: Pick<SetupStatus, "problem">) => status.problem === null;

/** What stopped requests, in words an Admin can act on, or undefined when requests can flow. */
export function connectionProblem(status: Pick<SetupStatus, "tokenSaved" | "problem" | "schemaError">): string | undefined {
  if (status.problem === null) return undefined;
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
