import { useRemoteStorage } from "./useRemoteStorage";
import { generateId } from "@/lib/id";
import type { ActivityItem, QuickNote, Task } from "@/lib/types";
import {
  seedActivity,
  seedEvents,
  seedNotes,
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
  // `dashboard.missions` and `dashboard.productivityHistory` used to be read
  // here. Both were seeded lists nothing could change (OPS-005), rendered by
  // widgets that looked live. The mission widgets now read the real board and
  // the productivity chart is gone, so neither slice has a reader. They stay in
  // BLANK_VALUES so an existing store can still be cleared of them.
  const [focus, setFocus] = useRemoteStorage<string>("dashboard.focus", "Ship the Dashboard v1");
  const [tasks, setTasks] = useRemoteStorage<Task[]>("dashboard.tasks", seedTasks);
  const [weeklyGoals] = useRemoteStorage("dashboard.weeklyGoals", seedWeeklyGoals);
  const [streaks] = useRemoteStorage("dashboard.streaks", seedStreaks);
  const [events] = useRemoteStorage("dashboard.events", seedEvents);
  const [notes, setNotes] = useRemoteStorage<QuickNote[]>("dashboard.notes", seedNotes);
  const [activity, setActivity] = useRemoteStorage<ActivityItem[]>(
    "dashboard.activity",
    seedActivity
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

  function editTask(id: string, title: string) {
    if (!title.trim()) return;
    setTasks((prev) => prev.map((t) => (t.id === id ? { ...t, title: title.trim() } : t)));
  }

  function deleteTask(id: string) {
    setTasks((prev) => prev.filter((t) => t.id !== id));
  }

  function addNote(text: string) {
    if (!text.trim()) return;
    setNotes((prev) => [
      { id: generateId(), text: text.trim(), createdAt: new Date().toISOString() },
      ...prev,
    ]);
  }

  function editNote(id: string, text: string) {
    if (!text.trim()) return;
    setNotes((prev) => prev.map((n) => (n.id === id ? { ...n, text: text.trim() } : n)));
  }

  function deleteNote(id: string) {
    setNotes((prev) => prev.filter((n) => n.id !== id));
  }

  return {
    focus,
    setFocus,
    tasks,
    toggleTask,
    addTask,
    editTask,
    deleteTask,
    weeklyGoals,
    streaks,
    events,
    notes,
    addNote,
    editNote,
    deleteNote,
    activity,
  };
}
