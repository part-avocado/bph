// Logic shared by the web routes and the MCP tools, so limits and ownership checks behave the same on both.
import type { IntakeState, Question } from "../shared/types";
import {
  buildBrief,
  getProjectRow,
  getQuestions,
  latestVersionStmt,
  newId,
  now,
  questionsStmt,
  toProject,
  toQuestions,
  toVersion,
  projectStmt,
  type ProjectRow,
  type QuestionRow,
  type VersionRow,
} from "./db";
import { planQuestions } from "./intake";
import type { RunConfig } from "./run";

export type Failure = { error: string; status: 400 | 404 | 409 | 429 };

const DAY_MS = 24 * 60 * 60 * 1000;
// Per user, per 24 hours. Callers loop (agents, or a script against the web API), so the
// model-backed steps and project creation are capped the same way on both surfaces.
export const MODEL_CALL_LIMIT = 200;
export const PROJECT_LIMIT = 30;
// Questions per project, answered or not; a re-plan never needs more than this.
const MAX_QUESTION_ROWS = 20;

/** Reserves one model-backed call, atomically so parallel calls can't overshoot the cap. Returns false at the cap. */
export async function spendModelCall(env: Env, userId: string): Promise<boolean> {
  const res = await env.DB.prepare(
    "INSERT INTO mcp_calls (user_id, created_at) SELECT ?1, ?2 WHERE (SELECT COUNT(*) FROM mcp_calls WHERE user_id = ?1 AND created_at > ?3) < ?4",
  )
    .bind(userId, now(), now() - DAY_MS, MODEL_CALL_LIMIT)
    .run();
  return !!res.meta.changes;
}

export async function projectLimitReached(env: Env, userId: string): Promise<boolean> {
  const used = await env.DB.prepare("SELECT COUNT(*) AS n FROM projects WHERE user_id = ? AND created_at > ?")
    .bind(userId, now() - DAY_MS)
    .first<{ n: number }>();
  return (used?.n ?? 0) >= PROJECT_LIMIT;
}

export const toIntakeState = (row: ProjectRow, questions: Question[]): IntakeState => ({
  project: toProject(row),
  questions,
  complete: !!row.intake_complete,
  summary: row.summary,
  summaryConfirmed: !!row.summary_confirmed,
});

/** Reads the project and its questions in one round trip. */
export async function loadIntake(db: D1Database, projectId: string, userId: string) {
  const [p, q] = await db.batch([projectStmt(db, projectId, userId), questionsStmt(db, projectId)]);
  return { row: p.results[0] as ProjectRow | undefined, questions: toQuestions(q.results as QuestionRow[]) };
}

/** Saves one answer (or skip) and, unless told otherwise, re-plans the questions that follow. */
export async function answerQuestion(
  env: Env,
  row: ProjectRow,
  userId: string,
  body: { questionId: string; prompt?: unknown; answer: string | null | undefined; replan?: unknown },
): Promise<IntakeState> {
  if (row.status !== "intake") return toIntakeState(row, await getQuestions(env.DB, row.id));
  const answer = body.answer?.trim().slice(0, 1000) || null;
  const skipped = answer ? 0 : 1;

  const res = await env.DB.prepare("UPDATE questions SET answer = ?, skipped = ? WHERE id = ? AND project_id = ?")
    .bind(answer, skipped, body.questionId, row.id)
    .run();
  if (!res.meta.changes) {
    // The question was replaced by a re-plan while the user was answering it. Keep the answer anyway,
    // placed just before the first open slot (counted and inserted in one statement).
    // OR IGNORE: the id comes from the client, so never let it collide with another project's question.
    // The row cap stops a client from growing the table by sending ids that match nothing.
    await env.DB.prepare(
      `INSERT OR IGNORE INTO questions (id, project_id, idx, prompt, why, options, answer, skipped)
       SELECT ?, ?, n - 0.5, ?, '', '[]', ?, ?
       FROM (SELECT COUNT(*) AS n FROM questions WHERE project_id = ? AND (answer IS NOT NULL OR skipped = 1))
       WHERE (SELECT COUNT(*) FROM questions WHERE project_id = ?) < ?`,
    )
      .bind(body.questionId, row.id, String(body.prompt ?? "").slice(0, 300), answer, skipped, row.id, row.id, MAX_QUESTION_ROWS)
      .run();
  }
  if (body.replan !== false) {
    // The answer is saved either way; a failed re-plan just keeps the questions already planned.
    try {
      const planned = await planQuestions(env, row);
      return toIntakeState(planned.row, planned.questions);
    } catch (err) {
      console.error("replan failed", err);
    }
  }
  const fresh = await loadIntake(env.DB, row.id, userId);
  return toIntakeState(fresh.row ?? row, fresh.questions);
}

