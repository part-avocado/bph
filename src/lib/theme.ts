import { useCallback, useEffect, useState } from "react";

export type Theme = "light" | "dark";

const KEY = "offshoot:theme";
const DARK_QUERY = "(prefers-color-scheme: dark)";

function stored(): Theme | null {
  try {
    const v = localStorage.getItem(KEY);
    return v === "light" || v === "dark" ? v : null;
  } catch {
    return null;
  }
}

function apply(theme: Theme) {
  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", theme === "dark" ? "#0e0e11" : "#f7f7f8");
}

/** The theme in effect: an explicit choice if the user made one, otherwise the system's. */
export function useTheme() {
  const [theme, setTheme] = useState<Theme>(() => (document.documentElement.dataset.theme === "dark" ? "dark" : "light"));

  // Follow the system until the user picks a side.
  useEffect(() => {
    const mq = window.matchMedia(DARK_QUERY);
    const onChange = () => {
      if (stored()) return;
      const next: Theme = mq.matches ? "dark" : "light";
      apply(next);
      setTheme(next);
    };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  const toggle = useCallback(() => {
    const next: Theme = theme === "dark" ? "light" : "dark";
    try {
      localStorage.setItem(KEY, next);
    } catch {
      /* private mode: the choice just won't persist */
    }
    apply(next);
    setTheme(next);
  }, [theme]);

  return { theme, toggle };
}
