-- Office Agents Analytics — D1 schema

CREATE TABLE IF NOT EXISTS proxy_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT DEFAULT (datetime('now')),
  device_hash TEXT NOT NULL,
  target_host TEXT,
  model TEXT,
  status INTEGER,
  method TEXT
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT DEFAULT (datetime('now')),
  type TEXT NOT NULL,
  device_hash TEXT,
  detail TEXT
);

CREATE INDEX IF NOT EXISTS idx_proxy_ts ON proxy_requests(ts);
CREATE INDEX IF NOT EXISTS idx_proxy_device ON proxy_requests(device_hash);
CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);
CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
