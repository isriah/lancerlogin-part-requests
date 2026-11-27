// What the Reminders tab shows, worked out from what the Worker returned. It imports nothing but the shared model, so the
// plugin's unit tests can run it.
import { formatDateTime, type Badge } from "./part-requests-model.ts";

export type ReminderSettings = {
  readonly enabled: boolean; readonly weekdays: readonly number[]; readonly runTime: string; readonly staleMinutes: number; readonly cooldownMinutes: number;
  readonly discordChannelId: string | null; readonly peopleKey: "external_id" | "id"; readonly revision: number;
};
export type RunCounts = Readonly<Record<"found" | "reminded" | "marked" | "discordSent" | "discordFailed" | "notionFailed" | "uncertain" | "nobody" | "recent" | "pingSkipped", number>>;
export type RequestLink = { readonly description: string; readonly pageUrl: string };
export type LastRun = {
  readonly runKey: string; readonly kind: string; readonly state: string; readonly errorCode: string | null; readonly truncated: boolean; readonly createdMs: number; readonly finishedMs: number;
  readonly counts: RunCounts; readonly nobody: readonly RequestLink[]; readonly checkPage: readonly RequestLink[];
  readonly pingSkipped: readonly (RequestLink & { readonly people: readonly { readonly name: string; readonly reason: string }[] })[];
  readonly failed: readonly (RequestLink & { readonly step: string; readonly code: string | null })[];
};
export type RemindersView = {
  readonly settings: ReminderSettings;
  readonly core: { readonly connected: boolean; readonly capabilities: { readonly comment: string; readonly update: string }; readonly ordersBound: boolean; readonly peopleBound: boolean };
  readonly target: { readonly dataSourceName: string | null; readonly verifiedMs: number | null; readonly schemaError: string | null; readonly current: boolean } | null;
  readonly targetVerified: boolean;
  readonly people: { readonly dataSourceName: string | null; readonly verifiedMs: number | null; readonly error: string | null; readonly current: boolean } | null;
  readonly problem: string | null; readonly problemMs: number | null; readonly timeZone: string | null; readonly nextRunMs: number | null;
  readonly activeRun: { readonly runKey: string; readonly kind: string; readonly state: string } | null;
  readonly lastRun: LastRun | null;
};
export type PreviewRequest = {
  readonly description: string; readonly pageUrl: string; readonly createdMs: number; readonly skipReason: string | null; readonly pings: number;
  readonly people: readonly { readonly name: string; readonly ping: boolean; readonly reason: string | null }[];
};
export type PreviewResult = { readonly requests: readonly PreviewRequest[]; readonly more: boolean; readonly source: "people" | "fallback"; readonly peopleIncomplete: boolean; readonly discordOff: boolean };

export const remindersRoute = "/admin/part-requests/reminders";
export const dayMinutes = 1440;
export const weekdayNames: readonly (readonly [number, string])[] = [[1, "Mon"], [2, "Tue"], [3, "Wed"], [4, "Thu"], [5, "Fri"], [6, "Sat"], [7, "Sun"]];

/** "2 days", "1 day" or, for a testing threshold, "90 minutes": the same words the reminder uses. */
export function durationLabel(minutes: number): string {
  if (minutes % dayMinutes === 0) { const days = minutes / dayMinutes; return `${days} ${days === 1 ? "day" : "days"}`; }
  return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
}

/** Days typed in the form, as minutes, or undefined when it is not a whole number of days from 1 to 30. */
export function daysToMinutes(text: string): number | undefined {
  const days = Number(text);
  return text.trim() !== "" && Number.isInteger(days) && days >= 1 && days <= 30 ? days * dayMinutes : undefined;
}
/** The days field shows whole days only; a testing threshold in minutes leaves it empty. */
export const minutesToDays = (minutes: number) => minutes % dayMinutes === 0 ? String(minutes / dayMinutes) : "";
export const testingThreshold = (minutes: number) => minutes < dayMinutes;

export const scheduleText = (settings: Pick<ReminderSettings, "weekdays" | "runTime">) =>
  `${weekdayNames.filter(([day]) => settings.weekdays.includes(day)).map(([, name]) => name).join(", ") || "No days"} at ${settings.runTime}`;

/** The tab's pill: what reminders are doing now. */
export function remindersBadge(view: Pick<RemindersView, "settings" | "targetVerified" | "problem" | "activeRun">): Badge {
  if (view.activeRun) return { label: "Sending", tone: "success" };
  if (!view.settings.enabled) return { label: "Off", tone: "neutral" };
  if (!view.targetVerified || view.problem) return { label: "Needs attention", tone: "error" };
  return { label: "On", tone: "success" };
}

const integrations = "Settings > Integrations > Notion";

