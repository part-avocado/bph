-- runs is read and deleted by project (GET /projects/:id sums rounds, DELETE
-- /projects/:id and the ON DELETE CASCADE from projects), which scanned the
-- whole table. Including rounds lets the SUM read the index alone.
CREATE INDEX IF NOT EXISTS runs_project ON runs (project_id, rounds);
