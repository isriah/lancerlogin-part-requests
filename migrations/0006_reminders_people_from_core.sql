-- Reminders no longer read a People database of their own: Core's people matching (module SDK 1.10.0) says which member is
-- behind each Notion person, so the People layout, its check and the choice of member ID column are not kept here any more.
-- Forward only: 0005 is released and never edited. Each column is dropped in place, without rebuilding the table. The CHECK
-- constraints on people_verified_ms and people_key belong to those columns alone, and no index, trigger, view or other
-- constraint names any of the five, which is what SQLite requires to drop a column.
ALTER TABLE part_requests_reminder_settings DROP COLUMN people_data_source_id;
ALTER TABLE part_requests_reminder_settings DROP COLUMN people_schema_json;
ALTER TABLE part_requests_reminder_settings DROP COLUMN people_verified_ms;
ALTER TABLE part_requests_reminder_settings DROP COLUMN people_error;
ALTER TABLE part_requests_reminder_settings DROP COLUMN people_key;
