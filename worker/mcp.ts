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
import { CONTACT_EMAIL, PROJECT_LIMIT, answerQuestion, loadIntake, projectLimitReached, spendModelCall as reserveModelCall, startRun, toIntakeState } from "./service";

const MAX_BODY_BYTES = 256 * 1024;
const MAX_IDEA = 4000;
const MAX_DETAILS = 8000;
const MAX_PROMPT_CHARS = 60_000;
// get_build holds the call open this long while a build runs, so agents never need a sleep of their own.
const WAIT_MS = 25_000;
const WAIT_STEP_MS = 2_000;
// Questions per batch, and improve passes in dangerous mode (on top of the first build).
const MAX_BATCH = 5;
const MAX_AUTO_IMPROVEMENTS = 3;
const ALL_OF_THE_ABOVE = /^(all|both) of (the above|these)\.?$/i;
const BROWSER_ORIGINS = ["https://claude.ai"];

// ---------- helpers ----------

type ErrorCode =
  | "SIGN_IN_REQUIRED"
  | "NOT_FOUND"
  | "INVALID_INPUT"
  | "WRONG_STEP"
  | "LIMIT_REACHED"
  | "MODEL_BUSY"
  | "MODEL_REJECTED"
  | "MODEL_BAD_REPLY"
  | "MODEL_UNAVAILABLE"
  | "INTERNAL";

/** An expected failure. `code` lets the agent branch; `hint` tells it what to do instead. */
class ToolError extends Error {
  constructor(
    message: string,
    readonly code: ErrorCode = "WRONG_STEP",
    readonly hint?: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
  }
}

type Extra = { authInfo?: { extra?: Record<string, unknown> } };

/** The signed-in user, read from this request's verified token and nowhere else. */
function userOf(extra: Extra): string {
  const id = extra.authInfo?.extra?.userId;
  if (typeof id !== "string" || !id) throw new ToolError("Sign in to continue.", "SIGN_IN_REQUIRED", "Re-authenticate the reskill MCP server (/mcp in Claude Code).");
  return id;
}

const ok = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] });
const fail = (message: string, code: ErrorCode, extra: { hint?: string; retryAfterSeconds?: number } = {}) => ({
  isError: true,
  content: [{ type: "text" as const, text: JSON.stringify({ error: { code, message, retryable: extra.retryAfterSeconds !== undefined, ...extra } }, null, 2) }],
});

/** Maps a model failure to a message the agent can act on, without leaking provider detail. */
function modelFailure(err: GeminiError) {
  const hint = "Nothing was lost; your progress is saved.";
  if (err.status === 429) return fail("The model is rate limited right now.", "MODEL_BUSY", { hint: `${hint} Retry the same call.`, retryAfterSeconds: 30 });
  if (err.status === 0 || (err.status >= 500 && err.status !== 502)) return fail("The model didn't respond.", "MODEL_BUSY", { hint: `${hint} Retry the same call.`, retryAfterSeconds: 15 });
  if (err.status === 502) return fail("The model sent back something unreadable.", "MODEL_BAD_REPLY", { hint: `${hint} Retry the same call; if it repeats, reword the idea.`, retryAfterSeconds: 5 });
  if (err.status === 400) return fail("The model declined this request.", "MODEL_REJECTED", { hint: "Reword the idea or correction and try again." });
  return fail("The model service is misconfigured or unavailable.", "MODEL_UNAVAILABLE", { hint: "This is a server problem. Tell the user rather than retrying." });
}

/** Runs a tool body, turning expected failures into messages the agent can act on. */
async function guard(run: () => Promise<unknown>) {
  try {
    return ok(await run());
  } catch (err) {
    if (err instanceof ToolError) return fail(err.message, err.code, { hint: err.hint, retryAfterSeconds: err.retryAfterSeconds });
    if (err instanceof GeminiError) {
      console.error("mcp model call failed", err.status, err.message);
      return modelFailure(err);
    }
    console.error("mcp tool failed", err);
    return fail("Something went wrong on our side.", "INTERNAL", { hint: "Retry once; if it repeats, tell the user.", retryAfterSeconds: 10 });
  }
}

/** Reserves one model-backed call, or tells the agent the daily cap is reached. */
async function spendModelCall(env: Env, userId: string) {
  const limited = await reserveModelCall(env, userId);
  if (limited) throw new ToolError(limited, "LIMIT_REACHED", `Tell the user; don't retry. They can email ${CONTACT_EMAIL} for a rate-limit increase.`);
}

async function ownedProject(env: Env, id: string, userId: string) {
  const row = await getProjectRow(env.DB, id, userId);
  if (!row) throw new ToolError("No skill with that id.", "NOT_FOUND", "Call list_skills for valid ids.");
  return row;
}

