// sessionStorage throws when the browser blocks site data, so every access is guarded.
// Callers treat it as a convenience: without storage they just lose the remembered value.

export function getSession(key: string): string | null {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

export function setSession(key: string, value: string) {
  try {
    sessionStorage.setItem(key, value);
  } catch {
    /* blocked or full: the value just won't persist */
  }
}

export function removeSession(key: string) {
  try {
    sessionStorage.removeItem(key);
  } catch {
    /* blocked: nothing to remove */
  }
}
