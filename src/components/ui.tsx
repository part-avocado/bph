import { Show, SignInButton, UserButton } from "@clerk/react";
import { motion } from "motion/react";
import type { ReactNode } from "react";
import { navigate } from "../lib/router";

export function Kbd({ children, dark = false }: { children: ReactNode; dark?: boolean }) {
  return <kbd className={`kbd ${dark ? "kbd-dark" : ""}`}>{children}</kbd>;
}

export const EnterIcon = () => (
  <svg width="9" height="9" viewBox="0 0 12 12" fill="none" aria-hidden>
    <path d="M10 2v4.5a1.5 1.5 0 0 1-1.5 1.5H2.5M2.5 8 5 5.5M2.5 8 5 10.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

type Tint = "dawn" | "lilac" | "sky" | "mint";

const TINTS: Record<Tint, [string, string, string, string, string]> = {
  dawn: ["#ffb38a", "#c9b6ff", "#9fd3ff", "#8ef0c2", "#ffd2a8"],
  lilac: ["#ffd6c2", "#d9c8ff", "#e9d8ff", "#ffe1cc", "#cfe3ff"],
  sky: ["#ffd0b5", "#d8c5ff", "#a9d8ff", "#bfe9ff", "#ffe0c4"],
  mint: ["#ffe2cc", "#e3d6ff", "#b9e0ff", "#c7f2dd", "#ffd9c0"],
};

/** Drifting gradient blobs. Placement matches the corners in the design. */
export function Mesh({ tint = "dawn", grid = false }: { tint?: Tint; grid?: boolean }) {
  const c = TINTS[tint];
  return (
    <>
      <div className="mesh" aria-hidden>
        <i style={{ background: c[0], width: "42vw", height: "42vw", left: "-12vw", top: "-16vw" }} />
        <i style={{ background: c[1], width: "40vw", height: "34vw", left: "30vw", top: "-22vw" }} />
        <i style={{ background: c[2], width: "38vw", height: "38vw", right: "-14vw", top: "-12vw" }} />
        <i style={{ background: c[3], width: "36vw", height: "30vw", left: "-12vw", bottom: "-16vw" }} />
        <i style={{ background: c[4], width: "40vw", height: "34vw", right: "-12vw", bottom: "-18vw" }} />
      </div>
      {grid && <div className="grid-bg" aria-hidden />}
    </>
  );
}

export function Header({ title, right }: { title?: string; right?: ReactNode }) {
  return (
    <header className="relative z-10 flex h-16 items-center justify-between gap-3 px-4 sm:px-7">
      <button
        onClick={() => navigate("/")}
        className="group flex min-w-0 items-center gap-2.5 rounded-lg py-1 pr-2 text-[14px] font-semibold tracking-[-0.01em]"
        aria-label="Offshoot home"
      >
        <span className="size-[15px] shrink-0 rounded-full bg-ink transition-transform duration-300 group-hover:scale-110" />
        <motion.span
          key={title ?? "Offshoot"}
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.35 }}
          className="truncate whitespace-nowrap"
        >
          {title ?? "Offshoot"}
        </motion.span>
      </button>
      <div className="flex shrink-0 items-center gap-1 whitespace-nowrap sm:gap-2">
        {right}
        <Show when="signed-in">
          <button onClick={() => navigate("/history")} className="rounded-full px-2.5 py-1.5 text-[12px] text-mute transition-colors hover:text-ink">
            History
          </button>
          <button
            onClick={() => navigate("/")}
            className="hidden rounded-full bg-paper/90 px-3.5 py-1.5 text-[12px] font-medium shadow-[0_1px_2px_rgb(0_0_0/0.06)] ring-1 ring-black/5 transition hover:bg-paper sm:block"
          >
            New
          </button>
          <div className="ml-1 flex size-7 items-center justify-center">
            <UserButton />
          </div>
        </Show>
        <Show when="signed-out">
          <SignInButton mode="modal">
            <button className="rounded-full bg-paper/90 px-3.5 py-1.5 text-[12px] font-medium ring-1 ring-black/5 transition hover:bg-paper">Sign in</button>
          </SignInButton>
        </Show>
      </div>
    </header>
  );
}

export function HintBar({ hints }: { hints: [ReactNode, string][] }) {
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-5 z-10 hidden justify-center sm:flex">
      <div className="flex items-center gap-4 rounded-full bg-paper/60 px-4 py-2 text-[11px] text-mute backdrop-blur-md">
        {hints.map(([k, label], i) => (
          <span key={i} className="flex items-center gap-1.5">
            {k}
            <span>{label}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

export function Spinner({ className = "" }: { className?: string }) {
  return (
    <svg className={`animate-spin ${className}`} width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.2" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

export function Toast({ message, onClose }: { message: string; onClose: () => void }) {
  return (
    <motion.div
      role="alert"
      initial={{ opacity: 0, y: 12, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 8 }}
      className="fixed inset-x-0 bottom-16 z-50 mx-auto flex w-fit max-w-[90vw] items-center gap-3 rounded-xl bg-ink px-4 py-2.5 text-[13px] text-white shadow-xl"
    >
      <span>{message}</span>
      <button onClick={onClose} className="text-white/60 hover:text-white" aria-label="Dismiss">
        ✕
      </button>
    </motion.div>
  );
}

export const screen = {
  initial: { opacity: 0, y: 10, filter: "blur(6px)" },
  animate: { opacity: 1, y: 0, filter: "blur(0px)", transition: { duration: 0.5, ease: [0.22, 1, 0.36, 1] } },
  exit: { opacity: 0, y: -8, filter: "blur(4px)", transition: { duration: 0.22 } },
} as const;
