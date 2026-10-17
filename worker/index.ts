import { verifyWebhook } from "@clerk/backend/webhooks";
import { Hono } from "hono";
import type { ProjectDetail } from "../shared/types";
import { requireUser } from "./auth";
import {
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
import { isInlineMime, planQuestions, summarizeIdea } from "./intake";
import { mcpApp } from "./mcp";
import { MODEL_CALL_LIMIT, PROJECT_LIMIT, answerQuestion, loadIntake, projectLimitReached, spendModelCall, startRun, toIntakeState } from "./service";

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

const modelLimitError = `You've used today's ${MODEL_CALL_LIMIT} planning steps. They refill over the next 24 hours.`;

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

/** Stops runs and wipes what their Durable Objects stored (the brief, drafts, log). One failure doesn't block the rest. */
async function cancelRuns(env: Env, runIds: string[]) {
  const outcomes = await Promise.allSettled(runIds.map((id) => env.RUN.get(env.RUN.idFromName(id)).cancel()));
  for (const o of outcomes) if (o.status === "rejected") console.error("run cleanup failed", o.reason);
}

async function deleteUserData(env: Env, userId: string) {
  const [files, runs] = await env.DB.batch([
    env.DB.prepare("SELECT a.r2_key FROM attachments a JOIN projects p ON p.id = a.project_id WHERE p.user_id = ?").bind(userId),
    env.DB.prepare("SELECT id FROM runs WHERE user_id = ?").bind(userId),
  ]);
  const results = files.results as { r2_key: string }[];
  const chunks: Promise<void>[] = [];
  for (let i = 0; i < results.length; i += 1000) chunks.push(env.UPLOADS.delete(results.slice(i, i + 1000).map((r) => r.r2_key)));
  await Promise.all([...chunks, cancelRuns(env, (runs.results as { id: string }[]).map((r) => r.id))]);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM runs WHERE user_id = ?").bind(userId),
    env.DB.prepare("DELETE FROM run_starts WHERE user_id = ?").bind(userId),
    env.DB.prepare("DELETE FROM mcp_calls WHERE user_id = ?").bind(userId),
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

  const userId = c.get("userId");
  if (await projectLimitReached(c.env, userId)) {
    return c.json({ error: `You've created ${PROJECT_LIMIT} skills in the last 24 hours. Try again tomorrow.` }, 429);
  }

  const id = newId();
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
    summary: null,
    summary_confirmed: 0,
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
  const [attachments, runs] = await c.env.DB.batch([
    c.env.DB.prepare("SELECT r2_key FROM attachments WHERE project_id = ?").bind(row.id),
    c.env.DB.prepare("SELECT id FROM runs WHERE project_id = ?").bind(row.id),
    c.env.DB.prepare("DELETE FROM runs WHERE project_id = ?").bind(row.id),
    c.env.DB.prepare("DELETE FROM projects WHERE id = ?").bind(row.id),
  ]);
  const keys = (attachments.results as { r2_key: string }[]).map((r) => r.r2_key);
  // A build in progress must stop spending tokens, whether or not the browser is still connected.
  c.executionCtx.waitUntil(cancelRuns(c.env, (runs.results as { id: string }[]).map((r) => r.id)));
  // The rows are gone; clearing the files from R2 doesn't need to hold up the response.
  if (keys.length) c.executionCtx.waitUntil(c.env.UPLOADS.delete(keys).catch((err) => console.error("R2 cleanup failed", err)));
  return c.json({ ok: true });
});

