// When reminders run, and which settings they accept. Pure functions, no database.
import test from "node:test";
import assert from "node:assert/strict";
import { dueSlot, durationText, localAt, localInstant, nextSlot, parseWeekdays, settingsProblems } from "../src/reminder-schedule.ts";

const zone = "America/New_York";
const monWedFri = [1, 3, 5];
const utc = (month: number, day: number, hour: number, minute = 0) => Date.UTC(2026, month - 1, day, hour, minute);

test("Mon, Wed and Fri at 15:00 New York time, before and after spring forward (2026-03-08)", () => {
  // Friday before the change is EST (UTC-5); Monday after it is EDT (UTC-4).
  assert.deepEqual(dueSlot(zone, monWedFri, "15:00", 0, utc(3, 6, 20, 1)), { date: "2026-03-06", ms: utc(3, 6, 20) });
  assert.deepEqual(dueSlot(zone, monWedFri, "15:00", 0, utc(3, 9, 19, 0)), { date: "2026-03-09", ms: utc(3, 9, 19) });
  // 14:59 EDT on Monday: the latest slot is still Friday's.
  assert.deepEqual(dueSlot(zone, monWedFri, "15:00", 0, utc(3, 9, 18, 59)), { date: "2026-03-06", ms: utc(3, 6, 20) });
  // Sunday, the day of the change, is not a run day.
  assert.equal(dueSlot(zone, monWedFri, "15:00", 0, utc(3, 8, 20))!.date, "2026-03-06");
});

test("Mon, Wed and Fri at 15:00 New York time, before and after fall back (2026-11-01)", () => {
  assert.deepEqual(dueSlot(zone, monWedFri, "15:00", 0, utc(10, 30, 19)), { date: "2026-10-30", ms: utc(10, 30, 19) });
  assert.deepEqual(dueSlot(zone, monWedFri, "15:00", 0, utc(11, 1, 12)), { date: "2026-10-30", ms: utc(10, 30, 19) });
  assert.deepEqual(dueSlot(zone, monWedFri, "15:00", 0, utc(11, 2, 20)), { date: "2026-11-02", ms: utc(11, 2, 20) });
  // 19:30 UTC on Monday is 14:30 EST, so Monday's slot has not come yet.
  assert.equal(dueSlot(zone, monWedFri, "15:00", 0, utc(11, 2, 19, 30))!.date, "2026-10-30");
});

test("a slot before the since time never fires; the next one does", () => {
  const since = utc(3, 9, 19, 1);
  assert.equal(dueSlot(zone, monWedFri, "15:00", since, utc(3, 9, 19, 30)), undefined, "turned on just after Monday's slot");
  assert.equal(dueSlot(zone, monWedFri, "15:00", since, utc(3, 10, 12)), undefined, "Tuesday: still nothing");
  assert.deepEqual(dueSlot(zone, monWedFri, "15:00", since, utc(3, 11, 19)), { date: "2026-03-11", ms: utc(3, 11, 19) });
  assert.deepEqual(dueSlot(zone, monWedFri, "15:00", utc(3, 9, 19), utc(3, 9, 19)), { date: "2026-03-09", ms: utc(3, 9, 19) }, "a slot exactly at since counts");
});

test("slots missed while the scheduler was stopped: only the latest runs, late", () => {
  // Stopped from Monday morning to Saturday: Wednesday's and Friday's slots were missed. Only Friday's is due.
  assert.deepEqual(dueSlot(zone, monWedFri, "15:00", utc(3, 9, 12), utc(3, 14, 16)), { date: "2026-03-13", ms: utc(3, 13, 19) });
  // Thursday noon: Wednesday's slot runs late.
  assert.deepEqual(dueSlot(zone, monWedFri, "15:00", 0, utc(3, 12, 16)), { date: "2026-03-11", ms: utc(3, 11, 19) });
});

test("other days and times, the next slot, and local dates", () => {
  assert.deepEqual(dueSlot(zone, [7], "09:30", 0, utc(3, 10, 12)), { date: "2026-03-08", ms: utc(3, 8, 13, 30) });
  assert.deepEqual(nextSlot(zone, monWedFri, "15:00", utc(3, 9, 19)), { date: "2026-03-11", ms: utc(3, 11, 19) }, "strictly after now");
  assert.deepEqual(nextSlot(zone, monWedFri, "15:00", utc(3, 9, 18)), { date: "2026-03-09", ms: utc(3, 9, 19) });
  assert.equal(dueSlot(zone, [], "15:00", 0, utc(3, 9, 20)), undefined);
  assert.equal(dueSlot(zone, monWedFri, "25:00", 0, utc(3, 9, 20)), undefined);
  assert.deepEqual(localAt(zone, utc(3, 9, 3)), { date: "2026-03-08", weekday: 7, minutes: 23 * 60 });
  // A skipped local time moves forward by the skipped hour.
  assert.equal(localInstant(zone, "2026-03-08", "02:30"), utc(3, 8, 7, 30));
  assert.throws(() => dueSlot("Not/AZone", monWedFri, "15:00", 0, utc(3, 9, 20)), RangeError);
});

test("settings validation, including minutes for testing", () => {
  const good = { enabled: true, weekdays: [1, 3, 5], runTime: "15:00", staleMinutes: 2880, cooldownMinutes: 2880, discordChannelId: "123456789012345678" };
  assert.deepEqual(settingsProblems(good), {});
  // The channel is required while reminders are on, and may be empty while they are off.
  assert.ok(settingsProblems({ ...good, discordChannelId: null }).discordChannelId);
  assert.deepEqual(settingsProblems({ ...good, enabled: false, discordChannelId: null }), {});
  assert.deepEqual(settingsProblems({ ...good, staleMinutes: 1, cooldownMinutes: 43_200, discordChannelId: "123456789012345678" }), {});
  for (const minutes of [0, -1, 43_201, 1.5, "10", null]) {
    assert.ok(settingsProblems({ ...good, staleMinutes: minutes }).staleMinutes, `stale ${minutes}`);
    assert.ok(settingsProblems({ ...good, cooldownMinutes: minutes }).cooldownMinutes, `cooldown ${minutes}`);
  }
  for (const weekdays of [[], [0], [8], [1, 1], "1,3,5", [1.5]]) assert.ok(settingsProblems({ ...good, weekdays }).weekdays, JSON.stringify(weekdays));
  for (const runTime of ["24:00", "3:00", "15:60", "", 1500]) assert.ok(settingsProblems({ ...good, runTime }).runTime, String(runTime));
  for (const channel of ["123", "abc456789012345678", "", 1234567890123456789]) assert.ok(settingsProblems({ ...good, discordChannelId: channel }).discordChannelId, String(channel));
  assert.ok(settingsProblems({ ...good, enabled: "yes" }).enabled);
  assert.deepEqual(parseWeekdays("5,1,3,3,9"), [1, 3, 5]);
});

test("the threshold reads as days when whole, as minutes when testing", () => {
  assert.equal(durationText(2880), "2 days");
  assert.equal(durationText(1440), "1 day");
  assert.equal(durationText(1), "1 minute");
  assert.equal(durationText(90), "90 minutes");
});
