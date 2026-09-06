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

/**
 * `unauthorised` is distinct from `offline` on purpose. A 401 and a dead server
 * both stop the data arriving, but they need opposite responses — one is "go
 * and start the server", the other is "you're on the wrong address". Collapsing
 * them into "offline" sent the owner hunting for a crashed process while the
 * server was running fine and deliberately refusing him.
 */
export type StoreStatus = "loading" | "online" | "offline" | "unauthorised";

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

/** Thrown on a 401 so callers can tell "refused" from "unreachable". */
export class ApiAuthError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(reason || "not authorised");
    this.name = "ApiAuthError";
    this.reason = reason;
  }
}

let authReason = "";

/** Why the server refused this device, if it did. Empty when it didn't. */
export function getAuthReason(): string {
  return authReason;
}

/**
 * Read a 401 body for the server's own explanation. Best effort — the reason is
 * for the owner's benefit, so a missing one must not mask the 401 itself.
 */
async function authErrorFrom(res: Response): Promise<ApiAuthError> {
  let reason = "";
  try {
    const body = (await res.json()) as { reason?: string; error?: string };
    reason = body.reason ?? body.error ?? "";
  } catch {
    /* non-JSON body — the status is the signal */
  }
  authReason = reason;
  return new ApiAuthError(reason);
}

