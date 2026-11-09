-- Carts: the switch, a short-lived copy of the open orders, and who has built a cart for which order.

-- The Admin switch for reading open orders. A paired device can read the whole team's orders while it is on.
ALTER TABLE part_requests_settings ADD COLUMN carts_enabled INTEGER NOT NULL DEFAULT 1 CHECK(carts_enabled IN (0, 1));

-- Where the copy has got to. A refresh reads one Notion page per request, so a long list takes several requests and keeps its
-- place here. lease_until_ms stops two requests reading Notion at once, and holds off retries after a failure.
CREATE TABLE part_requests_orders_state (
  installation_id TEXT PRIMARY KEY NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  published_generation INTEGER NOT NULL DEFAULT 0 CHECK(typeof(published_generation) = 'integer'),
  published_ms INTEGER CHECK(published_ms IS NULL OR typeof(published_ms) = 'integer'),
  published_truncated INTEGER NOT NULL DEFAULT 0 CHECK(published_truncated IN (0, 1)),
  published_skipped INTEGER NOT NULL DEFAULT 0 CHECK(typeof(published_skipped) = 'integer'),
  build_generation INTEGER CHECK(build_generation IS NULL OR typeof(build_generation) = 'integer'),
  build_cursor TEXT,
  build_pages INTEGER NOT NULL DEFAULT 0 CHECK(typeof(build_pages) = 'integer'),
  build_started_ms INTEGER CHECK(build_started_ms IS NULL OR typeof(build_started_ms) = 'integer'),
  build_skipped INTEGER NOT NULL DEFAULT 0 CHECK(typeof(build_skipped) = 'integer'),
  lease_until_ms INTEGER NOT NULL DEFAULT 0 CHECK(typeof(lease_until_ms) = 'integer'),
  last_error TEXT
);

-- The open orders, one row per Notion page read. A whole list is a few rows rather than one per order, because D1 counts rows
-- read and written. Readers only see the published generation, so a half-read list is never served.
CREATE TABLE part_requests_orders_cache (
  installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  generation INTEGER NOT NULL CHECK(typeof(generation) = 'integer'),
  page INTEGER NOT NULL CHECK(typeof(page) = 'integer'),
  orders_json TEXT NOT NULL,
  PRIMARY KEY(installation_id, generation, page)
);

-- One row per order per device: this device built a cart holding this quantity. Names come from the member and device rows when
-- read, so no personal data is copied here. Rows go away with the device or member, and expire so an unbought cart cannot hide
-- an order forever.
CREATE TABLE part_requests_cart_marks (
  installation_id TEXT NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  order_id TEXT NOT NULL CHECK(length(order_id) = 36),
  device_id TEXT NOT NULL,
  member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  quantity REAL NOT NULL CHECK(quantity > 0),
  marked_ms INTEGER NOT NULL CHECK(typeof(marked_ms) = 'integer'),
  expires_ms INTEGER NOT NULL CHECK(typeof(expires_ms) = 'integer'),
  PRIMARY KEY(installation_id, order_id, device_id),
  FOREIGN KEY(installation_id, device_id) REFERENCES part_requests_devices(installation_id, id) ON DELETE CASCADE
);
CREATE INDEX part_requests_cart_marks_expiry ON part_requests_cart_marks(installation_id, expires_ms);
CREATE INDEX part_requests_cart_marks_device ON part_requests_cart_marks(installation_id, device_id);
