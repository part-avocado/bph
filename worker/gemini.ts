// Minimal Gemini REST client. Works against generativelanguage.googleapis.com
// directly or through a Cloudflare AI Gateway google-ai-studio endpoint.

export type Part =
  | { text: string }
  | { inlineData: { mimeType: string; data: string } }
  | { functionCall: { name: string; args: Record<string, unknown> } };

export interface Content {
  role: "user" | "model";
  parts: Part[];
}

export type ThinkingLevel = "minimal" | "low" | "medium" | "high";

export interface FunctionDeclaration {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface GenerateRequest {
  system: string;
  contents: Content[];
  thinking?: ThinkingLevel;
  /** JSON schema for structured output. */
  schema?: Record<string, unknown>;
  functions?: FunctionDeclaration[];
  maxOutputTokens?: number;
  temperature?: number;
}

export interface Usage {
  tokensIn: number;
  tokensOut: number;
}

export interface GenerateResult {
  text: string;
  calls: { name: string; args: Record<string, unknown> }[];
  usage: Usage;
}

export class GeminiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

/** Gemma on the Gemini API only documents "minimal" (thinking off) and "high" (on). */
function thinkingFor(model: string, level: ThinkingLevel): ThinkingLevel {
  if (!model.startsWith("gemma")) return level;
  return level === "minimal" ? "minimal" : "high";
}

function buildBody(model: string, req: GenerateRequest) {
  const body: Record<string, unknown> = {
    systemInstruction: { parts: [{ text: req.system }] },
    contents: req.contents,
    generationConfig: {
      thinkingConfig: { thinkingLevel: thinkingFor(model, req.thinking ?? "low") },
      ...(req.maxOutputTokens ? { maxOutputTokens: req.maxOutputTokens } : {}),
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
      ...(req.schema ? { responseMimeType: "application/json", responseJsonSchema: req.schema } : {}),
    },
  };
  if (req.functions?.length) {
    body.tools = [{ functionDeclarations: req.functions }];
    body.toolConfig = { functionCallingConfig: { mode: "ANY" } };
  }
  return body;
}

interface RawResponse {
  candidates?: { content?: { parts?: Part[] }; finishReason?: string }[];
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; thoughtsTokenCount?: number };
  promptFeedback?: { blockReason?: string };
}

function usageOf(r: RawResponse): Usage {
  const u = r.usageMetadata ?? {};
  return { tokensIn: u.promptTokenCount ?? 0, tokensOut: (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0) };
}

const RETRYABLE = new Set([408, 429, 500, 502, 503, 504]);

async function post(env: Env, method: string, body: unknown, query = ""): Promise<Response> {
  const url = `${env.GEMINI_BASE_URL.replace(/\/$/, "")}/v1beta/models/${env.GEMINI_MODEL}:${method}${query}`;
  // Serialise once: prompts carry the whole brief and draft, and retries resend the same bytes.
  const payload = JSON.stringify(body);
  let lastError: GeminiError | null = null;
  let retryAfterMs = 0;
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, Math.max(retryAfterMs, 600 * 2 ** attempt + Math.random() * 400)));
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
        body: payload,
        signal: AbortSignal.timeout(180_000),
      });
    } catch (err) {
      lastError = new GeminiError(`Gemini request failed: ${(err as Error).message}`, 0);
      continue;
    }
    if (res.ok) return res;
    const detail = (await res.text()).slice(0, 500);
    lastError = new GeminiError(`Gemini ${res.status}: ${detail}`, res.status);
    if (!RETRYABLE.has(res.status)) break;
    // Honour the server's back-off hint on 429/503 (capped so a run never stalls for long).
    const hint = Number(res.headers.get("retry-after"));
    retryAfterMs = Number.isFinite(hint) && hint > 0 ? Math.min(hint * 1000, 20_000) : 0;
  }
  throw lastError!;
}

function collect(r: RawResponse, into: GenerateResult) {
  if (r.promptFeedback?.blockReason) throw new GeminiError(`Blocked: ${r.promptFeedback.blockReason}`, 400);
  for (const part of r.candidates?.[0]?.content?.parts ?? []) {
    if ("text" in part && !(part as { thought?: boolean }).thought) into.text += part.text;
    if ("functionCall" in part) into.calls.push({ name: part.functionCall.name, args: part.functionCall.args ?? {} });
  }
  if (r.usageMetadata) into.usage = usageOf(r);
}

export async function generate(env: Env, req: GenerateRequest): Promise<GenerateResult> {
  const res = await post(env, "generateContent", buildBody(env.GEMINI_MODEL, req));
  const out: GenerateResult = { text: "", calls: [], usage: { tokensIn: 0, tokensOut: 0 } };
  const raw = (await res.json().catch(() => null)) as RawResponse | null;
  if (!raw) throw new GeminiError("Gemini returned a response that wasn't JSON.", 502);
  collect(raw, out);
  return out;
}

/**
 * Streams a response, calling onChunk with the text so far. Used for long
 * agent outputs so the UI can show real progress.
 */
export async function generateStream(
  env: Env,
  req: GenerateRequest,
  onChunk: (textSoFar: string) => void,
): Promise<GenerateResult> {
  const res = await post(env, "streamGenerateContent", buildBody(env.GEMINI_MODEL, req), "?alt=sse");
  const out: GenerateResult = { text: "", calls: [], usage: { tokensIn: 0, tokensOut: 0 } };
  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  const handle = (raw: string) => {
    const line = raw.trim();
    if (!line.startsWith("data:")) return false;
    const payload = line.slice(5).trim();
    if (!payload || payload === "[DONE]") return false;
    let chunk: RawResponse;
    try {
      chunk = JSON.parse(payload) as RawResponse;
    } catch {
      throw new GeminiError("Gemini sent a malformed stream chunk.", 502);
    }
    collect(chunk, out);
    return true;
  };
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;
    const lines = buffer.split("\n");
    buffer = lines.pop()!;
    let changed = false;
    for (const line of lines) changed = handle(line) || changed;
    // One progress callback per network read, not per event.
    if (changed) onChunk(out.text);
  }
  // The last event may arrive without a trailing newline (it usually carries the usage totals).
  if (handle(buffer)) onChunk(out.text);
  return out;
}

/** Parses a structured-output response, tolerating stray code fences. */
export function parseJson<T>(text: string): T {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/, "").trim();
  return JSON.parse(cleaned) as T;
}

export function userText(text: string): Content {
  return { role: "user", parts: [{ text }] };
}
