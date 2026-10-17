import { Show, SignInButton, UserButton } from "@clerk/react";
import { motion, useReducedMotion, type HTMLMotionProps } from "motion/react";
import type { AnchorHTMLAttributes, HTMLAttributes, MouseEvent, ReactNode } from "react";
import { navigate } from "../lib/router";

/** The one easing curve every entrance uses. Mirrors --ease-out-soft in styles.css. */
export const EASE = [0.22, 1, 0.36, 1] as const;

export function Kbd({ children, dark = false }: { children: ReactNode; dark?: boolean }) {
  return <kbd className={`kbd ${dark ? "kbd-dark" : ""}`}>{children}</kbd>;
}

export const EnterIcon = () => (
  <svg width="9" height="9" viewBox="0 0 12 12" fill="none" aria-hidden>
    <path d="M10 2v4.5a1.5 1.5 0 0 1-1.5 1.5H2.5M2.5 8 5 5.5M2.5 8 5 10.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const keyIcon = (d: string, strokeWidth = 1.3) => (
  <svg width="9" height="9" viewBox="0 0 12 12" fill="none" aria-hidden>
    <path d={d} stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

export const ShiftIcon = () => keyIcon("M6 1.5 10.5 6.5H8v3.5H4V6.5H1.5z", 1.2);
export const CmdIcon = () =>
  keyIcon("M4.5 4.5h3v3h-3zM4.5 4.5V3A1.5 1.5 0 1 0 3 4.5h1.5M7.5 4.5V3A1.5 1.5 0 1 1 9 4.5H7.5M4.5 7.5V9A1.5 1.5 0 1 1 3 7.5h1.5M7.5 7.5V9A1.5 1.5 0 1 0 9 7.5H7.5", 1);
export const ArrowUpIcon = () => keyIcon("M6 10V2.5M3 5.5 6 2.5l3 3");
export const ArrowLeftIcon = () => keyIcon("M10 6H2.5M5.5 3 2.5 6l3 3");
/** The space bar: an open-top bracket. */
export const SpaceIcon = () => (
  <svg width="14" height="9" viewBox="0 0 14 9" fill="none" aria-hidden>
    <path d="M1.5 2.5v3a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1v-3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);
export const ArrowDownIcon = () => keyIcon("M6 2v7.5M3 6.5 6 9.5l3-3");

/** Inline separator between short pieces of text: an asterisk drawn around its own centre, so it sits mid-line instead of up high like the "*" glyph. */
export const Sep = () => (
  <svg width="8" height="8" viewBox="0 0 8 8" fill="none" className="mx-1.5 inline-block align-middle" aria-hidden>
    <path d="M4 .8v6.4M1.2 2.4l5.6 3.2M1.2 5.6l5.6-3.2" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
  </svg>
);

export const CheckIcon = ({ size = 13, ring = false, className = "" }: { size?: number; ring?: boolean; className?: string }) =>
  ring ? (
    <svg width={size} height={size} viewBox="0 0 12 12" fill="none" className={className} aria-hidden>
      <circle cx="6" cy="6" r="5" stroke="currentColor" strokeWidth="1.2" />
      <path d="M3.8 6.2 5.3 7.6 8.2 4.6" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ) : (
    <svg width={size} height={size} viewBox="0 0 12 12" fill="none" className={className} aria-hidden>
      <path d="M2.5 6.5 5 9l4.5-6" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );

// ---------- background ----------

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

/** Mesh, header and content: the frame every screen sits in. */
export function Page({
  tint,
  grid,
  title,
  headerRight,
  children,
  className = "",
  ...rest
}: { tint?: Tint; grid?: boolean; title?: string; headerRight?: ReactNode } & HTMLAttributes<HTMLDivElement>) {
  return (
    <div className={`relative min-h-full ${className}`} {...rest}>
      <Mesh tint={tint} grid={grid} />
      <Header title={title} right={headerRight} />
      {children}
    </div>
  );
}

// ---------- navigation ----------

/** A real link (so it can be opened in a new tab) that routes in-app on a plain click. */
export function Link({ to, onClick, ...rest }: { to: string } & AnchorHTMLAttributes<HTMLAnchorElement>) {
  return (
    <a
      href={to}
      onClick={(e: MouseEvent<HTMLAnchorElement>) => {
        onClick?.(e);
        if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        navigate(to);
      }}
      {...rest}
    />
  );
}

export function Header({ title, right }: { title?: string; right?: ReactNode }) {
  return (
    <header className="relative z-10 flex h-16 items-center justify-between gap-3 px-4 sm:px-7">
      <Link
        to="/"
        className="group flex min-w-0 items-center gap-2.5 rounded-lg py-1 pr-2 text-base font-semibold tracking-snug"
        aria-label={title ? `Offshoot home, ${title}` : "Offshoot home"}
      >
        <span className="size-3.75 shrink-0 rounded-full bg-ink transition-transform duration-300 group-hover:scale-110" />
        <motion.span
          key={title ?? "Offshoot"}
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.35, ease: EASE }}
          className="truncate whitespace-nowrap"
        >
          {title ?? "Offshoot"}
        </motion.span>
      </Link>
      <nav aria-label="Main" className="flex shrink-0 items-center gap-1 whitespace-nowrap sm:gap-2">
        {right}
        <Show when="signed-in">
          <Link to="/history" className="rounded-full px-2.5 py-1.5 text-xs text-mute transition-colors hover:text-ink">
            History
          </Link>
          <Link to="/" className={`${chip} hidden px-3.5 py-1.5 font-medium text-ink hover:bg-paper sm:block`}>
            New
          </Link>
          <div className="ml-1 flex size-7 items-center justify-center">
            <UserButton />
          </div>
        </Show>
        <Show when="signed-out">
          <SignInButton mode="modal">
            <button className={`${chip} px-3.5 py-1.5 font-medium text-ink hover:bg-paper`}>Sign in</button>
          </SignInButton>
        </Show>
      </nav>
    </header>
  );
}

