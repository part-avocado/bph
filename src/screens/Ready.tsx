import { AnimatePresence, motion } from "motion/react";
import { useEffect, useState } from "react";
import type { ProjectDetail } from "../../shared/types";
import { Button, CheckIcon, EASE, ErrorText, HintBar, Kbd, Page, chip, rise } from "../components/ui";
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
    try {
      await navigator.clipboard.writeText(body);
    } catch {
      setError("Couldn't copy to the clipboard. Select the prompt and copy it, or download it.");
      return;
    }
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
    // Revoking right away can cancel the download in some browsers.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
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
    <Page
      tint="mint"
      title={project.title}
      headerRight={
        <span className={`${chip} mr-1 flex items-center gap-1.5 px-2.5 py-1 font-medium text-ink sm:mr-2`}>
          <span className="size-1.5 rounded-full bg-ok" aria-hidden />
          Ready{score != null ? <span className="font-mono tabular-nums">· {score}</span> : null}
        </span>
      }
    >
      <main className="relative z-10 mx-auto grid max-w-wide gap-6 px-4 pt-6 pb-28 sm:px-6 lg:grid-cols-[minmax(0,1fr)_240px]">
        <div className="min-w-0">
          <motion.h1
            initial={{ opacity: 0, y: 14, filter: "blur(8px)" }}
            animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
            transition={{ duration: 0.7, ease: EASE }}
            className="text-title-lg font-semibold tracking-display text-balance sm:text-display"
          >
            Your prompt is ready.
          </motion.h1>
          <motion.p initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.2 }} className="mt-1.5 text-sm text-mute">
            {rounds} round{rounds === 1 ? "" : "s"} · {answers} answer{answers === 1 ? "" : "s"} · 0 questions left for Claude
          </motion.p>

          <motion.figure {...rise(0.15, 18)} className="card mt-6 overflow-hidden">
            <figcaption className="flex items-center justify-between gap-3 border-b border-line-2 px-4 py-2.5 font-mono text-2xs text-mute">
              <span className="flex items-center gap-2">
                <span className="flex gap-1" aria-hidden>
                  <span className="size-2 rounded-full bg-line" />
                  <span className="size-2 rounded-full bg-line" />
                  <span className="size-2 rounded-full bg-line" />
                </span>
                prompt.md
              </span>
              <span className="text-faint">for Claude Code</span>
            </figcaption>
            <pre
              tabIndex={0}
              aria-label="Generated prompt"
              aria-busy={!done}
              className="scroll-thin max-h-[62vh] overflow-auto px-4 py-5 font-mono text-sm leading-code break-words whitespace-pre-wrap text-ink focus-visible:-outline-offset-2 sm:px-5"
            >
              {visible}
              {!done && <span className="ml-0.5 inline-block h-3.5 w-1.5 translate-y-0.5 animate-pulse bg-ink/70" aria-hidden />}
            </pre>
          </motion.figure>
        </div>

        <motion.aside
          initial={{ opacity: 0, x: 12 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ delay: 0.3, duration: 0.6, ease: EASE }}
          className="space-y-3 lg:pt-[92px]"
          aria-label="Actions"
        >
          <Button size="xl" onClick={copy} className="relative w-full overflow-hidden shadow-press-lg" aria-live="polite">
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
                    <CheckIcon />
                    Copied
                  </>
                ) : (
                  <>
                    Copy prompt <Kbd dark>{isMac ? "⌘↵" : "Ctrl ↵"}</Kbd>
                  </>
                )}
              </motion.span>
            </AnimatePresence>
          </Button>

          <section className="card border-accent/30 p-4 shadow-accent-halo" aria-labelledby="improve-title">
            <h2 id="improve-title" className="flex items-center gap-2 text-base font-medium">
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" className="text-accent" aria-hidden>
                <path d="M13 8a5 5 0 1 1-1.5-3.6M13 2.5v2.5h-2.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              Not perfect yet?
            </h2>
            <p className="mt-2 text-xs leading-relaxed text-mute">
              Add another round of improvements. The orchestrator re-reads the brief, closes more gaps and aims for 95+.
            </p>
            <Button variant="accent" size="md" onClick={improve} disabled={improving} loading={improving} kbd="I" className="mt-3 w-full text-sm">
              Improve again
            </Button>
            <AnimatePresence>{error && <ErrorText className="mt-2 justify-start text-xs">{error}</ErrorText>}</AnimatePresence>
          </section>

          <Button variant="secondary" onClick={() => navigate("/")} kbd="N" className="w-full rounded-xl text-sm font-normal">
            Start a new tool
          </Button>
          <Button variant="ghost" size="xs" onClick={download} className="w-full font-normal">
            Download prompt.md
          </Button>

          <div className="rounded-xl bg-paper/60 p-4 text-xs leading-code text-ink-2 ring-1 ring-black/5 backdrop-blur">
            <h2 className="mb-1 text-2xs text-mute">Next</h2>
            <ol className="list-inside list-decimal marker:text-faint">
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
    </Page>
  );
}
