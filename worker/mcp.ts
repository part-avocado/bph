// MCP endpoint: lets an agent that signed in through Clerk OAuth create and build skills as that user.
import { corsHeaders, fetchClerkAuthorizationServerMetadata, generateClerkProtectedResourceMetadata } from "@clerk/mcp-tools/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { z } from "zod";
import type { AppEnv } from "./index";
import { getLatestVersion, getProjectRow, getQuestions, newId, now } from "./db";
import { GeminiError } from "./gemini";
import { planQuestions, summarizeIdea } from "./intake";
import { verifyMcpRequest } from "./mcp-auth";
import { answerQuestion, loadIntake, startRun, toIntakeState } from "./service";

const MAX_BODY_BYTES = 256 * 1024;
const MAX_IDEA = 4000;
const MAX_DETAILS = 8000;
const MAX_PROMPT_CHARS = 60_000;
const DAY_MS = 24 * 60 * 60 * 1000;
// Per user, per 24 hours. Agents loop, so the model-backed tools and project creation are capped.
const MODEL_CALL_LIMIT = 200;
const PROJECT_LIMIT = 30;
const BROWSER_ORIGINS = ["https://claude.ai"];

// ---------- helpers ----------

class ToolError extends Error {}

type Extra = { authInfo?: { extra?: Record<string, unknown> } };

/** The signed-in user, read from this request's verified token and nowhere else. */
function userOf(extra: Extra): string {
  const id = extra.authInfo?.extra?.userId;
  if (typeof id !== "string" || !id) throw new ToolError("Sign in to continue.");
  return id;
}

const ok = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] });
const fail = (message: string) => ({ isError: true, content: [{ type: "text" as const, text: message }] });

/** Runs a tool body, turning expected failures into messages the agent can act on. */
async function guard(run: () => Promise<unknown>) {
  try {
    return ok(await run());
  } catch (err) {
    if (err instanceof ToolError) return fail(err.message);
    if (err instanceof GeminiError) return fail("The model is busy or unavailable right now. Try again in a moment.");
    console.error("mcp tool failed", err);
    return fail("Something went wrong on our side. Try again in a moment.");
  }
}

/** Reserves one model-backed call, atomically so parallel calls can't overshoot the cap. */
async function spendModelCall(env: Env, userId: string) {
  const res = await env.DB.prepare(
    "INSERT INTO mcp_calls (user_id, created_at) SELECT ?1, ?2 WHERE (SELECT COUNT(*) FROM mcp_calls WHERE user_id = ?1 AND created_at > ?3) < ?4",
  )
    .bind(userId, now(), now() - DAY_MS, MODEL_CALL_LIMIT)
    .run();
  if (!res.meta.changes) throw new ToolError(`You've used today's ${MODEL_CALL_LIMIT} model-backed calls. They refill over the next 24 hours.`);
}

async function ownedProject(env: Env, id: string, userId: string) {
  const row = await getProjectRow(env.DB, id, userId);
  if (!row) throw new ToolError("No skill with that id.");
  return row;
}

const idArg = z.string().min(1).max(64).describe("The skill id from list_skills or create_skill.");

/** What the agent should do next, given where the skill is. */
function nextStep(row: { status: string; summary: string | null; summary_confirmed: number }, intake: { complete: boolean; open: number }) {
  if (row.status === "building") return "A build is running. Call get_build until it finishes.";
  if (row.status === "ready") return "The prompt is ready. Call get_build to read it, or start_build with improve=true to raise the score.";
  if (!row.summary_confirmed) return "Show the summary to the user. If it is right, call review_summary with no guidance. If it is off, call review_summary with their correction.";
  if (intake.open) return "Ask the user the open question (offer its options), then call answer_question with their reply. Pass no answer to skip it.";
  if (intake.complete) return "Intake is complete. Call start_build.";
  return "Call get_skill again to plan the questions.";
}

// ---------- the server ----------

