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
  summary: string | null;
  summary_confirmed: number;
  autonomous: number;
  active_run_id: string | null;
  created_at: number;
  updated_at: number;
}

/** Adds model usage to the user's weekly total (the cap is checked in service.ts). */
export async function recordTokens(db: D1Database, userId: string, usage: { tokensIn: number; tokensOut: number } | number) {
  const tokens = typeof usage === "number" ? usage : usage.tokensIn + usage.tokensOut;
  if (tokens <= 0) return;
  await db.prepare("INSERT INTO token_usage (user_id, tokens, created_at) VALUES (?, ?, ?)").bind(userId, Math.round(tokens), now()).run();
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

// Statements are exposed alongside their getters so routes can send several
// reads to D1 in one db.batch round trip instead of one request each.

export const projectStmt = (db: D1Database, id: string, userId: string) =>
  db.prepare("SELECT * FROM projects WHERE id = ? AND user_id = ?").bind(id, userId);

export async function getProjectRow(db: D1Database, id: string, userId: string) {
  return projectStmt(db, id, userId).first<ProjectRow>();
}

interface QuestionRow {
  id: string;
  prompt: string;
  why: string;
  options: string;
  answer: string | null;
  skipped: number;
}

export const questionsStmt = (db: D1Database, projectId: string) =>
  db.prepare("SELECT id, prompt, why, options, answer, skipped FROM questions WHERE project_id = ? ORDER BY idx").bind(projectId);

export function toQuestions(rows: QuestionRow[]): Question[] {
  return rows.map((q) => ({
    id: q.id,
    prompt: q.prompt,
    why: q.why,
    options: JSON.parse(q.options) as string[],
    answer: q.answer,
    skipped: !!q.skipped,
  }));
}

export async function getQuestions(db: D1Database, projectId: string): Promise<Question[]> {
  const { results } = await questionsStmt(db, projectId).all<QuestionRow>();
  return toQuestions(results);
}

interface VersionRow {
  id: string;
  version: number;
  body: string;
  score: number | null;
  created_at: number;
}

export const latestVersionStmt = (db: D1Database, projectId: string) =>
  db.prepare("SELECT id, version, body, score, created_at FROM prompt_versions WHERE project_id = ? ORDER BY version DESC LIMIT 1").bind(projectId);

export function toVersion(r: VersionRow | null | undefined): PromptVersion | null {
  return r ? { id: r.id, version: r.version, body: r.body, score: r.score, createdAt: r.created_at } : null;
}

export async function getLatestVersion(db: D1Database, projectId: string): Promise<PromptVersion | null> {
  return toVersion(await latestVersionStmt(db, projectId).first<VersionRow>());
}

/** The user's brief as every agent sees it: idea, attachment digest and answers. */
export function buildBrief(project: ProjectRow, questions: Question[]): string {
  const answered = questions.filter((q) => q.answer && !q.skipped);
  const lines = [`Idea: ${project.idea}`];
  if (project.summary_confirmed && project.summary) lines.push(`What the user confirmed they mean: ${project.summary}`);
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

export type { ProjectRow, QuestionRow, VersionRow };
