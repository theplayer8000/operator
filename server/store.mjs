// The one in-memory copy of data/operator.json, and the one place anything in
// server/ is allowed to read or write it.
//
// Extracted from index.mjs so a second caller — server/actions.mjs, the
// AI-callable capability layer — can read and write the same store the HTTP
// API does, without two independent copies that could disagree about what was
// just written.

import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
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
  const tmp = `${DATA_FILE}.tmp`;
  await writeFile(tmp, JSON.stringify(cache, null, 2), "utf8");
  await rename(tmp, DATA_FILE);
}

/** The one slice a reader wants, or undefined if nothing has been written yet. */
export async function readState(key) {
  const store = await load();
  return store.state[key];
}

/** Unconditional overwrite — what PUT /api/state/<key> has always done. */
export async function setState(key, value) {
  const store = await load();
  store.state[key] = value;
  await persist();
  return value;
}

/** Whole-map merge — what PUT /api/state (import/migrate) has always done. */
export async function mergeState(patch) {
  const store = await load();
  store.state = { ...store.state, ...patch };
  await persist();
}

export async function deleteState(key) {
  const store = await load();
  delete store.state[key];
  await persist();
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
  const next = mutate(store.state[key]);
  store.state[key] = next;
  await persist();
  return next;
}
