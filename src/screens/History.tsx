import { AnimatePresence, motion } from "motion/react";
import { useEffect, useState } from "react";
import { Header, HintBar, Kbd, Mesh } from "../components/ui";
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
  intake: ["bg-amber-500", "Answering"],
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
    setItems((list) => list?.filter((p) => p.id !== id) ?? null);
    setConfirming(null);
    try {
      await api.deleteProject(id);
    } catch (e) {
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
      navigate(`/p/${items[focus].id}`);
    } else if (e.key.toLowerCase() === "n") {
      e.preventDefault();
      navigate("/");
    }
  });

  return (
    <div className="relative min-h-full">
      <Mesh tint="lilac" />
      <Header title="History" />
      <main className="relative z-10 mx-auto max-w-[720px] px-4 pt-6 pb-28">
        <h1 className="text-[30px] font-semibold tracking-[-0.04em]">Your tools</h1>
        <p className="mt-1 text-[12.5px] text-mute">Every prompt you've made. Open one to copy it or improve it again.</p>

        {error && <p className="mt-4 text-[12.5px] text-bad">{error}</p>}

        <div className="card mt-6 overflow-hidden p-0">
          {items === null ? (
            <div className="space-y-px">
              {[0, 1, 2].map((i) => (
                <div key={i} className="px-4 py-4">
                  <div className="shimmer h-4 w-1/3" />
                  <div className="shimmer mt-2 h-3 w-2/3" />
                </div>
              ))}
            </div>
          ) : items.length === 0 ? (
            <div className="px-6 py-14 text-center">
              <p className="text-[14px] font-medium">Nothing here yet</p>
              <p className="mt-1 text-[12.5px] text-mute">Describe your first tool and it will show up here.</p>
              <button onClick={() => navigate("/")} className="mt-5 rounded-lg bg-ink px-3.5 py-2 text-[12.5px] text-white">
                Describe a tool
              </button>
            </div>
          ) : (
            <ul className="divide-y divide-line-2">
              <AnimatePresence initial={false}>
                {items.map((p, i) => (
                  <motion.li
                    key={p.id}
                    layout
                    initial={{ opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0, transition: { delay: i * 0.03 } }}
                    exit={{ opacity: 0, height: 0 }}
                    onMouseEnter={() => setFocus(i)}
                    className={`group relative flex items-center gap-4 px-4 py-3.5 transition-colors ${focus === i ? "bg-wash" : ""}`}
                  >
                    <button onClick={() => navigate(`/p/${p.id}`)} className="absolute inset-0" aria-label={`Open ${p.title}`} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-[13.5px] font-medium">{p.title}</span>
                        <span className="flex items-center gap-1 text-[10.5px] text-mute">
                          <span className={`size-1.5 rounded-full ${STATUS[p.status][0]}`} />
                          {STATUS[p.status][1]}
                        </span>
                      </div>
                      <p className="mt-0.5 truncate text-[12px] text-mute">{p.idea}</p>
                    </div>
                    {p.score != null && <span className="font-mono text-[11px] text-ink-2 tabular-nums">{p.score}</span>}
                    <span className="w-16 text-right text-[11px] text-faint">{ago(p.updated_at)}</span>
                    {confirming === p.id ? (
                      <span className="relative z-10 flex items-center gap-1">
                        <button onClick={() => remove(p.id)} className="rounded-md bg-bad px-2 py-1 text-[11px] text-white">
                          Delete
                        </button>
                        <button onClick={() => setConfirming(null)} className="rounded-md px-2 py-1 text-[11px] text-mute hover:text-ink">
                          Cancel
                        </button>
                      </span>
                    ) : (
                      <button
                        onClick={() => setConfirming(p.id)}
                        className="relative z-10 rounded-md px-1.5 py-1 text-[11px] text-faint opacity-0 transition group-hover:opacity-100 hover:text-bad focus:opacity-100"
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
              <Kbd>↑</Kbd>
              <Kbd>↓</Kbd>
            </span>,
            "move",
          ],
          [<Kbd key="e">↵</Kbd>, "open"],
          [<Kbd key="n">N</Kbd>, "new tool"],
        ]}
      />
    </div>
  );
}
