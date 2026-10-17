import { AnimatePresence, motion } from "motion/react";
import { useCallback, useEffect, useState } from "react";
import type { ProjectDetail } from "../../shared/types";
import { Button, EmptyState, Page, Skeleton, screen } from "../components/ui";
import type { Api } from "../lib/api";
import { navigate } from "../lib/router";
import { Construction } from "./Construction";
import { Intake } from "./Intake";
import { Ready } from "./Ready";

/** Loads a project and shows the screen that matches where it is. */
export function ProjectScreen({ api, id }: { api: Api; id: string }) {
  const [detail, setDetail] = useState<ProjectDetail | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const d = await api.getProject(id);
      setDetail(d);
      setRunId(d.project.status === "building" ? d.project.activeRunId : null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [api, id]);

  useEffect(() => {
    setDetail(null);
    void load();
  }, [load]);

  const startRun = useCallback((rid: string) => {
    setRunId(rid);
    setDetail((d) => (d ? { ...d, project: { ...d.project, status: "building", activeRunId: rid } } : d));
  }, []);

  if (error) {
    return (
      <Page>
        <main className="relative z-10 mx-auto max-w-sm px-4 pt-[20vh]">
          <EmptyState
            title="We couldn't open this skill."
            body={error}
            action={
              <Button size="sm" onClick={() => navigate("/history")}>
                Back to history
              </Button>
            }
          />
        </main>
      </Page>
    );
  }

  const status = detail?.project.status;
  const view = !detail ? "loading" : runId ? "building" : status === "ready" ? "ready" : "intake";

  return (
    <AnimatePresence mode="wait">
      <motion.div key={view} {...screen} className="min-h-full">
        {view === "loading" && (
          <Page>
            <main className="relative z-10 mx-auto max-w-narrow px-4 pt-[18vh]" aria-busy="true" aria-label="Loading skill">
              <Skeleton className="mx-auto h-9 w-4/5" />
              <Skeleton className="mx-auto mt-3 h-3.5 w-1/2" delay={80} />
              <div className="mt-8 space-y-2">
                {[0, 1, 2].map((i) => (
                  <Skeleton key={i} className="h-11.5 w-full rounded-xl" delay={160 + i * 120} />
                ))}
              </div>
            </main>
          </Page>
        )}
        {view === "intake" && <Intake api={api} project={detail!.project} onBuild={startRun} />}
        {view === "building" && <Construction api={api} project={detail!.project} runId={runId!} onDone={load} />}
        {view === "ready" && <Ready api={api} detail={detail!} onImprove={startRun} />}
      </motion.div>
    </AnimatePresence>
  );
}