/** What went wrong in the last run or check, and the fix, in words an Admin can act on. Undefined when nothing did. */
export function reminderProblemText(code: string | null, timeZone?: string, at?: number | null): string | undefined {
  if (!code) return undefined;
  const when = at ? ` (${formatDateTime(at, timeZone)})` : "";
  if (code === "notion_comment_403") return `Notion refused to add a reminder comment${when}. Turn on Insert comments in the connection's Capabilities in Notion's integration settings, then send reminders again.`;
  if (code === "notion_update_403") return `Notion refused to set Reminder sent${when}. Turn on Update content in the connection's Capabilities in Notion's integration settings. Reminders already commented on are not commented on again within the cooldown.`;
  if (code === "notion_comment_404") return `Notion could not find a request to comment on${when}. Check that the ordering database is still shared with Core's Notion connection.`;
  if (code === "schema") return "The ordering database no longer has what reminders need. Fix it in Notion, then check the ordering database again.";
  if (code === "target_changed") return "The ordering database chosen in Core changed. Check it again for reminders.";
  if (code === "people_schema") return "The People database no longer has what reminders need. Fix it in Notion, then check People again.";
  if (code.startsWith("people_notion_")) return "Notion refused to read the People database. Share it with Core's Notion connection, or stop using People.";
  if (code === "time_zone_missing") return "Set the installation's time zone in Settings, so reminders know when 3 PM is.";
  if (code === "time_zone_invalid") return "The installation's time zone is not one reminders recognise. Choose it again in Settings.";
  if (code === "notion_not_connected" || code === "notion_not_configured" || code === "notion_disabled" || code === "notion_unreadable") return `Core's Notion connection is not usable, so reminders stopped. Fix it in ${integrations}.`;
  if (code === "notion_unbound") return "Part Requests has no ordering database chosen in Core, so reminders stopped. Choose it on the Connection tab.";
  if (code === "notion_out_of_scope") return "A request was not in the ordering database chosen in Core, so nothing was sent for it and the run stopped. Check the ordering database again.";
  if (code === "notion_401") return `Notion rejected the token saved in Core. Save a new one in ${integrations}.`;
  if (code === "disabled") return undefined;
  return `The last run stopped before it finished${when}. It is tried again at the next scheduled time.`;
}

export const unpingedText = (reason: string) => reason === "ambiguous" ? "matches more than one member" : reason === "no_discord_id" ? "member has no Discord account linked" : "not matched to a member";
export const skipText = (reason: string | null) => reason === "no_people" ? "Nobody set in Orderer/Recipient" : reason === "recently_reminded" ? "Reminded recently" : "Will be reminded";
export const stepText = (step: string) => step === "comment" ? "Notion comment" : step === "mark" ? "Reminder sent" : "Discord message";

/** The last run in one line. */
export function lastRunSummary(run: LastRun, timeZone?: string): string {
  const when = formatDateTime(run.finishedMs || run.createdMs, timeZone);
  const kind = run.kind === "manual" ? "Sent by an Admin" : "Scheduled run";
  if (run.state === "failed" && run.errorCode === "disabled") return `${kind} on ${when} was stopped when reminders were turned off.`;
  const reminded = `${run.counts.reminded} ${run.counts.reminded === 1 ? "request" : "requests"} reminded`;
  return `${kind} on ${when}: ${run.counts.found ? reminded : "no stale requests"}${run.state === "failed" ? ", then it stopped" : ""}.`;
}

/** The People data source matches what was checked, or the reason pings use default recipients instead. */
export function peopleNote(view: Pick<RemindersView, "people" | "core">): string {
  if (!view.core.peopleBound) return "No People database is chosen, so pings use each member's default recipient. That may be a mentor rather than the member.";
  if (!view.people) return "Check the People database so reminders can use it.";
  if (view.people.error) return "The People database no longer has what reminders need. Check it again after fixing it in Notion.";
  if (!view.people.current) return "The People database chosen in Core changed. Check it again.";
  return "Pings use the People database: Notion account, then LancerLogin member ID, then the member's Discord account.";
}

/** Said under a days field while its value is a testing threshold in minutes, which the days field cannot show. */
export const testingThresholdNote = (minutes: number) => `Using the testing threshold under Advanced: ${durationLabel(minutes)}.`;

/** The People card's one status: in use, chosen but waiting for a check, or not chosen. */
export function peopleBadge(view: Pick<RemindersView, "people" | "core">): Badge {
  if (view.people && view.people.current && !view.people.error) return { label: "In use", tone: "success" };
  if (view.core.peopleBound) return { label: "Check needed", tone: "warning" };
  return { label: "Not chosen", tone: "neutral" };
}
