import { AnimatePresence, motion } from "motion/react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import type { AgentState, LogLine, Project, RunState } from "../../shared/types";
import { Abandon, Button, CheckIcon, Sep, EASE, EnterIcon, HintBar, Kbd, Page, Skeleton, Spinner, Thinking, rise } from "../components/ui";
import type { Api } from "../lib/api";
import { isTyping, useKeys } from "../lib/keys";
import { useKeyboardInset } from "../lib/useKeyboardInset";
import { useRun } from "../lib/useRun";

const fmtTok = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

function visibleAgents(s: RunState): AgentState[] {
  if (s.round === 0) return s.agents.filter((a) => a.role === "drafter");
  const critics = s.agents.filter((a) => a.role === "critic" && a.round === s.round);
  const prevRefiner = [...s.agents].reverse().find((a) => a.role === "refiner" && a.round === s.round - 1);
  const prevDrafter = s.round === 1 ? s.agents.find((a) => a.role === "drafter") : undefined;
  return [...(prevRefiner ? [prevRefiner] : prevDrafter ? [prevDrafter] : []), ...critics];
}

// ---------- small pieces ----------

function StatusPill({ a }: { a: AgentState }) {
  const map: Record<AgentState["status"], [string, string]> = {
    queued: ["text-faint", "Queued"],
    starting: ["text-faint", "Starting…"],
    working: ["text-accent", "Working"],
    done: ["text-ink-2", "Reviewed"],
    merged: ["text-ok", "Merged"],
    dropped: ["text-faint", "Dropped"],
    failed: ["text-bad", "Failed"],
  };
  const [cls, label] = map[a.status];
  return (
    <span className={`flex shrink-0 items-center gap-1.5 text-2xs ${cls}`}>
      {a.status === "working" && <span className="pulse-dot size-1.5 rounded-full bg-accent" aria-hidden />}
      {a.status === "merged" && <CheckIcon ring size={11} />}
      {label}
    </span>
  );
}

function AgentIcon({ role }: { role: AgentState["role"] }) {
  return (
    <span className="flex size-4.5 shrink-0 items-center justify-center rounded-md bg-accent/10 text-accent">
      <svg width="10" height="10" viewBox="0 0 16 16" fill="none" aria-hidden>
        {role === "critic" ? (
          <path d="M7 12A5 5 0 1 0 7 2a5 5 0 0 0 0 10Zm3.5-1.5L14 14" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        ) : role === "refiner" ? (
          <path d="M4 2v7a3 3 0 0 0 3 3h5M12 12l-2-2M12 12l-2 2M4 2a1.5 1.5 0 1 0 0 .01" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        ) : (
          <path d="M3 13h10M4 10l6.5-6.5 2 2L6 12H4v-2Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
        )}
      </svg>
    </span>
  );
}