export function HintBar({ hints }: { hints: [ReactNode, string][] }) {
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-5 z-10 hidden justify-center sm:flex" aria-hidden>
      <div className="flex items-center gap-4 rounded-full bg-paper/70 px-4 py-2 text-xs text-mute shadow-outline backdrop-blur-md">
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

// ---------- controls ----------

/** Frosted pill used for badges, header actions and suggestion chips. */
export const chip = "rounded-full bg-paper/80 text-xs text-ink-2 ring-1 ring-black/5 backdrop-blur transition";

const VARIANTS = {
  primary: "bg-ink text-white shadow-press hover:bg-ink/90",
  accent: "bg-accent text-white shadow-accent hover:bg-accent-2",
  secondary: "bg-paper/90 text-ink ring-1 ring-black/5 shadow-xs hover:bg-paper",
  outline: "border border-line bg-paper text-ink hover:bg-wash",
  danger: "bg-bad text-white hover:bg-bad/90",
  ghost: "text-mute hover:text-ink",
} as const;

const SIZES = {
  xs: "h-7 rounded-lg px-2 text-xs",
  sm: "h-8 rounded-lg px-3 text-sm",
  md: "h-9 rounded-control px-3.5 text-base",
  lg: "h-10 rounded-control px-4 text-base",
  xl: "h-11 rounded-xl px-4 text-base",
} as const;

/** Trailing padding is tighter when the button ends in a key hint. */
const KBD_PAD = { xs: "pr-1", sm: "pr-1.5", md: "pr-2", lg: "pr-2.5", xl: "pr-2.5" } as const;

export type ButtonProps = {
  variant?: keyof typeof VARIANTS;
  size?: keyof typeof SIZES;
  /** Key hint shown at the end, e.g. "I" or <EnterIcon />. */
  kbd?: ReactNode;
  loading?: boolean;
  children?: ReactNode;
} & Omit<HTMLMotionProps<"button">, "children">;

export function Button({ variant = "primary", size = "md", kbd, loading = false, className = "", children, type = "button", disabled, ...rest }: ButtonProps) {
  const dark = variant === "primary" || variant === "accent" || variant === "danger";
  return (
    <motion.button
      type={type}
      whileTap={disabled ? undefined : { scale: 0.97 }}
      disabled={disabled}
      aria-busy={loading || undefined}
      className={`inline-flex shrink-0 items-center justify-center gap-2 font-medium whitespace-nowrap transition-[background-color,box-shadow,color,opacity] duration-150 select-none disabled:cursor-not-allowed disabled:opacity-50 ${VARIANTS[variant]} ${SIZES[size]} ${kbd ? KBD_PAD[size] : ""} ${className}`}
      {...rest}
    >
      {loading && <Spinner />}
      {children}
      {kbd != null && <Kbd dark={dark}>{kbd}</Kbd>}
    </motion.button>
  );
}

export function Spinner({ className = "", label }: { className?: string; label?: string }) {
  return (
    <svg
      className={`shrink-0 animate-spin ${className}`}
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      role={label ? "status" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.2" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

// ---------- states ----------

/**
 * Full-width waiting state between steps: a slow orbiting mark, what is happening,
 * and faint placeholder rows so the next screen doesn't make the layout jump.
 */
export function Thinking({ title, detail, rows = 3 }: { title: string; detail?: ReactNode; rows?: number }) {
  const reduce = useReducedMotion();
  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0, transition: { duration: 0.4, ease: EASE } }}
      exit={{ opacity: 0, transition: { duration: 0.15 } }}
      className="text-center"
      role="status"
      aria-live="polite"
    >
      <svg width="52" height="52" viewBox="0 0 52 52" fill="none" className="mx-auto" aria-hidden>
        <circle cx="26" cy="26" r="21" stroke="currentColor" strokeOpacity="0.1" strokeWidth="2" />
        <motion.g
          style={{ originX: "26px", originY: "26px" }}
          animate={reduce ? undefined : { rotate: 360 }}
          transition={{ duration: 2.4, ease: "linear", repeat: Infinity }}
        >
          <path d="M26 5a21 21 0 0 1 21 21" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
          <circle cx="26" cy="5" r="2.6" fill="currentColor" />
        </motion.g>
        <motion.circle
          cx="26"
          cy="26"
          r="4"
          fill="currentColor"
          animate={reduce ? undefined : { scale: [1, 1.5, 1], opacity: [0.9, 0.35, 0.9] }}
          style={{ originX: "26px", originY: "26px" }}
          transition={{ duration: 1.8, ease: "easeInOut", repeat: Infinity }}
        />
      </svg>
      <p className="mt-5 text-title font-semibold tracking-title text-balance">{title}</p>
      {detail && <p className="mx-auto mt-2 max-w-sm text-sm text-pretty text-mute">{detail}</p>}
      {rows > 0 && (
        <div className="mx-auto mt-9 w-full max-w-narrow space-y-2 opacity-70" aria-hidden>
          {Array.from({ length: rows }, (_, i) => (
            <Skeleton key={i} className="h-11.5 w-full rounded-xl" delay={i * 140} />
          ))}
        </div>
      )}
    </motion.div>
  );
}

export function Skeleton({ className = "", delay = 0 }: { className?: string; delay?: number }) {
  return <div className={`shimmer ${className}`} style={delay ? { animationDelay: `${delay}ms` } : undefined} aria-hidden />;
}

/** Centered message for empty and error screens, with an optional action below. */
export function EmptyState({ title, body, action, className = "" }: { title: string; body?: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.45, ease: EASE }}
      className={`text-center ${className}`}
    >
      <p className="text-md font-medium tracking-snug">{title}</p>
      {body && <p className="mx-auto mt-1 max-w-sm text-sm text-pretty text-mute">{body}</p>}
      {action && <div className="mt-5 flex justify-center">{action}</div>}
    </motion.div>
  );
}

