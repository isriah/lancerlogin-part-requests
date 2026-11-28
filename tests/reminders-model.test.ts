// The Reminders tab's wording and form helpers, on their own. Synthetic values only.
import test from "node:test";
import assert from "node:assert/strict";
import {
  daysToMinutes, durationLabel, lastRunSummary, minutesToDays, peopleMatchingState, testingThresholdNote, reminderProblemText, remindersBadge, scheduleText, skipText, testingThreshold, unpingedText, type LastRun,
} from "../src/dashboard/part-requests-reminders-model.ts";

const settings = { enabled: true, weekdays: [1, 3, 5], runTime: "15:00", staleMinutes: 2880, cooldownMinutes: 2880, discordChannelId: "300000000000000001", revision: 1 };

test("days in the form, minutes underneath, and the same duration words as the reminder", () => {
  assert.equal(daysToMinutes("2"), 2880);
  for (const bad of ["", "0", "31", "1.5", "two"]) assert.equal(daysToMinutes(bad), undefined, bad);
  assert.equal(minutesToDays(4320), "3");
  assert.equal(minutesToDays(90), "", "a testing threshold leaves the days field empty");
  assert.equal(durationLabel(1440), "1 day");
  assert.equal(durationLabel(2880), "2 days");
  assert.equal(durationLabel(5), "5 minutes");
  assert.equal(testingThreshold(1439), true);
  assert.equal(testingThreshold(1440), false);
  assert.equal(scheduleText(settings), "Mon, Wed, Fri at 15:00");
  assert.equal(testingThresholdNote(60), "Using the testing threshold under Advanced: 60 minutes.");
});

test("the pill and the problems an Admin can act on", () => {
  assert.deepEqual(remindersBadge({ settings: { ...settings, enabled: false }, targetVerified: true, problem: null, activeRun: null }), { label: "Off", tone: "neutral" });
  assert.deepEqual(remindersBadge({ settings, targetVerified: false, problem: null, activeRun: null }), { label: "Needs attention", tone: "error" });
  assert.deepEqual(remindersBadge({ settings, targetVerified: true, problem: null, activeRun: null }), { label: "On", tone: "success" });
  assert.deepEqual(remindersBadge({ settings, targetVerified: true, problem: null, activeRun: { runKey: "manual:1", kind: "manual", state: "send" } }), { label: "Sending", tone: "success" });
  assert.match(reminderProblemText("notion_comment_403")!, /Insert comments/);
  assert.match(reminderProblemText("notion_update_403")!, /Update content/);
  assert.match(reminderProblemText("time_zone_missing")!, /time zone/);
  assert.match(reminderProblemText("target_changed")!, /Check it again/);
  assert.equal(reminderProblemText(null), undefined);
  assert.equal(reminderProblemText("disabled"), undefined);
  assert.equal(unpingedText("ambiguous"), "matches more than one member");
  assert.equal(skipText("no_people"), "Nobody set in Orderer/Recipient");
});

test("Core's people matching and the last run in words", () => {
  assert.equal(peopleMatchingState({ setUp: true, matched: 3 }), "in use, 3 people matched");
  assert.equal(peopleMatchingState({ setUp: true, matched: 1 }), "in use, 1 person matched");
  assert.equal(peopleMatchingState({ setUp: true, matched: 0 }), "set up, but nobody is matched yet, so pings use each member's default recipient");
  assert.equal(peopleMatchingState({ setUp: false, matched: 0 }), "not set up, so pings use each member's default recipient");
  // Codes 1.3 and 1.4 recorded for their own People database read as an ordinary stopped run, with no button that no longer exists.
  for (const code of ["people_schema", "people_notion_403"]) assert.doesNotMatch(reminderProblemText(code)!, /People/);
  const counts = { found: 3, reminded: 2, marked: 2, discordSent: 2, discordFailed: 0, notionFailed: 0, uncertain: 0, nobody: 1, recent: 0, pingSkipped: 0 };
  const run: LastRun = { runKey: "2026-11-25", kind: "scheduled", state: "done", errorCode: null, truncated: false, createdMs: Date.UTC(2026, 10, 25, 20), finishedMs: Date.UTC(2026, 10, 25, 20, 1), counts, nobody: [], checkPage: [], pingSkipped: [], failed: [] };
  assert.equal(lastRunSummary(run, "America/New_York"), "Scheduled run on Nov 25, 3:01 PM: 2 requests reminded.");
  assert.equal(lastRunSummary({ ...run, counts: { ...counts, found: 0, reminded: 0 } }, "America/New_York"), "Scheduled run on Nov 25, 3:01 PM: no stale requests.");
  assert.match(lastRunSummary({ ...run, state: "failed", errorCode: "disabled" }, "America/New_York"), /turned off/);
});
