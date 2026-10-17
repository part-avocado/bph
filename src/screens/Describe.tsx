import { useAuth, useClerk } from "@clerk/react";
import { AnimatePresence, motion, type Variants } from "motion/react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Button, EASE, EnterIcon, ErrorText, Kbd, Page, Sep, ShiftIcon, chip } from "../components/ui";
import { useApi } from "../lib/api";
import { ACCEPT, filesFromDrop, formatBytes, isSupported } from "../lib/files";
import { isMac } from "../lib/keys";
import { navigate } from "../lib/router";
import { getSession, removeSession, setSession } from "../lib/session";

const EXAMPLES: [string, string][] = [
  ["Changelog writer", "A skill that turns git history into release notes"],
  ["PR reviewer", "A skill that reviews my diff against our team style guide before I open a PR"],
  ["Commit helper", "A skill that writes conventional commit messages from my staged changes"],
];

const PENDING_KEY = "reskill:pending-idea";

const word: Variants = {
  hidden: { opacity: 0, y: 14, filter: "blur(10px)" },
  show: (i: number) => ({
    opacity: 1,
    y: 0,
    filter: "blur(0px)",
    transition: { delay: 0.08 + i * 0.07, duration: 0.7, ease: EASE },
  }),
};

function Headline() {
  const lines = [
    { text: "Describe your skill,", className: "text-ink" },
    { text: "and we'll take it from here.", className: "text-faint" },
  ];
  let i = 0;
  return (
    <h1 className="text-center text-display font-semibold tracking-display text-balance sm:text-hero">
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
  const [idea, setIdea] = useState(() => getSession(PENDING_KEY) ?? "");
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const resumeAfterSignIn = useRef(false);
  const busyRef = useRef(false);

  useEffect(() => {
    const t = setTimeout(() => textRef.current?.focus({ preventScroll: true }), 450);
    return () => clearTimeout(t);
  }, []);

  // Keep the idea safe across a sign-in redirect.
  useEffect(() => {
    if (idea) setSession(PENDING_KEY, idea);
    else removeSession(PENDING_KEY);
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
    if (!text || busyRef.current) {
      textRef.current?.focus();
      return;
    }
    if (!isSignedIn) {
      resumeAfterSignIn.current = true;
      clerk.openSignIn({ forceRedirectUrl: window.location.href });
      return;
    }
    // A ref, not state: two Enter presses in one frame would both see busy === false.
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      const { project } = await api.createProject(text, files);
      removeSession(PENDING_KEY);
      navigate(`/p/${project.id}`);
    } catch (err) {
      setError((err as Error).message);
      busyRef.current = false;
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
    <Page
      tint="dawn"
      grid
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
        try {
          addFiles(await filesFromDrop(e.dataTransfer));
        } catch {
          setError("Couldn't read the dropped files. Try attaching them with the button.");
        }
      }}
    >
      <main className="relative z-10 mx-auto flex max-w-form flex-col items-center px-4 pt-[12vh] pb-24">
        <Headline />

        <motion.form
          initial={{ opacity: 0, y: 22, scale: 0.985 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          transition={{ delay: 0.55, duration: 0.8, ease: EASE }}
          onSubmit={(e) => {
            e.preventDefault();
            void start();
          }}
          aria-busy={busy}
          className={`card mt-10 w-full p-1.5 transition-shadow duration-300 ${dragging ? "ring-2 ring-accent/50" : "focus-within:shadow-card-lift"}`}
        >
          <label htmlFor="idea" className="sr-only">
            Describe the skill you want
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
            placeholder="A skill that turns git history into release notes"
            className="block w-full resize-none bg-transparent px-4 pt-3.5 pb-2 text-md outline-none placeholder:text-faint"
            maxLength={4000}
          />

          <AnimatePresence initial={false}>
            {files.length > 0 && (
              <motion.ul
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: "auto", opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                aria-label="Attachments"
                className="flex flex-wrap gap-1.5 overflow-hidden px-3.5"
              >
                {files.map((f, i) => (
                  <motion.li
                    layout
                    key={f.name + f.size}
                    initial={{ opacity: 0, scale: 0.9 }}
                    animate={{ opacity: 1, scale: 1 }}
                    className="group flex max-w-full min-w-0 items-center gap-1.5 rounded-md bg-wash py-1 pr-1 pl-2 text-xs text-ink-2 ring-1 ring-line"
                  >
                    <span className="max-w-44 truncate">{f.name}</span>
                    <span className="shrink-0 text-faint">{formatBytes(f.size)}</span>
                    <button
                      type="button"
                      onClick={() => setFiles((p) => p.filter((_, j) => j !== i))}
                      className="shrink-0 rounded px-1 text-faint transition-colors hover:bg-line hover:text-ink"
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
              className="flex min-w-0 items-center gap-2 rounded-md py-1 text-left text-xs text-mute transition-colors hover:text-ink"
            >
              <svg width="12" height="12" viewBox="0 0 16 16" fill="none" className="shrink-0" aria-hidden>
                <path d="M8 11V2.5M8 2.5 4.5 6M8 2.5 11.5 6M2.5 13.5h11" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              <span className="truncate">
                {dragging ? "Drop to attach" : (
                  <>
                    <span className="sm:hidden">Attach a README or screenshot</span>
                    <span className="hidden sm:inline">or drop a README, screenshot or folder</span>
                  </>
                )}
              </span>
            </button>
            <input
              ref={fileRef}
              type="file"
              multiple
              accept={ACCEPT}
              className="hidden"
              aria-label="Attach files"
              onChange={(e) => {
                addFiles([...(e.target.files ?? [])]);
                e.target.value = "";
              }}
            />
            <Button type="submit" disabled={!isLoaded} loading={busy} kbd={<EnterIcon />}>
              {busy ? "Starting" : "Start"}
            </Button>
          </div>
        </motion.form>

        <AnimatePresence>
          {error && (
            <ErrorText className="mt-3" onDismiss={() => setError(null)}>
              {error}
            </ErrorText>
          )}
        </AnimatePresence>

        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.9, duration: 0.6 }}
          className="mt-6 flex flex-wrap justify-center gap-1.5"
          role="group"
          aria-label="Example ideas"
        >
          {EXAMPLES.map(([label, text]) => (
            <button
              key={label}
              type="button"
              title={text}
              onClick={() => {
                setIdea(text);
                textRef.current?.focus();
              }}
              className={`${chip} px-3 py-1 text-mute hover:bg-paper hover:text-ink`}
            >
              {label}
            </button>
          ))}
        </motion.div>

        <p className="mt-10 hidden text-xs text-faint sm:block">
          <Kbd><EnterIcon /></Kbd> start<Sep /><Kbd>{isMac ? <ShiftIcon /> : "Shift"}</Kbd> <Kbd><EnterIcon /></Kbd> new line
        </p>
      </main>
    </Page>
  );
}
