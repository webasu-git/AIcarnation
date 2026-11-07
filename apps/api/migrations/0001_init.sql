CREATE TABLE users (
  anon_id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL
);

CREATE TABLE agents (
  id TEXT PRIMARY KEY,
  anon_id TEXT NOT NULL REFERENCES users(anon_id),
  definition TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
