import { DurableObject } from "cloudflare:workers";
import type { AgentRole, AgentState, ClientCommand, LogLine, RunState, ServerEvent } from "../shared/types";
import {
  CRITIC_LENSES,
  CRITIC_SCHEMA,
  DRAFTER_SYSTEM,
  JUDGE_SCHEMA,
  JUDGE_SYSTEM,
  ORCHESTRATOR_FUNCTIONS,
  ORCHESTRATOR_SYSTEM,
  REFINER_SYSTEM,
  criticSystem,
} from "./agents/prompts";
import { newId, now } from "./db";
import { generate, generateStream, parseJson, userText, type GenerateResult } from "./gemini";

export interface RunConfig {
  runId: string;
  projectId: string;
  userId: string;
  brief: string;
  maxRounds: number;
  targetScore: number;
  tokenBudget: number;
  /** Present when improving an existing prompt instead of drafting fresh. */
  base: { id: string; version: number; body: string; score: number | null } | null;
}

interface Draft {
  id: string;
  version: number;
  body: string;
  score: number | null;
}

interface Verdict {
  score: number;
  gaps: string[];
  lenses: string[];
}

const LOG_LIMIT = 400;
const MAX_ROUNDS = 8;
const BROADCAST_EVERY_MS = 200;

/** Counts added and removed lines between two texts, ignoring order. */
function lineDiff(before: string, after: string) {
  const count = new Map<string, number>();
  for (const l of before.split("\n")) if (l.trim()) count.set(l, (count.get(l) ?? 0) + 1);
  let added = 0;
  for (const l of after.split("\n")) {
    if (!l.trim()) continue;
    const n = count.get(l) ?? 0;
    if (n > 0) count.set(l, n - 1);
    else added++;
  }
  let removed = 0;
  for (const n of count.values()) removed += n;
  return { added, removed };
}

export class RunObject extends DurableObject<Env> {
  private state: RunState | null = null;
  private config: RunConfig | null = null;
  private draft: Draft | null = null;
  private verdict: Verdict | null = null;
  /** In-memory copy of the stored log, so appending a line doesn't re-read it from storage. */
  private logLines: LogLine[] | null = null;
  private lastBroadcast = 0;
  private broadcastTimer: ReturnType<typeof setTimeout> | null = null;

  // ---------- lifecycle ----------

  private async load() {
    if (this.state) return;
    const got = await this.ctx.storage.get<unknown>(["state", "config", "draft", "verdict", "log"]);
    this.state = (got.get("state") as RunState) ?? null;
    this.config = (got.get("config") as RunConfig) ?? null;
    this.draft = (got.get("draft") as Draft) ?? null;
    this.verdict = (got.get("verdict") as Verdict) ?? null;
    this.logLines ??= (got.get("log") as LogLine[]) ?? [];
  }

  private async save() {
    await this.ctx.storage.put({ state: this.state, draft: this.draft, verdict: this.verdict });
  }

  async start(config: RunConfig) {
    await this.load();
    if (this.state) return this.state;
    this.config = config;
    this.draft = config.base ? { ...config.base } : null;
    this.state = {
      id: config.runId,
      projectId: config.projectId,
      status: "running",
      round: config.base ? 1 : 0,
      maxRounds: config.maxRounds,
      targetScore: config.targetScore,
      score: config.base?.score ?? null,
      draftVersion: config.base?.version ?? 0,
      agents: [],
      next: null,
      tokensIn: 0,
      tokensOut: 0,
      tokenBudget: config.tokenBudget,
      steering: [],
      error: null,
      startedAt: now(),
      finishedAt: null,
    };
    this.logLines = [];
    await this.ctx.storage.put({ config, state: this.state, draft: this.draft, log: this.logLines });
    await this.log("orchestrator", config.base ? `improving draft v${config.base.version}` : "up, reading the brief");
    await this.ctx.storage.setAlarm(Date.now());
    return this.state;
  }

  async getState() {
    await this.load();
    return this.state;
  }

  // ---------- websocket ----------

