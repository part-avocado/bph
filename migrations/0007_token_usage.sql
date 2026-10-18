-- Model tokens spent per user, so a weekly cap holds even after projects are deleted.
CREATE TABLE token_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  tokens INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX token_usage_user_week ON token_usage (user_id, created_at);
