import { RedirectToSignIn, Show, useAuth } from "@clerk/react";
import { AnimatePresence, MotionConfig, motion } from "motion/react";
import { Suspense, lazy, useEffect } from "react";
import { useApi } from "./lib/api";
import { matchRoute, usePath } from "./lib/router";
import { Describe } from "./screens/Describe";
import { screen } from "./components/ui";

// Describe is the landing page and ships in the main bundle. The signed-in
// screens load on demand, and are prefetched once the first paint is done.
const loadHistory = () => import("./screens/History");
const loadUsage = () => import("./screens/Usage");
const loadProject = () => import("./screens/ProjectScreen");
const History = lazy(() => loadHistory().then((m) => ({ default: m.History })));
const Usage = lazy(() => loadUsage().then((m) => ({ default: m.Usage })));
const ProjectScreen = lazy(() => loadProject().then((m) => ({ default: m.ProjectScreen })));

function usePrefetchScreens() {
  useEffect(() => {
    const prefetch = () => void Promise.all([loadProject(), loadHistory()]).catch(() => {});
    if ("requestIdleCallback" in window) {
      const id = requestIdleCallback(prefetch, { timeout: 3000 });
      return () => cancelIdleCallback(id);
    }
    const t = setTimeout(prefetch, 1500);
    return () => clearTimeout(t);
  }, []);
}

export function App() {
  const path = usePath();
  const route = matchRoute(path);
  const api = useApi();
  const { isLoaded } = useAuth();
  usePrefetchScreens();

  return (
    <MotionConfig reducedMotion="user">
      <AnimatePresence mode="wait">
        <motion.div key={route.name === "project" ? `p-${route.id}` : route.name} {...screen} className="min-h-full">
          {route.name === "describe" && <Describe />}
          {route.name !== "describe" && isLoaded && (
            <>
              <Show when="signed-in">
                <Suspense fallback={null}>
                  {route.name === "history" && <History api={api} />}
                  {route.name === "usage" && <Usage api={api} />}
                  {route.name === "project" && <ProjectScreen api={api} id={route.id} />}
                </Suspense>
              </Show>
              <Show when="signed-out">
                <RedirectToSignIn />
              </Show>
            </>
          )}
        </motion.div>
      </AnimatePresence>
    </MotionConfig>
  );
}
