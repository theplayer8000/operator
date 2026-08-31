// The one in-memory copy of data/operator.json, and the one place anything in
// server/ is allowed to read or write it.
//
// Extracted from index.mjs so a second caller — server/actions.mjs, the
// AI-callable capability layer — can read and write the same store the HTTP
// API does, without two independent copies that could disagree about what was
// just written.

import { readFile, writeFile, mkdir, rename, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Point this at a NAS mount when the server moves to the EPYC box.
export const DATA_FILE = process.env.OPERATOR_DATA ?? join(ROOT, "data", "operator.json");
export const SCHEMA_VERSION = 3;

/** Shape on disk: { schemaVersion, updatedAt, state: { "<key>": <value> } } */
function emptyStore() {
  return { schemaVersion: SCHEMA_VERSION, updatedAt: null, state: {} };
}

/** Default wall-clock starts for the fixed routine sections, used by v1 → v2. */
const DEFAULT_SECTION_START = {
  morning: "06:30",
  work: "09:00",
  gym: "17:30",
  learning: "19:30",
  forex: "20:30",
  evening: "21:30",
  sleep: "23:00",
};

/**
 * Migrations run oldest-first on load. Each entry takes the store at version
 * N and returns it at version N+1. Add one whenever a persisted shape changes
 * — this is the piece localStorage never had (OPS-003).
 */
const MIGRATIONS = [
  // Index N takes the store from version N to N+1.

  // 0 → 1: nothing. Version 1 was the first shipped shape; stores written
  // before versioning existed are already in it.
  null,

  // 1 → 2: RoutineSection gained `startTime`. A store written before this has
  // sections with no start, which would render as "--:--" on the new timeline.
  // Backfill from the same defaults the seed uses, keyed by section — the set
  // of sections is fixed, so this is exact rather than a guess.
  (store) => {
    const sections = store.state?.["routine.sections"];
    if (!Array.isArray(sections)) return store;

    store.state["routine.sections"] = sections.map((section) =>
      section && typeof section === "object" && typeof section.startTime !== "string"
        ? { ...section, startTime: DEFAULT_SECTION_START[section.key] ?? "09:00" }
        : section
    );
    return store;
  },

  // 2 → 3: routine completions move from a `done` flag on each task to
  // `routine.completions`, keyed by local date — the shape gym.completions
  // already uses. Before this, a nightly reset flipped `done` back for every
  // repeating step, so completion was never history, only current state.
  //
  // Anything already ticked is credited to *today* rather than thrown away.
  // That is a guess about when it happened, but it is the only date the old
  // shape supports and it is right far more often than it is wrong: the reset
  // means a `done: true` can only have been set since the last local midnight.
  //
  // `done` is deliberately left as-is on the task. It stays the truth for
  // one-off (non-repeating) steps, and for repeating ones it is simply no
  // longer read — additive only, per docs/data-model.md.
  (store) => {
    const sections = store.state?.["routine.sections"];
    if (!Array.isArray(sections)) return store;

    const ticked = [];
    for (const section of sections) {
      if (!section || !Array.isArray(section.tasks)) continue;
      for (const task of section.tasks) {
        if (task && task.done === true && task.repeatDaily !== false) ticked.push(task.id);
      }
    }
    if (ticked.length === 0) return store;

    // Local date parts, never toISOString() — that is UTC and would file an
    // evening's ticks under tomorrow (OPS-009).
    const now = new Date();
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(
      now.getDate()
    ).padStart(2, "0")}`;

    const existing = store.state["routine.completions"];
    const completions = existing && typeof existing === "object" && !Array.isArray(existing)
      ? { ...existing }
      : {};
    completions[today] = [...new Set([...(completions[today] ?? []), ...ticked])];
    store.state["routine.completions"] = completions;
    return store;
  },
];

function migrate(store) {
  let current = store.schemaVersion ?? 0;
  while (current < SCHEMA_VERSION) {
    const step = MIGRATIONS[current];
    if (typeof step === "function") store = step(store);
    current += 1;
    store.schemaVersion = current;
  }
  return store;
}

let cache = null;

export async function load() {
  if (cache) return cache;
  if (!existsSync(DATA_FILE)) {
    cache = emptyStore();
    return cache;
  }
  try {
    const raw = await readFile(DATA_FILE, "utf8");
    const parsed = JSON.parse(raw);
    cache = migrate({ ...emptyStore(), ...parsed });
  } catch (err) {
    // Never destroy a file we couldn't parse — surface it and refuse to write.
    console.error(`[operator] cannot read ${DATA_FILE}:`, err.message);
    throw new Error("data file is unreadable; refusing to overwrite it");
  }
  return cache;
}

/** Write via temp file + rename so a crash mid-write can't truncate the store. */
export async function persist() {
  cache.updatedAt = new Date().toISOString();
  await mkdir(dirname(DATA_FILE), { recursive: true });
  /*
    A temp name UNIQUE to this write, not a shared `.tmp`.

    Observed 2026-08-31: `ENOENT` renaming `operator.json.tmp`, twice. A shared
    temp name makes two overlapping writes collide — A writes tmp, B overwrites
    it, A renames it into place, and B's rename then finds nothing. The write
    is lost.

    That is a collision rather than a lock, so the retry above cannot help and
    `ENOENT` is deliberately not in its transient list: retrying does not bring
    a consumed file back. Giving each write its own temp file removes the race
    at the source instead.

    Distinct from the EPERM of 2026-08-22, which really was a transient lock and
    really is worth retrying — same symptom, opposite cause, and treating them
    alike would have papered over a lost write.
  */
  const tmp = `${DATA_FILE}.${process.pid}.${Date.now().toString(36)}.tmp`;
  try {
    await writeFile(tmp, JSON.stringify(cache, null, 2), "utf8");
    await renameWithRetry(tmp, DATA_FILE);
  } catch (err) {
    // Never leave a half-written temp file behind to be mistaken for a store.
    await rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

/**
 * The rename, retried — because on Windows it fails for reasons that pass.
 *
 * Observed 2026-08-22 mid-way through a 38-call batch rebuilding the gym
 * programme: `EPERM` renaming `operator.json.tmp`. Windows refuses a rename
 * while anything holds a handle on the target, and several things
 * legitimately do — Operator's own hourly backup reading the store, the search
 * indexer, antivirus. All of them let go within milliseconds.
 *
 * POSIX rename does not have this failure mode, which is why the original
 * temp-file-and-rename (correct, and the reason a crash cannot truncate the
 * store) needed nothing more on the machines it was written for.
 */
async function renameWithRetry(from, to, attempts = 5) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      await rename(from, to);
      return;
    } catch (err) {
      const transient = err?.code === "EPERM" || err?.code === "EBUSY" || err?.code === "EACCES";
      if (!transient || i === attempts - 1) throw err;
      // 20ms, 40, 80, 160 — a lock this short outlives none of them.
      await new Promise((r) => setTimeout(r, 20 * 2 ** i));
    }
  }
}

/** The one slice a reader wants, or undefined if nothing has been written yet. */
export async function readState(key) {
  const store = await load();
  return store.state[key];
}

/** Unconditional overwrite — what PUT /api/state/<key> has always done. */
export async function setState(key, value) {
  const store = await load();
  return commit(store, key, store.state[key], value);
}

/**
 * Whole-map merge — what PUT /api/state (import/migrate) has always done.
 *
 * Rolls back wholesale rather than per key: this is the import path, and a
 * half-applied import is the one outcome worse than a failed one.
 */
export async function mergeState(patch) {
  const store = await load();
  const previous = store.state;
  store.state = { ...store.state, ...patch };
  try {
    await persist();
  } catch (err) {
    store.state = previous;
    throw err;
  }
}

export async function deleteState(key) {
  const store = await load();
  const previous = store.state[key];
  if (previous === undefined) return; // nothing to do, nothing to roll back
  delete store.state[key];
  try {
    await persist();
  } catch (err) {
    store.state[key] = previous;
    throw err;
  }
}

/**
 * Read-modify-write one slice, atomically with respect to every other caller.
 *
 * `mutate` must be synchronous — no `await` inside it. `load()` and
 * `persist()` are the only yield points here, and JavaScript runs every
 * synchronous stretch between them to completion before any other request's
 * handler can observe `cache` — so two toggles on the same key, however they
 * arrive (two HTTP requests, two tool calls inside one turn), can never both
 * read the same "before" value and clobber each other. `PUT /api/state/<key>`
 * already relies on exactly this guarantee without stating it; this just
 * gives it a name so `actions.mjs` doesn't have to reinvent it per action.
 */
export async function withState(key, mutate) {
  const store = await load();
  const previous = store.state[key];
  const next = mutate(previous);
  return commit(store, key, previous, next);
}

/**
 * Put the new value in memory only if it reached the disk.
 *
 * **A failed write used to leave the change applied anyway.** `store.state[key]`
 * was assigned before `persist()`, so an error from the write threw *after* the
 * mutation was live: the caller saw a failure, retried, and applied it twice.
 * That is not theoretical — on 2026-08-22 a transient `EPERM` mid-batch did
 * exactly this and put a duplicate exercise in the gym programme.
 *
 * The quieter half was worse. Memory and disk disagreed until the next
 * successful write, so a restart in that window would have silently discarded
 * a change the app had already confirmed on screen.
 *
 * Rolling back on failure makes the operation all-or-nothing from the caller's
 * point of view: an error now means nothing happened, so a retry is safe.
 */
async function commit(store, key, previous, next) {
  store.state[key] = next;
  try {
    await persist();
  } catch (err) {
    // Back to what is actually on disk. `undefined` means the key did not
    // exist, and must be deleted rather than set — otherwise a failed first
    // write leaves the slice present-but-undefined, which reads differently
    // to absent everywhere downstream.
    if (previous === undefined) delete store.state[key];
    else store.state[key] = previous;
    throw err;
  }
  return next;
}
