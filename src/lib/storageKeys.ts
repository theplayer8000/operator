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
  // Local date, not toISOString() — see the OPS-009 note on useRoutineData.
  // This one had the same bug and would have set the wrong day for up to an
  // hour after a clear, exactly the window OPS-009 fixed for the reset itself.
  "routine.lastReset": toDateKey(new Date()),
  "missions.records": [],
  "homelab.services": [],
  "events.records": [],
  "updates.entries": [],
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
      "Every step and note. The seven sections and their start times stay — there's no way to recreate a section.",
    keys: ["routine.sections", "routine.lastReset"],
  },
  {
    label: "Mission Board",
    description: "Every mission, including milestones, dependencies and history. Archived ones too.",
    keys: ["missions.records"],
  },
  {
    label: "Events",
    description: "Every event on the calendar, past and future.",
    keys: ["events.records"],
  },
  {
    label: "Homelab",
    description: "The service tiles. Clearing these never touches the services themselves.",
    keys: ["homelab.services"],
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
