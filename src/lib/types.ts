// Core domain types shared across every module (Dashboard, Projects, Learning, ...).
// Keeping these in one place means every future page reads/writes the same shape.

export type ID = string;

export type Priority = "low" | "medium" | "high";

export interface Task {
  id: ID;
  title: string;
  done: boolean;
  priority: Priority;
  dueDate?: string; // ISO date
  missionId?: ID; // links a task to a Project/Mission
}

// The lightweight `Mission` type lived here — a second, parallel mission shape
// used only by the Dashboard's widgets over `dashboard.missions`. Retired in
// v9: those widgets now read the real `MissionRecord` board, so there is one
// mission type again. See ADR 0008, which supersedes ADR 0003.

export interface WeeklyGoal {
  id: ID;
  label: string;
  target: number;
  current: number;
  unit: string;
}

export interface Streak {
  id: ID;
  label: string;
  days: number;
  alive: boolean; // false if broken
}

// --- Events ---------------------------------------------------------------
// Its own feature since v10 (`events.records`). The Dashboard's Upcoming
// Events widget reads it read-only, the same shape as the mission widgets —
// it used to render `dashboard.events` seed data that nothing could change.

export type EventKind = "work" | "personal" | "admin" | "health" | "other";

/**
 * A repeat rule. Only weekly exists because it's the only shape that's come
 * up (work shifts) — add others when there's a real case, not speculatively.
 *
 * **One stored record per series, never one per occurrence.** Occurrences are
 * expanded at read time in `useEvents`. Writing N copies of a recurring event
 * makes editing the series impossible and is the standard way calendar data
 * rots — see the note in `data-model.md`.
 */
export interface EventRecurrence {
  type: "weekly";
  /** ISO weekdays it lands on: 1 = Monday … 7 = Sunday. */
  weekdays: number[];
  /** Last day the rule applies, inclusive. Local `"YYYY-MM-DD"`. */
  until: string;
}

export interface CalendarEvent {
  id: ID;
  title: string;
  /**
   * Local calendar day, "YYYY-MM-DD". Not a timestamp: a birthday is the 3rd
   * of March wherever you are, and building this with toISOString() puts every
   * BST evening on the wrong day. Use toDateKey() from lib/time.ts.
   */
  date: string;
  /** Optional local wall-clock time, "HH:MM". Absent means all-day. */
  time?: string;
  /**
   * How long it runs, in minutes. Only meaningful alongside `time` — an
   * all-day event has no slot to occupy. This is what lets a timed event sit
   * on the Daily Routine's Day Schedule as a real block rather than a bare
   * marker: see `RoutineTimeline`, which reads today's timed events and
   * interleaves them with routine blocks, read-only.
   */
  durationMinutes?: number;
  notes: string;
  kind: EventKind;
  /**
   * Absent for a one-off. When present, `date` is the series **start** and
   * the event repeats per this rule until `recurrence.until`.
   */
  recurrence?: EventRecurrence;
  /**
   * Days the series doesn't happen — annual leave, bank holidays, a swapped
   * shift. Only meaningful alongside `recurrence`. This is what "delete" does
   * to a single occurrence of a repeating event: it skips that day rather
   * than destroying the rule.
   */
  skipDates?: string[];
  /**
   * Notes that belong to **one day** of a series, keyed by local date —
   * *"the areas I missed on today's collection"*, not standing information
   * about the shift. Only meaningful alongside `recurrence`.
   *
   * This exists because `notes` above is a property of the *series*: one stored
   * record means editing it writes to every occurrence, which is right for
   * "ward 4, ask for Sarah" and useless for anything that happened on a
   * particular Thursday. The two are deliberately separate fields rather than
   * one field with rules attached.
   *
   * Second per-date field on a series after `skipDates`, and the same shape:
   * a key that isn't there means nothing was written that day. Blank notes
   * delete their key rather than storing `""`.
   */
  occurrenceNotes?: Record<string, string>;
}

/**
 * One materialised occurrence of an event on a specific day.
 *
 * For a one-off this is the record itself. For a recurring series it's a copy
 * with `date` set to the occurrence's day and a synthetic `id` (`ruleId@date`)
 * so React keys stay unique — `seriesId` carries the real record id, and every
 * mutator must write through to that, never to the synthetic one.
 */
export interface EventOccurrence extends CalendarEvent {
  /** Set only on expanded occurrences of a recurring series. */
  seriesId?: ID;
  /**
   * This day's entry from the series' `occurrenceNotes`, resolved at expansion
   * time so a consumer never has to index the map by date itself — and so
   * `notes` (the series note) and this one can't get mixed up.
   */
  occurrenceNote?: string;
}

