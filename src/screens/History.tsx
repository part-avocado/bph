import { AnimatePresence, motion } from "motion/react";
import { useEffect, useState } from "react";
import { ArrowDownIcon, ArrowUpIcon, Button, EmptyState, EnterIcon, ErrorText, HintBar, Kbd, Link, Page, Skeleton } from "../components/ui";
import type { Api, ProjectSummary } from "../lib/api";
import { isTyping, useKeys } from "../lib/keys";
import { navigate } from "../lib/router";

function ago(t: number) {
  const s = (Date.now() - t) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

const STATUS: Record<ProjectSummary["status"], [string, string]> = {
  intake: ["bg-warn", "Answering"],
  building: ["bg-accent", "Building"],
  ready: ["bg-ok", "Ready"],
};

export function History({ api }: { api: Api }) {
  const [items, setItems] = useState<ProjectSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [focus, setFocus] = useState(0);
  const [confirming, setConfirming] = useState<string | null>(null);

  useEffect(() => {
    api
      .listProjects()
      .then((r) => setItems(r.projects))
      .catch((e) => setError((e as Error).message));
  }, [api]);

  async function remove(id: string) {
    const before = items;
    setItems((list) => list?.filter((p) => p.id !== id) ?? null);
    setFocus((f) => Math.max(0, Math.min(f, (items?.length ?? 1) - 2)));
    setConfirming(null);
    try {
      await api.deleteProject(id);
    } catch (e) {
      // Put it back: the delete didn't happen.
      setItems(before);
      setError((e as Error).message);
    }
  }

  useKeys((e) => {
    if (isTyping(e) || !items?.length) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setFocus((f) => Math.min(items.length - 1, f + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setFocus((f) => Math.max(0, f - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      // The list can shrink under the focus after a delete.
      const p = items[Math.min(focus, items.length - 1)];
      if (p) navigate(`/p/${p.id}`);
    } else if (e.key.toLowerCase() === "n") {
      e.preventDefault();
      navigate("/");
    }
  });

  return (
    <Page tint="lilac" title="History">
      <main className="relative z-10 mx-auto max-w-list px-4 pt-6 pb-28">
        <h1 className="text-title font-semibold tracking-display">Your tools</h1>
        <p className="mt-1 text-sm text-mute">Every prompt you've made. Open one to copy it or improve it again.</p>

        <AnimatePresence>
          {error && (
            <ErrorText className="mt-4 justify-start" onDismiss={() => setError(null)}>
              {error}
            </ErrorText>
          )}
        </AnimatePresence>

        <div className="card mt-6 overflow-hidden p-0" aria-busy={items === null}>
          {items === null ? (
            <div className="divide-y divide-line-2">
              {[0, 1, 2].map((i) => (
                <div key={i} className="px-4 py-4">
                  <Skeleton className="h-4 w-1/3" delay={i * 120} />
                  <Skeleton className="mt-2 h-3 w-2/3" delay={i * 120} />
                </div>
              ))}
            </div>
          ) : items.length === 0 ? (
            <EmptyState
              className="px-6 py-14"
              title="Nothing here yet"
              body="Describe your first tool and it will show up here."
              action={
                <Button size="sm" onClick={() => navigate("/")}>
                  Describe a tool
                </Button>
              }
            />
          ) : (
            <ul className="divide-y divide-line-2" aria-label="Your tools">
              <AnimatePresence initial={false}>
                {items.map((p, i) => (
                  <motion.li
                    key={p.id}
                    layout
                    initial={{ opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0, transition: { delay: i * 0.03 } }}
                    exit={{ opacity: 0, height: 0 }}
                    onMouseEnter={() => setFocus(i)}
                    className={`group relative flex items-center gap-3 px-4 py-3.5 transition-colors sm:gap-4 ${focus === i ? "bg-wash" : ""}`}
                  >
                    <Link to={`/p/${p.id}`} onFocus={() => setFocus(i)} className="absolute inset-0 focus-visible:-outline-offset-2" aria-label={`Open ${p.title}`} />
                    <div className="min-w-0 flex-1">
                      <div className="flex min-w-0 items-center gap-2">
                        <span className="truncate text-base font-medium">{p.title}</span>
                        <span className="flex shrink-0 items-center gap-1 text-2xs text-mute">
                          <span className={`size-1.5 rounded-full ${STATUS[p.status][0]}`} aria-hidden />
                          {STATUS[p.status][1]}
                        </span>
                      </div>
                      <p className="mt-0.5 truncate text-sm text-mute">{p.idea}</p>
                    </div>
                    {p.score != null && (
                      <span className="shrink-0 font-mono text-xs text-ink-2 tabular-nums" title="Score">
                        {p.score}
                      </span>
                    )}
                    <time dateTime={new Date(p.updated_at).toISOString()} className="hidden w-16 shrink-0 text-right text-xs text-faint sm:block">
                      {ago(p.updated_at)}
                    </time>
                    {confirming === p.id ? (
                      <span className="relative z-10 flex shrink-0 items-center gap-1">
                        <Button variant="danger" size="xs" onClick={() => remove(p.id)} autoFocus>
                          Delete
                        </Button>
                        <Button variant="ghost" size="xs" onClick={() => setConfirming(null)}>
                          Cancel
                        </Button>
                      </span>
                    ) : (
                      <button
                        onClick={() => setConfirming(p.id)}
                        className="relative z-10 shrink-0 rounded-md px-1.5 py-1 text-xs text-faint opacity-0 transition group-hover:opacity-100 group-focus-within:opacity-100 hover:text-bad focus-visible:opacity-100 pointer-coarse:opacity-100"
                        aria-label={`Delete ${p.title}`}
                      >
                        Delete
                      </button>
                    )}
                  </motion.li>
                ))}
              </AnimatePresence>
            </ul>
          )}
        </div>
      </main>
      <HintBar
        hints={[
          [
            <span key="a" className="flex gap-1">
              <Kbd><ArrowUpIcon /></Kbd>
              <Kbd><ArrowDownIcon /></Kbd>
            </span>,
            "move",
          ],
          [<Kbd key="e"><EnterIcon /></Kbd>, "open"],
          [<Kbd key="n">N</Kbd>, "new tool"],
        ]}
      />
    </Page>
  );
}
