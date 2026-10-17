import { useSyncExternalStore } from "react";

// A tiny history router: the app only has a handful of routes.

const listeners = new Set<() => void>();
const subscribe = (fn: () => void) => {
  listeners.add(fn);
  window.addEventListener("popstate", fn);
  return () => {
    listeners.delete(fn);
    window.removeEventListener("popstate", fn);
  };
};

export function navigate(to: string, { replace = false } = {}) {
  if (to === location.pathname) return;
  const go = () => {
    history[replace ? "replaceState" : "pushState"](null, "", to);
    listeners.forEach((fn) => fn());
  };
  go();
  window.scrollTo({ top: 0 });
}

export function usePath() {
  return useSyncExternalStore(subscribe, () => location.pathname);
}

export type Route = { name: "describe" } | { name: "history" } | { name: "project"; id: string };

export function matchRoute(path: string): Route {
  if (/^\/history\/?$/.test(path)) return { name: "history" };
  const m = path.match(/^\/p\/([a-z0-9]+)\/?$/);
  if (m) return { name: "project", id: m[1] };
  return { name: "describe" };
}
