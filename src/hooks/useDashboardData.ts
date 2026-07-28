import { useRemoteStorage } from "./useRemoteStorage";
import { generateId } from "@/lib/id";
import type { ActivityItem, QuickNote, Task } from "@/lib/types";
import {
  seedActivity,
  seedEvents,
  seedMissions,
  seedNotes,
  seedProductivityHistory,
  seedStreaks,
  seedTasks,
  seedWeeklyGoals,
} from "@/lib/seed";

/**
 * Single hook the Dashboard page (and later, other pages) reads/writes through.
 * Each slice is its own localStorage key so future modules (Projects, Learning...)
 * can own their slice without touching the others.
 */
export function useDashboardData() {
  const [focus, setFocus] = useRemoteStorage<string>("dashboard.focus", "Ship the Dashboard v1");
  const [tasks, setTasks] = useRemoteStorage<Task[]>("dashboard.tasks", seedTasks);
  const [missions, setMissions] = useRemoteStorage("dashboard.missions", seedMissions);
  const [weeklyGoals] = useRemoteStorage("dashboard.weeklyGoals", seedWeeklyGoals);
  const [streaks] = useRemoteStorage("dashboard.streaks", seedStreaks);
  const [events] = useRemoteStorage("dashboard.events", seedEvents);
  const [notes, setNotes] = useRemoteStorage<QuickNote[]>("dashboard.notes", seedNotes);
  const [activity, setActivity] = useRemoteStorage<ActivityItem[]>(
    "dashboard.activity",
    seedActivity
  );
  const [productivityHistory] = useRemoteStorage(
    "dashboard.productivityHistory",
    seedProductivityHistory
  );

  function logActivity(label: string, kind: ActivityItem["kind"]) {
    setActivity((prev) =>
      [{ id: generateId(), label, timestamp: new Date().toISOString(), kind }, ...prev].slice(
        0,
        20
      )
    );
  }

  function toggleTask(id: string) {
    setTasks((prev) =>
      prev.map((t) => (t.id === id ? { ...t, done: !t.done } : t))
    );
    const task = tasks.find((t) => t.id === id);
    if (task && !task.done) logActivity(`Completed "${task.title}"`, "task");
  }

  function addTask(title: string) {
    if (!title.trim()) return;
    setTasks((prev) => [
      { id: generateId(), title: title.trim(), done: false, priority: "medium" },
      ...prev,
    ]);
  }

  function addNote(text: string) {
    if (!text.trim()) return;
    setNotes((prev) => [
      { id: generateId(), text: text.trim(), createdAt: new Date().toISOString() },
      ...prev,
    ]);
  }

  const productivityScore = Math.round(
    productivityHistory.reduce((sum, d) => sum + d.score, 0) / productivityHistory.length
  );

  return {
    focus,
    setFocus,
    tasks,
    toggleTask,
    addTask,
    missions,
    setMissions,
    weeklyGoals,
    streaks,
    events,
    notes,
    addNote,
    activity,
    productivityHistory,
    productivityScore,
  };
}
