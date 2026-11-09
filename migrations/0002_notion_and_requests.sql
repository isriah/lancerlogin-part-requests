-- Phase 1: the Notion connection, the request log, recipients and rate limits. None of this travels in a backup.

-- Tell a member's devices apart on the Admin page.
ALTER TABLE part_requests_devices ADD COLUMN label TEXT NOT NULL DEFAULT 'Browser extension' CHECK(length(label) BETWEEN 1 AND 60);
ALTER TABLE part_requests_devices ADD COLUMN last_used_ms INTEGER CHECK(last_used_ms IS NULL OR typeof(last_used_ms) = 'integer');

-- The Notion connection. The token is stored only as ciphertext from services.credentials. address_salt keeps client
-- addresses out of the database: only a salted hash of an address is ever stored.
CREATE TABLE part_requests_notion (
  installation_id TEXT PRIMARY KEY NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  ciphertext TEXT,
  iv TEXT,
  address_salt TEXT NOT NULL CHECK(length(address_salt) = 64),
  database_id TEXT,
  data_source_id TEXT,
  schema_json TEXT,
  verified_ms INTEGER CHECK(verified_ms IS NULL OR typeof(verified_ms) = 'integer'),
  schema_error TEXT,
  updated_ms INTEGER NOT NULL CHECK(typeof(updated_ms) = 'integer')
);

-- One row per submission ID, written before Notion is called. Names are kept as they were, so the log survives a member's
-- removal from the roster and a device's revocation.
CREATE TABLE part_requests_submissions (
  installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  id TEXT NOT NULL CHECK(length(id) = 36),
  member_id TEXT REFERENCES members(id) ON DELETE SET NULL,
  member_name TEXT NOT NULL,
  device_id TEXT NOT NULL,
  device_label TEXT NOT NULL,
  fingerprint TEXT NOT NULL CHECK(length(fingerprint) = 64),
  state TEXT NOT NULL CHECK(state IN ('pending', 'created', 'failed', 'uncertain')),
  vendor_label TEXT NOT NULL,
  description TEXT NOT NULL,
  status_name TEXT NOT NULL,
  team_name TEXT,
  recipient_name TEXT,
  sku TEXT NOT NULL,
  url TEXT NOT NULL,
  url_key TEXT NOT NULL,
  sku_key TEXT NOT NULL,
  quantity REAL,
  price REAL,
  page_url TEXT,
  failure_code TEXT,
  failure_message TEXT,
  created_ms INTEGER NOT NULL CHECK(typeof(created_ms) = 'integer'),
  finished_ms INTEGER CHECK(finished_ms IS NULL OR typeof(finished_ms) = 'integer'),
  PRIMARY KEY(installation_id, id)
);
CREATE INDEX part_requests_submissions_recent ON part_requests_submissions(installation_id, created_ms);
CREATE INDEX part_requests_submissions_url ON part_requests_submissions(installation_id, url_key, created_ms);
CREATE INDEX part_requests_submissions_sku ON part_requests_submissions(installation_id, sku_key, created_ms);

-- Fixed-window request counts per device and kind of request. The refresh job prunes old rows.
CREATE TABLE part_requests_device_limits (
  installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL,
  bucket TEXT NOT NULL CHECK(bucket IN ('create', 'general')),
  window_start_ms INTEGER NOT NULL CHECK(typeof(window_start_ms) = 'integer'),
  requests INTEGER NOT NULL CHECK(typeof(requests) = 'integer' AND requests >= 0),
  PRIMARY KEY(installation_id, device_id, bucket)
);

-- Wrong PINs per client address, by salted hash. part_requests_pairing_limits stays as the shared backstop.
CREATE TABLE part_requests_pairing_address_limits (
  installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  address_hash TEXT NOT NULL CHECK(length(address_hash) = 64),
  window_start_ms INTEGER NOT NULL CHECK(typeof(window_start_ms) = 'integer'),
  failures INTEGER NOT NULL CHECK(typeof(failures) = 'integer' AND failures >= 0),
  paused_until_ms INTEGER NOT NULL CHECK(typeof(paused_until_ms) = 'integer'),
  PRIMARY KEY(installation_id, address_hash)
);

-- Workspace members and people named on existing requests. An empty name is looked up once by the refresh job.
CREATE TABLE part_requests_recipients (
  installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  notion_user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  name_checked INTEGER NOT NULL DEFAULT 0 CHECK(name_checked IN (0, 1)),
  last_seen_ms INTEGER NOT NULL CHECK(typeof(last_seen_ms) = 'integer'),
  PRIMARY KEY(installation_id, notion_user_id)
);

-- Where the refresh job has got to, so it can do one Notion call per scheduler slice.
CREATE TABLE part_requests_recipient_refresh (
  installation_id TEXT PRIMARY KEY NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  step TEXT NOT NULL CHECK(step IN ('idle', 'schema', 'users', 'requests', 'names')),
  cursor TEXT,
  pages INTEGER NOT NULL DEFAULT 0 CHECK(typeof(pages) = 'integer'),
  next_due_ms INTEGER NOT NULL CHECK(typeof(next_due_ms) = 'integer'),
  finished_ms INTEGER CHECK(finished_ms IS NULL OR typeof(finished_ms) = 'integer'),
  last_error TEXT
);

-- Each member's chosen Notion person, the default on their later requests.
CREATE TABLE part_requests_member_recipients (
  installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  notion_user_id TEXT NOT NULL,
  updated_ms INTEGER NOT NULL CHECK(typeof(updated_ms) = 'integer'),
  PRIMARY KEY(installation_id, member_id)
);
