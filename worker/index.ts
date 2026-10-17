import { verifyWebhook } from "@clerk/backend/webhooks";
import { Hono } from "hono";
import type { IntakeState, ProjectDetail, Question } from "../shared/types";
import { requireUser } from "./auth";
import {
  buildBrief,
  getProjectRow,
  getQuestions,
  latestVersionStmt,
  newId,
  now,
  projectStmt,
  questionsStmt,
  toProject,
  toQuestions,
  toVersion,
  type ProjectRow,
  type QuestionRow,
  type VersionRow,
} from "./db";
import { GeminiError } from "./gemini";
import { isInlineMime, planQuestions } from "./intake";
import type { RunConfig } from "./run";

export { RunObject } from "./run";

export type AppEnv = { Bindings: Env; Variables: { userId: string } };

const MAX_FILES = 40;
const MAX_TOTAL_BYTES = 12 * 1024 * 1024;
const MAX_INLINE_BYTES = 5 * 1024 * 1024;
const TEXT_EXT = /\.(md|mdx|txt|json|jsonc|ya?ml|toml|ini|env\.example|csv|tsv|xml|html?|css|scss|[cm]?[jt]sx?|py|rb|go|rs|java|kt|swift|c|cc|cpp|h|hpp|cs|php|sh|zsh|sql|graphql|prisma|vue|svelte|astro|lua|dart|ex|exs|r|gradle|dockerfile|makefile)$/i;
// Extensionless key files the browser accepts (see src/lib/files.ts KEY_FILES).
const TEXT_NAMES = /(^|\/)(readme|dockerfile|makefile|gemfile|go\.mod|\.env\.example)$/i;

const app = new Hono<AppEnv>().basePath("/api");

app.onError((err, c) => {
  console.error(err);
  if (err instanceof GeminiError) {
    return c.json({ error: "The model is busy or unavailable right now. Try again in a moment." }, 502);
  }
  return c.json({ error: "Something went wrong on our side. Try again in a moment." }, 500);
});

app.get("/health", (c) => c.json({ ok: true }));

// ---- Clerk webhook: keep users in sync, delete data when a user is deleted ----
app.post("/webhooks/clerk", async (c) => {
  let evt;
  try {
    evt = await verifyWebhook(c.req.raw, { signingSecret: c.env.CLERK_WEBHOOK_SIGNING_SECRET });
  } catch {
    return c.json({ error: "Invalid signature" }, 400);
  }
  if (evt.type === "user.created" || evt.type === "user.updated") {
    const u = evt.data;
    const email = u.email_addresses?.find((e) => e.id === u.primary_email_address_id)?.email_address ?? null;
    const name = [u.first_name, u.last_name].filter(Boolean).join(" ") || u.username || null;
    await c.env.DB.prepare(
      `INSERT INTO users (id, email, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET email = excluded.email, name = excluded.name, updated_at = excluded.updated_at`,
    )
      .bind(u.id, email, name, now(), now())
      .run();
  } else if (evt.type === "user.deleted" && evt.data.id) {
    await deleteUserData(c.env, evt.data.id);
  }
  return c.json({ ok: true });
});

async function deleteUserData(env: Env, userId: string) {
  const { results } = await env.DB.prepare(
    "SELECT a.r2_key FROM attachments a JOIN projects p ON p.id = a.project_id WHERE p.user_id = ?",
  )
    .bind(userId)
    .all<{ r2_key: string }>();
  const chunks: Promise<void>[] = [];
  for (let i = 0; i < results.length; i += 1000) chunks.push(env.UPLOADS.delete(results.slice(i, i + 1000).map((r) => r.r2_key)));
  await Promise.all(chunks);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM runs WHERE user_id = ?").bind(userId),
    env.DB.prepare("DELETE FROM run_starts WHERE user_id = ?").bind(userId),
    env.DB.prepare("DELETE FROM projects WHERE user_id = ?").bind(userId),
    env.DB.prepare("DELETE FROM users WHERE id = ?").bind(userId),
  ]);
}

// ---- Everything below requires a signed-in user ----
app.use("/projects/*", requireUser);
app.use("/projects", requireUser);
app.use("/runs/*", requireUser);

