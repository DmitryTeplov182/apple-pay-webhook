CREATE TABLE IF NOT EXISTS requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT NOT NULL,
  method TEXT NOT NULL,
  path TEXT NOT NULL,
  content_type TEXT,
  query TEXT NOT NULL,
  headers TEXT NOT NULL,
  raw_body TEXT NOT NULL,
  raw_body_encoding TEXT NOT NULL,
  "json" TEXT,
  form TEXT
);

CREATE INDEX IF NOT EXISTS idx_requests_timestamp ON requests (timestamp);

CREATE TABLE IF NOT EXISTS zenmoney_tags (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  parent_id TEXT,
  show_income INTEGER NOT NULL,
  show_outcome INTEGER NOT NULL,
  changed INTEGER NOT NULL,
  raw TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY,
  created_at TEXT NOT NULL,
  amount TEXT NOT NULL,
  currency TEXT NOT NULL DEFAULT '',
  "transaction" TEXT NOT NULL,
  name TEXT NOT NULL,
  card TEXT NOT NULL,
  merchant TEXT NOT NULL,
  category_id TEXT,
  zenmoney_id TEXT,
  zenmoney_pending INTEGER NOT NULL DEFAULT 0,
  raw TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_payments_merchant ON payments (merchant);

CREATE TABLE IF NOT EXISTS merchant_rules (
  merchant_key TEXT PRIMARY KEY,
  merchant TEXT NOT NULL,
  category_id TEXT
);

CREATE TABLE IF NOT EXISTS zenmoney_accounts (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  type TEXT NOT NULL,
  currency TEXT NOT NULL,
  instrument_id INTEGER,
  archive INTEGER NOT NULL,
  changed INTEGER NOT NULL,
  raw TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS card_accounts (
  card TEXT PRIMARY KEY,
  account_id TEXT NOT NULL
);