/** Starts a build run, or returns the one already going. Enforces the daily limit. */
export async function startRun(env: Env, row: ProjectRow, userId: string, improve: boolean | undefined, feedback?: string): Promise<{ runId: string } | Failure> {
  // Everything the decision needs, fetched at once: the brief's questions and the base version
  // in one D1 batch, alongside the active run's state from its Durable Object.
  const db = env.DB;
  const [[q, v], existing] = await Promise.all([
    db.batch([questionsStmt(db, row.id), ...(improve ? [latestVersionStmt(db, row.id)] : [])]),
    row.active_run_id && row.status === "building" ? env.RUN.get(env.RUN.idFromName(row.active_run_id)).getState() : null,
  ]);
  // A run that's still going is returned as-is, and doesn't count against the daily limit.
  if (existing && existing.status !== "done" && existing.status !== "failed") return { runId: row.active_run_id! };

  const base = v ? toVersion(v.results[0] as VersionRow | undefined) : null;
  const runId = newId();
  const config: RunConfig = {
    runId,
    projectId: row.id,
    userId,
    brief: buildBrief(row, toQuestions(q.results as QuestionRow[])),
    maxRounds: improve ? 2 : 3,
    // Improving an already-strong prompt should still aim higher than where it is.
    targetScore: base?.score != null ? Math.min(99, Math.max(95, base.score + 2)) : 95,
    tokenBudget: Number(env.RUN_TOKEN_BUDGET),
    feedback: improve ? feedback?.trim().slice(0, 1000) || undefined : undefined,
    base: base ? { id: base.id, version: base.version, body: base.body, score: base.score } : null,
  };
  // Take a slot under the daily limit in the same statement that counts, so parallel starts
  // (even for different projects) can't all pass a stale count. The run id doubles as the row id.
  const slot = await env.DB.prepare(
    "INSERT INTO run_starts (id, user_id, created_at) SELECT ?1, ?2, ?3 WHERE (SELECT COUNT(*) FROM run_starts WHERE user_id = ?2 AND created_at > ?4) < ?5",
  )
    .bind(runId, userId, now(), now() - DAY_MS, Number(env.DAILY_RUN_LIMIT))
    .run();
  if (!slot.meta.changes) {
    return { error: `You've used today's ${env.DAILY_RUN_LIMIT} runs. They refill over the next 24 hours.`, status: 429 };
  }
  // Claim the project only if nobody else started a run since we read it (double clicks, two tabs).
  const claim = await env.DB.prepare(
    "UPDATE projects SET status = 'building', intake_complete = 1, active_run_id = ?, updated_at = ? WHERE id = ? AND active_run_id IS ?",
  )
    .bind(runId, now(), row.id, row.active_run_id)
    .run();
  if (!claim.meta.changes) {
    // This start didn't happen, so it shouldn't use up a run.
    await env.DB.prepare("DELETE FROM run_starts WHERE id = ?").bind(runId).run();
    const current = await getProjectRow(env.DB, row.id, userId);
    if (current?.active_run_id && current.status === "building") return { runId: current.active_run_id };
    return { error: "This tool changed while starting. Try again.", status: 409 };
  }
  await env.DB.prepare("INSERT INTO runs (id, project_id, user_id, status, created_at) VALUES (?, ?, ?, 'running', ?)").bind(runId, row.id, userId, now()).run();
  try {
    await env.RUN.get(env.RUN.idFromName(runId)).start(config);
  } catch (err) {
    // Don't leave the project pointing at a run that never started.
    await env.DB.batch([
      env.DB.prepare("UPDATE projects SET status = ?, active_run_id = ? WHERE id = ? AND active_run_id = ?").bind(
        row.status,
        row.active_run_id,
        row.id,
        runId,
      ),
      env.DB.prepare("UPDATE runs SET status = 'failed' WHERE id = ?").bind(runId),
    ]);
    throw err;
  }
  return { runId };
}