function AgentCard({ a, cardRef }: { a: AgentState; cardRef: (el: HTMLDivElement | null) => void }) {
  const idle = a.status === "starting" || a.status === "queued";
  const barColor = a.status === "merged" ? "bg-ok" : a.status === "failed" ? "bg-bad" : "bg-accent";
  return (
    <motion.div
      ref={cardRef}
      layout
      initial={{ opacity: 0, x: -10, scale: 0.98 }}
      animate={{ opacity: 1, x: 0, scale: 1 }}
      exit={{ opacity: 0, scale: 0.97 }}
      transition={{ duration: 0.4, ease: EASE }}
      className={`rounded-xl bg-paper px-3.5 py-3 ${
        idle ? "border border-dashed border-line" : a.status === "merged" ? "border border-ok/25 bg-ok/[0.03]" : "border border-line shadow-xs"
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <AgentIcon role={a.role} />
          <span className="truncate text-sm font-medium">{a.label}</span>
        </div>
        <StatusPill a={a} />
      </div>
      <div className="mt-1.5 flex items-center justify-between gap-2 font-mono text-2xs text-faint">
        <span className="min-w-0 truncate">{a.branch}</span>
        <span className="shrink-0 tabular-nums">
          {idle ? (
            a.note
          ) : (
            <>
              <span className="text-ok">+{a.added}</span> <span className="text-bad/80">−{a.removed}</span><Sep />{fmtTok(a.tokensOut)} tok
            </>
          )}
        </span>
      </div>
      {!idle && (
        <div className="mt-2.5 flex items-center gap-2.5">
          <div
            className="h-0.75 flex-1 overflow-hidden rounded-full bg-line-2"
            role="progressbar"
            aria-label={`${a.label} progress`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(a.progress * 100)}
          >
            <motion.div className={`h-full rounded-full ${barColor}`} animate={{ width: `${Math.round(a.progress * 100)}%` }} transition={{ duration: 0.35, ease: "easeOut" }} />
          </div>
          <span className={`w-8 text-right font-mono text-2xs tabular-nums ${a.status === "merged" ? "text-ok" : "text-accent"}`} aria-hidden>
            {Math.round(a.progress * 100)}%
          </span>
        </div>
      )}
      {(a.status === "done" || a.status === "merged" || a.status === "failed") && a.note && (
        <p className="mt-2 line-clamp-2 text-xs leading-snug text-mute">{a.note}</p>
      )}
      {idle && <p className="mt-1.5 text-2xs text-faint">Starting a reviewer on its own branch</p>}
    </motion.div>
  );
}

/** Elbow connectors between the three columns, measured from the real cards. */
function Connectors({
  container,
  from,
  to,
  merge,
  agents,
}: {
  container: RefObject<HTMLDivElement | null>;
  from: RefObject<HTMLDivElement | null>;
  to: Map<string, HTMLDivElement>;
  merge: RefObject<HTMLDivElement | null>;
  agents: AgentState[];
}) {
  const [paths, setPaths] = useState<{ d: string; tone: "ok" | "live" | "idle" }[]>([]);
  const [size, setSize] = useState({ w: 0, h: 0 });

  useLayoutEffect(() => {
    let last = "";
    const measure = () => {
      const c = container.current;
      const o = from.current;
      const m = merge.current;
      if (!c || !o || !m) return;
      const cr = c.getBoundingClientRect();
      const rel = (r: DOMRect) => ({ l: r.left - cr.left, r: r.right - cr.left, cy: r.top - cr.top + r.height / 2 });
      const or = rel(o.getBoundingClientRect());
      const mr = rel(m.getBoundingClientRect());
      const out: { d: string; tone: "ok" | "live" | "idle" }[] = [];
      for (const a of agents) {
        const el = to.get(a.id);
        if (!el) continue;
        const ar = rel(el.getBoundingClientRect());
        const tone = a.status === "merged" ? "ok" : a.status === "starting" || a.status === "queued" ? "idle" : "live";
        const x1 = or.r + (ar.l - or.r) / 2;
        out.push({ d: `M${or.r},${or.cy} H${x1} V${ar.cy} H${ar.l}`, tone });
        const x2 = ar.r + (mr.l - ar.r) / 2;
        out.push({ d: `M${ar.r},${ar.cy} H${x2} V${mr.cy} H${mr.l}`, tone });
      }
      // Polled while cards animate, so only re-render when a line actually moved.
      const key = `${cr.width}x${cr.height}|${out.map((p) => p.d + p.tone).join("|")}`;
      if (key === last) return;
      last = key;
      setPaths(out);
      setSize({ w: cr.width, h: cr.height });
    };
    measure();
    const ro = new ResizeObserver(measure);
    if (container.current) ro.observe(container.current);
    // Cards animate their layout; keep lines attached. The overlay is desktop-only, so skip polling on phones.
    const id = window.matchMedia("(min-width: 1024px)").matches ? setInterval(measure, 250) : undefined;
    return () => {
      ro.disconnect();
      if (id) clearInterval(id);
    };
  }, [agents, container, from, merge, to]);

  return (
    <svg className="pointer-events-none absolute inset-0 hidden lg:block" width={size.w} height={size.h} aria-hidden>
      {paths.map((p, i) => (
        <path
          key={i}
          d={p.d}
          fill="none"
          strokeWidth="1.25"
          className={p.tone === "ok" ? "stroke-ok/70" : p.tone === "live" ? "stroke-accent/60" : "dash-flow stroke-accent/40"}
        />
      ))}
    </svg>
  );
}

function Drawer({ open, onClose, title, side, children }: { open: boolean; onClose: () => void; title: string; side: "right" | "bottom"; children: React.ReactNode }) {
  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div className="fixed inset-0 z-40 bg-black/10 backdrop-blur-xs" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose} aria-hidden />
          <motion.aside
            role="dialog"
            aria-modal="true"
            aria-label={title}
            initial={side === "right" ? { x: "100%" } : { y: "100%" }}
            animate={side === "right" ? { x: 0 } : { y: 0 }}
            exit={side === "right" ? { x: "100%" } : { y: "100%" }}
            transition={{ type: "spring", damping: 32, stiffness: 340 }}
            className={`fixed z-50 flex flex-col bg-paper shadow-2xl ${
              side === "right" ? "inset-y-0 right-0 w-full max-w-form border-l border-line" : "inset-x-0 bottom-0 h-[55dvh] rounded-t-2xl border-t border-line"
            }`}
          >
            <div className="flex h-12 shrink-0 items-center justify-between border-b border-line-2 px-5">
              <h2 className="min-w-0 truncate text-base font-medium">{title}</h2>
              <Button variant="ghost" size="xs" onClick={onClose} kbd="esc" autoFocus className="font-normal">
                Close
              </Button>
            </div>
            <div className="scroll-thin min-h-0 flex-1 overflow-auto">{children}</div>
          </motion.aside>
        </>
      )}
    </AnimatePresence>
  );
}

const SOURCE_COLORS = ["text-sky-600", "text-violet-600", "text-amber-600", "text-emerald-600", "text-rose-600", "text-cyan-600", "text-fuchsia-600"];
function colorFor(source: string) {
  let h = 0;
  for (const ch of source) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return SOURCE_COLORS[h % SOURCE_COLORS.length];
}

function LogView({ log }: { log: LogLine[] }) {
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // Newer browsers return a promise from scroll methods; never hand it to React as a cleanup.
    void end.current?.scrollIntoView({ block: "end" });
  }, [log.length]);
  const width = Math.min(24, Math.max(10, ...log.map((l) => l.source.length)));
  return (
    <div className="px-4 py-4 font-mono text-xs leading-code sm:px-5">
      {log.length === 0 && <p className="font-sans text-sm text-mute">Nothing logged yet.</p>}
      {log.map((l, i) => (
        <div key={i} className="flex gap-3 whitespace-pre-wrap">
          <span className="shrink-0 text-faint tabular-nums">{new Date(l.t).toLocaleTimeString([], { hour12: false })}</span>
          <span className={`shrink-0 ${colorFor(l.source)}`} style={{ width: `${width + 2}ch` }}>
            {l.source.padEnd(width)} |
          </span>
          <span className="min-w-0 break-words text-ink-2">{l.text}</span>
        </div>
      ))}
      <div ref={end} />
    </div>
  );
}

// ---------- screen ----------

export function Construction({ api, project, runId, onDone }: { api: Api; project: Project; runId: string; onDone: () => void }) {
  const { state, draft, log, connection, send } = useRun(runId, api.getToken);
  const [panel, setPanel] = useState<null | "draft" | "log">(null);
  const keyboardInset = useKeyboardInset();
  const [steering, setSteering] = useState(false);
  const [steerText, setSteerText] = useState("");
  const [abandonError, setAbandonError] = useState<string | null>(null);
  const steerRef = useRef<HTMLInputElement>(null);

  const gridRef = useRef<HTMLDivElement>(null);
  const orchRef = useRef<HTMLDivElement>(null);
  const mergeRef = useRef<HTMLDivElement>(null);
  const cardRefs = useRef(new Map<string, HTMLDivElement>()).current;

  const agents = useMemo(() => (state ? visibleAgents(state) : []), [state]);
  const done = state?.status === "done";

  useEffect(() => {
    if (!done) return;
    const t = setTimeout(onDone, 1400);
    return () => clearTimeout(t);
  }, [done, onDone]);

  useEffect(() => {
    if (steering) steerRef.current?.focus();
  }, [steering]);

  const paused = state?.status === "paused" || state?.status === "pausing";
  const togglePause = () => send({ type: paused ? "resume" : "pause" });

  useKeys((e) => {
    if (steering || isTyping(e)) return;
    if (panel) {
      if (e.key === "Escape") {
        e.preventDefault();
        setPanel(null);
      }
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      if (!done) setSteering(true);
    } else if (e.key === "Escape") {
      e.preventDefault();
      if (!done) togglePause();
    } else if (e.key === "1") {
      e.preventDefault();
      setPanel("log");
    } else if (e.key.toLowerCase() === "d" && draft) {
      e.preventDefault();
      setPanel("draft");
    }
  });

  const critics = agents.filter((a) => a.role === "critic");
  const reviewed = critics.filter((a) => a.status === "done" || a.status === "merged" || a.status === "failed").length;
  const latest = state?.agents[state.agents.length - 1];
  const judging = latest?.role === "judge" && latest.status === "working";
  const refiner = state?.agents.find((a) => a.role === "refiner" && a.round === state.round);
  const merging = refiner?.status === "working";

  let mergeTitle = `Merge into draft v${(state?.draftVersion ?? 0) + 1}`;
  let mergeSub = critics.length ? "Waiting on all branches" : "Waiting for reviewers";
  let mergeMeta = critics.length ? `${reviewed} of ${critics.length} complete` : "";
  if (state?.round === 0) {
    mergeTitle = "Draft v1";
    mergeSub = judging ? "Scoring the first draft" : "Drafter is writing";
    mergeMeta = "";
  } else if (merging) {
    mergeTitle = `Merging into draft v${state!.draftVersion + 1}`;
    mergeSub = `Refiner is combining ${reviewed} branch${reviewed === 1 ? "" : "es"}`;
    mergeMeta = `${Math.round(refiner!.progress * 100)}%`;
  } else if (judging) {
    mergeTitle = `Scoring draft v${state!.draftVersion}`;
    mergeSub = "Judge is checking it against the brief";
    mergeMeta = "";
  } else if (done) {
    mergeTitle = `Draft v${state!.draftVersion}`;
    mergeSub = "Ready";
    mergeMeta = `score ${state!.score}/100`;
  }

  return (
    <Page
      tint="sky"
      title={project.title}
      headerRight={
        state && (
          <span className="mr-2 hidden font-mono text-xs text-mute tabular-nums sm:inline">
            {state.round === 0 ? "Drafting" : "Reviewing"}
          </span>
        )
      }
    >
      <main className="relative z-10 mx-auto max-w-wide px-4 pt-4 pb-28 sm:px-6">
        <motion.section {...rise()} className="card overflow-hidden" aria-labelledby="worktrees-title">
          <div className="flex flex-wrap items-start justify-between gap-4 px-4 pt-5 sm:px-6">
            <div className="min-w-0">
              <h1 id="worktrees-title" className="text-lg font-semibold tracking-heading">
                Worktrees
              </h1>
              <p className="mt-0.5 text-sm text-pretty text-mute">Each critic reviews in its own branch. The refiner merges what survives.</p>
            </div>
            <div className="flex items-center gap-2">
              {!done && state && (
                <Button variant="outline" size="sm" onClick={togglePause} disabled={state.status === "failed"} className="gap-1.5 font-normal" aria-pressed={paused}>
                  {paused ? (
                    <svg width="9" height="9" viewBox="0 0 10 10" aria-hidden>
                      <path d="M2 1l7 4-7 4z" fill="currentColor" />
                    </svg>
                  ) : (
                    <svg width="9" height="9" viewBox="0 0 10 10" aria-hidden>
                      <rect x="1.5" y="1" width="2.4" height="8" rx=".6" fill="currentColor" />
                      <rect x="6.1" y="1" width="2.4" height="8" rx=".6" fill="currentColor" />
                    </svg>
                  )}
                  {state.status === "pausing" ? "Pausing…" : paused ? "Resume" : "Pause"}
                </Button>
              )}
              <Button variant="accent" size="sm" onClick={() => setPanel("draft")} disabled={!draft} kbd="D">
                See draft {draft ? `v${draft.version}` : ""}
              </Button>
            </div>
          </div>

          {/* Next task, always on top */}
          <div className="mx-4 mt-4 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 rounded-xl border border-line bg-wash/70 px-3 py-2.5 sm:mx-6" aria-live="polite">
            <AnimatePresence mode="popLayout" initial={false}>
              <motion.div
                key={state?.next ? `${state.next.task}-${state.next.label}` : state?.status}
                initial={{ opacity: 0, y: 6 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -6 }}
                className="flex min-w-0 items-center gap-3"
              >
                <span className="shrink-0 rounded-md bg-paper px-1.5 py-0.5 font-mono text-2xs text-mute ring-1 ring-line">
                  #{state?.next?.task ?? (state ? state.agents.length : "–")}
                </span>
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium">
                    {state?.next?.label ??
                      (done ? "All tasks finished" : state?.status === "failed" ? "Run stopped" : paused ? "Paused" : state ? "Working" : "Connecting")}
                  </div>
                  <div className="text-2xs text-faint">{state?.next ? "Queued next" : done ? "Prompt is ready" : ""}</div>
                </div>
              </motion.div>
            </AnimatePresence>
            <span className="min-w-0 text-xs text-pretty text-mute sm:max-w-[50%] sm:text-right">
              {state?.status === "failed" ? (
                <span className="text-bad">{state.error}</span>
              ) : state?.next ? (
                state.next.reason
              ) : connection === "reconnecting" ? (
                "Reconnecting…"
              ) : (
                ""
              )}
            </span>
          </div>

          {/* The worktree */}
          <div ref={gridRef} className="relative mt-5 grid gap-5 px-4 pb-6 sm:px-6 lg:grid-cols-[180px_minmax(0,1fr)_180px] lg:gap-14">
            <Connectors container={gridRef} from={orchRef} to={cardRefs} merge={mergeRef} agents={agents} />

            <div className="flex flex-col">
              <h2 className="mb-3 font-mono text-2xs font-normal text-mute">Orchestrate</h2>
              <div className="flex flex-1 items-center">
                <div ref={orchRef} className="w-full rounded-xl bg-ink p-3 text-on-ink shadow-press-lg">
                  <div className="flex items-center gap-2.5">
                    <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-on-ink/10">
                      <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden>
                        <circle cx="8" cy="3.5" r="1.8" stroke="currentColor" strokeWidth="1.4" />
                        <circle cx="3.5" cy="12" r="1.8" stroke="currentColor" strokeWidth="1.4" />
                        <circle cx="12.5" cy="12" r="1.8" stroke="currentColor" strokeWidth="1.4" />
                        <path d="M8 5.3v2.2M8 7.5 4.5 10.3M8 7.5l3.5 2.8" stroke="currentColor" strokeWidth="1.4" />
                      </svg>
                    </span>
                    <div>
                      <div className="text-sm font-medium">Orchestrator</div>
                      <div className="text-2xs text-on-ink/60">
                        {state ? (state.round === 0 ? "Drafting" : "Reviewing") : "Starting"}
                      </div>
                    </div>
                  </div>
                  {state?.score != null && (
                    <div className="mt-3">
                      <div className="flex justify-between font-mono text-2xs text-on-ink/60">
                        <span>score {state.score}</span>
                        <span>target {state.targetScore}</span>
                      </div>
                      <div className="mt-1 h-0.75 overflow-hidden rounded-full bg-on-ink/10" aria-hidden>
                        <motion.div
                          className={`h-full rounded-full ${state.score >= state.targetScore ? "bg-ok-bright" : "bg-on-ink/80"}`}
                          animate={{ width: `${Math.min(100, (state.score / state.targetScore) * 100)}%` }}
                        />
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>

            <div>
              <h2 className="mb-3 font-mono text-2xs font-normal text-mute">Review in parallel</h2>
              <div className="space-y-2.5">
                <AnimatePresence mode="popLayout">
                  {agents.map((a) => (
                    <AgentCard
                      key={a.id}
                      a={a}
                      cardRef={(el) => {
                        if (el) cardRefs.set(a.id, el);
                        else cardRefs.delete(a.id);
                      }}
                    />
                  ))}
                  {state && state.round > 0 && !critics.length && !done && (
                    <motion.div
                      key="planning"
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      exit={{ opacity: 0 }}
                      className="flex items-center gap-2 rounded-xl border border-dashed border-line px-3.5 py-3 text-xs text-mute"
                    >
                      {paused ? "Paused. Resume to start the next round." : (
                        <>
                          <Spinner className="text-accent" /> Orchestrator is choosing reviewers for round {state.round}…
                        </>
                      )}
                    </motion.div>
                  )}
                  {!state && (
                    <Thinking key="boot" compact rows={0} title="Connecting to the run" detail="Spinning up the orchestrator." />
                  )}
                </AnimatePresence>
              </div>
            </div>

            <div className="flex flex-col">
              <h2 className="mb-3 font-mono text-2xs font-normal text-mute">Merge</h2>
              <div className="flex flex-1 items-center">
                <motion.div
                  ref={mergeRef}
                  layout
                  className={`w-full rounded-xl border p-3 transition-colors duration-500 ${done ? "border-ok/30 bg-ok/[0.05]" : "border-line bg-paper"}`}
                >
                  <div className="flex items-center gap-2 text-sm font-medium">
                    {done ? (
                      <CheckIcon ring className="shrink-0 text-ok" />
                    ) : merging || judging ? (
                      <Spinner className="text-accent" />
                    ) : (
                      <svg width="13" height="13" viewBox="0 0 16 16" fill="none" className="shrink-0" aria-hidden>
                        <path d="M4 2v12M4 6c0 3 8 2 8 6M12 12v2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
                      </svg>
                    )}
                    {mergeTitle}
                  </div>
                  <div className="mt-1 text-2xs text-mute">{mergeSub}</div>
                  {mergeMeta && <div className="mt-1 font-mono text-2xs text-faint">{mergeMeta}</div>}
                </motion.div>
              </div>
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line-2 px-4 py-3 font-mono text-2xs text-mute sm:px-6">
            <span className="tabular-nums">
              <span className="tracking-wider">TOKENS</span>&nbsp;&nbsp; {fmtTok(state?.tokensIn ?? 0)} in / {fmtTok(state?.tokensOut ?? 0)} out
            </span>
          </div>
        </motion.section>

        <AnimatePresence>
          {state?.status === "failed" && (
            <motion.div
              role="alert"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              className="mt-4 flex items-center justify-between gap-3 rounded-xl border border-bad/20 bg-paper px-4 py-3 text-sm shadow-xs"
            >
              <span className="min-w-0 text-pretty text-bad">The run stopped: {state.error}</span>
              <Button size="sm" onClick={() => send({ type: "resume" })}>
                Retry
              </Button>
            </motion.div>
          )}
        </AnimatePresence>
      </main>

      {/* Steer the next round */}
      <AnimatePresence>
        {steering && (
          <motion.form
            style={{ marginBottom: keyboardInset }}
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 16 }}
            transition={{ type: "spring", damping: 30, stiffness: 380 }}
            onSubmit={(e) => {
              e.preventDefault();
              if (steerText.trim()) send({ type: "steer", text: steerText.trim() });
              steerRef.current?.blur();
              setSteerText("");
              setSteering(false);
            }}
            className="card fixed inset-x-4 bottom-[max(1.5rem,env(safe-area-inset-bottom))] z-30 mx-auto flex max-w-narrow items-center gap-2 p-1.5 shadow-card-lift sm:bottom-16"
          >
            <input
              aria-label="Steer the next round"
              ref={steerRef}
              value={steerText}
              onChange={(e) => setSteerText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.preventDefault();
                  steerRef.current?.blur();
                  setSteering(false);
                }
              }}
              placeholder="Steer the next round, e.g. use SQLite, not Postgres"
              className="h-9 min-w-0 flex-1 bg-transparent px-3 text-base outline-none placeholder:text-faint"
              maxLength={500}
            />
            <Button type="submit" size="sm" kbd={<EnterIcon />}>
              Send
            </Button>
          </motion.form>
        )}
      </AnimatePresence>

      <Drawer open={panel === "draft"} onClose={() => setPanel(null)} title={draft ? `Draft v${draft.version}${draft.score != null ? ` ∗ ${draft.score}/100` : ""}` : "Draft"} side="right">
        <pre className="px-4 py-5 font-mono text-sm leading-code break-words whitespace-pre-wrap text-ink-2 sm:px-6">{draft?.body}</pre>
      </Drawer>
      <Drawer open={panel === "log"} onClose={() => setPanel(null)} title="Full log" side="bottom">
        <LogView log={log} />
      </Drawer>

      {!done && (
        <Abandon
          onDelete={async () => {
            // Stop the agents first so they don't keep spending tokens on a deleted project.
            send({ type: "pause" });
            await api.deleteProject(project.id);
          }}
          onError={setAbandonError}
        />
      )}
      {abandonError && (
        <p className="fixed bottom-[max(4rem,calc(env(safe-area-inset-bottom)+1rem))] left-4 z-20 max-w-xs rounded-lg bg-paper px-3 py-2 text-xs text-bad shadow-outline sm:left-6" role="alert">
          {abandonError}
        </p>
      )}

      <HintBar
        hints={[
          [<Kbd key="e"><EnterIcon /></Kbd>, "steer"],
          [<Kbd key="esc">esc</Kbd>, paused ? "resume" : "pause"],
          [<Kbd key="1">1</Kbd>, "full log"],
          [<Kbd key="d">D</Kbd>, "draft"],
        ]}
      />
    </Page>
  );
}
