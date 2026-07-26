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

/** Exports every "os.*" key as a single JSON blob — used by Settings later. */
export function exportAllData(): string {
  const data: Record<string, unknown> = {};
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key && key.startsWith(`${NAMESPACE}.`)) {
      data[key] = JSON.parse(localStorage.getItem(key) ?? "null");
    }
  }
  return JSON.stringify(data, null, 2);
}

/** Imports a JSON blob produced by exportAllData(). */
export function importAllData(json: string): void {
  const data = JSON.parse(json) as Record<string, unknown>;
  Object.entries(data).forEach(([key, value]) => {
    if (key.startsWith(`${NAMESPACE}.`)) {
      localStorage.setItem(key, JSON.stringify(value));
    }
  });
}

export function resetAllData(): void {
  Object.keys(localStorage)
    .filter((k) => k.startsWith(`${NAMESPACE}.`))
    .forEach((k) => localStorage.removeItem(k));
}
