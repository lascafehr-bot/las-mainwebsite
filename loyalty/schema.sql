-- Las Cafe loyalty: D1 schema. Safe to run more than once.

CREATE TABLE IF NOT EXISTS branches (
  id   INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS staff (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL UNIQUE,          -- used as the login username
  pin_hash   TEXT NOT NULL,                 -- "salt:pbkdf2" (never the raw PIN)
  branch_id  INTEGER NOT NULL REFERENCES branches(id),
  active     INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

-- One card per customer, shared by every branch.
CREATE TABLE IF NOT EXISTS customers (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  phone            TEXT NOT NULL UNIQUE,    -- normalized: 9665XXXXXXXX
  name             TEXT NOT NULL,
  card_code        TEXT NOT NULL UNIQUE,    -- what the QR / wallet pass holds, e.g. LAS-K7M2Q9XP
  cups             INTEGER NOT NULL DEFAULT 0,
  points           INTEGER NOT NULL DEFAULT 0,
  rewards_redeemed INTEGER NOT NULL DEFAULT 0,
  last_stamp_at    INTEGER,                 -- ms epoch, drives the 3-hour limit
  created_at       INTEGER NOT NULL
);

-- Audit log: every action, with staff name and branch (denormalized so history never changes).
-- type: register | stamp | visit (under min amount, no cup) | redeem | redeem_failed
CREATE TABLE IF NOT EXISTS transactions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id  INTEGER NOT NULL REFERENCES customers(id),
  type         TEXT NOT NULL,
  amount       REAL,
  cups_after   INTEGER,
  points_delta INTEGER NOT NULL DEFAULT 0,
  staff_id     INTEGER,
  staff_name   TEXT NOT NULL,
  branch_id    INTEGER,
  branch_name  TEXT,
  note         TEXT,
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tx_created  ON transactions(created_at);
CREATE INDEX IF NOT EXISTS idx_tx_customer ON transactions(customer_id);
CREATE INDEX IF NOT EXISTS idx_tx_branch   ON transactions(branch_id, created_at);

-- Short-lived counters that slow down guessing of phone numbers and PINs.
CREATE TABLE IF NOT EXISTS rate_limits (
  key TEXT NOT NULL,
  ts  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_rate ON rate_limits(key, ts);

-- Points carried over from Bonat, per phone, so importing a newer file never counts them twice.
CREATE TABLE IF NOT EXISTS bonat_import (
  phone       TEXT PRIMARY KEY,
  points      INTEGER NOT NULL,
  imported_at INTEGER NOT NULL
);

-- All business rules live here, so changing a rule never needs a schema change.
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

INSERT OR IGNORE INTO branches (name) VALUES ('العليا'), ('الملقا'), ('جدة');

INSERT OR IGNORE INTO settings (key, value) VALUES
  ('min_amount',           '10'),   -- SAR needed for a cup + points
  ('cups_per_reward',      '5'),    -- cups to fill the card (next drink is free)
  ('points_per_riyal',     '1'),    -- points earned per riyal on a qualifying bill
  ('stamp_cooldown_hours', '3'),    -- max 1 stamp per customer in this window
  -- Points redemption is not decided yet. When it is, edit this one value:
  ('points_redemption',    '{"enabled":false,"points_needed":null,"value_sar":null}'),
  ('wallet_apple_url',     ''),
  ('wallet_google_url',    '');
