// Types shared by the Worker and the browser.

export type ProjectStatus = "intake" | "building" | "ready";

export interface Project {
  id: string;
  title: string;
  idea: string;
  status: ProjectStatus;
  createdAt: number;
  updatedAt: number;
  activeRunId: string | null;
}

export interface Question {
  id: string;
  prompt: string;
  /** Why this matters, shown as a quiet hint under the question. */
  why: string;
  options: string[];
  answer: string | null;
  skipped: boolean;
}

export interface IntakeState {
  project: Project;
  questions: Question[];
  /** True once the planner believes nothing else is worth asking. */
  complete: boolean;
  /** The model's paraphrase of the idea; null until it has been written. */
  summary: string | null;
  /** Questions only start once the user has confirmed the paraphrase. */
  summaryConfirmed: boolean;
}

export interface PromptVersion {
  id: string;
  version: number;
  body: string;
  score: number | null;
  createdAt: number;
}

export interface ProjectDetail {
  project: Project;
  questions: Question[];
  latest: PromptVersion | null;
  rounds: number;
}

// ---- Construction run (Durable Object state, streamed over WebSocket) ----

export type AgentRole = "drafter" | "critic" | "refiner" | "judge";
export type AgentStatus = "queued" | "starting" | "working" | "done" | "merged" | "dropped" | "failed";

export interface AgentState {
  /** Sequential task number across the whole run, shown as #N. */
  task: number;
  id: string;
  role: AgentRole;
  /** Human label, e.g. "Critic · edge cases". */
  label: string;
  /** Branch-style name, e.g. critic/edge-cases. */
  branch: string;
  round: number;
  status: AgentStatus;
  progress: number;
  added: number;
  removed: number;
  tokensIn: number;
  tokensOut: number;
  note: string;
}

export type RunStatus = "queued" | "running" | "pausing" | "paused" | "done" | "failed";

export interface RunState {
  id: string;
  projectId: string;
  status: RunStatus;
  round: number;
  maxRounds: number;
  targetScore: number;
  score: number | null;
  draftVersion: number;
  agents: AgentState[];
  /** The next task that will run once active work finishes. */
  next: { task: number; label: string; reason: string } | null;
  tokensIn: number;
  tokensOut: number;
  tokenBudget: number;
  steering: string[];
  error: string | null;
  startedAt: number;
  finishedAt: number | null;
}

export interface LogLine {
  t: number;
  source: string;
  text: string;
}

export type ServerEvent =
  | { type: "state"; state: RunState }
  | { type: "draft"; version: number; body: string; score: number | null }
  | { type: "log"; lines: LogLine[]; replace?: boolean };

export type ClientCommand =
  | { type: "pause" }
  | { type: "resume" }
  | { type: "steer"; text: string }
  | { type: "rounds"; delta: 1 | -1 };

/** One rolling limit. `resetsAt` is when the oldest counted use ages out and frees room; null while nothing is counted. */
export interface UsageLimit {
  key: "planning" | "skills" | "runs" | "tokens";
  used: number;
  limit: number;
  windowHours: number;
  resetsAt: number | null;
}

export interface Usage {
  limits: UsageLimit[];
  contactEmail: string;
}