async function fetchState(): Promise<Record<string, unknown>> {
  const res = await fetch(API, { headers: { accept: "application/json" } });
  if (res.status === 401) throw await authErrorFrom(res);
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

      /*
        Seed the fingerprints so the NEXT change can be incremental.

        They cannot be computed here: matching the server's hash would need
        `crypto.subtle`, and Operator is used over Tailscale at a bare IP where
        browsers withhold it (see the secure-context note in CLAUDE.md). So the
        server is asked — one small request, once per full load.

        Cleared first, and left empty on failure. An empty map makes the next
        refresh a full reload, which is exactly the behaviour this had before,
        so an old server or a flaky moment costs correctness nothing.
      */
      fingerprints.clear();
      try {
        const res = await fetch(`${API}/meta`, { headers: { accept: "application/json" } });
        if (res.ok) {
          const meta = (await res.json()) as StateMeta;
          if (meta?.keys) {
            Object.entries(meta.keys).forEach(([k, v]) => fingerprints.set(k, v));
          }
        }
      } catch {
        /* Older server, or offline. Next refresh reloads in full. */
      }
    } catch (err) {
      if (err instanceof ApiAuthError) {
        console.warn("[operator] storage server refused this device:", err.reason);
        setStatus("unauthorised");
      } else {
        console.warn("[operator] storage server unreachable, using local mirror:", err);
        setStatus("offline");
      }
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

/*
  Fingerprints of what the server last told us, per slice.

  Empty until the first successful meta fetch, and cleared by `load()` — a full
  reload has no idea which slices it agreed with, so claiming a fingerprint
  afterwards would let the next incremental sync skip a slice that had moved.
*/
const fingerprints = new Map<string, string>();

type StateMeta = { updatedAt: string | null; keys: Record<string, string> };

/**
 * Fetch only the slices that actually changed.
 *
 * ## What this replaces
 *
 * The poll on `/api/health` is cheap and correct — it asks "did anything
 * change" for a few dozen bytes. The refetch behind it was not: any change at
 * all pulled the whole of `/api/state`, which is 1.1 MB and of which
 * `knowledge.notes` alone is 741 KB. So ticking one gym box on a phone
 * downloaded the entire vault over 4G, and the Health page had been reporting
 * exactly this for days.
 *
 * ## Why it falls back rather than failing
 *
 * `/api/state/meta` and the per-key GET are new, and `server/` only loads at
 * boot — so a browser running this build will be talking to a server that does
 * not have them yet, until the next restart. Anything unexpected returns false
 * and the caller does the full `load()` it always did. That is not defensive
 * padding: it is what makes this change safe to ship without a restart, and it
 * remains the honest behaviour afterwards for an offline or half-answered poll.
 *
 * @returns true when the cache is up to date, false to fall back.
 */
async function syncChangedSlices(): Promise<boolean> {
  // Nothing to compare against — the first sync after a load has to be a load.
  if (fingerprints.size === 0) return false;

  let meta: StateMeta;
  try {
    const res = await fetch(`${API}/meta`, { headers: { accept: "application/json" } });
    if (res.status === 401) throw await authErrorFrom(res);
    if (!res.ok) return false;
    meta = (await res.json()) as StateMeta;
  } catch (err) {
    if (err instanceof ApiAuthError) throw err;
    return false;
  }
  if (!meta?.keys || typeof meta.keys !== "object") return false;

  const changed = Object.keys(meta.keys).filter((k) => fingerprints.get(k) !== meta.keys[k]);
  /*
    Slices the server no longer has. Rare — `deleteState` is a Settings action —
    but a key left in the cache after being cleared would read as live data, and
    the whole point of this path is that the cache stays true.
  */
  const removed = [...fingerprints.keys()].filter((k) => !(k in meta.keys));

  /*
    Past a certain fraction, one request for everything beats many for most of
    it. An import or a migration touches every slice, and this path would then
    make twenty round trips to do worse than the thing it replaced.
  */
  if (changed.length > 6) return false;

  const fetched: Array<[string, unknown]> = [];
  for (const key of changed) {
    try {
      const res = await fetch(`${API}/${encodeURIComponent(key)}`, {
        headers: { accept: "application/json" },
      });
      if (res.status === 401) throw await authErrorFrom(res);
      if (!res.ok) return false;
      const body = (await res.json()) as { value?: unknown };
      fetched.push([key, body?.value ?? null]);
    } catch (err) {
      if (err instanceof ApiAuthError) throw err;
      return false;
    }
  }

  /*
    Applied only once every fetch has succeeded. A partial application would
    leave the cache holding some slices from after the change and some from
    before, with fingerprints claiming all of it was current — which the next
    sync would then believe.
  */
  for (const [key, value] of fetched) {
    cache.set(key, value);
    serverKeys.add(key);
    fingerprints.set(key, meta.keys[key]);
  }
  for (const key of removed) {
    cache.delete(key);
    serverKeys.delete(key);
    fingerprints.delete(key);
  }
  setStatus("online");
  [...changed, ...removed].forEach(notify);
  return true;
}

let refreshing: Promise<void> | null = null;

/**
 * Re-read the server, without `retry()`'s trip through "loading" — so a
 * successful refresh is invisible and a failed one leaves the existing data on
 * screen rather than blanking it.
 */
export function refresh(): Promise<void> {
  if (refreshing) return refreshing;
  /*
    Try the incremental path first, and fall back to the full reload this always
    did. `syncChangedSlices` returns false for anything it is not completely
    sure about — a server without the new routes, a partial fetch, or too many
    slices to be worth the round trips — so the fallback is the ordinary case
    rather than the error case.
  */
  refreshing = (async () => {
    try {
      if (await syncChangedSlices()) return;
    } catch (err) {
      if (err instanceof ApiAuthError) {
        console.warn("[operator] storage server refused this device:", err.reason);
        setStatus("unauthorised");
        return;
      }
    }
    loadPromise = null;
    await load();
  })().finally(() => {
    refreshing = null;
  });
  return refreshing;
}

/**
 * Re-read whenever the app comes back to the foreground.
 *
 * iOS suspends an installed web app when you switch away: the web view is
 * frozen, its connections are dropped, and on resume the page is restored from
 * a snapshot. Every fetch made after that fails, and because nothing retried,
 * the app sat on a screen full of "storage server unreachable" that could never
 * recover — while the server was up the whole time. That is the actual bug
 * behind "it doesn't reload".
 *
 * It also means a phone picks up edits made on the desktop simply by being
 * opened, which is the behaviour you'd assume a shared store already had.
 *
 * Three events because no one of them is reliable across the cases that matter:
 * `visibilitychange` covers app switching, `focus` covers a desktop window
 * regaining focus, and `pageshow` covers a back-forward cache restore, which is
 * the common one on iOS. They overlap constantly — the in-flight guard above is
 * what stops that becoming three requests.
 */
if (typeof document !== "undefined") {
  const onResume = () => {
    if (document.visibilityState === "visible") void refresh();
  };
  document.addEventListener("visibilitychange", onResume);
  window.addEventListener("focus", onResume);
  window.addEventListener("pageshow", onResume);
}

/*
  Notice changes made somewhere else, while you are looking at the page.

  The events above cover coming BACK to a tab. They do not cover the case that
  now matters most: speaking to Operator changes the data server-side while the
  map is open and focused, so nothing fires and the screen keeps showing the old
  number until you navigate away and return. The owner hit this the first time a
  spoken command worked — *"i thought we was going to have live updates"*.

  ## Poll a stamp, not the data

  `/api/health` reports the store's `updatedAt`. That is a few dozen bytes and
  no disk access, against a full `/api/state` that is the entire dataset. So the
  loop asks "did anything change" cheaply and only pays for the data when the
  answer is yes.

  ## Polling rather than a socket, deliberately

  Same reasoning as the job model in `docs/ai-workspace-design.md`: iOS
  suspends a backgrounded tab and a WebSocket comes back dead in ways that are
  awkward to detect, whereas a poll that missed its turn simply runs late. A
  dropped poll is invisible; a dropped socket is a page that has silently
  stopped updating.

  ## Only while visible

  A hidden tab polls nothing — `visibilitychange` above already refreshes on
  return, so a background tab would be paying battery to learn something it is
  about to be told anyway. This matters on a phone in a pocket.
*/
/*
  Two speeds, not one.

  4s is the right resting rate — cheap enough to leave running, slow enough not
  to matter on a phone. But it is also the reason a spoken change feels laggy
  rather than live: the owner watched a mission move and said he *"wanted it
  smoother"*, and a fixed 4s is exactly as slow when something is actively
  happening as when nothing has happened all afternoon.

  So the loop speeds up for a few seconds after it sees a change. Talking to
  Operator produces a burst of writes — an acknowledgement, then the action,
  then the reply — and during that burst it follows closely. When the burst
  stops it settles back rather than polling fast forever.

  This is not a compromise between the two rates. It is the observation that the
  moment you care about latency is the moment something just changed.
*/
const RESTING_MS = 4000;
const ACTIVE_MS = 800;
/** How long a change keeps the loop awake. Long enough to span a whole turn. */
const ACTIVE_FOR_MS = 15_000;

if (typeof document !== "undefined" && typeof window !== "undefined") {
  let lastSeen: string | null = null;
  let checking = false;
  let quickUntil = 0;
  let timer = 0;

  const schedule = () => {
    window.clearTimeout(timer);
    const wait = Date.now() < quickUntil ? ACTIVE_MS : RESTING_MS;
    timer = window.setTimeout(() => void check(), wait);
  };

  const check = async () => {
    /*
      Reschedule from a `finally` rather than running on a fixed interval, so a
      slow response cannot stack requests behind each other — the same reasoning
      as the in-flight guard on `refresh()` and the job poller before it.
    */
    if (checking || document.visibilityState !== "visible") {
      schedule();
      return;
    }
    checking = true;
    try {
      const res = await fetch("/api/health", { headers: { accept: "application/json" } });
      if (!res.ok) return;
      const body = (await res.json()) as { updatedAt?: string | null };
      const stamp = body?.updatedAt ?? null;
      /*
        The first reading only learns where the store is. Treating it as a
        change would mean a full refetch on every page load, on top of the one
        `load()` already did.
      */
      if (lastSeen === null) {
        lastSeen = stamp;
        return;
      }
      if (stamp !== lastSeen) {
        lastSeen = stamp;
        // Something is happening — follow it closely for a while.
        quickUntil = Date.now() + ACTIVE_FOR_MS;
        void refresh();
      }
    } catch {
      // Offline is already handled by load()'s status; a failed poll is silent.
    } finally {
      checking = false;
      schedule();
    }
  };

  schedule();
  /*
    Coming back to the tab is itself a reason to expect a change, so check at
    once and stay quick for a moment rather than waiting out a resting interval.
  */
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    quickUntil = Date.now() + ACTIVE_FOR_MS;
    void check();
  });
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
    if (res.status === 401) throw await authErrorFrom(res);
    if (!res.ok) throw new Error(`PUT ${key} → ${res.status}`);
    pending.delete(key);
    setStatus("online");
    await flushPending();
  } catch (err) {
    // Queue either way — a refused device may be on the wrong address and about
    // to move to the right one, and losing the edit in the meantime would be the
    // worst outcome. But say which it was, because "start the server" and
    // "you're on the wrong URL" are different actions.
    pending.set(key, value);
    if (err instanceof ApiAuthError) {
      console.warn(`[operator] write queued, server refused this device:`, err.reason);
      setStatus("unauthorised");
    } else {
      console.warn(`[operator] write queued, server unreachable:`, err);
      setStatus("offline");
    }
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
