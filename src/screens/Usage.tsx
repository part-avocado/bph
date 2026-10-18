import { AnimatePresence } from "motion/react";
import { useEffect, useState } from "react";
import type { Usage as UsageData, UsageLimit } from "../../shared/types";
import { ErrorText, Page, Skeleton } from "../components/ui";
import type { Api } from "../lib/api";

const LABELS: Record<UsageLimit["key"], [string, string]> = {
  planning: ["Planning steps", "Questions, paraphrases and re-plans"],
  skills: ["New skills", "Ideas you've started"],
  runs: ["Builds", "Prompt builds and improvements"],
  tokens: ["Model tokens", "Total spent across everything you do"],
};

const num = (n: number) => n.toLocaleString();

function when(t: number) {
  const mins = Math.max(1, Math.round((t - Date.now()) / 60000));
  const rel = mins < 60 ? `${mins}m` : mins < 60 * 48 ? `${Math.round(mins / 60)}h` : `${Math.round(mins / 1440)}d`;
  return `in ${rel}, ${new Date(t).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" })}`;
}

function Meter({ l }: { l: UsageLimit }) {
  const [title, hint] = LABELS[l.key];
  const pct = l.limit > 0 ? Math.min(100, (l.used / l.limit) * 100) : 100;
  const left = Math.max(0, l.limit - l.used);
  return (
    <li className="px-4 py-4">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-base font-medium">{title}</span>
        <span className="font-mono text-xs text-ink-2 tabular-nums">
          {num(l.used)} / {num(l.limit)}
        </span>
      </div>
      <div
        className="mt-2 h-1.5 overflow-hidden rounded-full bg-line-2"
        role="progressbar"
        aria-label={title}
        aria-valuemin={0}
        aria-valuemax={l.limit}
        aria-valuenow={Math.min(l.used, l.limit)}
      >
        <div className={`h-full rounded-full transition-[width] duration-500 ${pct >= 100 ? "bg-bad" : pct >= 80 ? "bg-warn" : "bg-ok"}`} style={{ width: `${pct}%` }} />
      </div>
      <p className="mt-2 text-sm text-mute">
        {num(left)} left · {hint}
      </p>
      <p className="mt-0.5 text-xs text-faint">
        {l.resetsAt ? `Frees up ${when(l.resetsAt)}` : "Nothing used"} · rolling {l.windowHours === 168 ? "7 days" : `${l.windowHours} hours`}
      </p>
    </li>
  );
}

export function Usage({ api }: { api: Api }) {
  const [data, setData] = useState<UsageData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .getUsage()
      .then(setData)
      .catch((e) => setError((e as Error).message));
  }, [api]);

  return (
    <Page tint="sky" title="Usage">
      <main className="relative z-10 mx-auto max-w-list px-4 pt-6 pb-28">
        <h1 className="text-title font-semibold tracking-display">Usage</h1>
        <p className="mt-1 text-sm text-mute">
          What you've used and what's left. Limits roll rather than reset all at once: each use frees up a day (or a week, for tokens) after it happened.
        </p>

        <AnimatePresence>
          {error && (
            <ErrorText className="mt-4 justify-start" onDismiss={() => setError(null)}>
              {error}
            </ErrorText>
          )}
        </AnimatePresence>

        <div className="card mt-6 overflow-hidden p-0" aria-busy={data === null}>
          {data === null ? (
            <div className="divide-y divide-line-2">
              {[0, 1, 2, 3].map((i) => (
                <div key={i} className="px-4 py-4">
                  <Skeleton className="h-4 w-1/3" delay={i * 120} />
                  <Skeleton className="mt-3 h-1.5 w-full" delay={i * 120} />
                </div>
              ))}
            </div>
          ) : (
            <ul className="divide-y divide-line-2" aria-label="Usage limits">
              {data.limits.map((l) => (
                <Meter key={l.key} l={l} />
              ))}
            </ul>
          )}
        </div>
        {data && (
          <p className="mt-4 text-sm text-mute">
            Need more? Email <a className="underline" href={`mailto:${data.contactEmail}`}>{data.contactEmail}</a> to raise your limit.
          </p>
        )}
      </main>
    </Page>
  );
}