const toOpen = (q: { id: string; prompt: string; why: string; options: string[] }) => ({ id: q.id, prompt: q.prompt, why: q.why, options: q.options });

const idArg = z.string().min(1).max(64).describe("The skill id from list_skills or create_skill.");

/** What the agent should do next, given where the skill is. */
function nextStep(row: { status: string; summary: string | null; summary_confirmed: number; autonomous: number }, intake: { complete: boolean; open: number }) {
  if (row.status === "building") return "A build is running. Call get_build until it finishes.";
  if (row.status === "ready") return "The prompt is ready. Call get_build to read it, or start_build with improve=true to raise the score.";
  if (!row.summary_confirmed) return "Check the summary against what the user asked for. If it matches, call review_summary with no guidance (no need to ask the user). If it misses something, call review_summary with a correction, taken from the user's own request.";
  if (intake.open && row.autonomous) return "Dangerous mode: don't ask the user. Answer every open question yourself from the request and your best judgment (pick one of the options, or write your own), in one answer_question call with `answers`. Pass no answer only when no sensible choice exists.";
  if (intake.open) return "If the user already answered this in their request, call answer_question with that. Otherwise ask the user (offer its options) and pass their reply. Pass no answer to skip it.";
  if (intake.complete) return "Intake is complete. Call start_build.";
  return "Call get_skill again to plan the questions.";
}

// ---------- the server ----------

