import { AnimatePresence, motion } from "motion/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Project, Question } from "../../shared/types";
import { ArrowDownIcon, ArrowUpIcon, Button, CheckIcon, EASE, EnterIcon, ErrorText, HintBar, Kbd, Page, Skeleton, Spinner } from "../components/ui";
import type { Api } from "../lib/api";
import { isTyping, useKeys } from "../lib/keys";

interface Local {
  choice: number | null;
  custom: string;
}

function initialLocal(q: Question): Local {
  if (q.answer === null) return { choice: null, custom: "" };
  const i = q.options.indexOf(q.answer);
  return i >= 0 ? { choice: i, custom: "" } : { choice: null, custom: q.answer };
}

export function Intake({ api, project, onBuild }: { api: Api; project: Project; onBuild: (runId: string) => void }) {
  const [title, setTitle] = useState(project.title);
  const [questions, setQuestions] = useState<Question[] | null>(null);
  /** Answers given here that the server may not have confirmed yet. */
  const [pending, setPending] = useState<Record<string, string | null>>({});
  const [currentId, setCurrentId] = useState<string | null>(null);
  const [locals, setLocals] = useState<Record<string, Local>>({});
  const [focus, setFocus] = useState(0);
  const [inFlight, setInFlight] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [building, setBuilding] = useState(false);
  const [dir, setDir] = useState(1);
  const queue = useRef(Promise.resolve());
  const customRef = useRef<HTMLInputElement>(null);

  // Server state with local answers laid over it.
  const view = useMemo(
    () =>
      (questions ?? []).map((q) =>
        q.id in pending ? { ...q, answer: pending[q.id], skipped: pending[q.id] === null } : q,
      ),
    [questions, pending],
  );
  const isSettled = (q: Question) => q.answer !== null || q.skipped;
  const firstOpen = view.find((q) => !isSettled(q))?.id ?? null;
  const index = currentId ? view.findIndex((q) => q.id === currentId) : -1;
  const current = index >= 0 ? view[index] : null;
  const answeredCount = view.filter(isSettled).length;
  const realAnswers = view.filter((q) => q.answer !== null && !q.skipped).length;

  const absorb = useCallback((qs: Question[], t: string) => {
    setQuestions(qs);
    setTitle(t);
  }, []);

  useEffect(() => {
    let live = true;
    api
      .plan(project.id)
      .then((s) => {
        if (!live) return;
        absorb(s.questions, s.project.title);
        setCurrentId(s.questions.find((q) => q.answer === null && !q.skipped)?.id ?? null);
      })
      .catch((e) => live && setError((e as Error).message));
    return () => {
      live = false;
    };
  }, [api, project.id, absorb]);

  // If a re-plan removed the question on screen, move to the first open one.
  useEffect(() => {
    if (questions && currentId && !view.some((q) => q.id === currentId)) setCurrentId(firstOpen);
    if (questions && !currentId && firstOpen && inFlight === 0) setCurrentId(firstOpen);
  }, [questions, view, currentId, firstOpen, inFlight]);

  const local = current ? (locals[current.id] ?? initialLocal(current)) : { choice: null, custom: "" };
  const setLocal = (patch: Partial<Local>) => current && setLocals((m) => ({ ...m, [current.id]: { ...local, ...patch } }));

  useEffect(() => {
    if (!current) return;
    const l = locals[current.id] ?? initialLocal(current);
    setFocus(l.custom ? current.options.length : (l.choice ?? 0));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.id]);

  function submit(answer: string | null) {
    if (!current) return;
    const q = current;
    setDir(1);
    setPending((p) => ({ ...p, [q.id]: answer }));
    const next = view.slice(index + 1).find((x) => !isSettled(x) && x.id !== q.id);
    setCurrentId(next?.id ?? null);
    setInFlight((n) => n + 1);
    queue.current = queue.current.then(async () => {
      try {
        const s = await api.answer(project.id, { questionId: q.id, prompt: q.prompt, answer });
        absorb(s.questions, s.project.title);
        setPending((p) => {
          const { [q.id]: _, ...rest } = p;
          return rest;
        });
      } catch (e) {
        setError((e as Error).message);
        // Not saved: reopen the question so it isn't silently left out of the brief.
        setPending((p) => {
          const { [q.id]: _, ...rest } = p;
          return rest;
        });
      } finally {
        setInFlight((n) => n - 1);
      }
    });
  }

  function continueWith(choiceOverride?: number) {
    if (!current) return;
    const custom = local.custom.trim();
    const choice = choiceOverride ?? local.choice ?? (focus < current.options.length ? focus : null);
    const answer = custom || (choice !== null ? current.options[choice] : null);
    if (!answer) return customRef.current?.focus();
    submit(answer);
  }

  function back() {
    const prevIndex = current ? index - 1 : view.length - 1;
    if (prevIndex < 0) return;
    setDir(-1);
    setCurrentId(view[prevIndex].id);
  }

  async function build() {
    if (building) return;
    setBuilding(true);
    try {
      await queue.current;
      const { runId } = await api.startRun(project.id);
      onBuild(runId);
    } catch (e) {
      setError((e as Error).message);
      setBuilding(false);
    }
  }

  const loading = questions === null;
  const thinking = !loading && !current && inFlight > 0;
  const done = !loading && !current && inFlight === 0;

  useKeys((e) => {
    if (loading) return;
    if (done) {
      if (e.key === "Enter") {
        e.preventDefault();
        void build();
      } else if (e.key === "ArrowLeft" && !isTyping(e)) back();
      return;
    }
    if (!current) return;
    const n = current.options.length;
    const typing = isTyping(e);
    if (e.key === "ArrowDown") {
      e.preventDefault();
      const f = Math.min(n, focus + 1);
      setFocus(f);
      if (f === n) customRef.current?.focus();
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      const f = Math.max(0, focus - 1);
      setFocus(f);
      if (typing && f < n) customRef.current?.blur();
    } else if (e.key === "Enter") {
      e.preventDefault();
      continueWith();
    } else if (typing) {
      if (e.key === "Escape") {
        customRef.current?.blur();
        setFocus(0);
      }
    } else if (e.key === " ") {
      e.preventDefault();
      if (focus < n) setLocal({ choice: local.choice === focus ? null : focus, custom: "" });
    } else if (e.key === "ArrowLeft" || e.key === "Backspace") {
      e.preventDefault();
      back();
    } else if (/^[1-9]$/.test(e.key) && Number(e.key) <= n) {
      e.preventDefault();
      const i = Number(e.key) - 1;
      setFocus(i);
      setLocal({ choice: i, custom: "" });
    } else if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
      // Start typing anywhere to write your own answer.
      e.preventDefault();
      setFocus(n);
      setLocal({ custom: local.custom + e.key, choice: null });
      customRef.current?.focus();
    }
  });

  const total = Math.max(view.length, 1);
  const position = current ? index + 1 : answeredCount;

  return (
    <Page
      tint="lilac"
      title={title}
      headerRight={
        !loading && (
          <div className="mr-2 hidden items-center gap-3 sm:flex" role="progressbar" aria-label="Questions answered" aria-valuemin={0} aria-valuemax={total} aria-valuenow={position}>
            <div className="flex gap-1" aria-hidden>
              {view.map((q, i) => (
                <motion.span
                  key={q.id}
                  layout
                  className={`h-0.75 rounded-full ${i < position ? "bg-ink" : "bg-ink/12"}`}
                  animate={{ width: i === index ? 26 : 18 }}
                  transition={{ duration: 0.35, ease: EASE }}
                />
              ))}
            </div>
            <span className="font-mono text-xs text-mute tabular-nums">
              {position} / {total}
            </span>
          </div>
        )
      }
    >
      <main className="relative z-10 mx-auto flex min-h-[calc(100dvh-4rem)] max-w-narrow flex-col justify-center px-4 pb-28">
        {!loading && (
          <p className="mb-6 text-center font-mono text-xs text-mute tabular-nums sm:hidden" aria-hidden>
            {position} / {total}
          </p>
        )}
        <AnimatePresence mode="wait" custom={dir}>
          {loading ? (
            <motion.div key="loading" exit={{ opacity: 0 }} className="space-y-3" aria-busy="true">
              <p className="mb-6 flex items-center justify-center gap-2 text-base text-mute" role="status">
                <Spinner /> Reading your idea…
              </p>
              <Skeleton className="mx-auto h-9 w-4/5" />
              <div className="h-4" />
              {[0, 1, 2].map((i) => (
                <Skeleton key={i} className="h-11.5 w-full rounded-xl" delay={i * 120} />
              ))}
            </motion.div>
          ) : current ? (
            <motion.section
              key={current.id}
              custom={dir}
              initial={{ opacity: 0, y: dir * 18, filter: "blur(6px)" }}
              animate={{ opacity: 1, y: 0, filter: "blur(0px)", transition: { duration: 0.45, ease: EASE } }}
              exit={{ opacity: 0, y: dir * -14, filter: "blur(4px)", transition: { duration: 0.18 } }}
              aria-labelledby="q"
            >
              <h2 id="q" className="text-center text-title font-semibold tracking-title text-balance sm:text-title-lg">
                {current.prompt}
              </h2>
              {current.why && <p className="mt-2 text-center text-sm text-pretty text-mute">{current.why}</p>}

              <div role="radiogroup" aria-labelledby="q" className="mt-7 space-y-2">
                {current.options.map((opt, i) => {
                  const selected = local.choice === i && !local.custom;
                  const focused = focus === i;
                  return (
                    <motion.button
                      key={opt}
                      role="radio"
                      aria-checked={selected}
                      initial={{ opacity: 0, y: 8 }}
                      animate={{ opacity: 1, y: 0, transition: { delay: 0.06 + i * 0.05 } }}
                      whileTap={{ scale: 0.99 }}
                      onMouseEnter={() => setFocus(i)}
                      onClick={() => {
                        setFocus(i);
                        setLocal({ choice: i, custom: "" });
                      }}
                      onDoubleClick={() => continueWith(i)}
                      className={`flex w-full items-center gap-3 rounded-xl bg-paper/85 px-3.5 py-3 text-left text-base backdrop-blur transition-[box-shadow,background-color] duration-150 ${
                        focused ? "bg-paper shadow-outline-strong" : "shadow-outline hover:bg-paper"
                      }`}
                    >
                      <span
                        className={`flex size-4.5 shrink-0 items-center justify-center rounded-full text-white transition-colors ${
                          selected ? "bg-ink" : "ring-1 ring-black/20"
                        }`}
                        aria-hidden
                      >
                        <AnimatePresence>
                          {selected && (
                            <motion.span initial={{ scale: 0 }} animate={{ scale: 1 }} exit={{ scale: 0 }} className="flex">
                              <CheckIcon size={9} />
                            </motion.span>
                          )}
                        </AnimatePresence>
                      </span>
                      <span className="min-w-0 flex-1 text-pretty">{opt}</span>
                      {focused && !selected && <Kbd>space</Kbd>}
                      {!focused && (
                        <span className="hidden font-mono text-2xs text-faint sm:inline" aria-hidden>
                          {i + 1}
                        </span>
                      )}
                    </motion.button>
                  );
                })}
              </div>

              <input
                ref={customRef}
                value={local.custom}
                onChange={(e) => setLocal({ custom: e.target.value, choice: e.target.value ? null : local.choice })}
                onFocus={() => setFocus(current.options.length)}
                placeholder="Or type your own…"
                aria-label="Your own answer"
                className={`mt-2 w-full rounded-xl px-3.5 py-3 text-base outline-none placeholder:text-faint transition-[box-shadow,background-color] duration-150 ${
                  focus === current.options.length ? "bg-paper shadow-outline-strong" : "bg-transparent"
                }`}
              />

              <div className="mt-7 flex items-center justify-center gap-3">
                <Button onClick={() => continueWith()} kbd={<EnterIcon />}>
                  Continue
                </Button>
                <Button variant="ghost" size="sm" onClick={() => submit(null)}>
                  Skip
                </Button>
              </div>
            </motion.section>
          ) : thinking ? (
            <motion.div key="thinking" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="text-center">
              <p className="flex items-center justify-center gap-2 text-base text-mute" role="status">
                <Spinner /> Checking whether anything else matters…
              </p>
            </motion.div>
          ) : (
            <motion.section
              key="done"
              initial={{ opacity: 0, y: 18, filter: "blur(6px)" }}
              animate={{ opacity: 1, y: 0, filter: "blur(0px)", transition: { duration: 0.5, ease: EASE } }}
              exit={{ opacity: 0, scale: 0.98 }}
            >
              <h2 className="text-center text-title font-semibold tracking-display">That's everything.</h2>
              <p className="mt-2 text-center text-base text-pretty text-mute">
                {realAnswers} answer{realAnswers === 1 ? "" : "s"}{answeredCount > realAnswers ? `, ${answeredCount - realAnswers} left for Offshoot to decide` : ""}. Reviewers will draft, challenge and merge your prompt next.
              </p>
              <ul className="card mt-7 divide-y divide-line-2 overflow-hidden p-0" aria-label="Your answers">
                {view.map((q) => (
                  <li key={q.id}>
                    <button
                      onClick={() => {
                        setDir(-1);
                        setCurrentId(q.id);
                      }}
                      className="flex w-full flex-col gap-0.5 px-4 py-3 text-left transition-colors hover:bg-wash focus-visible:-outline-offset-2 sm:flex-row sm:items-baseline sm:justify-between sm:gap-4"
                      aria-label={`Change answer: ${q.prompt}`}
                    >
                      <span className="text-sm text-mute">{q.prompt}</span>
                      <span className="text-base sm:max-w-[55%] sm:shrink-0 sm:text-right">
                        {q.skipped ? <span className="text-faint">Decide for me</span> : q.answer}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
              <div className="mt-7 flex justify-center">
                <Button size="lg" onClick={build} disabled={building} loading={building} kbd={<EnterIcon />}>
                  {building ? "Starting reviewers" : "Build the prompt"}
                </Button>
              </div>
            </motion.section>
          )}
        </AnimatePresence>

        <AnimatePresence>
          {error && (
            <ErrorText className="mt-6" onDismiss={() => setError(null)}>
              {error}
            </ErrorText>
          )}
        </AnimatePresence>
      </main>

      <HintBar
        hints={
          done
            ? [
                [<Kbd key="e"><EnterIcon /></Kbd>, "build"],
                [<Kbd key="l">←</Kbd>, "back"],
              ]
            : [
                [
                  <span key="a" className="flex gap-1">
                    <Kbd><ArrowUpIcon /></Kbd>
                    <Kbd><ArrowDownIcon /></Kbd>
                  </span>,
                  "move",
                ],
                [<Kbd key="s">space</Kbd>, "select"],
                [<Kbd key="e"><EnterIcon /></Kbd>, "continue"],
                [<Kbd key="l">←</Kbd>, "back"],
              ]
        }
      />
    </Page>
  );
}