export interface QuickNote {
  id: ID;
  text: string;
  createdAt: string;
}

export interface ActivityItem {
  id: ID;
  label: string;
  timestamp: string;
  kind: "task" | "mission" | "streak" | "note" | "system";
}

// --- Daily Routine ------------------------------------------------------
// Own namespace, same pattern as the Dashboard's slices above: a fixed set
// of sections (the shape of a day), each independently editable.

export type RoutineSectionKey =
  | "morning"
  | "work"
  | "gym"
  | "learning"
  | "forex"
  | "evening"
  | "sleep";

export interface RoutineTask {
  id: ID;
  title: string;
  /**
   * **Only meaningful when `repeatDaily` is false.** A one-off step is done
   * once and stays done, so its state belongs to the step rather than to a
   * date.
   *
   * For a repeating step this field is **ignored** — the truth lives in
   * `routine.completions`, keyed by date (schema v3). Before v3 this was the
   * only record of completion and a nightly reset flipped it back, which is
   * why there is no routine history older than v3: it was overwritten daily,
   * not archived. Left in place rather than removed, per the additive-only
   * rule in docs/data-model.md.
   */
  done: boolean;
  estimatedMinutes: number;
  repeatDaily: boolean;
  /**
   * Which ISO weekdays this step runs on: 1 = Monday … 7 = Sunday.
   *
   * **Absent means every day**, which is what every step meant before this
   * field existed — so it is additive and no stored routine needs migrating.
   * Only meaningful when `repeatDaily` is true; a one-off step happens once,
   * on no particular weekday.
   *
   * Why it exists: routine steps were identical on every date while the
   * calendar was not, so "work at Darams" appeared on days off, on holidays,
   * forever. The Day Schedule's own copy admitted it — *"your routine steps
   * are the same every day; what changes is the calendar"* — and admitting it
   * did not stop it being wrong on the day.
   *
   * **A tick already recorded is never re-evaluated against this.**
   * `routine.completions` is keyed by date, so narrowing a step's days changes
   * what happens next, not what happened. A step ticked on a Sunday that no
   * longer runs on Sundays stays ticked on that Sunday — the alternative is
   * rewriting history to match a rule invented afterwards.
   */
  weekdays?: number[];
}

/**
 * date key (`"YYYY-MM-DD"`) → the IDs of repeating steps ticked on that date.
 *
 * Same shape as `GymCompletions`, for the same reason: a date with no entry is
 * simply a date nothing was ticked on, so there is nothing to reset and last
 * Tuesday stays readable. Task IDs are unique across sections, so the section
 * does not need to be part of the key.
 */
export type RoutineCompletions = Record<string, ID[]>;

export interface RoutineSection {
  key: RoutineSectionKey;
  label: string;
  tasks: RoutineTask[];
  notes: string;
  /**
   * Local wall-clock start, "HH:MM" 24h. Not a timestamp — a routine happens
   * at 06:30 every day, not at one instant. The block's end is derived from
   * the section's task minutes rather than stored, so it stays honest when
   * tasks are added or re-estimated.
   *
   * Added in schema v2; see MIGRATIONS in server/index.mjs for how existing
   * stores get one.
   */
  startTime: string;
}

/** Derived per render from a section's startTime + task minutes. Never stored. */
export interface ScheduleBlock {
  key: RoutineSectionKey;
  label: string;
  /** Minutes since local midnight. */
  start: number;
  end: number;
  durationMinutes: number;
  doneTasks: number;
  totalTasks: number;
  /** True when the section starts before the previous one has finished. */
  overlapsPrevious: boolean;
}

export interface DashboardData {
  focus: string;
  tasks: Task[];
  weeklyGoals: WeeklyGoal[];
  streaks: Streak[];
  notes: QuickNote[];
  activity: ActivityItem[];
}

// --- Activity Log ---------------------------------------------------------
// The one read-only aggregator in the app. It owns no storage: entries are
// derived on the fly from the Dashboard's activity slice and every mission's
// embedded activity[]. Nothing here is persisted, and nothing here mutates.

export type LogSource = "dashboard" | "mission";

export interface LogEntry {
  id: ID;
  label: string;
  timestamp: string;
  source: LogSource;
  /** Present for dashboard entries — the original ActivityItem kind. */
  kind?: ActivityItem["kind"];
  /** Present for mission entries, so the row can link back to the record. */
  missionId?: ID;
  missionName?: string;
}

// --- Homelab --------------------------------------------------------------
// The tile grid that makes Operator the front door to the EPYC box. Each
// service is something running *on the same machine as Operator's storage
// server* — that assumption is what lets the client rewrite "localhost" to
// whatever host the browser reached Operator on (see `serviceUrl` in
// useHomelab.ts), so a tile works from the phone as well as the desk.
//
// Operator holds only the pointer. It does not embed, proxy, or share data
// with any of these services.

