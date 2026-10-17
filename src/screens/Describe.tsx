import { useAuth, useClerk } from "@clerk/react";
import { AnimatePresence, motion, type Variants } from "motion/react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { EnterIcon, Header, Kbd, Mesh, Spinner } from "../components/ui";
import { useApi } from "../lib/api";
import { ACCEPT, filesFromDrop, formatBytes, isSupported } from "../lib/files";
import { isMac } from "../lib/keys";
import { navigate } from "../lib/router";

const EXAMPLES: [string, string][] = [
  ["Changelog writer", "A tool that lets me turn git history into release notes"],
  ["Photo renamer", "A CLI that renames my photo library by date taken and location"],
  ["Standup bot", "A Slack bot that collects daily standups and posts a summary at 10am"],
];

const PENDING_KEY = "offshoot:pending-idea";

const word: Variants = {
  hidden: { opacity: 0, y: 14, filter: "blur(10px)" },
  show: (i: number) => ({
    opacity: 1,
    y: 0,
    filter: "blur(0px)",
    transition: { delay: 0.08 + i * 0.07, duration: 0.7, ease: [0.22, 1, 0.36, 1] as const },
  }),
};

function Headline() {
  const lines = [
    { text: "Describe a tool.", className: "text-ink" },
    { text: "We'll write the prompt.", className: "text-faint" },
  ];
  let i = 0;
  return (
    <h1 className="text-center text-[40px] leading-[1.02] font-semibold tracking-[-0.045em] sm:text-[58px]">
      {lines.map((l) => (
        <span key={l.text} className={`block ${l.className}`}>
          {l.text.split(" ").map((w) => (
            <motion.span key={w + i} custom={i++} variants={word} initial="hidden" animate="show" className="inline-block whitespace-pre">
              {w}{" "}
            </motion.span>
          ))}
        </span>
      ))}
    </h1>
  );
}

