import { useEffect, useRef } from "react";

export const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

export function isTyping(e: KeyboardEvent) {
  const t = e.target as HTMLElement | null;
  return !!t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
}

/** Plain Enter/Space on a focused button, link or select belongs to that control, not to screen shortcuts. */
function activatesFocused(e: KeyboardEvent) {
  if (e.key !== "Enter" && e.key !== " ") return false;
  if (e.metaKey || e.ctrlKey || e.altKey) return false;
  const t = e.target as HTMLElement | null;
  // Choice lists (Intake's options) are driven by the screen's own keys.
  if (!t?.closest || t.closest("[role=radio], [role=option]")) return false;
  return !!t.closest("button, a[href], select, summary, [role=button]");
}

/**
 * Global keydown handler. The latest handler is always used, so callers can
 * close over fresh state; handlers call preventDefault on keys they claim.
 */
export function useKeys(handler: (e: KeyboardEvent) => void, enabled = true) {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (!e.defaultPrevented && !e.isComposing && !activatesFocused(e)) ref.current(e);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enabled]);
}
