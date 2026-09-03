// The storage namespaces Settings can act on, grouped by the feature that owns
// them. This mirrors the key registry in docs/data-model.md — when you add a
// slice, add it here too, or Settings will silently refuse to back it up in a
// per-feature reset and the owner won't know it was missed.
//
// Export/import work on the whole store and don't consult this list, so a
// forgotten key is still backed up — it just can't be reset on its own.

import { seedRoutineSections } from "./seed";
import { toDateKey } from "./time";

export interface FeatureSlice {
  /** Feature label, as it appears in the nav. */
  label: string;
  /** What clearing this actually loses, in the owner's terms. */
  description: string;
  keys: string[];
}

/**
 * The empty value for each slice.
 *
 * Clearing **writes these**, it does not delete the key. Deleting would make
 * the feature fall back to its first-run seed — so "clear" would hand back the
 * demo tasks and fake missions, which is the opposite of what clearing is for.
 *
 * Two slices can't be blanked to nothing and stay usable:
 *
 * - `routine.sections` keeps its seven sections (with start times) and drops
 *   only their steps and notes. Sections are fixed by the type and there is no
 *   UI to create one, so an empty array is a Daily Routine you can never
 *   refill.
 * - `theme.accent` is a four-value union with no empty member; it goes back to
 *   the default rather than to nothing.
 *
 * A key absent from this map is deleted rather than blanked — see clearKeys.
 */
export const BLANK_VALUES: Record<string, unknown> = {
  "dashboard.focus": "",
  "dashboard.tasks": [],
  "dashboard.weeklyGoals": [],
  "dashboard.streaks": [],
  "dashboard.notes": [],
  "dashboard.activity": [],
  "dashboard.productivityHistory": [],
  // Retired — no reader left, but existing stores still hold them and a clear
  // should take them out rather than leave orphans behind.
  "dashboard.missions": [], // v9
  "dashboard.events": [], // v10 — replaced by events.records
  "routine.sections": seedRoutineSections.map((s) => ({ ...s, tasks: [], notes: "" })),
  // Keyed by date rather than a list, so its empty value is an object — same
  // as gym.completions.
  "routine.completions": {},
  // Retired in v16 with the nightly reset it guarded (schema v3 keys completions
  // by date, so there is nothing to roll back). Kept here so a clear takes it
  // out of existing stores rather than leaving an orphan.
  // Local date, not toISOString() — see the OPS-009 note on useRoutineData.
  "routine.lastReset": toDateKey(new Date()),
  "missions.records": [],
  "homelab.services": [],
  "events.records": [],
  "updates.entries": [],
  "gym.sessions": [],
  // Keyed by date rather than a list, so its empty value is an object.
  "gym.completions": {},
  "gym.skipped": [],
  "knowledge.notes": [],
  "work.handoffs": [],
  "theme.accent": "gold",
};

export const FEATURE_SLICES: FeatureSlice[] = [
  {
    label: "Dashboard",
    description: "Focus, tasks, quick notes, activity feed, goals, streaks and events.",
    keys: [
      "dashboard.focus",
      "dashboard.tasks",
      "dashboard.weeklyGoals",
      "dashboard.streaks",
      "dashboard.notes",
      "dashboard.activity",
      "dashboard.productivityHistory",
    ],
  },
  {
    label: "Daily Routine",
    description:
      "Every step and note, and which steps you ticked on which day. The seven sections and their start times stay — there's no way to recreate a section.",
    keys: ["routine.sections", "routine.completions", "routine.lastReset"],
  },
  {
    label: "Mission Board",
    description: "Every mission, including milestones, dependencies and history. Archived ones too.",
    keys: ["missions.records"],
  },
  {
    label: "Calendar",
    description: "Every event on the calendar, past and future.",
    keys: ["events.records"],
  },
  {
    label: "Homelab",
    description: "The service tiles. Clearing these never touches the services themselves.",
    keys: ["homelab.services"],
  },
  {
    label: "Gym",
    description:
      "Session templates, every exercise you've ticked off, and which days you skipped. Clearing loses your training history.",
    keys: ["gym.sessions", "gym.completions", "gym.skipped"],
  },
  {
    label: "Work log",
    description:
      "Every finished turn, from any session — Operator's own jobs and the ones run from a terminal. Clearing it does not undo any work; it only makes Operator unable to tell you what happened.",
    keys: ["work.handoffs"],
  },
  {
    label: "Knowledge Vault",
    description:
      "Every note, command and resource, with its topics and links. Clearing loses what you worked out and wrote down, which is the least recoverable thing here.",
    keys: ["knowledge.notes"],
  },
  {
    label: "Updates",
    description: "The shipped/pending log itself — everything on this list.",
    keys: ["updates.entries"],
  },
  {
    label: "Appearance",
    description: "Accent colour, back to gold. Currently has almost no visible effect (OPS-007).",
    keys: ["theme.accent"],
  },
];

/** Every key Settings knows about, flattened. */
export const ALL_KNOWN_KEYS = FEATURE_SLICES.flatMap((s) => s.keys);
