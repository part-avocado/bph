-- The model's paraphrase of the idea, which the user confirms (or corrects) before any questions.
ALTER TABLE projects ADD COLUMN summary TEXT;
ALTER TABLE projects ADD COLUMN summary_confirmed INTEGER NOT NULL DEFAULT 0;
-- Projects that already have questions were past this step.
UPDATE projects SET summary_confirmed = 1;