app.get("/projects", async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT p.id, p.title, p.idea, p.status, p.updated_at,
       (SELECT score FROM prompt_versions v WHERE v.project_id = p.id ORDER BY version DESC LIMIT 1) AS score
     FROM projects p WHERE p.user_id = ? ORDER BY p.updated_at DESC LIMIT 100`,
  )
    .bind(c.get("userId"))
    .all();
  return c.json({ projects: results });
});

app.post("/projects", async (c) => {
  const form = await c.req.formData().catch(() => null);
  if (!form) return c.json({ error: "Send the idea as a form." }, 400);
  const idea = String(form.get("idea") ?? "").trim();
  if (idea.length < 3) return c.json({ error: "Describe the tool in a few words first." }, 400);
  if (idea.length > 4000) return c.json({ error: "Keep the description under 4,000 characters; attach longer docs as files." }, 400);

  const files = form.getAll("files").filter((f): f is File => typeof f !== "string");
  if (files.length > MAX_FILES) return c.json({ error: `Attach at most ${MAX_FILES} files.` }, 400);
  let total = 0;
  for (const f of files) {
    total += f.size;
    const inline = isInlineMime(f.type);
    if (!inline && !f.type.startsWith("text/") && !TEXT_EXT.test(f.name) && !TEXT_NAMES.test(f.name)) {
      return c.json({ error: `${f.name} isn't a supported file. Use text, code, images or PDFs.` }, 400);
    }
    if (inline && f.size > MAX_INLINE_BYTES) return c.json({ error: `${f.name} is over 5 MB.` }, 400);
  }
  if (total > MAX_TOTAL_BYTES) return c.json({ error: "Attachments are over 12 MB in total." }, 400);

  const id = newId();
  const userId = c.get("userId");
  const t = now();
  const title = idea.split(/\s+/).slice(0, 4).join(" ");
  const stmts = [
    c.env.DB.prepare(
      "INSERT INTO projects (id, user_id, title, idea, context, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'intake', ?, ?)",
    ).bind(id, userId, title, idea, files.length ? null : "", t, t),
  ];
  const uploads: Promise<unknown>[] = [];
  for (const f of files) {
    const aid = newId();
    const key = `${userId}/${id}/${aid}`;
    // Pass the File itself (R2 rejects streams without a known length); uploads run in parallel
    // and the D1 rows are written once they all land.
    uploads.push(c.env.UPLOADS.put(key, f, { httpMetadata: { contentType: f.type || "text/plain" } }));
    stmts.push(
      c.env.DB.prepare("INSERT INTO attachments (id, project_id, name, mime, size, r2_key, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(
        aid,
        id,
        f.name.slice(0, 300),
        isInlineMime(f.type) ? f.type : "text/plain",
        f.size,
        key,
        t,
      ),
    );
  }
  await Promise.all(uploads);
  await c.env.DB.batch(stmts);
  // Everything in the row is known here, so skip reading it back.
  const row: ProjectRow = {
    id,
    user_id: userId,
    title,
    idea,
    context: files.length ? null : "",
    status: "intake",
    intake_complete: 0,
    active_run_id: null,
    created_at: t,
    updated_at: t,
  };
  return c.json({ project: toProject(row) });
});

const roundsStmt = (db: D1Database, projectId: string) =>
  db.prepare("SELECT COALESCE(SUM(rounds), 0) AS n FROM runs WHERE project_id = ?").bind(projectId);

app.get("/projects/:id", async (c) => {
  const db = c.env.DB;
  const id = c.req.param("id");
  // One round trip. The project read checks ownership; the rest is discarded if it fails.
  const [p, q, v, r] = await db.batch([projectStmt(db, id, c.get("userId")), questionsStmt(db, id), latestVersionStmt(db, id), roundsStmt(db, id)]);
  const row = p.results[0] as ProjectRow | undefined;
  if (!row) return c.json({ error: "Not found" }, 404);
  const questions = toQuestions(q.results as QuestionRow[]);
  const latest = toVersion(v.results[0] as VersionRow | undefined);
  const rounds = (r.results[0] as { n: number } | undefined)?.n ?? 0;
  return c.json({ project: toProject(row), questions, latest, rounds } satisfies ProjectDetail);
});

