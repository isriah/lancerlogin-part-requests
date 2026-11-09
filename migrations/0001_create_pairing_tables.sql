-- Pairing through Discord. PINs and device keys are stored only as SHA-256. Rows go away with the member.

-- The address /ordering-pin sends to students. The command handler receives no services, so it reads this from the database.
CREATE TABLE part_requests_settings (
  installation_id TEXT PRIMARY KEY NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  site_address TEXT NOT NULL CHECK(length(site_address) BETWEEN 1 AND 200),
  updated_ms INTEGER NOT NULL CHECK(typeof(updated_ms) = 'integer')
);

-- One row per PIN. device_id is set by the statement that uses the PIN, so the device insert follows that exact use.
CREATE TABLE part_requests_pairing_pins (
  installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  pin_hash TEXT NOT NULL CHECK(length(pin_hash) = 64 AND pin_hash NOT GLOB '*[^0-9a-f]*'),
  member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  created_ms INTEGER NOT NULL CHECK(typeof(created_ms) = 'integer'),
  expires_ms INTEGER NOT NULL CHECK(typeof(expires_ms) = 'integer'),
  cancelled_ms INTEGER CHECK(cancelled_ms IS NULL OR typeof(cancelled_ms) = 'integer'),
  used_ms INTEGER CHECK(used_ms IS NULL OR typeof(used_ms) = 'integer'),
  device_id TEXT,
  PRIMARY KEY(installation_id, pin_hash)
);
-- At most one unused PIN per member; running the command again cancels the earlier one first.
CREATE UNIQUE INDEX part_requests_pairing_pins_open ON part_requests_pairing_pins(installation_id, member_id) WHERE used_ms IS NULL AND cancelled_ms IS NULL;
CREATE INDEX part_requests_pairing_pins_member ON part_requests_pairing_pins(installation_id, member_id, expires_ms);

-- Paired devices. A member can have up to five with revoked_ms unset; the limit is enforced where PINs and devices are added.
CREATE TABLE part_requests_devices (
  installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  id TEXT NOT NULL,
  key_hash TEXT NOT NULL CHECK(length(key_hash) = 64 AND key_hash NOT GLOB '*[^0-9a-f]*'),
  member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  created_ms INTEGER NOT NULL CHECK(typeof(created_ms) = 'integer'),
  revoked_ms INTEGER CHECK(revoked_ms IS NULL OR typeof(revoked_ms) = 'integer'),
  PRIMARY KEY(installation_id, id),
  UNIQUE(installation_id, key_hash)
);
CREATE INDEX part_requests_devices_member ON part_requests_devices(installation_id, member_id, revoked_ms);

-- Wrong PINs across the installation. A PIN identifies nobody until it matches, so there is no per-member count.
CREATE TABLE part_requests_pairing_limits (
  installation_id TEXT PRIMARY KEY NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  window_start_ms INTEGER NOT NULL CHECK(typeof(window_start_ms) = 'integer'),
  failures INTEGER NOT NULL CHECK(typeof(failures) = 'integer' AND failures >= 0),
  paused_until_ms INTEGER NOT NULL CHECK(typeof(paused_until_ms) = 'integer')
);
