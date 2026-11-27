-- Stale-request reminders: a Notion comment, a Discord ping and "Reminder sent" on each Incomplete Request in the ordering
-- database that has waited too long. Notion is reached through Core's connection: the `orders` binding, and the optional
-- read-only `people` binding. None of this travels in a backup, so a restore turns reminders off until an Admin checks them again.

-- The one settings row. The layouts (schema_json, people_schema_json) are saved only by a successful check through Core's
-- bindings, with the data source they describe, so a binding changed in Core reads as unchecked. schedule_since_ms moves
-- forward whenever reminders are turned on or the days or time change, so a slot from before then never fires.
CREATE TABLE part_requests_reminder_settings (
  installation_id TEXT PRIMARY KEY NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0, 1)),
  weekdays TEXT NOT NULL DEFAULT '1,3,5' CHECK(length(weekdays) BETWEEN 1 AND 13),
  run_time TEXT NOT NULL DEFAULT '15:00' CHECK(length(run_time) = 5),
  stale_minutes INTEGER NOT NULL DEFAULT 2880 CHECK(typeof(stale_minutes) = 'integer' AND stale_minutes BETWEEN 1 AND 43200),
  cooldown_minutes INTEGER NOT NULL DEFAULT 2880 CHECK(typeof(cooldown_minutes) = 'integer' AND cooldown_minutes BETWEEN 1 AND 43200),
  discord_channel_id TEXT CHECK(discord_channel_id IS NULL OR (length(discord_channel_id) BETWEEN 17 AND 20 AND discord_channel_id NOT GLOB '*[^0-9]*')),
  database_id TEXT,
  data_source_id TEXT,
  schema_json TEXT,
  verified_ms INTEGER CHECK(verified_ms IS NULL OR typeof(verified_ms) = 'integer'),
  schema_error TEXT,
  people_data_source_id TEXT,
  people_schema_json TEXT,
  people_verified_ms INTEGER CHECK(people_verified_ms IS NULL OR typeof(people_verified_ms) = 'integer'),
  people_error TEXT,
  people_key TEXT NOT NULL DEFAULT 'external_id' CHECK(people_key IN ('external_id', 'id')),
  schedule_since_ms INTEGER NOT NULL CHECK(typeof(schedule_since_ms) = 'integer'),
  last_error TEXT,
  last_error_ms INTEGER CHECK(last_error_ms IS NULL OR typeof(last_error_ms) = 'integer'),
  revision INTEGER NOT NULL DEFAULT 0 CHECK(typeof(revision) = 'integer'),
  updated_ms INTEGER NOT NULL CHECK(typeof(updated_ms) = 'integer')
);

-- One row per run: the local date of a scheduled slot, or manual:<ms>. config_json is a snapshot of the settings, so a change
-- made during a run never mixes into it. mentions_json holds only IDs: Notion user ID to Discord user ID, or why there is none.
CREATE TABLE part_requests_reminder_runs (
  installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  run_key TEXT NOT NULL CHECK(length(run_key) BETWEEN 1 AND 40),
  kind TEXT NOT NULL CHECK(kind IN ('scheduled', 'manual')),
  state TEXT NOT NULL CHECK(state IN ('schema', 'people', 'collect', 'send', 'done', 'failed')),
  config_json TEXT NOT NULL,
  mentions_json TEXT,
  people_json TEXT,
  cursor TEXT,
  pages INTEGER NOT NULL DEFAULT 0 CHECK(typeof(pages) = 'integer'),
  truncated INTEGER NOT NULL DEFAULT 0 CHECK(truncated IN (0, 1)),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(typeof(attempts) = 'integer'),
  lease_token TEXT,
  lease_until_ms INTEGER NOT NULL DEFAULT 0 CHECK(typeof(lease_until_ms) = 'integer'),
  next_attempt_ms INTEGER NOT NULL DEFAULT 0 CHECK(typeof(next_attempt_ms) = 'integer'),
  error_code TEXT,
  counts_json TEXT,
  created_ms INTEGER NOT NULL CHECK(typeof(created_ms) = 'integer'),
  finished_ms INTEGER CHECK(finished_ms IS NULL OR typeof(finished_ms) = 'integer'),
  PRIMARY KEY(installation_id, run_key)
);
CREATE INDEX part_requests_reminder_runs_state ON part_requests_reminder_runs(installation_id, state, created_ms);

-- One row per stale request a run found. Each step has its own state, and a step starts only when the one before it is final.
-- comment_ms is the local backstop for the cooldown: a comment sent or uncertain counts even if "Reminder sent" was not set.
CREATE TABLE part_requests_reminder_items (
  installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  run_key TEXT NOT NULL,
  page_id TEXT NOT NULL CHECK(length(page_id) = 36),
  seq INTEGER NOT NULL CHECK(typeof(seq) = 'integer'),
  page_url TEXT NOT NULL,
  description TEXT NOT NULL CHECK(length(description) <= 200),
  people_json TEXT NOT NULL,
  mentions_json TEXT NOT NULL,
  unpinged_json TEXT NOT NULL,
  skip_reason TEXT CHECK(skip_reason IS NULL OR skip_reason IN ('no_people', 'recently_reminded')),
  comment_state TEXT NOT NULL CHECK(comment_state IN ('pending', 'sending', 'sent', 'failed', 'uncertain', 'skipped')),
  discord_state TEXT NOT NULL CHECK(discord_state IN ('pending', 'sent', 'failed', 'skipped')),
  discord_note TEXT,
  mark_state TEXT NOT NULL CHECK(mark_state IN ('pending', 'set', 'failed', 'skipped')),
  comment_ms INTEGER CHECK(comment_ms IS NULL OR typeof(comment_ms) = 'integer'),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK(typeof(attempts) = 'integer'),
  next_attempt_ms INTEGER NOT NULL DEFAULT 0 CHECK(typeof(next_attempt_ms) = 'integer'),
  error_code TEXT,
  PRIMARY KEY(installation_id, run_key, page_id),
  FOREIGN KEY(installation_id, run_key) REFERENCES part_requests_reminder_runs(installation_id, run_key) ON DELETE CASCADE
);
CREATE INDEX part_requests_reminder_items_page ON part_requests_reminder_items(installation_id, page_id, comment_ms);