app.delete("/projects/:id", async (c) => {
  const row = await getProjectRow(c.env.DB, c.req.param("id"), c.get("userId"));
  if (!row) return c.json({ error: "Not found" }, 404);
  const [attachments] = await c.env.DB.batch([
    c.env.DB.prepare("SELECT r2_key FROM attachments WHERE project_id = ?").bind(row.id),
    c.env.DB.prepare("DELETE FROM runs WHERE project_id = ?").bind(row.id),
    c.env.DB.prepare("DELETE FROM projects WHERE id = ?").bind(row.id),
  ]);
  const keys = (attachments.results as { r2_key: string }[]).map((r) => r.r2_key);
  // The rows are gone; clearing the files from R2 doesn't need to hold up the response.
  if (keys.length) c.executionCtx.waitUntil(c.env.UPLOADS.delete(keys).catch((err) => console.error("R2 cleanup failed", err)));
  return c.json({ ok: true });
});

const toIntakeState = (row: ProjectRow, questions: Question[]): IntakeState => ({
  project: toProject(row),
  questions,
  complete: !!row.intake_complete,
});

/** Reads the project and its questions in one round trip. */
async function loadIntake(db: D1Database, projectId: string, userId: string) {
  const [p, q] = await db.batch([projectStmt(db, projectId, userId), questionsStmt(db, projectId)]);
  return { row: p.results[0] as ProjectRow | undefined, questions: toQuestions(q.results as QuestionRow[]) };
}

/** First call plans the questions; later calls return what's already planned. */
app.post("/projects/:id/plan", async (c) => {
  const { row, questions } = await loadIntake(c.env.DB, c.req.param("id"), c.get("userId"));
  if (!row) return c.json({ error: "Not found" }, 404);
  if (!questions.length && !row.intake_complete) {
    const planned = await planQuestions(c.env, row, { existing: questions });
    return c.json(toIntakeState(planned.row, planned.questions));
  }
  return c.json(toIntakeState(row, questions));
});

app.post("/projects/:id/answers", async (c) => {
  const userId = c.get("userId");
  const row = await getProjectRow(c.env.DB, c.req.param("id"), userId);
  if (!row) return c.json({ error: "Not found" }, 404);
  if (row.status !== "intake") return c.json(toIntakeState(row, await getQuestions(c.env.DB, row.id)));
  const body = await c.req
    .json<{ questionId: unknown; prompt: unknown; answer: unknown; replan?: unknown }>()
    .catch(() => null);
  if (!body || typeof body.questionId !== "string" || !body.questionId || body.questionId.length > 64) {
    return c.json({ error: "Missing question." }, 400);
  }
  if (body.answer != null && typeof body.answer !== "string") return c.json({ error: "Answers must be text." }, 400);
  const answer = body.answer?.trim().slice(0, 1000) || null;
  const skipped = answer ? 0 : 1;

  const res = await c.env.DB.prepare("UPDATE questions SET answer = ?, skipped = ? WHERE id = ? AND project_id = ?")
    .bind(answer, skipped, body.questionId, row.id)
    .run();
  if (!res.meta.changes) {
    // The question was replaced by a re-plan while the user was answering it. Keep the answer anyway,
    // placed just before the first open slot (counted and inserted in one statement).
    // OR IGNORE: the id comes from the client, so never let it collide with another project's question.
    await c.env.DB.prepare(
      `INSERT OR IGNORE INTO questions (id, project_id, idx, prompt, why, options, answer, skipped)
       SELECT ?, ?, COUNT(*) - 0.5, ?, '', '[]', ?, ? FROM questions WHERE project_id = ? AND (answer IS NOT NULL OR skipped = 1)`,
    )
      .bind(body.questionId, row.id, String(body.prompt ?? "").slice(0, 300), answer, skipped, row.id)
      .run();
  }
  if (body.replan !== false) {
    // The answer is saved either way; a failed re-plan just keeps the questions already planned.
    try {
      const planned = await planQuestions(c.env, row, { keepNext: true });
      return c.json(toIntakeState(planned.row, planned.questions));
    } catch (err) {
      console.error("replan failed", err);
    }
  }
  const fresh = await loadIntake(c.env.DB, row.id, userId);
  return c.json(toIntakeState(fresh.row ?? row, fresh.questions));
});