function buildServer(env: Env) {
  const server = new McpServer({ name: "reskill", version: "1.0.0" }, {
    instructions:
      "reSkill turns an idea into a finished build prompt for a Claude Code / Codex skill. Flow: create_skill (dangerous=true only if the user explicitly wants a hands-off run: you then answer every question and keep improving until the score target is met, never asking them), review_summary (confirm what was understood), answer_question for each question the user should decide (answer several at once with `answers`; get_skill's batch returns several), start_build, get_build until done, then use the returned prompt to write the skill. You decide whether the summary is right: compare it with what the user asked for and confirm it yourself with review_summary, or send a correction as guidance. Only involve the user if their request is genuinely ambiguous. Ask the user the intake questions unless their request already answers them; answer those from what they said, and skip the rest.",
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
        "Starts a new skill from an idea. Describe what the skill should do in the user's words. Follow with get_skill to receive the summary, which you check against the request.",
      inputSchema: {
        idea: z.string().min(3).max(MAX_IDEA).describe("What the skill should do, in plain words."),
        details: z.string().max(MAX_DETAILS).optional().describe("Optional longer context: conventions, examples, constraints the user supplied."),
        dangerous: z
          .boolean()
          .optional()
          .describe("Dangerous mode: only when the user explicitly asked for hands-off operation. You then answer the intake questions yourself and keep calling start_build with improve=true until the score target is met, never asking the user. Defaults to false."),
      },
      annotations: write,
    },
    async ({ idea, details, dangerous }, extra) =>
      guard(async () => {
        const userId = userOf(extra);
        const trimmed = idea.trim();
        if (trimmed.length < 3) throw new ToolError("Describe the skill in a few words first.", "INVALID_INPUT");
        if (await projectLimitReached(env, userId)) throw new ToolError(`You've created ${PROJECT_LIMIT} skills in the last 24 hours.`, "LIMIT_REACHED", `Reuse an existing skill from list_skills, or tell the user to try tomorrow. They can email ${CONTACT_EMAIL} for a rate-limit increase.`);

        const id = newId();
        const t = now();
        const full = details?.trim() ? `${trimmed}\n\nDetails:\n${details.trim()}` : trimmed;
        // context "" means there are no attachments to digest.
        await env.DB.prepare(
          "INSERT INTO projects (id, user_id, title, idea, context, status, autonomous, created_at, updated_at) VALUES (?, ?, ?, ?, '', 'intake', ?, ?, ?)",
        )
          .bind(id, userId, trimmed.split(/\s+/).slice(0, 4).join(" ").slice(0, 40), full, dangerous ? 1 : 0, t, t)
          .run();
        return { id, dangerous: !!dangerous, next: "Call get_skill to receive the summary to check." };
      }),
  );

  server.registerTool(
    "get_skill",
    {
      title: "Get a skill's state",
      description:
        "Returns where a skill is: the summary awaiting your check, the questions (the first unanswered one is the one to ask; pass batch to get several at once), answers so far, and the latest score. Planning the summary or questions happens on demand here, so call it after create_skill and after confirming the summary.",
      inputSchema: {
        id: idArg,
        batch: z.number().int().min(1).max(MAX_BATCH).optional().describe(`How many open questions to return in openQuestions, to answer together in one answer_question call. Defaults to 1. Later questions were planned before the earlier ones were answered, so they may overlap a little.`),
      },
      annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ id, batch }, extra) =>
      guard(async () => {
        const userId = userOf(extra);
        let { row, questions } = await loadIntake(env.DB, id, userId);
        if (!row) throw new ToolError("No skill with that id.", "NOT_FOUND", "Call list_skills for valid ids.");
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
        const pending = questions.filter((q) => q.answer === null && !q.skipped);
        const open = pending[0];
        const latest = await getLatestVersion(env.DB, row.id);
        return {
          id: row.id,
          title: row.title,
          status: row.status,
          summary: state.summary,
          summaryConfirmed: state.summaryConfirmed,
          intakeComplete: state.complete,
          openQuestion: open ? toOpen(open) : null,
          ...((batch ?? 1) > 1 ? { openQuestions: pending.slice(0, batch).map(toOpen) } : {}),
          dangerous: !!row.autonomous,
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
        "Call with no guidance once the summary matches what the user asked for (you judge this; don't ask them); this plans the questions. Call with guidance (what the summary got wrong, grounded in the user's request) to have it rewritten, then check the new one the same way.",
      inputSchema: { id: idArg, guidance: z.string().max(1000).optional().describe("The user's correction. Omit to confirm.") },
      annotations: write,
    },
    async ({ id, guidance }, extra) =>
      guard(async () => {
        const userId = userOf(extra);
        const { row, questions } = await loadIntake(env.DB, id, userId);
        if (!row) throw new ToolError("No skill with that id.", "NOT_FOUND", "Call list_skills for valid ids.");
        if (row.status !== "intake") throw new ToolError("This skill is past intake.", "WRONG_STEP", "Call get_build to see its build, or start_build with improve=true.");
        const fix = guidance?.trim();
        if (fix) {
          await spendModelCall(env, userId);
          await summarizeIdea(env, row, fix);
          return { summary: row.summary, next: "Check the new summary against the request. Confirm with review_summary (no guidance) when it matches." };
        }
        if (!row.summary) throw new ToolError("There is no summary yet.", "WRONG_STEP", "Call get_skill first to generate it.");
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
      title: "Answer intake questions",
      description:
        "Records answers to open questions from get_skill and re-plans the remaining ones. Answer one (questionId + answer) or several at once with `answers` (up to " + MAX_BATCH + ", from get_skill's openQuestions) to save round trips. Omit an answer to skip it (the drafter then decides). Outside dangerous mode, only pass answers the user gave or clearly implied. Choosing \"All of the above\" records every other option.",
      inputSchema: {
        id: idArg,
        questionId: z.string().min(1).max(64).optional(),
        answer: z.string().max(1000).optional().describe("The answer, free text or one of the offered options."),
        answers: z
          .array(z.object({ questionId: z.string().min(1).max(64), answer: z.string().max(1000).optional() }))
          .min(1)
          .max(MAX_BATCH)
          .optional()
          .describe("Several answers at once, instead of questionId and answer."),
      },
      annotations: write,
    },
    async ({ id, questionId, answer, answers }, extra) =>
      guard(async () => {
        const userId = userOf(extra);
        const row = await ownedProject(env, id, userId);
        if (row.status !== "intake") throw new ToolError("This skill is past intake.", "WRONG_STEP", "Call get_build to see its build, or start_build with improve=true.");
        if (answers && questionId) throw new ToolError("Pass either questionId or answers, not both.", "INVALID_INPUT");
        const items = answers ?? (questionId ? [{ questionId, answer }] : []);
        if (!items.length) throw new ToolError("Pass questionId, or answers for several questions.", "INVALID_INPUT");
        if (new Set(items.map((i) => i.questionId)).size !== items.length) throw new ToolError("Each question can appear only once.", "INVALID_INPUT");
        const known = await getQuestions(env.DB, row.id);
        const asked = items.map((i) => {
          const q = known.find((k) => k.id === i.questionId);
          if (!q) throw new ToolError("A question isn't part of this skill.", "INVALID_INPUT", "Call get_skill for the current open questions.");
          return { q, answer: i.answer };
        });
        // One model call covers the whole batch: only the last answer re-plans.
        await spendModelCall(env, userId);
        let state!: Awaited<ReturnType<typeof answerQuestion>>;
        for (const [i, { q, answer: given }] of asked.entries()) {
          const text = given?.trim();
          const full = text && ALL_OF_THE_ABOVE.test(text) ? q.options.filter((o) => !ALL_OF_THE_ABOVE.test(o.trim())).join("; ") : text;
          state = await answerQuestion(env, row, userId, { questionId: q.id, prompt: q.prompt, answer: full, replan: i === asked.length - 1 });
        }
        const open = state.questions.find((q) => q.answer === null && !q.skipped);
        return {
          answered: asked.length,
          intakeComplete: state.complete,
          openQuestion: open ? toOpen(open) : null,
          next: open ? (row.autonomous ? "Dangerous mode: answer it yourself." : "Ask the user this question.") : state.complete ? "Intake is complete. Call start_build." : "Call get_skill.",
        };
      }),
  );

  server.registerTool(
    "start_build",
    {
      title: "Build the prompt",
      description:
        "Starts the multi-agent build that drafts, critiques and refines the skill's prompt. Takes a few minutes. Use improve=true on a finished skill to push the score higher. Subject to the weekly build limit.",
      inputSchema: { id: idArg, improve: z.boolean().optional() },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ id, improve }, extra) =>
      guard(async () => {
        const userId = userOf(extra);
        const row = await ownedProject(env, id, userId);
        if (row.status === "intake" && !row.summary_confirmed) throw new ToolError("The summary hasn't been confirmed.", "WRONG_STEP", "Call review_summary with no guidance, then answer the questions.");
        const res = await startRun(env, row, userId, improve);
        if ("error" in res) throw new ToolError(res.error, res.status === 429 ? "LIMIT_REACHED" : "WRONG_STEP", res.status === 429 ? `Tell the user; limits refill over time. They can email ${CONTACT_EMAIL} for a rate-limit increase.` : undefined);
        return { runId: res.runId, next: "Call get_build repeatedly until status is done. It waits for progress itself, so don't sleep or poll in a shell." };
      }),
  );

  server.registerTool(
    "get_build",
    {
      title: "Get build progress and the prompt",
      description:
        "Returns the build's status, round and score and, when a draft exists, the current build prompt. While a build is running this call waits up to ~25 seconds for progress, so just call it again; never sleep or poll in a shell. When status is done the prompt is final: hand it to a coding agent to write the skill.",
      inputSchema: {
        id: idArg,
        version: z.number().int().positive().optional().describe("A specific prompt version. Defaults to the latest."),
        wait: z.boolean().optional().describe("While a build is running, wait up to ~25s for progress before answering. Defaults to true."),
      },
      annotations: read,
    },
    async ({ id, version, wait }, extra) =>
      guard(async () => {
        const userId = userOf(extra);
        const row = await ownedProject(env, id, userId);
        const stateOf = () => (row.active_run_id ? env.RUN.get(env.RUN.idFromName(row.active_run_id)).getState() : Promise.resolve(null));
        const isActive = (r: Awaited<ReturnType<typeof stateOf>>) => !!r && r.status !== "done" && r.status !== "failed";
        let run = await stateOf();
        if (wait !== false && isActive(run)) {
          const seen = `${run!.status}/${run!.round}/${run!.score}`;
          for (const deadline = Date.now() + WAIT_MS; Date.now() < deadline; ) {
            await new Promise((r) => setTimeout(r, WAIT_STEP_MS));
            run = await stateOf();
            if (!isActive(run) || `${run!.status}/${run!.round}/${run!.score}` !== seen) break;
          }
        }
        const active = isActive(run);
        const draft = version
          ? await env.DB.prepare("SELECT version, body, score FROM prompt_versions WHERE project_id = ? AND version = ?")
              .bind(row.id, version)
              .first<{ version: number; body: string; score: number | null }>()
          : await getLatestVersion(env.DB, row.id);
        if (version && !draft) throw new ToolError(`No version ${version} for this skill.`, "NOT_FOUND", "Omit version to get the latest.");
        return {
          status: run?.status ?? (row.status === "ready" ? "done" : "not_started"),
          round: run?.round ?? null,
          maxRounds: run?.maxRounds ?? null,
          score: run?.score ?? draft?.score ?? null,
          targetScore: run?.targetScore ?? null,
          error: run?.error ?? null,
          version: draft?.version ?? null,
          prompt: draft ? draft.body.slice(0, MAX_PROMPT_CHARS) : null,
          next: active
            ? "Still building. Call get_build again right away (it waits for progress); don't sleep."
            : draft
              ? row.autonomous && (draft.score ?? 0) < (run?.targetScore ?? 95) && draft.version <= MAX_AUTO_IMPROVEMENTS && run?.status !== "failed"
                ? `Dangerous mode: score ${draft.score ?? "unknown"} is below target. Call start_build with improve=true, then get_build again. Don't ask the user.`
                : "Build finished."
              : "Call start_build first.",
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
      properties: { scopes_supported: ["profile", "email"], resource_name: "reSkill" },
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
