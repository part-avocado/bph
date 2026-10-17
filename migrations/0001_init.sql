CREATE TABLE users (
  id TEXT PRIMARY KEY,            -- Clerk user id
  email TEXT,
  name TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  title TEXT NOT NULL,
  idea TEXT NOT NULL,
  context TEXT,                   -- digest of attachments, filled lazily
  status TEXT NOT NULL DEFAULT 'intake',
  intake_complete INTEGER NOT NULL DEFAULT 0,
  active_run_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX projects_user ON projects (user_id, updated_at DESC);

CREATE TABLE attachments (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  r2_key TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX attachments_project ON attachments (project_id);

CREATE TABLE questions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  idx INTEGER NOT NULL,
  prompt TEXT NOT NULL,
  why TEXT NOT NULL DEFAULT '',
  options TEXT NOT NULL,          -- JSON array
  answer TEXT,
  skipped INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX questions_project ON questions (project_id, idx);

CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  status TEXT NOT NULL,
  rounds INTEGER NOT NULL DEFAULT 0,
  score INTEGER,
  tokens_in INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  finished_at INTEGER
);
CREATE INDEX runs_user_day ON runs (user_id, created_at);

CREATE TABLE prompt_versions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
  run_id TEXT NOT NULL,
  parent_id TEXT,
  version INTEGER NOT NULL,
  body TEXT NOT NULL,
  score INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX versions_project ON prompt_versions (project_id, version DESC);