function buildServer(env: Env) {
  const server = new McpServer({ name: "offshoot", version: "1.0.0" }, {
    instructions:
      "Offshoot turns an idea into a finished build prompt for a Claude Code / Codex skill. Flow: create_skill, review_summary (confirm what was understood), answer_question for each question the user should decide, start_build, get_build until done, then use the returned prompt to write the skill. Always let the user confirm the summary and answer questions rather than answering for them.",
  });

  const read = { readOnlyHint: true, openWorldHint: false } as const;
  const write = { readOnlyHint: false, destructiveHint: false, openWorldHint: false } as const;

  server.registerTool(
    "list_skills",
    { title: "List skills", description: "Lists the signed-in user's skills, newest first (up to 100).", inputSchema: {}, annotations: read },
    async (_args, extra) =>
      guard(async () => {
        const { results } = await env.DB.prepare(
          `SELECT p.id, p.title, p.status, p.updated_at AS updatedAt,
             (SELECT score FROM prompt_versions v WHERE v.project_id = p.id ORDER BY version DESC LIMIT 1) AS score
           FROM projects p WHERE p.user_id = ? ORDER BY p.updated_at DESC LIMIT 100`,
        )
          .bind(userOf(extra))
          .all();
        return { skills: results };
      }),
  );

  server.registerTool(
    "create_skill",
    {
      title: "Create a skill",
      description:
        "Starts a new skill from an idea. Describe what the skill should do in the user's words. Follow with get_skill to receive the summary the user must confirm.",
      inputSchema: {
        idea: z.string().min(3).max(MAX_IDEA).describe("What the skill should do, in plain words."),
        details: z.string().max(MAX_DETAILS).optional().describe("Optional longer context: conventions, examples, constraints the user supplied."),
      },
      annotations: write,
    },
    async ({ idea, details }, extra) =>
      guard(async () => {
        const userId = userOf(extra);
        const trimmed = idea.trim();
        if (trimmed.length < 3) throw new ToolError("Describe the skill in a few words first.");
        const used = await env.DB.prepare("SELECT COUNT(*) AS n FROM projects WHERE user_id = ? AND created_at > ?")
          .bind(userId, now() - DAY_MS)
          .first<{ n: number }>();
        if ((used?.n ?? 0) >= PROJECT_LIMIT) throw new ToolError(`You've created ${PROJECT_LIMIT} skills in the last 24 hours. Try again later.`);

        const id = newId();
        const t = now();
        const full = details?.trim() ? `${trimmed}\n\nDetails:\n${details.trim()}` : trimmed;
        // context "" means there are no attachments to digest.
        await env.DB.prepare(
          "INSERT INTO projects (id, user_id, title, idea, context, status, created_at, updated_at) VALUES (?, ?, ?, ?, '', 'intake', ?, ?)",
        )
          .bind(id, userId, trimmed.split(/\s+/).slice(0, 4).join(" ").slice(0, 40), full, t, t)
          .run();
        return { id, next: "Call get_skill to receive the summary for the user to confirm." };
      }),
  );

  server.registerTool(
    "get_skill",
    {
      title: "Get a skill's state",
      description:
        "Returns where a skill is: the summary awaiting confirmation, the questions (the first unanswered one is the one to ask), answers so far, and the latest score. Planning the summary or questions happens on demand here, so call it after create_skill and after confirming the summary.",
      inputSchema: { id: idArg },
      annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ id }, extra) =>
      guard(async () => {
        const userId = userOf(extra);
        let { row, questions } = await loadIntake(env.DB, id, userId);
        if (!row) throw new ToolError("No skill with that id.");
        if (row.status === "intake") {
          if (!row.summary_confirmed) {
            if (!row.summary) {
              await spendModelCall(env, userId);
              await summarizeIdea(env, row);
            }
          } else if (!questions.length && !row.intake_complete) {
            await spendModelCall(env, userId);
            const planned = await planQuestions(env, row, { existing: questions });
            row = planned.row;
            questions = planned.questions;
          }
        }
        const state = toIntakeState(row, questions);
        const open = questions.find((q) => q.answer === null && !q.skipped);
        const latest = await getLatestVersion(env.DB, row.id);
        return {
          id: row.id,
          title: row.title,
          status: row.status,
          summary: state.summary,
          summaryConfirmed: state.summaryConfirmed,
          intakeComplete: state.complete,
          openQuestion: open ? { id: open.id, prompt: open.prompt, why: open.why, options: open.options } : null,
          answered: questions.filter((q) => q.answer || q.skipped).map((q) => ({ question: q.prompt, answer: q.skipped ? "(skipped)" : q.answer })),
          latestVersion: latest ? { version: latest.version, score: latest.score } : null,
          next: nextStep(row, { complete: state.complete, open: open ? 1 : 0 }),
        };
      }),
  );

  server.registerTool(
    "review_summary",
    {
      title: "Confirm or correct the summary",
      description:
        "Call with no guidance once the user agrees the summary captures their idea; this plans the questions. Call with guidance (the user's correction, in their words) to have the summary rewritten, then show the new one.",
      inputSchema: { id: idArg, guidance: z.string().max(1000).optional().describe("The user's correction. Omit to confirm.") },
      annotations: write,
    },
    async ({ id, guidance }, extra) =>
      guard(async () => {
        const userId = userOf(extra);
        const { row, questions } = await loadIntake(env.DB, id, userId);
        if (!row) throw new ToolError("No skill with that id.");
        if (row.status !== "intake") throw new ToolError("This skill is past intake.");
        const fix = guidance?.trim();
        if (fix) {
          await spendModelCall(env, userId);
          await summarizeIdea(env, row, fix);
          return { summary: row.summary, next: "Show the new summary to the user. Confirm with review_summary (no guidance) when it's right." };
        }
        if (!row.summary) throw new ToolError("There is no summary yet. Call get_skill first.");
        if (!row.summary_confirmed) {
          await env.DB.prepare("UPDATE projects SET summary_confirmed = 1, updated_at = ? WHERE id = ?").bind(now(), row.id).run();
          row.summary_confirmed = 1;
        }
        if (!questions.length && !row.intake_complete) {
          await spendModelCall(env, userId);
          const planned = await planQuestions(env, row, { existing: questions });
          return { confirmed: true, next: "Call get_skill to read the first question." , questions: planned.questions.length };
        }
        return { confirmed: true, next: "Call get_skill." };
      }),
  );

  server.registerTool(
    "answer_question",
    {
      title: "Answer an intake question",
      description:
        "Records the user's answer to the open question from get_skill and re-plans the remaining questions. Omit answer to skip (the drafter then decides). Only pass answers the user gave.",
      inputSchema: {
        id: idArg,
        questionId: z.string().min(1).max(64),
        answer: z.string().max(1000).optional().describe("The user's answer, free text or one of the offered options."),
      },
      annotations: write,
    },
    async ({ id, questionId, answer }, extra) =>
      guard(async () => {
        const userId = userOf(extra);
        const row = await ownedProject(env, id, userId);
        if (row.status !== "intake") throw new ToolError("This skill is past intake.");
        const asked = (await getQuestions(env.DB, row.id)).find((q) => q.id === questionId);
        if (!asked) throw new ToolError("That question isn't part of this skill. Call get_skill for the current one.");
        await spendModelCall(env, userId);
        const state = await answerQuestion(env, row, userId, { questionId, prompt: asked.prompt, answer });
        const open = state.questions.find((q) => q.answer === null && !q.skipped);
        return {
          intakeComplete: state.complete,
          openQuestion: open ? { id: open.id, prompt: open.prompt, why: open.why, options: open.options } : null,
          next: open ? "Ask the user this question." : state.complete ? "Intake is complete. Call start_build." : "Call get_skill.",
        };
      }),
  );

  server.registerTool(
    "start_build",
    {
      title: "Build the prompt",
      description:
        "Starts the multi-agent build that drafts, critiques and refines the skill's prompt. Takes a few minutes. Use improve=true on a finished skill to push the score higher. Subject to the daily run limit.",
      inputSchema: { id: idArg, improve: z.boolean().optional() },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ id, improve }, extra) =>
      guard(async () => {
        const userId = userOf(extra);
        const row = await ownedProject(env, id, userId);
        if (row.status === "intake" && !row.summary_confirmed) throw new ToolError("Confirm the summary with review_summary first.");
        const res = await startRun(env, row, userId, improve);
        if ("error" in res) throw new ToolError(res.error);
        return { runId: res.runId, next: "Call get_build every 15-30 seconds until status is done." };
      }),
  );

  server.registerTool(
    "get_build",
    {
      title: "Get build progress and the prompt",
      description:
        "Returns the build's status, round and score and, when a draft exists, the current build prompt. When status is done the prompt is final: hand it to a coding agent to write the skill.",
      inputSchema: { id: idArg, version: z.number().int().positive().optional().describe("A specific prompt version. Defaults to the latest.") },
      annotations: read,
    },
    async ({ id, version }, extra) =>
      guard(async () => {
        const userId = userOf(extra);
        const row = await ownedProject(env, id, userId);
        const run = row.active_run_id ? await env.RUN.get(env.RUN.idFromName(row.active_run_id)).getState() : null;
        const active = !!run && run.status !== "done" && run.status !== "failed";
        const draft = version
          ? await env.DB.prepare("SELECT version, body, score FROM prompt_versions WHERE project_id = ? AND version = ?")
              .bind(row.id, version)
              .first<{ version: number; body: string; score: number | null }>()
          : await getLatestVersion(env.DB, row.id);
        if (version && !draft) throw new ToolError(`No version ${version} for this skill.`);
        return {
          status: run?.status ?? (row.status === "ready" ? "done" : "not_started"),
          round: run?.round ?? null,
          maxRounds: run?.maxRounds ?? null,
          score: run?.score ?? draft?.score ?? null,
          targetScore: run?.targetScore ?? null,
          error: run?.error ?? null,
          version: draft?.version ?? null,
          prompt: draft ? draft.body.slice(0, MAX_PROMPT_CHARS) : null,
          next: active ? "Still building. Poll again in 15-30 seconds." : draft ? "Build finished." : "Call start_build first.",
          pollAfterSeconds: active ? 20 : null,
        };
      }),
  );

  return server;
}

