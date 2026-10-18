-- MCP skills created in "dangerous" mode: the agent answers its own questions and iterates without asking the user.
ALTER TABLE projects ADD COLUMN autonomous INTEGER NOT NULL DEFAULT 0;
