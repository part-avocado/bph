import type { Project, PromptVersion, Question } from "../shared/types";

export const now = () => Date.now();
export const newId = () => crypto.randomUUID().replace(/-/g, "").slice(0, 16);

interface ProjectRow {
  id: string;
  user_id: string;
  title: string;
  idea: string;
  context: string | null;
  status: Project["status"];
  intake_complete: number;
  active_run_id: string | null;
  created_at: number;
  updated_at: number;
}

export function toProject(r: ProjectRow): Project {
  return {
    id: r.id,
    title: r.title,
    idea: r.idea,
    status: r.status,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    activeRunId: r.active_run_id,
  };
}

export async function getProjectRow(db: D1Database, id: string, userId: string) {
  return db.prepare("SELECT * FROM projects WHERE id = ? AND user_id = ?").bind(id, userId).first<ProjectRow>();
}

interface QuestionRow {
  id: string;
  prompt: string;
  why: string;
  options: string;
  answer: string | null;
  skipped: number;
}

export async function getQuestions(db: D1Database, projectId: string): Promise<Question[]> {
  const { results } = await db
    .prepare("SELECT id, prompt, why, options, answer, skipped FROM questions WHERE project_id = ? ORDER BY idx")
    .bind(projectId)
    .all<QuestionRow>();
  return results.map((q) => ({
    id: q.id,
    prompt: q.prompt,
    why: q.why,
    options: JSON.parse(q.options) as string[],
    answer: q.answer,
    skipped: !!q.skipped,
  }));
}

export async function getLatestVersion(db: D1Database, projectId: string): Promise<PromptVersion | null> {
  const r = await db
    .prepare("SELECT id, version, body, score, created_at FROM prompt_versions WHERE project_id = ? ORDER BY version DESC LIMIT 1")
    .bind(projectId)
    .first<{ id: string; version: number; body: string; score: number | null; created_at: number }>();
  return r ? { id: r.id, version: r.version, body: r.body, score: r.score, createdAt: r.created_at } : null;
}

/** The user's brief as every agent sees it: idea, attachment digest and answers. */
export async function buildBrief(db: D1Database, project: ProjectRow): Promise<string> {
  const questions = await getQuestions(db, project.id);
  const answered = questions.filter((q) => q.answer && !q.skipped);
  const lines = [`Idea: ${project.idea}`];
  if (project.context) lines.push("", "From the user's attachments:", project.context);
  if (answered.length) {
    lines.push("", "The user's answers:");
    for (const q of answered) lines.push(`- ${q.prompt} ${q.answer}`);
  }
  const skipped = questions.filter((q) => q.skipped);
  if (skipped.length) {
    lines.push("", "Skipped (decide these yourself):");
    for (const q of skipped) lines.push(`- ${q.prompt}`);
  }
  return lines.join("\n");
}

export type { ProjectRow };