// ---------- routes ----------

export const mcpApp = new Hono<AppEnv>();

mcpApp.onError((err, c) => {
  console.error(err);
  return c.json({ error: "Something went wrong on our side." }, 500);
});

const metadataCors = (c: { header: (k: string, v: string) => void }) => {
  for (const [k, v] of Object.entries(corsHeaders)) c.header(k, v);
};
const resourceUrl = (reqUrl: string) => `${new URL(reqUrl).origin}/mcp`;

const protectedResource = (c: import("hono").Context<AppEnv>) => {
  metadataCors(c);
  return c.json(
    generateClerkProtectedResourceMetadata({
      publishableKey: c.env.CLERK_PUBLISHABLE_KEY,
      resourceUrl: resourceUrl(c.req.url),
      properties: { scopes_supported: ["profile", "email"], resource_name: "Offshoot" },
    }),
  );
};
mcpApp.get("/.well-known/oauth-protected-resource/mcp", protectedResource);
mcpApp.get("/.well-known/oauth-protected-resource", protectedResource);

let asMeta: { until: number; body: unknown } | null = null;
mcpApp.get("/.well-known/oauth-authorization-server", async (c) => {
  if (!asMeta || asMeta.until < Date.now()) {
    asMeta = { until: Date.now() + 5 * 60_000, body: await fetchClerkAuthorizationServerMetadata({ publishableKey: c.env.CLERK_PUBLISHABLE_KEY }) };
  }
  metadataCors(c);
  return c.json(asMeta.body as object);
});
mcpApp.options("/.well-known/*", (c) => {
  metadataCors(c);
  return c.body(null, 204);
});