/** First call plans the questions; later calls return what's already planned. */
app.post("/projects/:id/plan", async (c) => {
  const { row, questions } = await loadIntake(c.env.DB, c.req.param("id"), c.get("userId"));
  if (!row) return c.json({ error: "Not found" }, 404);
  // Nothing is asked until the user has agreed with the model's paraphrase of the idea.
  if (!row.summary_confirmed) {
    if (!row.summary) {
      if (!(await spendModelCall(c.env, row.user_id))) return c.json({ error: modelLimitError }, 429);
      await summarizeIdea(c.env, row);
    }
    return c.json(toIntakeState(row, questions));
  }
  if (!questions.length && !row.intake_complete) {
    if (!(await spendModelCall(c.env, row.user_id))) return c.json({ error: modelLimitError }, 429);
    const planned = await planQuestions(c.env, row, { existing: questions });
    return c.json(toIntakeState(planned.row, planned.questions));
  }
  return c.json(toIntakeState(row, questions));
});

/** The user says the paraphrase is off; rewrite it with their correction. */
app.post("/projects/:id/summary", async (c) => {
  const { row, questions } = await loadIntake(c.env.DB, c.req.param("id"), c.get("userId"));
  if (!row) return c.json({ error: "Not found" }, 404);
  if (row.status !== "intake") return c.json(toIntakeState(row, questions));
  const body = await c.req.json<{ guidance?: unknown }>().catch(() => null);
  const guidance = typeof body?.guidance === "string" ? body.guidance.trim().slice(0, 1000) : "";
  if (!guidance) return c.json({ error: "Tell us what to change." }, 400);
  if (!(await spendModelCall(c.env, row.user_id))) return c.json({ error: modelLimitError }, 429);
  await summarizeIdea(c.env, row, guidance);
  return c.json(toIntakeState(row, questions));
});

/** The user agrees with the paraphrase; now plan the questions. */
app.post("/projects/:id/summary/confirm", async (c) => {
  const { row, questions } = await loadIntake(c.env.DB, c.req.param("id"), c.get("userId"));
  if (!row) return c.json({ error: "Not found" }, 404);
  if (row.status !== "intake") return c.json(toIntakeState(row, questions));
  // Checked before confirming, so hitting the cap leaves the summary unconfirmed and retryable.
  if (!(await spendModelCall(c.env, row.user_id))) return c.json({ error: modelLimitError }, 429);
  await c.env.DB.prepare("UPDATE projects SET summary_confirmed = 1, updated_at = ? WHERE id = ?").bind(now(), row.id).run();
  row.summary_confirmed = 1;
  const planned = await planQuestions(c.env, row, { existing: questions });
  return c.json(toIntakeState(planned.row, planned.questions));
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
  // Each answer re-plans the remaining questions, which is a model call. Without the budget the answer would not even be saved.
  if (body.replan !== false && !(await spendModelCall(c.env, userId))) return c.json({ error: modelLimitError }, 429);
  return c.json(await answerQuestion(c.env, row, userId, { ...body, questionId: body.questionId, answer: body.answer as string | null | undefined }));
});

app.post("/projects/:id/runs", async (c) => {
  const userId = c.get("userId");
  const row = await getProjectRow(c.env.DB, c.req.param("id"), userId);
  if (!row) return c.json({ error: "Not found" }, 404);
  const { improve, feedback } = await c.req.json<{ improve?: boolean; feedback?: unknown }>().catch(() => ({ improve: false, feedback: undefined }));
  const res = await startRun(c.env, row, userId, improve, typeof feedback === "string" ? feedback : undefined);
  return "error" in res ? c.json({ error: res.error }, res.status) : c.json(res);
});

app.get("/runs/:id/ws", async (c) => {
  const runId = c.req.param("id");
  const owner = await c.env.DB.prepare("SELECT user_id FROM runs WHERE id = ?").bind(runId).first<{ user_id: string }>();
  if (!owner || owner.user_id !== c.get("userId")) return c.json({ error: "Not found" }, 404);
  if (c.req.header("Upgrade") !== "websocket") return c.json({ error: "Expected WebSocket" }, 426);
  return c.env.RUN.get(c.env.RUN.idFromName(runId)).fetch(c.req.raw);
});

// The MCP endpoint and its OAuth discovery documents live outside /api.
const root = new Hono<AppEnv>();
root.route("/", mcpApp);
root.route("/", app);

export default root;