  async fetch(request: Request) {
    if (request.headers.get("Upgrade") !== "websocket") return new Response("Expected WebSocket", { status: 426 });
    await this.load();
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    if (this.state) pair[1].send(JSON.stringify({ type: "state", state: this.state } satisfies ServerEvent));
    if (this.draft) pair[1].send(JSON.stringify(this.draftEvent()));
    pair[1].send(JSON.stringify({ type: "log", lines: this.logLines ?? [], replace: true } satisfies ServerEvent));
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  async webSocketMessage(_ws: WebSocket, message: string | ArrayBuffer) {
    await this.load();
    const s = this.state;
    if (!s || typeof message !== "string") return;
    let cmd: ClientCommand;
    try {
      cmd = JSON.parse(message) as ClientCommand;
    } catch {
      return;
    }
    if (!cmd || typeof cmd !== "object") return;
    switch (cmd.type) {
      case "pause":
        if (s.status === "running") {
          s.status = "pausing";
          await this.log("orchestrator", "pause requested, finishing the current step");
        }
        break;
      case "resume":
        if (s.status === "paused" || s.status === "pausing" || s.status === "failed") {
          const wasIdle = s.status !== "pausing";
          s.status = "running";
          s.error = null;
          await this.log("orchestrator", "resumed");
          if (wasIdle) await this.ctx.storage.setAlarm(Date.now());
        }
        break;
      case "steer": {
        if (typeof cmd.text !== "string") return;
        const text = cmd.text.trim().slice(0, 500);
        if (text && s.status !== "done") {
          s.steering.push(text);
          await this.log("you", `steer: ${text}`);
        }
        break;
      }
      case "rounds":
        if (cmd.delta !== 1 && cmd.delta !== -1) return;
        if (s.status !== "done") {
          s.maxRounds = Math.min(MAX_ROUNDS, Math.max(Math.max(s.round, 1), s.maxRounds + cmd.delta));
          await this.log("orchestrator", `target set to ${s.maxRounds} rounds`);
        }
        break;
    }
    await this.save();
    this.broadcast({ type: "state", state: s }, true);
  }

  async webSocketClose(ws: WebSocket, code: number) {
    try {
      ws.close(code, "bye");
    } catch {
      // already closed
    }
  }

  private broadcast(event: ServerEvent, immediate = false) {
    const send = () => {
      this.lastBroadcast = Date.now();
      const data = JSON.stringify(event.type === "state" ? { type: "state", state: this.state } : event);
      for (const ws of this.ctx.getWebSockets()) {
        try {
          ws.send(data);
        } catch {
          // socket went away; hibernation API cleans it up
        }
      }
    };
    if (event.type !== "state" || immediate) return send();
    // Coalesce rapid progress updates.
    if (this.broadcastTimer) return;
    const wait = Math.max(0, BROADCAST_EVERY_MS - (Date.now() - this.lastBroadcast));
    this.broadcastTimer = setTimeout(() => {
      this.broadcastTimer = null;
      send();
    }, wait);
  }

  private draftEvent(): ServerEvent {
    return { type: "draft", version: this.draft!.version, body: this.draft!.body, score: this.draft!.score };
  }

  private async log(source: string, text: string) {
    const line: LogLine = { t: now(), source, text };
    const log = this.logLines ?? ((await this.ctx.storage.get<LogLine[]>("log")) ?? []);
    log.push(line);
    if (log.length > LOG_LIMIT) log.splice(0, log.length - LOG_LIMIT);
    this.logLines = log;
    await this.ctx.storage.put("log", log);
    this.broadcast({ type: "log", lines: [line] });
  }

  // ---------- the run loop: one step per alarm ----------

  async alarm() {
    await this.load();
    const s = this.state;
    if (!s || !this.config || s.status !== "running") return;
    try {
      await this.step();
    } catch (err) {
      s.status = "failed";
      s.error = (err as Error).message.slice(0, 300);
      s.next = null;
      for (const a of s.agents) if (a.status === "working" || a.status === "starting") a.status = "failed";
      await this.log("orchestrator", `stopped: ${s.error}`);
      await this.save();
      await this.persistRun();
      this.broadcast({ type: "state", state: s }, true);
    }
  }

  private async step() {
    const s = this.state!;

    if (!this.draft) {
      await this.runDrafter();
      await this.runJudge();
      s.round = 1;
    } else {
      // Resuming after the first judge failed: the drafting step is over.
      if (s.round === 0) s.round = 1;
      if (s.tokensIn + s.tokensOut >= s.tokenBudget) {
        await this.log("orchestrator", "token budget reached, keeping the best draft");
        return this.finish();
      }
      if (this.verdict === null) await this.runJudge();
      if ((s.score ?? 0) >= s.targetScore) return this.finish();
      // Resuming after a judge failed on this round's merge: the round itself already finished.
      const merged = s.agents.some((a) => a.role === "refiner" && a.round === s.round && a.status === "merged");
      if (!merged) await this.runRound();
      if ((s.score ?? 0) >= s.targetScore || s.round >= s.maxRounds) return this.finish();
      s.round++;
    }

    if (s.status === "pausing") {
      s.status = "paused";
      s.next = null;
      await this.log("orchestrator", `paused before round ${s.round}`);
    } else {
      s.next = { task: s.agents.length + 1, label: "Orchestrator", reason: `Planning round ${s.round}` };
      await this.ctx.storage.setAlarm(Date.now() + 50);
    }
    await this.save();
    this.broadcast({ type: "state", state: s }, true);
  }

  private newAgent(role: AgentRole, label: string, branch: string): AgentState {
    const s = this.state!;
    const agent: AgentState = {
      task: s.agents.length + 1,
      id: newId(),
      role,
      label,
      branch,
      round: s.round,
      status: "starting",
      progress: 0,
      added: 0,
      removed: 0,
      tokensIn: 0,
      tokensOut: 0,
      note: "creating worktree…",
    };
    s.agents.push(agent);
    return agent;
  }

  private account(agent: AgentState, res: GenerateResult) {
    const s = this.state!;
    agent.tokensIn += res.usage.tokensIn;
    agent.tokensOut += res.usage.tokensOut;
    s.tokensIn += res.usage.tokensIn;
    s.tokensOut += res.usage.tokensOut;
  }

  /** Runs one streamed agent call with live progress against an expected length. */
  private async streamAgent(agent: AgentState, expectedChars: number, req: Parameters<typeof generateStream>[1]) {
    agent.status = "working";
    agent.note = "";
    this.broadcast({ type: "state", state: this.state! }, true);
    const res = await generateStream(this.env, req, (text) => {
      agent.progress = Math.min(0.97, text.length / Math.max(400, expectedChars));
      this.broadcast({ type: "state", state: this.state! });
    });
    this.account(agent, res);
    agent.progress = 1;
    return res;
  }

  private briefBlock() {
    const s = this.state!;
    const steer = s.steering.length ? `\n\nSteering notes from the user (these override reviewers):\n${s.steering.map((t) => `- ${t}`).join("\n")}` : "";
    return `USER BRIEF\n${this.config!.brief}${steer}`;
  }

  private async commitDraft(body: string, parentId: string | null) {
    const s = this.state!;
    const version = (this.draft?.version ?? 0) + 1;
    this.draft = { id: newId(), version, body: body.trim(), score: null };
    // The old verdict scored the old draft; a resumed run must re-judge this one.
    this.verdict = null;
    s.draftVersion = version;
    await this.env.DB.prepare(
      "INSERT INTO prompt_versions (id, project_id, run_id, parent_id, version, body, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
      .bind(this.draft.id, s.projectId, s.id, parentId, version, this.draft.body, now())
      .run();
    this.broadcast(this.draftEvent());
  }

  private async runDrafter() {
    const agent = this.newAgent("drafter", "Drafter", "main");
    this.state!.next = null;
    await this.log("drafter", "writing draft v1 from the brief");
    const res = await this.streamAgent(agent, 3600, {
      system: DRAFTER_SYSTEM,
      contents: [userText(this.briefBlock())],
      thinking: "medium",
    });
    if (!res.text.trim()) throw new Error("The drafter returned an empty prompt.");
    await this.commitDraft(res.text, null);
    const { added } = lineDiff("", this.draft!.body);
    agent.added = added;
    agent.status = "merged";
    agent.note = "draft v1";
    await this.log("drafter", `draft v1 ready, ${added} lines`);
  }

  private async runJudge() {
    const s = this.state!;
    const agent = this.newAgent("judge", "Judge", "judge");
    s.next = null;
    agent.status = "working";
    agent.note = "";
    this.broadcast({ type: "state", state: s }, true);
    const res = await generate(this.env, {
      system: JUDGE_SYSTEM,
      contents: [userText(`${this.briefBlock()}\n\nAVAILABLE LENSES: ${Object.keys(CRITIC_LENSES).join(", ")}\n\nPROMPT v${this.draft!.version}\n${this.draft!.body}`)],
      schema: JUDGE_SCHEMA,
      thinking: "medium",
      temperature: 0.2,
    });
    this.account(agent, res);
    const raw = parseJson<Partial<Verdict>>(res.text);
    const score = Number(raw.score);
    if (!Number.isFinite(score)) throw new Error("The judge returned no score.");
    const strings = (x: unknown) => (Array.isArray(x) ? x.filter((y): y is string => typeof y === "string") : []);
    const v: Verdict = { score: Math.max(0, Math.min(100, Math.round(score))), gaps: strings(raw.gaps), lenses: strings(raw.lenses) };
    this.verdict = v;
    s.score = v.score;
    this.draft!.score = v.score;
    agent.status = "done";
    agent.progress = 1;
    agent.note = `scored ${v.score}`;
    await this.env.DB.prepare("UPDATE prompt_versions SET score = ? WHERE id = ?").bind(v.score, this.draft!.id).run();
    this.broadcast(this.draftEvent());
    await this.log("judge", `v${this.draft!.version} scored ${v.score}/100${v.gaps.length ? ` · gaps: ${v.gaps.slice(0, 3).join("; ")}` : ""}`);
  }

  private async planRound(): Promise<{ lens: string; instruction: string }[]> {
    const s = this.state!;
    const v = this.verdict!;
    const previous = s.agents.filter((a) => a.role === "critic" && a.round === s.round - 1).map((a) => a.branch.split("/")[1]);
    await this.log("orchestrator", `planning round ${s.round} of ${s.maxRounds}`);
    const res = await generate(this.env, {
      system: ORCHESTRATOR_SYSTEM,
      contents: [
        userText(
          `${this.briefBlock()}\n\nROUND ${s.round} of ${s.maxRounds}. Target score ${s.targetScore}. Current score ${v.score}.\nJudge gaps:\n${v.gaps.map((g) => `- ${g}`).join("\n") || "- none"}\nJudge suggests lenses: ${v.lenses.join(", ") || "none"}\nLenses used last round: ${previous.join(", ") || "none"}\n\nCURRENT DRAFT v${this.draft!.version}\n${this.draft!.body}`,
        ),
      ],
      functions: ORCHESTRATOR_FUNCTIONS,
      thinking: "low",
    });
    s.tokensIn += res.usage.tokensIn;
    s.tokensOut += res.usage.tokensOut;

    const picks = new Map<string, string>();
    for (const call of res.calls) {
      if (call.name !== "spawn_reviewer") continue;
      const lens = String(call.args.lens ?? "");
      if (CRITIC_LENSES[lens] && !picks.has(lens)) picks.set(lens, String(call.args.instruction ?? ""));
    }
    // The score is below target, so a finish call alone isn't enough: fall back to the judge's lenses.
    for (const lens of [...v.lenses, "ambiguity", "edge-cases"]) {
      if (picks.size >= 2) break;
      if (CRITIC_LENSES[lens] && !picks.has(lens)) picks.set(lens, v.gaps[0] ?? "Close the most important gap.");
    }
    return [...picks].slice(0, 4).map(([lens, instruction]) => ({ lens, instruction }));
  }

  private async runRound() {
    const s = this.state!;
    const base = this.draft!;
    const plan = await this.planRound();
    const critics = plan.map(({ lens }) => this.newAgent("critic", `Critic · ${CRITIC_LENSES[lens].label}`, `critic/${lens}`));
    const refinerTask = s.agents.length + 1;
    s.next = { task: refinerTask, label: `Refiner · round ${s.round}`, reason: "Waiting on the active reviews" };
    for (const c of critics) await this.log(c.branch, `spawned: ${plan[critics.indexOf(c)].instruction}`);
    await this.save();
    this.broadcast({ type: "state", state: s }, true);

    const branches = await Promise.all(
      plan.map(async ({ lens, instruction }, i) => {
        const agent = critics[i];
        // Stagger starts slightly so reviews don't all hit the API in the same millisecond.
        await new Promise((r) => setTimeout(r, i * 350));
        try {
          const res = await this.streamAgent(agent, base.body.length * 1.15 + 300, {
            system: criticSystem(lens, instruction),
            contents: [userText(`${this.briefBlock()}\n\nDRAFT v${base.version}\n${base.body}`)],
            schema: CRITIC_SCHEMA,
            thinking: "medium",
          });
          const out = parseJson<{ summary: string; revised: string }>(res.text);
          const diff = lineDiff(base.body, out.revised);
          agent.added = diff.added;
          agent.removed = diff.removed;
          agent.status = "done";
          agent.note = out.summary;
          await this.log(agent.branch, `done: ${out.summary} (+${diff.added} −${diff.removed})`);
          return { agent, ...out };
        } catch (err) {
          agent.status = "failed";
          agent.note = "review failed, branch dropped";
          await this.log(agent.branch, `failed: ${(err as Error).message.slice(0, 160)}`);
          return null;
        } finally {
          this.broadcast({ type: "state", state: s }, true);
        }
      }),
    );

    const ok = branches.filter((b): b is NonNullable<typeof b> => !!b && b.revised.trim().length > 0);
    if (!ok.length) throw new Error("Every review in this round failed.");

    // Merge.
    const refiner = this.newAgent("refiner", `Refiner · round ${s.round}`, `refiner/round-${s.round}`);
    s.next = { task: refiner.task + 1, label: "Judge", reason: "Waiting on the merge" };
    await this.log(refiner.branch, `merging ${ok.length} branch${ok.length > 1 ? "es" : ""} into draft v${base.version + 1}`);
    const branchText = ok.map((b) => `--- BRANCH ${b.agent.branch} (${b.summary}) ---\n${b.revised}`).join("\n\n");
    const res = await this.streamAgent(refiner, base.body.length * 1.1, {
      system: REFINER_SYSTEM,
      contents: [userText(`${this.briefBlock()}\n\nBASE DRAFT v${base.version}\n${base.body}\n\n${branchText}`)],
      thinking: "medium",
    });
    if (!res.text.trim()) throw new Error("The refiner returned an empty prompt.");
    const diff = lineDiff(base.body, res.text);
    refiner.added = diff.added;
    refiner.removed = diff.removed;
    await this.commitDraft(res.text, base.id);
    refiner.status = "merged";
    refiner.note = `draft v${this.draft!.version}`;
    for (const b of ok) b.agent.status = "merged";
    await this.log(refiner.branch, `merged into draft v${this.draft!.version} (+${diff.added} −${diff.removed})`);
    await this.save();

    await this.runJudge();
  }

  private async finish() {
    const s = this.state!;
    s.status = "done";
    s.next = null;
    s.finishedAt = now();
    const rounds = s.agents.filter((a) => a.role === "refiner" && a.status === "merged").length;
    await this.log("orchestrator", `done after ${rounds} review round${rounds === 1 ? "" : "s"}, score ${s.score}/100`);
    await this.save();
    await this.persistRun();
    this.broadcast({ type: "state", state: s }, true);
  }

  private async persistRun() {
    const s = this.state!;
    const stmts = [
      this.env.DB.prepare("UPDATE runs SET status = ?, rounds = ?, score = ?, tokens_in = ?, tokens_out = ?, finished_at = ? WHERE id = ?").bind(
        s.status,
        s.agents.filter((a) => a.role === "refiner" && a.status === "merged").length,
        s.score,
        s.tokensIn,
        s.tokensOut,
        s.finishedAt,
        s.id,
      ),
    ];
    if (s.status === "done") {
      stmts.push(this.env.DB.prepare("UPDATE projects SET status = 'ready', updated_at = ? WHERE id = ?").bind(now(), s.projectId));
    }
    await this.env.DB.batch(stmts);
  }
}
