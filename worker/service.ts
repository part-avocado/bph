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
    await env.DB.prepare(
      `INSERT OR IGNORE INTO questions (id, project_id, idx, prompt, why, options, answer, skipped)
       SELECT ?, ?, COUNT(*) - 0.5, ?, '', '[]', ?, ? FROM questions WHERE project_id = ? AND (answer IS NOT NULL OR skipped = 1)`,
    )
      .bind(body.questionId, row.id, String(body.prompt ?? "").slice(0, 300), answer, skipped, row.id)
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
export async function startRun(env: Env, row: ProjectRow, userId: string, improve: boolean | undefined): Promise<{ runId: string } | Failure> {
  // Everything the decision needs, fetched at once: the daily count, the brief's questions and
  // the base version in one D1 batch, alongside the active run's state from its Durable Object.
  const db = env.DB;
  const since = now() - 24 * 60 * 60 * 1000;
  const [[used, q, v], existing] = await Promise.all([
    db.batch([
      db.prepare("SELECT COUNT(*) AS n FROM run_starts WHERE user_id = ? AND created_at > ?").bind(userId, since),
      questionsStmt(db, row.id),
      ...(improve ? [latestVersionStmt(db, row.id)] : []),
    ]),
    row.active_run_id && row.status === "building" ? env.RUN.get(env.RUN.idFromName(row.active_run_id)).getState() : null,
  ]);
  // A run that's still going is returned as-is, and doesn't count against the daily limit.
  if (existing && existing.status !== "done" && existing.status !== "failed") return { runId: row.active_run_id! };
  if (((used.results[0] as { n: number } | undefined)?.n ?? 0) >= Number(env.DAILY_RUN_LIMIT)) {
    return { error: `You've used today's ${env.DAILY_RUN_LIMIT} runs. They refill over the next 24 hours.`, status: 429 };
  }

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
    base: base ? { id: base.id, version: base.version, body: base.body, score: base.score } : null,
  };
  // Claim the project only if nobody else started a run since we read it (double clicks, two tabs).
  const claim = await env.DB.prepare(
    "UPDATE projects SET status = 'building', intake_complete = 1, active_run_id = ?, updated_at = ? WHERE id = ? AND active_run_id IS ?",
  )
    .bind(runId, now(), row.id, row.active_run_id)
    .run();
  if (!claim.meta.changes) {
    const current = await getProjectRow(env.DB, row.id, userId);
    if (current?.active_run_id && current.status === "building") return { runId: current.active_run_id };
    return { error: "This tool changed while starting. Try again.", status: 409 };
  }
  await env.DB.batch([
    env.DB.prepare("INSERT INTO runs (id, project_id, user_id, status, created_at) VALUES (?, ?, ?, 'running', ?)").bind(runId, row.id, userId, now()),
    env.DB.prepare("INSERT INTO run_starts (id, user_id, created_at) VALUES (?, ?, ?)").bind(runId, userId, now()),
  ]);
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
