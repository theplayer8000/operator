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
