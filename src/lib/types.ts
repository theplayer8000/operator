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

export interface Mission {
  id: ID;
  name: string;
  category: "server" | "homelab" | "darams" | "gaming" | "ai" | "custom";
  progress: number; // 0-100
  deadline?: string;
  priority: Priority;
  archived: boolean;
}

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

export interface UpcomingEvent {
  id: ID;
  title: string;
  date: string; // ISO date
  time?: string;
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
}

export interface DashboardData {
  focus: string;
  tasks: Task[];
  missions: Mission[];
  weeklyGoals: WeeklyGoal[];
  streaks: Streak[];
  events: UpcomingEvent[];
  notes: QuickNote[];
  activity: ActivityItem[];
  productivityHistory: { day: string; score: number }[];
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