/** Inline error line. Pass onDismiss to let the user clear it. */
export function ErrorText({ children, onDismiss, className = "" }: { children: ReactNode; onDismiss?: () => void; className?: string }) {
  return (
    <motion.p
      role="alert"
      initial={{ opacity: 0, y: -4 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0 }}
      className={`flex items-start justify-center gap-2 text-sm text-bad ${className}`}
    >
      <span className="text-pretty">{children}</span>
      {onDismiss && (
        <button onClick={onDismiss} className="shrink-0 rounded px-1 text-bad/60 transition-colors hover:text-bad" aria-label="Dismiss error">
          ✕
        </button>
      )}
    </motion.p>
  );
}

export function Toast({ message, onClose }: { message: string; onClose: () => void }) {
  return (
    <motion.div
      role="alert"
      initial={{ opacity: 0, y: 12, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 8 }}
      className="fixed inset-x-0 bottom-16 z-50 mx-auto flex w-fit max-w-[90vw] items-center gap-3 rounded-xl bg-ink px-4 py-2.5 text-base text-white shadow-xl"
    >
      <span>{message}</span>
      <button onClick={onClose} className="text-white/60 hover:text-white" aria-label="Dismiss">
        ✕
      </button>
    </motion.div>
  );
}

// ---------- motion presets ----------

export const screen = {
  initial: { opacity: 0, y: 10, filter: "blur(6px)" },
  animate: { opacity: 1, y: 0, filter: "blur(0px)", transition: { duration: 0.5, ease: EASE } },
  exit: { opacity: 0, y: -8, filter: "blur(4px)", transition: { duration: 0.22 } },
} as const;

/** Entrance for a block that rises into place. */
export const rise = (delay = 0, y = 16) => ({
  initial: { opacity: 0, y },
  animate: { opacity: 1, y: 0 },
  transition: { delay, duration: 0.6, ease: EASE },
});
