// Thin, typed wrapper around window.localStorage.
// Every module namespaces its key (e.g. "os.dashboard", "os.projects") so
// Settings > Export/Import JSON can later serialize the whole "os.*" namespace.

const NAMESPACE = "os";

export function storageKey(key: string): string {
  return `${NAMESPACE}.${key}`;
}

export function readStorage<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(storageKey(key));
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function writeStorage<T>(key: string, value: T): void {
  try {
    localStorage.setItem(storageKey(key), JSON.stringify(value));
  } catch {
    // Storage can fail (quota, private mode). Fail silently; data stays in memory.
  }
}

/**
 * Drop one key from the offline mirror.
 *
 * This is not housekeeping — it is required for reset to work. `getSnapshot`
 * falls back to the mirror whenever the server doesn't have a key, so deleting
 * a slice on the server and leaving the mirror alone makes the "deleted" data
 * reappear on the next read. Server delete and mirror delete are one operation.
 */
export function removeStorage(key: string): void {
  try {
    localStorage.removeItem(storageKey(key));
  } catch {
    /* nothing to do — the mirror is best-effort */
  }
}

/** Drop the whole mirror. Same reasoning as removeStorage, for a full reset. */
export function clearMirror(): void {
  try {
    Object.keys(localStorage)
      .filter((k) => k.startsWith(`${NAMESPACE}.`))
      .forEach((k) => localStorage.removeItem(k));
  } catch {
    /* best-effort */
  }
}

// The old exportAllData / importAllData / resetAllData lived here and read the
// mirror. Since v5 the mirror is a read-through cache, not the store — an
// export taken from it would silently miss anything this browser had never
// loaded. Settings exports from the server instead (GET /api/state).