app.post("/projects/:id/runs", async (c) => {
  const userId = c.get("userId");
  const row = await getProjectRow(c.env.DB, c.req.param("id"), userId);
  if (!row) return c.json({ error: "Not found" }, 404);
  const { improve } = await c.req.json<{ improve?: boolean }>().catch(() => ({ improve: false }));

  // Everything the decision needs, fetched at once: the daily count, the brief's questions and
  // the base version in one D1 batch, alongside the active run's state from its Durable Object.
  const db = c.env.DB;
  const since = now() - 24 * 60 * 60 * 1000;
  const [[used, q, v], existing] = await Promise.all([
    db.batch([
      db.prepare("SELECT COUNT(*) AS n FROM run_starts WHERE user_id = ? AND created_at > ?").bind(userId, since),
      questionsStmt(db, row.id),
      ...(improve ? [latestVersionStmt(db, row.id)] : []),
    ]),
    row.active_run_id && row.status === "building" ? c.env.RUN.get(c.env.RUN.idFromName(row.active_run_id)).getState() : null,
  ]);
  // A run that's still going is returned as-is, and doesn't count against the daily limit.
  if (existing && existing.status !== "done" && existing.status !== "failed") return c.json({ runId: row.active_run_id });
  if (((used.results[0] as { n: number } | undefined)?.n ?? 0) >= Number(c.env.DAILY_RUN_LIMIT)) {
    return c.json({ error: `You've used today's ${c.env.DAILY_RUN_LIMIT} runs. They refill over the next 24 hours.` }, 429);
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
    tokenBudget: Number(c.env.RUN_TOKEN_BUDGET),
    base: base ? { id: base.id, version: base.version, body: base.body, score: base.score } : null,
  };
  // Claim the project only if nobody else started a run since we read it (double clicks, two tabs).
  const claim = await c.env.DB.prepare(
    "UPDATE projects SET status = 'building', intake_complete = 1, active_run_id = ?, updated_at = ? WHERE id = ? AND active_run_id IS ?",
  )
    .bind(runId, now(), row.id, row.active_run_id)
    .run();
  if (!claim.meta.changes) {
    const current = await getProjectRow(c.env.DB, row.id, userId);
    if (current?.active_run_id && current.status === "building") return c.json({ runId: current.active_run_id });
    return c.json({ error: "This tool changed while starting. Try again." }, 409);
  }
  await c.env.DB.batch([
    c.env.DB.prepare("INSERT INTO runs (id, project_id, user_id, status, created_at) VALUES (?, ?, ?, 'running', ?)").bind(runId, row.id, userId, now()),
    c.env.DB.prepare("INSERT INTO run_starts (id, user_id, created_at) VALUES (?, ?, ?)").bind(runId, userId, now()),
  ]);
  try {
    await c.env.RUN.get(c.env.RUN.idFromName(runId)).start(config);
  } catch (err) {
    // Don't leave the project pointing at a run that never started.
    await c.env.DB.batch([
      c.env.DB.prepare("UPDATE projects SET status = ?, active_run_id = ? WHERE id = ? AND active_run_id = ?").bind(
        row.status,
        row.active_run_id,
        row.id,
        runId,
      ),
      c.env.DB.prepare("UPDATE runs SET status = 'failed' WHERE id = ?").bind(runId),
    ]);
    throw err;
  }
  return c.json({ runId });
});

app.get("/runs/:id/ws", async (c) => {
  const runId = c.req.param("id");
  const owner = await c.env.DB.prepare("SELECT user_id FROM runs WHERE id = ?").bind(runId).first<{ user_id: string }>();
  if (!owner || owner.user_id !== c.get("userId")) return c.json({ error: "Not found" }, 404);
  if (c.req.header("Upgrade") !== "websocket") return c.json({ error: "Expected WebSocket" }, 426);
  return c.env.RUN.get(c.env.RUN.idFromName(runId)).fetch(c.req.raw);
});

export default app;
