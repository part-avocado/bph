import { verifyWebhook } from "@clerk/backend/webhooks";
import { Hono } from "hono";
import type { IntakeState, ProjectDetail } from "../shared/types";
import { requireUser } from "./auth";
import { buildBrief, getLatestVersion, getProjectRow, getQuestions, newId, now, toProject } from "./db";
import { isInlineMime, planQuestions } from "./intake";
import type { RunConfig } from "./run";

export { RunObject } from "./run";

export type AppEnv = { Bindings: Env; Variables: { userId: string } };

const MAX_FILES = 40;
const MAX_TOTAL_BYTES = 12 * 1024 * 1024;
const MAX_INLINE_BYTES = 5 * 1024 * 1024;
const TEXT_EXT = /\.(md|mdx|txt|json|jsonc|ya?ml|toml|ini|env\.example|csv|tsv|xml|html?|css|scss|[cm]?[jt]sx?|py|rb|go|rs|java|kt|swift|c|cc|cpp|h|hpp|cs|php|sh|zsh|sql|graphql|prisma|vue|svelte|astro|lua|dart|ex|exs|r|gradle|dockerfile|makefile)$/i;

const app = new Hono<AppEnv>().basePath("/api");

app.onError((err, c) => {
  console.error(err);
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
  for (let i = 0; i < results.length; i += 1000) await env.UPLOADS.delete(results.slice(i, i + 1000).map((r) => r.r2_key));
  await env.DB.batch([
    env.DB.prepare("DELETE FROM runs WHERE user_id = ?").bind(userId),
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
  const form = await c.req.formData();
  const idea = String(form.get("idea") ?? "").trim();
  if (idea.length < 3) return c.json({ error: "Describe the tool in a few words first." }, 400);
  if (idea.length > 4000) return c.json({ error: "Keep the description under 4,000 characters; attach longer docs as files." }, 400);

  const files = form.getAll("files").filter((f): f is File => typeof f !== "string");
  if (files.length > MAX_FILES) return c.json({ error: `Attach at most ${MAX_FILES} files.` }, 400);
  let total = 0;
  for (const f of files) {
    total += f.size;
    const inline = isInlineMime(f.type);
    if (!inline && !f.type.startsWith("text/") && !TEXT_EXT.test(f.name)) {
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
  for (const f of files) {
    const aid = newId();
    const key = `${userId}/${id}/${aid}`;
    await c.env.UPLOADS.put(key, f.stream(), { httpMetadata: { contentType: f.type || "text/plain" } });
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
  await c.env.DB.batch(stmts);
  const row = await getProjectRow(c.env.DB, id, userId);
  return c.json({ project: toProject(row!) });
});

app.get("/projects/:id", async (c) => {
  const row = await getProjectRow(c.env.DB, c.req.param("id"), c.get("userId"));
  if (!row) return c.json({ error: "Not found" }, 404);
  const [questions, latest, rounds] = await Promise.all([
    getQuestions(c.env.DB, row.id),
    getLatestVersion(c.env.DB, row.id),
    c.env.DB.prepare("SELECT COALESCE(SUM(rounds), 0) AS n FROM runs WHERE project_id = ?").bind(row.id).first<{ n: number }>(),
  ]);
  return c.json({ project: toProject(row), questions, latest, rounds: rounds?.n ?? 0 } satisfies ProjectDetail);
});

app.delete("/projects/:id", async (c) => {
  const row = await getProjectRow(c.env.DB, c.req.param("id"), c.get("userId"));
  if (!row) return c.json({ error: "Not found" }, 404);
  const { results } = await c.env.DB.prepare("SELECT r2_key FROM attachments WHERE project_id = ?").bind(row.id).all<{ r2_key: string }>();
  if (results.length) await c.env.UPLOADS.delete(results.map((r) => r.r2_key));
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM runs WHERE project_id = ?").bind(row.id),
    c.env.DB.prepare("DELETE FROM projects WHERE id = ?").bind(row.id),
  ]);
  return c.json({ ok: true });
});

async function intakeState(env: Env, projectId: string, userId: string): Promise<IntakeState> {
  const row = (await getProjectRow(env.DB, projectId, userId))!;
  return { project: toProject(row), questions: await getQuestions(env.DB, projectId), complete: !!row.intake_complete };
}

/** First call plans the questions; later calls return what's already planned. */
app.post("/projects/:id/plan", async (c) => {
  const userId = c.get("userId");
  const row = await getProjectRow(c.env.DB, c.req.param("id"), userId);
  if (!row) return c.json({ error: "Not found" }, 404);
  const questions = await getQuestions(c.env.DB, row.id);
  if (!questions.length && !row.intake_complete) await planQuestions(c.env, row);
  return c.json(await intakeState(c.env, row.id, userId));
});

app.post("/projects/:id/answers", async (c) => {
  const userId = c.get("userId");
  const row = await getProjectRow(c.env.DB, c.req.param("id"), userId);
  if (!row) return c.json({ error: "Not found" }, 404);
  if (row.status !== "intake") return c.json(await intakeState(c.env, row.id, userId));
  const body = await c.req.json<{ questionId: string; prompt: string; answer: string | null; replan?: boolean }>();
  const answer = body.answer?.trim().slice(0, 1000) || null;
  const skipped = answer ? 0 : 1;

  const res = await c.env.DB.prepare("UPDATE questions SET answer = ?, skipped = ? WHERE id = ? AND project_id = ?")
    .bind(answer, skipped, body.questionId, row.id)
    .run();
  if (!res.meta.changes) {
    // The question was replaced by a re-plan while the user was answering it. Keep the answer anyway.
    const { n } = (await c.env.DB.prepare("SELECT COUNT(*) AS n FROM questions WHERE project_id = ? AND (answer IS NOT NULL OR skipped = 1)")
      .bind(row.id)
      .first<{ n: number }>())!;
    await c.env.DB.prepare("INSERT INTO questions (id, project_id, idx, prompt, why, options, answer, skipped) VALUES (?, ?, ?, ?, '', '[]', ?, ?)")
      .bind(body.questionId, row.id, n - 0.5, String(body.prompt).slice(0, 300), answer, skipped)
      .run();
  }
  if (body.replan !== false) await planQuestions(c.env, row, { keepNext: true });
  return c.json(await intakeState(c.env, row.id, userId));
});

app.post("/projects/:id/runs", async (c) => {
  const userId = c.get("userId");
  const row = await getProjectRow(c.env.DB, c.req.param("id"), userId);
  if (!row) return c.json({ error: "Not found" }, 404);
  const { improve } = await c.req.json<{ improve?: boolean }>().catch(() => ({ improve: false }));

  const since = now() - 24 * 60 * 60 * 1000;
  const used = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM runs WHERE user_id = ? AND created_at > ?").bind(userId, since).first<{ n: number }>();
  if ((used?.n ?? 0) >= Number(c.env.DAILY_RUN_LIMIT)) {
    return c.json({ error: `You've used today's ${c.env.DAILY_RUN_LIMIT} runs. They refill over the next 24 hours.` }, 429);
  }

  if (row.active_run_id && row.status === "building") {
    const existing = await c.env.RUN.get(c.env.RUN.idFromName(row.active_run_id)).getState();
    if (existing && existing.status !== "done" && existing.status !== "failed") return c.json({ runId: row.active_run_id });
  }

  const base = improve ? await getLatestVersion(c.env.DB, row.id) : null;
  const runId = newId();
  const config: RunConfig = {
    runId,
    projectId: row.id,
    userId,
    brief: await buildBrief(c.env.DB, row),
    maxRounds: improve ? 2 : 3,
    // Improving an already-strong prompt should still aim higher than where it is.
    targetScore: base?.score != null ? Math.min(99, Math.max(95, base.score + 2)) : 95,
    tokenBudget: Number(c.env.RUN_TOKEN_BUDGET),
    base: base ? { id: base.id, version: base.version, body: base.body, score: base.score } : null,
  };
  await c.env.DB.batch([
    c.env.DB.prepare("INSERT INTO runs (id, project_id, user_id, status, created_at) VALUES (?, ?, ?, 'running', ?)").bind(runId, row.id, userId, now()),
    c.env.DB.prepare("UPDATE projects SET status = 'building', intake_complete = 1, active_run_id = ?, updated_at = ? WHERE id = ?").bind(
      runId,
      now(),
      row.id,
    ),
  ]);
  await c.env.RUN.get(c.env.RUN.idFromName(runId)).start(config);
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
