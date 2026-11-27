// When stale-request reminders run, and what their settings may be. Pure: no database, no SDK, so tests run it directly.
// Times are local to the installation's time zone. Weekdays are ISO numbers: 1 is Monday and 7 is Sunday.

export const minuteMs = 60_000;
export const dayMinutes = 1440;
export const defaultWeekdays: readonly number[] = [1, 3, 5];
export const defaultRunTime = "15:00";
export const defaultStaleMinutes = 2 * dayMinutes;
export const defaultCooldownMinutes = 2 * dayMinutes;
/** 30 days, the longest threshold or cooldown, and how long run history is kept. */
export const maximumMinutes = 30 * dayMinutes;

export type PeopleKey = "external_id" | "id";
export type ReminderSettingsInput = {
  readonly enabled: boolean; readonly weekdays: readonly number[]; readonly runTime: string; readonly staleMinutes: number;
  readonly cooldownMinutes: number; readonly discordChannelId: string | null; readonly peopleKey: PeopleKey;
};

const timePattern = /^([01]\d|2[0-3]):([0-5]\d)$/;
export const isRunTime = (value: unknown): value is string => typeof value === "string" && timePattern.test(value);
export const validMinutes = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= maximumMinutes;
export const validChannelId = (value: unknown): value is string => typeof value === "string" && /^\d{17,20}$/.test(value);

/** Every problem with submitted settings, keyed by field, in words an Admin can act on. Empty means they can be saved. */
export function settingsProblems(input: Record<string, unknown>): Record<string, string> {
  const problems: Record<string, string> = {};
  if (typeof input.enabled !== "boolean") problems.enabled = "Send enabled as true or false.";
  const days = input.weekdays;
  if (!Array.isArray(days) || !days.length || days.length > 7 || days.some((day) => !Number.isInteger(day) || day < 1 || day > 7) || new Set(days).size !== days.length) problems.weekdays = "Choose at least one day.";
  if (!isRunTime(input.runTime)) problems.runTime = "Enter a time as HH:MM, for example 15:00.";
  if (!validMinutes(input.staleMinutes)) problems.staleMinutes = `Use a whole number of minutes from 1 to ${maximumMinutes} (30 days).`;
  if (!validMinutes(input.cooldownMinutes)) problems.cooldownMinutes = `Use a whole number of minutes from 1 to ${maximumMinutes} (30 days).`;
  if (input.discordChannelId !== null && !validChannelId(input.discordChannelId)) problems.discordChannelId = "Paste a Discord channel ID: 17 to 20 digits.";
  else if (input.enabled === true && input.discordChannelId === null) problems.discordChannelId = "Choose the Discord channel reminders are posted in. It is needed while reminders are on.";
  if (input.peopleKey !== "external_id" && input.peopleKey !== "id") problems.peopleKey = "Choose which member ID the People database holds.";
  return problems;
}

export const formatWeekdays = (days: readonly number[]) => [...days].sort((a, b) => a - b).join(",");
export function parseWeekdays(text: string | null | undefined): number[] {
  const days = String(text ?? "").split(",").map(Number).filter((day) => Number.isInteger(day) && day >= 1 && day <= 7);
  return [...new Set(days)].sort((a, b) => a - b);
}

/** "2 days" or "90 minutes": whole days read as days, a testing threshold as minutes. */
export function durationText(minutes: number): string {
  if (minutes % dayMinutes === 0) { const days = minutes / dayMinutes; return `${days} ${days === 1 ? "day" : "days"}`; }
  return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
}

// ---- Local time, through Intl, which Workers and Node both carry with full time zone data.

type Local = { readonly date: string; readonly weekday: number; readonly minutes: number };
const pad = (value: number) => String(value).padStart(2, "0");

function parts(timeZone: string, ms: number) {
  const values: Record<string, number> = {};
  for (const part of new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(ms)) {
    if (part.type !== "literal") values[part.type] = Number(part.value);
  }
  return values as { year: number; month: number; day: number; hour: number; minute: number; second: number };
}

/** The local date, ISO weekday and minutes after midnight at an instant. Throws a RangeError for an unknown time zone. */
export function localAt(timeZone: string, ms: number): Local {
  const p = parts(timeZone, ms);
  const date = `${p.year}-${pad(p.month)}-${pad(p.day)}`;
  return { date, weekday: isoWeekday(date), minutes: p.hour * 60 + p.minute };
}

export function isoWeekday(date: string): number {
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay() || 7;
}

export function addDays(date: string, days: number): string {
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

const offsetAt = (timeZone: string, ms: number) => {
  const p = parts(timeZone, ms);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ms / 1000) * 1000;
};

/** The instant a local date and HH:MM time names. A time skipped by a clock change moves forward with the clock. */
export function localInstant(timeZone: string, date: string, time: string): number {
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  const [hour, minute] = time.split(":").map(Number) as [number, number];
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  const first = wall - offsetAt(timeZone, wall);
  const second = wall - offsetAt(timeZone, first);
  return first === second ? first : Math.max(first, second);
}

export type Slot = { readonly date: string; readonly ms: number };

/** The first scheduled slot after `now`, for the Admin page. */
export function nextSlot(timeZone: string, weekdays: readonly number[], runTime: string, now: number): Slot | undefined {
  if (!weekdays.length || !isRunTime(runTime)) return undefined;
  const today = localAt(timeZone, now).date;
  for (let ahead = 0; ahead <= 7; ahead++) {
    const date = addDays(today, ahead);
    if (!weekdays.includes(isoWeekday(date))) continue;
    const ms = localInstant(timeZone, date, runTime);
    if (ms > now) return { date, ms };
  }
  return undefined;
}

/**
 * The latest scheduled slot at or before `now` that is not before `sinceMs`, or undefined. Only the latest counts, so slots
 * missed while the scheduler was stopped never run one after another: the most recent runs late, once, keyed by its date.
 */
export function dueSlot(timeZone: string, weekdays: readonly number[], runTime: string, sinceMs: number, now: number): Slot | undefined {
  if (!weekdays.length || !isRunTime(runTime)) return undefined;
  const today = localAt(timeZone, now).date;
  for (let back = 0; back <= 7; back++) {
    const date = addDays(today, -back);
    if (!weekdays.includes(isoWeekday(date))) continue;
    const ms = localInstant(timeZone, date, runTime);
    if (ms > now) continue;
    return ms >= sinceMs ? { date, ms } : undefined;
  }
  return undefined;
}