mcpApp.use(
  "/mcp",
  cors({
    origin: (origin, c) => {
      const parties = String(c.env.AUTHORIZED_PARTIES).split(",").map((s: string) => s.trim());
      return BROWSER_ORIGINS.includes(origin) || parties.includes(origin) ? origin : null;
    },
    allowHeaders: ["authorization", "content-type", "accept", "mcp-protocol-version"],
    allowMethods: ["POST", "OPTIONS"],
    exposeHeaders: ["WWW-Authenticate"],
    maxAge: 86400,
  }),
);

mcpApp.post("/mcp", async (c) => {
  const challenge = { "WWW-Authenticate": `Bearer resource_metadata="${new URL(c.req.url).origin}/.well-known/oauth-protected-resource/mcp"` };
  const auth = await verifyMcpRequest(c.env, c.req.raw);
  if (!auth) return c.json({ error: "Sign in to continue." }, 401, challenge);
  if (Number(c.req.header("content-length") ?? 0) > MAX_BODY_BYTES) return c.json({ error: "Request too large." }, 413);

  // Stateless: a fresh server and transport per request, bound to this request's token only.
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  try {
    await buildServer(c.env).connect(transport);
    return await transport.handleRequest(c.req.raw, { authInfo: auth });
  } finally {
    c.executionCtx.waitUntil(transport.close().catch(() => undefined));
  }
});

// No server-initiated streams in stateless mode.
mcpApp.get("/mcp", (c) => c.json({ error: "Use POST." }, 405, { Allow: "POST" }));