export interface HomelabService {
  id: ID;
  name: string;
  description: string;
  /** As seen from the box running the storage server. Usually "localhost". */
  host: string;
  port: number;
  /** Appended when opening the service, e.g. "/" or "/dashboard". */
  path: string;
  protocol: "http" | "https";
  /** Free text shown on the tile, e.g. "Flask · SQLite". */
  stack: string;
}

/** Result of one server-side reachability probe. Never persisted. */
export interface ServiceStatus {
  id: ID;
  online: boolean;
  latencyMs: number | null;
}

// --- Gym --------------------------------------------------------------------
// Session templates plus per-day tick-offs. Deliberately separate from the
// Daily Routine's `gym` block: routine sections are identical every day, and a
// training split isn't — Tuesday is Heavy Pull and Wednesday is Heavy Push.
// That mismatch is the whole reason this feature exists.
//
// The programme itself lives in reference/gym-programme.md; this is the part
// you tick off at the gym.

export interface GymExercise {
  id: ID;
  name: string;
  /** Free text, matching the programme: "4 × 8–10", "Top set + 3 back-offs". */
  sets: string;
  /** The one cue worth remembering mid-session. Optional. */
  cue?: string;
}

export interface GymSession {
  id: ID;
  /** Matches the calendar event title after the "Gym — " prefix. */
  name: string;
  /** ISO weekday it runs on: 1 = Monday … 7 = Sunday. */
  weekday: number;
  /** Wall-clock start, "HH:MM" — mirrors the calendar rule. */
  time: string;
  exercises: GymExercise[];
}

/**
 * Which exercises were ticked, keyed by local date so each session's ticks are
 * their own and nothing needs resetting. Derived progress is computed per
 * render; only the raw ticks are stored.
 */
export type GymCompletions = Record<string, ID[]>;

// --- Updates ----------------------------------------------------------------
// A running log of what's changed in Operator itself, and what's queued —
// reviewable in the app, not just in git history or docs/handoffs. Distinct
// from the Activity Log (`/log`), which aggregates the owner's own task and
// mission activity; this one is about the app's own development. Own
// namespace, own hook, own page — same recipe as everything else.

export type UpdateStatus = "done" | "pending";

export interface UpdateEntry {
  id: ID;
  title: string;
  /** Optional longer note — may be empty. */
  detail: string;
  status: UpdateStatus;
  /**
   * Local calendar day it shipped, "YYYY-MM-DD". Absent for a pending entry —
   * there's nothing to date until it's done. Set via toDateKey(), never
   * toISOString() — see the note on CalendarEvent.date.
   */
  date?: string;
}

// --- Mission Board --------------------------------------------------------
// The heart of the app. Deliberately its own namespace ("missions.records"),
// separate from the Dashboard's lightweight `Mission` summary type above —
// the Dashboard's "Current Missions" / "Project Progress" widgets stay on
// their own seeded data untouched. This is the rich, long-term record.

export type MissionCategory =
  | "server"
  | "homelab"
  | "darams"
  | "ai"
  | "learning"
  | "career"
  | "gym"
  | "forex"
  | "custom";

export type MissionDifficulty = "easy" | "moderate" | "hard" | "epic";

export type MissionStatus = "not_started" | "in_progress" | "blocked" | "complete";

export type MilestoneStatus = "pending" | "in_progress" | "complete";

export interface Milestone {
  id: ID;
  title: string;
  description: string;
  status: MilestoneStatus;
  progress: number; // 0-100
  estimatedDuration: string; // free text, e.g. "2 weeks"
  completionDate?: string; // ISO date, set once complete
  notes: string;
}

export interface MissionActivityEntry {
  id: ID;
  label: string;
  timestamp: string;
}

export interface MissionRecord {
  id: ID;
  name: string;
  description: string;
  category: MissionCategory;
  difficulty: MissionDifficulty;
  status: MissionStatus;
  progress: number; // 0-100
  estimatedCompletion?: string; // ISO date
  timeInvestedHours: number;
  nextObjective: string;
  objectivesNotes: string;
  notes: string;
  milestones: Milestone[];
  dependsOn: ID[]; // ids of missions that must precede this one
  relatedLearning: string; // free text — will link to Knowledge Vault once it exists
  relatedJourneyMilestone: string; // free text — will link to Journey once it exists
  whyItMatters: string;
  unlocks: string;
  knowledgeNeeded: string;
  activity: MissionActivityEntry[];
  archived: boolean;
  createdAt: string;
}

