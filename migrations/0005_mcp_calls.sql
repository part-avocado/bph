-- Model-backed MCP tool calls, so an agent looping on a tool can't run up Gemini usage.
CREATE TABLE mcp_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX mcp_calls_user_day ON mcp_calls (user_id, created_at);
