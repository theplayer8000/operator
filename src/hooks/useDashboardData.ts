import { useRemoteStorage } from "./useRemoteStorage";
import { generateId } from "@/lib/id";
import type { ActivityItem, QuickNote, Streak, Task, WeeklyGoal } from "@/lib/types";
import {
  seedActivity,
  seedNotes,
  seedStreaks,
  seedTasks,
  seedWeeklyGoals,
} from "@/lib/seed";

/** Whole numbers, never negative — a goal count or a streak length. */
const atLeastZero = (n: number) => Math.max(0, Math.round(Number(n) || 0));

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
  const [weeklyGoals, setWeeklyGoals] = useRemoteStorage<WeeklyGoal[]>(
    "dashboard.weeklyGoals",
    seedWeeklyGoals,
  );
  const [streaks, setStreaks] = useRemoteStorage<Streak[]>("dashboard.streaks", seedStreaks);
  // `dashboard.events` was retired in v10 — Events is a real feature now
  // (`events.records`) and the widget reads that. See useEvents.ts.
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

  // --- weekly goals ---------------------------------------------------------
  // A hand-tracked counter towards a weekly target. Nothing resets `current`
  // automatically — a week is a unit the owner keeps in his head, and the reset
  // is an edit like any other.

  function addWeeklyGoal(input: { label: string; target: number; unit: string }) {
    if (!input.label.trim()) return;
    setWeeklyGoals((prev) => [
      ...prev,
      {
        id: generateId(),
        label: input.label.trim(),
        target: atLeastZero(input.target) || 1,
        current: 0,
        unit: input.unit.trim(),
      },
    ]);
  }

  function editWeeklyGoal(id: string, patch: Partial<Omit<WeeklyGoal, "id">>) {
    setWeeklyGoals((prev) =>
      prev.map((g) =>
        g.id === id
          ? {
              ...g,
              ...patch,
              ...(patch.label !== undefined ? { label: patch.label.trim() } : {}),
              ...(patch.unit !== undefined ? { unit: patch.unit.trim() } : {}),
              ...(patch.target !== undefined ? { target: atLeastZero(patch.target) || 1 } : {}),
              ...(patch.current !== undefined ? { current: atLeastZero(patch.current) } : {}),
            }
          : g,
      ),
    );
  }

  /** +1 / −1 the progress count — the day-to-day operation. Floors at 0. */
  function bumpWeeklyGoal(id: string, delta: number) {
    setWeeklyGoals((prev) =>
      prev.map((g) => (g.id === id ? { ...g, current: atLeastZero(g.current + delta) } : g)),
    );
  }

  function deleteWeeklyGoal(id: string) {
    setWeeklyGoals((prev) => prev.filter((g) => g.id !== id));
  }

  // --- streaks -------------------------------------------------------------

  function addStreak(label: string) {
    if (!label.trim()) return;
    setStreaks((prev) => [...prev, { id: generateId(), label: label.trim(), days: 0, alive: true }]);
  }

  function editStreak(id: string, patch: Partial<Omit<Streak, "id">>) {
    setStreaks((prev) =>
      prev.map((s) =>
        s.id === id
          ? {
              ...s,
              ...patch,
              ...(patch.label !== undefined ? { label: patch.label.trim() } : {}),
              ...(patch.days !== undefined ? { days: atLeastZero(patch.days) } : {}),
            }
          : s,
      ),
    );
  }

  function bumpStreak(id: string, delta: number) {
    setStreaks((prev) =>
      prev.map((s) => (s.id === id ? { ...s, days: atLeastZero(s.days + delta) } : s)),
    );
  }

  /**
   * Break or revive a streak. Breaking KEEPS the day count — the widget greys a
   * dead streak but still shows how long it ran, and that history is worth
   * seeing. Zeroing it is a separate, deliberate edit.
   */
  function setStreakAlive(id: string, alive: boolean) {
    setStreaks((prev) => prev.map((s) => (s.id === id ? { ...s, alive } : s)));
  }

  function deleteStreak(id: string) {
    setStreaks((prev) => prev.filter((s) => s.id !== id));
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
    addWeeklyGoal,
    editWeeklyGoal,
    bumpWeeklyGoal,
    deleteWeeklyGoal,
    streaks,
    addStreak,
    editStreak,
    bumpStreak,
    setStreakAlive,
    deleteStreak,
    notes,
    addNote,
    editNote,
    deleteNote,
    activity,
  };
}
