import { RedirectToSignIn, Show, useAuth } from "@clerk/react";
import { AnimatePresence, MotionConfig, motion } from "motion/react";
import { useApi } from "./lib/api";
import { matchRoute, usePath } from "./lib/router";
import { Describe } from "./screens/Describe";
import { History } from "./screens/History";
import { ProjectScreen } from "./screens/ProjectScreen";
import { screen } from "./components/ui";

export function App() {
  const path = usePath();
  const route = matchRoute(path);
  const api = useApi();
  const { isLoaded } = useAuth();

  return (
    <MotionConfig reducedMotion="user">
      <AnimatePresence mode="wait">
        <motion.div key={route.name === "project" ? `p-${route.id}` : route.name} {...screen} className="min-h-full">
          {route.name === "describe" && <Describe />}
          {route.name !== "describe" && isLoaded && (
            <>
              <Show when="signed-in">
                {route.name === "history" && <History api={api} />}
                {route.name === "project" && <ProjectScreen api={api} id={route.id} />}
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
