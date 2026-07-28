import { useEffect } from "react";
import { useRemoteStorage } from "./useRemoteStorage";
import { generateId } from "@/lib/id";
import { seedRoutineSections } from "@/lib/seed";
import type { RoutineSection, RoutineSectionKey, RoutineTask } from "@/lib/types";

function todayKey(): string {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

/**
 * Same pattern as useDashboardData: one localStorage-backed slice
 * ("routine.sections"), plus a small "routine.lastReset" marker used to
 * roll repeating tasks back to incomplete once per calendar day.
 */
export function useRoutineData() {
  const [sections, setSections] = useRemoteStorage<RoutineSection[]>(
    "routine.sections",
    seedRoutineSections
  );
  const [lastReset, setLastReset] = useRemoteStorage<string>("routine.lastReset", todayKey());

  useEffect(() => {
    if (lastReset !== todayKey()) {
      setSections((prev) =>
        prev.map((s) => ({
          ...s,
          tasks: s.tasks.map((t) => (t.repeatDaily ? { ...t, done: false } : t)),
        }))
      );
      setLastReset(todayKey());
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function toggleTask(sectionKey: RoutineSectionKey, taskId: string) {
    setSections((prev) =>
      prev.map((s) =>
        s.key !== sectionKey
          ? s
          : {
              ...s,
              tasks: s.tasks.map((t) => (t.id === taskId ? { ...t, done: !t.done } : t)),
            }
      )
    );
  }

  function addTask(sectionKey: RoutineSectionKey, title: string, estimatedMinutes = 10) {
    if (!title.trim()) return;
    setSections((prev) =>
      prev.map((s) =>
        s.key !== sectionKey
          ? s
          : {
              ...s,
              tasks: [
                ...s.tasks,
                {
                  id: generateId(),
                  title: title.trim(),
                  done: false,
                  estimatedMinutes,
                  repeatDaily: true,
                },
              ],
            }
      )
    );
  }

  function editTask(
    sectionKey: RoutineSectionKey,
    taskId: string,
    patch: { title?: string; estimatedMinutes?: number }
  ) {
    // Build key by key. An explicit `undefined` in the spread below would
    // overwrite the existing value rather than leave it alone.
    const clean: Partial<RoutineTask> = {};
    if (patch.title !== undefined && patch.title.trim()) clean.title = patch.title.trim();
    if (patch.estimatedMinutes !== undefined && Number.isFinite(patch.estimatedMinutes)) {
      clean.estimatedMinutes = Math.max(0, Math.round(patch.estimatedMinutes));
    }
    if (Object.keys(clean).length === 0) return;

    setSections((prev) =>
      prev.map((s) =>
        s.key !== sectionKey
          ? s
          : {
              ...s,
              tasks: s.tasks.map((t) => (t.id === taskId ? { ...t, ...clean } : t)),
            }
      )
    );
  }

  function deleteTask(sectionKey: RoutineSectionKey, taskId: string) {
    setSections((prev) =>
      prev.map((s) =>
        s.key !== sectionKey ? s : { ...s, tasks: s.tasks.filter((t) => t.id !== taskId) }
      )
    );
  }

  function toggleRepeat(sectionKey: RoutineSectionKey, taskId: string) {
    setSections((prev) =>
      prev.map((s) =>
        s.key !== sectionKey
          ? s
          : {
              ...s,
              tasks: s.tasks.map((t) =>
                t.id === taskId ? { ...t, repeatDaily: !t.repeatDaily } : t
              ),
            }
      )
    );
  }

  function setNotes(sectionKey: RoutineSectionKey, notes: string) {
    setSections((prev) => prev.map((s) => (s.key === sectionKey ? { ...s, notes } : s)));
  }

  const totalTasks = sections.reduce((sum, s) => sum + s.tasks.length, 0);
  const doneTasks = sections.reduce((sum, s) => sum + s.tasks.filter((t) => t.done).length, 0);
  const totalMinutes = sections.reduce(
    (sum, s) => sum + s.tasks.reduce((a, t) => a + t.estimatedMinutes, 0),
    0
  );
  const doneMinutes = sections.reduce(
    (sum, s) => sum + s.tasks.filter((t) => t.done).reduce((a, t) => a + t.estimatedMinutes, 0),
    0
  );
  const overallPercent = totalTasks === 0 ? 0 : Math.round((doneTasks / totalTasks) * 100);

  return {
    sections,
    toggleTask,
    addTask,
    editTask,
    deleteTask,
    toggleRepeat,
    setNotes,
    overallPercent,
    doneTasks,
    totalTasks,
    doneMinutes,
    totalMinutes,
  };
}
