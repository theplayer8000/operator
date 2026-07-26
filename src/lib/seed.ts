import type {
  ActivityItem,
  Mission,
  QuickNote,
  RoutineSection,
  Streak,
  Task,
  UpcomingEvent,
  WeeklyGoal,
} from "./types";

// First-run content only — every array below is fully editable/replaceable
// the moment the user touches it, since each is backed by useLocalStorage.

export const seedTasks: Task[] = [
  { id: "t1", title: "Review Darams tenancies module HTML", done: false, priority: "high" },
  { id: "t2", title: "Rack-plan the EPYC server bay", done: false, priority: "medium" },
  { id: "t3", title: "30 min French — Duolingo streak", done: true, priority: "low" },
  { id: "t4", title: "Log today's forex observations", done: false, priority: "medium" },
];

export const seedMissions: Mission[] = [
  { id: "m1", name: "EPYC Server Build", category: "server", progress: 62, priority: "high", archived: false },
  { id: "m2", name: "Home Lab Network", category: "homelab", progress: 40, priority: "medium", archived: false },
  { id: "m3", name: "Darams CRM", category: "darams", progress: 78, priority: "high", archived: false },
  { id: "m4", name: "AI Development", category: "ai", progress: 25, priority: "medium", archived: false },
];

export const seedWeeklyGoals: WeeklyGoal[] = [
  { id: "w1", label: "Study hours", target: 10, current: 6, unit: "h" },
  { id: "w2", label: "Gym sessions", target: 4, current: 3, unit: "" },
  { id: "w3", label: "Forex journal entries", target: 5, current: 2, unit: "" },
];

export const seedStreaks: Streak[] = [
  { id: "s1", label: "Learning", days: 12, alive: true },
  { id: "s2", label: "Gym", days: 5, alive: true },
  { id: "s3", label: "Forex journal", days: 0, alive: false },
];

export const seedEvents: UpcomingEvent[] = [
  { id: "e1", title: "GEH NHS shift", date: nextDays(1) },
  { id: "e2", title: "Darams UI review call", date: nextDays(3) },
  { id: "e3", title: "Breakin Science — Amsterdam", date: nextDays(21) },
];

export const seedNotes: QuickNote[] = [
  { id: "n1", text: "RustDesk port to double-check for Teo's setup", createdAt: new Date().toISOString() },
];

export const seedActivity: ActivityItem[] = [
  { id: "a1", label: "Completed \"30 min French\"", timestamp: hoursAgo(2), kind: "task" },
  { id: "a2", label: "Darams CRM moved to 78%", timestamp: hoursAgo(6), kind: "mission" },
  { id: "a3", label: "Learning streak hit 12 days", timestamp: hoursAgo(20), kind: "streak" },
];

export const seedProductivityHistory = [
  { day: "Mon", score: 62 },
  { day: "Tue", score: 71 },
  { day: "Wed", score: 55 },
  { day: "Thu", score: 80 },
  { day: "Fri", score: 74 },
  { day: "Sat", score: 40 },
  { day: "Sun", score: 66 },
];

export const seedRoutineSections: RoutineSection[] = [
  {
    key: "morning",
    label: "Morning",
    notes: "",
    tasks: [
      { id: "r1", title: "Make bed", done: false, estimatedMinutes: 2, repeatDaily: true },
      { id: "r2", title: "Hydrate + supplements", done: false, estimatedMinutes: 5, repeatDaily: true },
      { id: "r3", title: "Review today's focus", done: false, estimatedMinutes: 5, repeatDaily: true },
    ],
  },
  {
    key: "work",
    label: "Work",
    notes: "",
    tasks: [
      { id: "r4", title: "Check shift schedule", done: false, estimatedMinutes: 5, repeatDaily: true },
      { id: "r5", title: "Clear priority inbox", done: false, estimatedMinutes: 20, repeatDaily: true },
    ],
  },
  {
    key: "gym",
    label: "Gym",
    notes: "",
    tasks: [
      { id: "r6", title: "Warm up", done: false, estimatedMinutes: 10, repeatDaily: true },
      { id: "r7", title: "Push / Pull / Legs session", done: false, estimatedMinutes: 60, repeatDaily: true },
      { id: "r8", title: "Log body weight", done: false, estimatedMinutes: 2, repeatDaily: true },
    ],
  },
  {
    key: "learning",
    label: "Learning",
    notes: "",
    tasks: [
      { id: "r9", title: "Linux Journey — next module", done: false, estimatedMinutes: 30, repeatDaily: true },
      { id: "r10", title: "Log progress + next lesson", done: false, estimatedMinutes: 5, repeatDaily: true },
    ],
  },
  {
    key: "forex",
    label: "Forex",
    notes: "",
    tasks: [
      { id: "r11", title: "Review overnight market", done: false, estimatedMinutes: 15, repeatDaily: true },
      { id: "r12", title: "Journal entry — observations", done: false, estimatedMinutes: 10, repeatDaily: true },
    ],
  },
  {
    key: "evening",
    label: "Evening",
    notes: "",
    tasks: [
      { id: "r13", title: "Tidy workspace", done: false, estimatedMinutes: 10, repeatDaily: true },
      { id: "r14", title: "Plan tomorrow's focus", done: false, estimatedMinutes: 5, repeatDaily: true },
    ],
  },
  {
    key: "sleep",
    label: "Sleep",
    notes: "",
    tasks: [
      { id: "r15", title: "Screens off", done: false, estimatedMinutes: 0, repeatDaily: true },
      { id: "r16", title: "Lights out by target time", done: false, estimatedMinutes: 0, repeatDaily: true },
    ],
  },
];

function nextDays(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString();
}
function hoursAgo(n: number): string {
  const d = new Date();
  d.setHours(d.getHours() - n);
  return d.toISOString();
}