export function Describe() {
  const api = useApi();
  const { isSignedIn, isLoaded } = useAuth();
  const clerk = useClerk();
  const [idea, setIdea] = useState(() => sessionStorage.getItem(PENDING_KEY) ?? "");
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const resumeAfterSignIn = useRef(false);

  useEffect(() => {
    const t = setTimeout(() => textRef.current?.focus({ preventScroll: true }), 450);
    return () => clearTimeout(t);
  }, []);

  // Keep the idea safe across a sign-in redirect.
  useEffect(() => {
    if (idea) sessionStorage.setItem(PENDING_KEY, idea);
    else sessionStorage.removeItem(PENDING_KEY);
  }, [idea]);

  // Grow the textarea with its content, and re-measure when its width changes.
  useLayoutEffect(() => {
    const el = textRef.current;
    if (!el) return;
    const fit = () => {
      el.style.height = "0px";
      el.style.height = `${Math.min(220, Math.max(64, el.scrollHeight))}px`;
      el.style.overflowY = el.scrollHeight > 220 ? "auto" : "hidden";
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, [idea]);

  async function start() {
    const text = idea.trim();
    if (!text || busy) {
      textRef.current?.focus();
      return;
    }
    if (!isSignedIn) {
      resumeAfterSignIn.current = true;
      clerk.openSignIn({ forceRedirectUrl: window.location.href });
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const { project } = await api.createProject(text, files);
      sessionStorage.removeItem(PENDING_KEY);
      navigate(`/p/${project.id}`);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  // Signing in through the modal returns here; carry on where the user left off.
  useEffect(() => {
    if (isSignedIn && resumeAfterSignIn.current) {
      resumeAfterSignIn.current = false;
      void start();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isSignedIn]);

  function addFiles(list: File[]) {
    const ok = list.filter(isSupported);
    if (ok.length < list.length) setError("Some files were skipped. Use text, code, images or PDFs.");
    setFiles((prev) => {
      const seen = new Set(prev.map((f) => f.name + f.size));
      return [...prev, ...ok.filter((f) => !seen.has(f.name + f.size))].slice(0, 40);
    });
  }

  return (
    <div
      className="relative min-h-full"
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target || !e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false);
      }}
      onDrop={async (e) => {
        e.preventDefault();
        setDragging(false);
        addFiles(await filesFromDrop(e.dataTransfer));
      }}
    >
      <Mesh tint="dawn" grid />
      <Header />
      <main className="relative z-10 mx-auto flex max-w-[640px] flex-col items-center px-4 pt-[12vh] pb-24">
        <motion.div
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6 }}
          className="mb-5 flex items-center gap-2 rounded-full bg-paper/70 px-3 py-1 text-[11.5px] text-ink-2 ring-1 ring-black/5 backdrop-blur"
        >
          <span className="size-1.5 rounded-full bg-ink" />
          Answer once. Claude never has to ask.
        </motion.div>

        <Headline />

        <motion.form
          initial={{ opacity: 0, y: 22, scale: 0.985 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          transition={{ delay: 0.55, duration: 0.8, ease: [0.22, 1, 0.36, 1] }}
          onSubmit={(e) => {
            e.preventDefault();
            void start();
          }}
          className={`card mt-10 w-full p-1.5 transition-shadow duration-300 ${dragging ? "ring-2 ring-accent/50" : "focus-within:shadow-[0_1px_2px_rgb(0_0_0/0.04),0_20px_60px_-16px_rgb(0_0_0/0.16)]"}`}
        >
          <label htmlFor="idea" className="sr-only">
            Describe the tool you want
          </label>
          <textarea
            id="idea"
            ref={textRef}
            value={idea}
            onChange={(e) => setIdea(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void start();
              }
            }}
            onPaste={(e) => {
              const pasted = [...e.clipboardData.files];
              if (pasted.length) {
                e.preventDefault();
                addFiles(pasted);
              }
            }}
            placeholder="A tool that lets me turn git history into release notes"
            className="block w-full resize-none bg-transparent px-4 pt-3.5 pb-2 text-[15.5px] leading-relaxed outline-none placeholder:text-faint"
            maxLength={4000}
          />

          <AnimatePresence initial={false}>
            {files.length > 0 && (
              <motion.ul
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: "auto", opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                className="flex flex-wrap gap-1.5 overflow-hidden px-3.5"
              >
                {files.map((f, i) => (
                  <motion.li
                    layout
                    key={f.name + f.size}
                    initial={{ opacity: 0, scale: 0.9 }}
                    animate={{ opacity: 1, scale: 1 }}
                    className="group flex items-center gap-1.5 rounded-md bg-wash py-1 pr-1 pl-2 text-[11.5px] text-ink-2 ring-1 ring-line"
                  >
                    <span className="max-w-[180px] truncate">{f.name}</span>
                    <span className="text-faint">{formatBytes(f.size)}</span>
                    <button
                      type="button"
                      onClick={() => setFiles((p) => p.filter((_, j) => j !== i))}
                      className="rounded px-1 text-faint hover:bg-line hover:text-ink"
                      aria-label={`Remove ${f.name}`}
                    >
                      ✕
                    </button>
                  </motion.li>
                ))}
              </motion.ul>
            )}
          </AnimatePresence>

          <div className="flex items-center justify-between gap-3 px-3.5 pt-3 pb-2">
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              className="flex items-center gap-2 rounded-md py-1 text-[11.5px] text-faint transition-colors hover:text-ink-2"
            >
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden>
                <path d="M8 11V2.5M8 2.5 4.5 6M8 2.5 11.5 6M2.5 13.5h11" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              {dragging ? "Drop to attach" : "or drop a README, screenshot or folder"}
            </button>
            <input
              ref={fileRef}
              type="file"
              multiple
              accept={ACCEPT}
              className="hidden"
              onChange={(e) => {
                addFiles([...(e.target.files ?? [])]);
                e.target.value = "";
              }}
            />
            <motion.button
              type="submit"
              whileTap={{ scale: 0.97 }}
              disabled={!isLoaded}
              className="flex h-9 items-center gap-2 rounded-[10px] bg-ink pr-2 pl-3.5 text-[13px] font-medium text-white shadow-[0_6px_16px_-6px_rgb(0_0_0/0.5)] transition-opacity disabled:opacity-60"
            >
              {busy ? <Spinner /> : null}
              {busy ? "Starting" : "Start"}
              <Kbd dark>
                <EnterIcon />
              </Kbd>
            </motion.button>
          </div>
        </motion.form>

        <AnimatePresence>
          {error && (
            <motion.p initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="mt-3 text-[12.5px] text-bad" role="alert">
              {error}
            </motion.p>
          )}
        </AnimatePresence>

        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.9, duration: 0.6 }}
          className="mt-6 flex flex-wrap justify-center gap-1.5"
        >
          {EXAMPLES.map(([label, text]) => (
            <button
              key={label}
              onClick={() => {
                setIdea(text);
                textRef.current?.focus();
              }}
              className="rounded-full bg-paper/60 px-3 py-1 text-[11.5px] text-mute ring-1 ring-black/5 backdrop-blur transition hover:bg-paper hover:text-ink"
            >
              {label}
            </button>
          ))}
        </motion.div>

        <p className="mt-10 hidden text-[11px] text-faint sm:block">
          <Kbd>↵</Kbd> start · <Kbd>{isMac ? "⇧" : "Shift"}</Kbd> <Kbd>↵</Kbd> new line
        </p>
      </main>
    </div>
  );
}
