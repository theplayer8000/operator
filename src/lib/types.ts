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
  notes: string;
  kind: EventKind;
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
  done: boolean;
  estimatedMinutes: number;
  repeatDaily: boolean;
}

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

