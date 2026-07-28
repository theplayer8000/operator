// Shared client-side store backed by the Operator storage server.
//
// One module-level snapshot for the whole app, not one copy per hook call.
// That is deliberate: the old useLocalStorage gave every call site its own
// useState, so two components reading the same key diverged and clobbered
// each other (OPS-004) — and a mutator followed by navigate() lost the write
// entirely (OPS-016). A single shared cache with subscribers removes both.
//
// localStorage is kept as a read-through mirror so a cold start with the
// server down still shows the last known data instead of an empty app.

import { clearMirror, readStorage, removeStorage, writeStorage } from "./storage";

export type StoreStatus = "loading" | "online" | "offline";

type Listener = () => void;

const API = "/api/state";

const cache = new Map<string, unknown>();
/**
 * Keys the server has actually stored. Distinct from `cache`, which also holds
 * mirror/seed fallbacks the moment anything reads a key — so cache membership
 * cannot answer "does the server know about this yet".
 */
const serverKeys = new Set<string>();
const listeners = new Map<string, Set<Listener>>();
const statusListeners = new Set<Listener>();

/** Writes the server hasn't accepted yet. Flushed on the next success. */
const pending = new Map<string, unknown>();

let status: StoreStatus = "loading";
let loadPromise: Promise<void> | null = null;

// --- notification ---------------------------------------------------------

function notify(key: string) {
  listeners.get(key)?.forEach((fn) => fn());
}

function setStatus(next: StoreStatus) {
  if (status === next) return;
  status = next;
  statusListeners.forEach((fn) => fn());
}

// --- loading --------------------------------------------------------------

async function fetchState(): Promise<Record<string, unknown>> {
  const res = await fetch(API, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`GET ${API} → ${res.status}`);
  const body = (await res.json()) as { state?: Record<string, unknown> };
  return body.state ?? {};
}

/**
 * One-time lift of any data still sitting in localStorage from before the
 * server existed. Only runs when the server has nothing at all, so it can
 * never overwrite real server data.
 */
async function migrateLocalStorage(): Promise<Record<string, unknown> | null> {
  const local: Record<string, unknown> = {};
  for (let i = 0; i < localStorage.length; i++) {
    const full = localStorage.key(i);
    if (!full?.startsWith("os.")) continue;
    try {
      local[full.slice(3)] = JSON.parse(localStorage.getItem(full) ?? "null");
    } catch {
      /* skip unparseable */
    }
  }
  if (Object.keys(local).length === 0) return null;

  const res = await fetch(API, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(local),
  });
  if (!res.ok) throw new Error(`migrate → ${res.status}`);
  console.info(`[operator] migrated ${Object.keys(local).length} keys from localStorage`);
  return local;
}

export function load(): Promise<void> {
  if (loadPromise) return loadPromise;

  loadPromise = (async () => {
    try {
      let state = await fetchState();

      if (Object.keys(state).length === 0) {
        const migrated = await migrateLocalStorage();
        if (migrated) state = migrated;
      }

      const touched = new Set([...cache.keys(), ...Object.keys(state)]);
      cache.clear();
      serverKeys.clear();
      Object.entries(state).forEach(([k, v]) => {
        cache.set(k, v);
        serverKeys.add(k);
      });
      setStatus("online");
      await flushPending();
      touched.forEach(notify);
    } catch (err) {
      console.warn("[operator] storage server unreachable, using local mirror:", err);
      setStatus("offline");
    }
  })();

  return loadPromise;
}

/** Retry after the server was unreachable. Safe to call repeatedly. */
export function retry(): Promise<void> {
  loadPromise = null;
  setStatus("loading");
  return load();
}

// --- writing --------------------------------------------------------------

async function flushPending() {
  if (pending.size === 0) return;
  const batch = Object.fromEntries(pending);
  try {
    const res = await fetch(API, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(batch),
    });
    if (!res.ok) throw new Error(`flush → ${res.status}`);
    pending.clear();
  } catch {
    // Stay pending; the next successful write or retry() will try again.
  }
}

async function push(key: string, value: unknown) {
  try {
    const res = await fetch(`${API}/${encodeURIComponent(key)}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value }),
    });
    if (!res.ok) throw new Error(`PUT ${key} → ${res.status}`);
    pending.delete(key);
    setStatus("online");
    await flushPending();
  } catch (err) {
    console.warn(`[operator] write queued, server unreachable:`, err);
    pending.set(key, value);
    setStatus("offline");
  }
}

// --- public api -----------------------------------------------------------

export function getSnapshot<T>(key: string, fallback: T): T {
  if (cache.has(key)) return cache.get(key) as T;

  // Not loaded yet (or the server has never seen this key) — fall back to the
  // local mirror, then to the feature's seed.
  const mirrored = readStorage<T>(key, fallback);
  cache.set(key, mirrored);
  return mirrored;
}

/**
 * True when the server holds this key, or we have already handed it a write
 * for one — as opposed to a mirror or seed having merely been read into the
 * cache. Only meaningful once load() has resolved.
 *
 * Homelab is the one feature that needs this: the server probes the services
 * listed in its own copy of the slice, so a seed that only ever existed in the
 * browser would leave every tile unprobed.
 */
export function hasOnServer(key: string): boolean {
  return serverKeys.has(key);
}

export function set<T>(key: string, value: T): void {
  cache.set(key, value);
  serverKeys.add(key);
  writeStorage(key, value); // keep the offline mirror current
  notify(key);
  void push(key, value);
}

/**
 * Forget a key locally after the server has dropped it, so the owning feature
 * falls back to its seed. Clears the cache entry, the server-key record, the
 * mirror, and any queued write — a pending write would otherwise resurrect the
 * slice the moment the server came back.
 */
export function dropKey(key: string): void {
  cache.delete(key);
  serverKeys.delete(key);
  pending.delete(key);
  removeStorage(key);
  notify(key);
}

/** Same, for every key. Used by Settings > Reset everything. */
export function dropAll(): void {
  const touched = [...cache.keys()];
  cache.clear();
  serverKeys.clear();
  pending.clear();
  clearMirror();
  touched.forEach(notify);
}

/**
 * Re-read the whole store from the server and notify every subscriber. Used
 * after an import, where the server's contents changed underneath us.
 */
export async function reload(): Promise<void> {
  loadPromise = null;
  await load();
}

export function subscribe(key: string, fn: Listener): () => void {
  let set_ = listeners.get(key);
  if (!set_) {
    set_ = new Set();
    listeners.set(key, set_);
  }
  set_.add(fn);
  return () => set_!.delete(fn);
}

export function getStatus(): StoreStatus {
  return status;
}

export function subscribeStatus(fn: Listener): () => void {
  statusListeners.add(fn);
  return () => statusListeners.delete(fn);
}

/** True when there are writes the server hasn't accepted. */
export function hasPendingWrites(): boolean {
  return pending.size > 0;
}
