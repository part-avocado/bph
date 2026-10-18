-- Run starts outlive their project so deleting a project can't reset the weekly run limit.
CREATE TABLE run_starts (
  id TEXT PRIMARY KEY,            -- run id
  user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX run_starts_user_day ON run_starts (user_id, created_at);

INSERT INTO run_starts (id, user_id, created_at) SELECT id, user_id, created_at FROM runs;
