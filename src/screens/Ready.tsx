import { AnimatePresence, motion } from "motion/react";
import { useEffect, useState } from "react";
import type { ProjectDetail } from "../../shared/types";
import { Header, HintBar, Kbd, Mesh, Spinner } from "../components/ui";
import type { Api } from "../lib/api";
import { isMac, isTyping, useKeys } from "../lib/keys";
import { navigate } from "../lib/router";

/** Reveals the prompt line by line the first time it's shown. */
function useReveal(text: string, key: string) {
  const seenKey = `offshoot:seen:${key}`;
  const lines = text.split("\n");
  const [shown, setShown] = useState(() => (sessionStorage.getItem(seenKey) ? lines.length : 0));
  useEffect(() => {
    if (shown >= lines.length) {
      sessionStorage.setItem(seenKey, "1");
      return;
    }
    const step = Math.max(1, Math.ceil(lines.length / 45));
    const t = setTimeout(() => setShown((n) => Math.min(lines.length, n + step)), 16);
    return () => clearTimeout(t);
  }, [shown, lines.length, seenKey]);
  return { visible: lines.slice(0, shown).join("\n"), done: shown >= lines.length };
}

export function Ready({ api, detail, onImprove }: { api: Api; detail: ProjectDetail; onImprove: (runId: string) => void }) {
  const { project, latest, questions, rounds } = detail;
  const body = latest?.body ?? "";
  const { visible, done } = useReveal(body, latest?.id ?? "none");
  const [copied, setCopied] = useState(false);
  const [improving, setImproving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const answers = questions.filter((q) => q.answer && !q.skipped).length;

  async function copy() {
    await navigator.clipboard.writeText(body);
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  }

  async function improve() {
    if (improving) return;
    setImproving(true);
    setError(null);
    try {
      const { runId } = await api.startRun(project.id, true);
      onImprove(runId);
    } catch (e) {
      setError((e as Error).message);
      setImproving(false);
    }
  }

  function download() {
    const url = URL.createObjectURL(new Blob([body], { type: "text/markdown" }));
    const a = Object.assign(document.createElement("a"), { href: url, download: "prompt.md" });
    a.click();
    URL.revokeObjectURL(url);
  }

  useKeys((e) => {
    if (isTyping(e)) return;
    const mod = isMac ? e.metaKey : e.ctrlKey;
    if ((mod && e.key === "Enter") || (!mod && e.key.toLowerCase() === "c" && !e.shiftKey && !e.altKey)) {
      e.preventDefault();
      void copy();
    } else if (e.key.toLowerCase() === "i" && !mod) {
      e.preventDefault();
      void improve();
    } else if (e.key.toLowerCase() === "n" && !mod) {
      e.preventDefault();
      navigate("/");
    }
  });

  const score = latest?.score;

  return (
    <div className="relative min-h-full">
      <Mesh tint="mint" />
      <Header
        title={project.title}
        right={
          <span className="mr-2 flex items-center gap-1.5 rounded-full bg-paper/90 px-2.5 py-1 text-[11px] font-medium ring-1 ring-black/5">
            <span className="size-1.5 rounded-full bg-ok" />
            Ready{score != null ? ` · ${score}` : ""}
          </span>
        }
      />

      <main className="relative z-10 mx-auto grid max-w-[1040px] gap-6 px-4 pt-6 pb-28 sm:px-6 lg:grid-cols-[minmax(0,1fr)_240px]">
        <div className="min-w-0">
          <motion.h1
            initial={{ opacity: 0, y: 14, filter: "blur(8px)" }}
            animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
            transition={{ duration: 0.7, ease: [0.22, 1, 0.36, 1] }}
            className="text-[36px] font-semibold tracking-[-0.045em] sm:text-[44px]"
          >
            Your prompt is ready.
          </motion.h1>
          <motion.p initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.2 }} className="mt-1 text-[12.5px] text-mute">
            {rounds} round{rounds === 1 ? "" : "s"} · {answers} answer{answers === 1 ? "" : "s"} · 0 questions left for Claude
          </motion.p>

          <motion.div
            initial={{ opacity: 0, y: 18 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.15, duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
            className="card mt-6 overflow-hidden"
          >
            <div className="flex items-center justify-between border-b border-line-2 px-4 py-2.5 font-mono text-[10.5px] text-faint">
              <span>prompt.md</span>
              <span>for Claude Code</span>
            </div>
            <pre className="scroll-thin max-h-[62vh] overflow-auto px-5 py-5 font-mono text-[12px] leading-[1.75] whitespace-pre-wrap text-ink">
              {visible}
              {!done && <span className="ml-0.5 inline-block h-3.5 w-1.5 translate-y-0.5 animate-pulse bg-ink/70" />}
            </pre>
          </motion.div>
        </div>

        <motion.aside
          initial={{ opacity: 0, x: 12 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ delay: 0.3, duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
          className="space-y-3 lg:pt-[92px]"
        >
          <motion.button
            whileTap={{ scale: 0.98 }}
            onClick={copy}
            className="relative flex h-11 w-full items-center justify-center gap-2 overflow-hidden rounded-xl bg-ink text-[13px] font-medium text-white shadow-[0_10px_24px_-10px_rgb(0_0_0/0.6)]"
          >
            <AnimatePresence mode="wait" initial={false}>
              <motion.span
                key={copied ? "copied" : "copy"}
                initial={{ y: 12, opacity: 0 }}
                animate={{ y: 0, opacity: 1 }}
                exit={{ y: -12, opacity: 0 }}
                transition={{ duration: 0.18 }}
                className="flex items-center gap-2"
              >
                {copied ? (
                  <>
                    <svg width="13" height="13" viewBox="0 0 12 12" fill="none" aria-hidden>
                      <path d="M2.5 6.5 5 9l4.5-6" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                    Copied
                  </>
                ) : (
                  <>
                    Copy prompt <Kbd dark>{isMac ? "⌘↵" : "Ctrl ↵"}</Kbd>
                  </>
                )}
              </motion.span>
            </AnimatePresence>
          </motion.button>

          <div className="card border-accent/30 p-4 shadow-[0_0_0_3px_rgb(37_99_235/0.06)]">
            <div className="flex items-center gap-2 text-[13px] font-medium">
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" className="text-accent" aria-hidden>
                <path d="M13 8a5 5 0 1 1-1.5-3.6M13 2.5v2.5h-2.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              Not perfect yet?
            </div>
            <p className="mt-2 text-[11.5px] leading-relaxed text-mute">
              Add another round of improvements. The orchestrator re-reads the brief, closes more gaps and aims for 95+.
            </p>
            <motion.button
              whileTap={{ scale: 0.98 }}
              onClick={improve}
              disabled={improving}
              className="mt-3 flex h-9 w-full items-center justify-center gap-2 rounded-lg bg-accent text-[12.5px] font-medium text-white transition hover:bg-accent-2 disabled:opacity-70"
            >
              {improving ? <Spinner /> : null}
              Improve again <Kbd dark>I</Kbd>
            </motion.button>
            {error && <p className="mt-2 text-[11px] text-bad">{error}</p>}
          </div>

          <button
            onClick={() => navigate("/")}
            className="flex h-9 w-full items-center justify-center gap-2 rounded-xl bg-paper/90 text-[12.5px] ring-1 ring-black/5 transition hover:bg-paper"
          >
            Start a new tool <Kbd>N</Kbd>
          </button>
          <button onClick={download} className="w-full text-center text-[11.5px] text-mute transition-colors hover:text-ink">
            Download prompt.md
          </button>

          <div className="rounded-xl bg-paper/60 p-4 text-[11.5px] leading-[1.9] text-ink-2 ring-1 ring-black/5 backdrop-blur">
            <div className="mb-1 text-[10.5px] text-faint">Next</div>
            <ol className="list-inside list-decimal">
              <li>Open Claude Code in an empty folder</li>
              <li>Paste the prompt</li>
              <li>It builds. No questions.</li>
            </ol>
          </div>
        </motion.aside>
      </main>

      <HintBar
        hints={[
          [<Kbd key="c">{isMac ? "⌘↵" : "Ctrl ↵"}</Kbd>, "copy"],
          [<Kbd key="i">I</Kbd>, "improve"],
          [<Kbd key="n">N</Kbd>, "new tool"],
        ]}
      />
    </div>
  );
}
