import type { Question } from "../shared/types";
import { DIGEST_SCHEMA, DIGEST_SYSTEM, PLANNER_SCHEMA, PLANNER_SYSTEM, SUMMARY_SCHEMA, SUMMARY_SYSTEM } from "./agents/prompts";
import { getQuestions, newId, now, recordTokens, projectStmt, questionsStmt, toQuestions, type ProjectRow, type QuestionRow } from "./db";
import { generate, parseJson, type Part } from "./gemini";

const TEXT_LIMIT = 60_000;

function toBase64(buf: ArrayBuffer) {
  let s = "";
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export const isInlineMime = (mime: string) => mime.startsWith("image/") || mime === "application/pdf";

/** Summarises attachments once and caches the digest on the project. */
export async function ensureDigest(env: Env, project: ProjectRow): Promise<string | null> {
  if (project.context !== null) return project.context;
  const { results } = await env.DB.prepare("SELECT name, mime, r2_key FROM attachments WHERE project_id = ?")
    .bind(project.id)
    .all<{ name: string; mime: string; r2_key: string }>();
  if (!results.length) {
    await env.DB.prepare("UPDATE projects SET context = '' WHERE id = ?").bind(project.id).run();
    return (project.context = "");
  }

  // Fetch every attachment from R2 at once; the text budget is applied in order afterwards.
  const bodies = await Promise.all(
    results.map(async (a) => {
      const obj = await env.UPLOADS.get(a.r2_key);
      if (!obj) return null;
      return isInlineMime(a.mime) ? { inline: true as const, data: toBase64(await obj.arrayBuffer()) } : { inline: false as const, data: await obj.text() };
    }),
  );

  const parts: Part[] = [{ text: `The user's idea: ${project.idea}\n\nAttached files follow.` }];
  let textBudget = TEXT_LIMIT;
  results.forEach((a, i) => {
    const body = bodies[i];
    if (!body) return;
    if (body.inline) {
      parts.push({ text: `\n--- ${a.name} ---` }, { inlineData: { mimeType: a.mime, data: body.data } });
    } else if (textBudget > 0) {
      const text = body.data.slice(0, textBudget);
      textBudget -= text.length;
      parts.push({ text: `\n--- ${a.name} ---\n${text}` });
    }
  });

  const res = await generate(env, {
    system: DIGEST_SYSTEM,
    contents: [{ role: "user", parts }],
    schema: DIGEST_SCHEMA,
    thinking: "low",
  });
  await recordTokens(env.DB, project.user_id, res.usage);
  const parsed = parseJson<{ context?: unknown }>(res.text);
  const context = typeof parsed.context === "string" ? parsed.context : "";
  await env.DB.prepare("UPDATE projects SET context = ? WHERE id = ?").bind(context, project.id).run();
  project.context = context;
  return context;
}

/**
 * Has the model restate the idea so the user can check it. A correction from the
 * user steers the rewrite. If the model fails, the user's own words stand in so
 * they are never stuck before the questions.
 */
export async function summarizeIdea(env: Env, project: ProjectRow, guidance?: string): Promise<string> {
  let summary = project.idea.trim().slice(0, 600);
  try {
    const context = await ensureDigest(env, project);
    const text = [
      `The user's idea:\n${project.idea}`,
      context ? `\nFrom their attachments:\n${context}` : "",
      guidance && project.summary
        ? `\nYour previous restatement, which they say is off:\n${project.summary}\n\nTheir correction:\n${guidance}`
        : "",
    ].join("\n");
    const res = await generate(env, {
      system: SUMMARY_SYSTEM,
      contents: [{ role: "user", parts: [{ text }] }],
      schema: SUMMARY_SCHEMA,
      thinking: "low",
      temperature: 0.3,
    });
    await recordTokens(env.DB, project.user_id, res.usage);
    const parsed = parseJson<{ summary?: unknown }>(res.text);
    if (typeof parsed.summary === "string" && parsed.summary.trim()) summary = parsed.summary.trim().slice(0, 800);
  } catch (err) {
    console.error("summary failed", err);
    // A correction must still land when the model is down: keep the user's words as the paraphrase.
    if (guidance) summary = guidance.trim().slice(0, 800);
  }
  await env.DB.prepare("UPDATE projects SET summary = ?, summary_confirmed = 0, updated_at = ? WHERE id = ?")
    .bind(summary, now(), project.id)
    .run();
  project.summary = summary;
  project.summary_confirmed = 0;
  return summary;
}

interface PlannerOutput {
  title: string;
  questions: { prompt: string; why: string; options: string[] }[];
}

const MAX_QUESTIONS = 6;

/**
 * Re-plans the unanswered questions given everything known so far. Answered
 * questions stay; the pending tail is replaced. Returns the project row and
 * questions as they stand after the write, read in the same D1 batch.
 */
export async function planQuestions(env: Env, project: ProjectRow, opts: { keepNext?: boolean; existing?: Question[] } = {}) {
  // A digest the model can't produce (say it rejects an attachment) must not block the questions;
  // plan from the idea alone and let a later call try the attachments again.
  const [, existing] = await Promise.all([
    ensureDigest(env, project).catch((err) => console.error("digest failed", err)),
    opts.existing ?? getQuestions(env.DB, project.id),
  ]);
  const settled = existing.filter((q) => q.answer !== null || q.skipped);
  // The browser may already be showing the next question; keep it stable.
  const pinned = opts.keepNext ? existing.find((q) => q.answer === null && !q.skipped) : undefined;
  const kept = settled.length + (pinned ? 1 : 0);

  const known = [
    `Idea: ${project.idea}`,
    project.context ? `\nFrom attachments:\n${project.context}` : "",
    settled.length
      ? `\nAlready asked, in order:\n${settled.map((q) => `- ${q.prompt} → ${q.skipped ? "(skipped, drafter will decide)" : q.answer}`).join("\n")}\n\nMost recent answer: ${settled.at(-1)!.skipped ? "(skipped)" : settled.at(-1)!.answer}. Your first question must follow from it.`
      : "",
    pinned ? `\nAbout to be asked (do not repeat it): ${pinned.prompt}` : "",
    `\nYou may ask at most ${Math.max(0, MAX_QUESTIONS - kept)} more questions.`,
  ].join("\n");

  const res = await generate(env, {
    system: PLANNER_SYSTEM,
    contents: [{ role: "user", parts: [{ text: known }] }],
    schema: PLANNER_SCHEMA,
    thinking: "low",
    temperature: 0.4,
  });
  await recordTokens(env.DB, project.user_id, res.usage);
  const raw = parseJson<Partial<PlannerOutput>>(res.text);
  // Structured output is usually right, but never trust its shape blindly.
  const out: PlannerOutput = {
    title: typeof raw.title === "string" && raw.title.trim() ? raw.title.trim() : project.title,
    questions: (Array.isArray(raw.questions) ? raw.questions : [])
      .filter((q) => q && typeof q.prompt === "string" && q.prompt.trim() && Array.isArray(q.options))
      .map((q) => ({
        prompt: q.prompt.trim().slice(0, 300),
        why: typeof q.why === "string" ? q.why.slice(0, 300) : "",
        // Deduped: the browser keys option buttons by their text.
        options: [...new Set(q.options.filter((o): o is string => typeof o === "string" && !!o.trim()).map((o) => o.trim().slice(0, 200)))],
      })),
  };
  const norm = (t: string) => t.toLowerCase().replace(/[^a-z0-9 ]/g, "").trim();
  const asked = new Set([...settled, ...(pinned ? [pinned] : [])].map((q) => norm(q.prompt)));
  const fresh = out.questions
    .filter((q) => q.options.length >= 2 && !asked.has(norm(q.prompt)) && asked.add(norm(q.prompt)))
    .slice(0, Math.max(0, MAX_QUESTIONS - kept));

  const stmts: D1PreparedStatement[] = [
    env.DB.prepare("DELETE FROM questions WHERE project_id = ? AND answer IS NULL AND skipped = 0 AND id != ?").bind(
      project.id,
      pinned?.id ?? "",
    ),
    ...fresh.map((q, i) =>
      env.DB.prepare("INSERT INTO questions (id, project_id, idx, prompt, why, options) VALUES (?, ?, ?, ?, ?, ?)").bind(
        newId(),
        project.id,
        kept + i,
        q.prompt,
        q.why,
        JSON.stringify(q.options.slice(0, 4)),
      ),
    ),
    env.DB.prepare("UPDATE projects SET title = ?, intake_complete = ?, updated_at = ? WHERE id = ?").bind(
      settled.length === 0 ? out.title.slice(0, 40) : project.title,
      fresh.length === 0 && !pinned ? 1 : 0,
      now(),
      project.id,
    ),
    // Read back the result in the same round trip.
    projectStmt(env.DB, project.id, project.user_id),
    questionsStmt(env.DB, project.id),
  ];
  const results = await env.DB.batch(stmts);
  if (settled.length === 0) project.title = out.title.slice(0, 40);
  const row = (results[results.length - 2].results[0] as ProjectRow | undefined) ?? project;
  const questions = toQuestions(results[results.length - 1].results as QuestionRow[]);
  return { complete: fresh.length === 0 && !pinned, row, questions };
}
