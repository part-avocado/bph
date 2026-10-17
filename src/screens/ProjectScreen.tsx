import { AnimatePresence, motion } from "motion/react";
import { useCallback, useEffect, useState } from "react";
import type { ProjectDetail } from "../../shared/types";
import { Header, Mesh, Spinner, screen } from "../components/ui";
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
      <div className="relative min-h-full">
        <Mesh />
        <Header />
        <div className="relative z-10 mx-auto max-w-sm pt-[20vh] text-center">
          <p className="text-[15px] font-medium">We couldn't open this tool.</p>
          <p className="mt-1 text-[12.5px] text-mute">{error}</p>
          <button onClick={() => navigate("/history")} className="mt-5 rounded-lg bg-ink px-3.5 py-2 text-[12.5px] text-white">
            Back to history
          </button>
        </div>
      </div>
    );
  }

  const status = detail?.project.status;
  const view = !detail ? "loading" : runId ? "building" : status === "ready" ? "ready" : "intake";

  return (
    <AnimatePresence mode="wait">
      <motion.div key={view} {...screen} className="min-h-full">
        {view === "loading" && (
          <div className="relative min-h-full">
            <Mesh />
            <Header />
            <div className="relative z-10 flex justify-center pt-[30vh] text-mute">
              <Spinner />
            </div>
          </div>
        )}
        {view === "intake" && <Intake api={api} project={detail!.project} onBuild={startRun} />}
        {view === "building" && <Construction api={api} project={detail!.project} runId={runId!} onDone={load} />}
        {view === "ready" && <Ready api={api} detail={detail!} onImprove={startRun} />}
      </motion.div>
    </AnimatePresence>
  );
}
