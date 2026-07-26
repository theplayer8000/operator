import { useEffect } from "react";
import { useLocalStorage } from "./useLocalStorage";
import { seedRoutineSections } from "@/lib/seed";
import type { RoutineSection, RoutineSectionKey } from "@/lib/types";

function todayKey(): string {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

/**
 * Same pattern as useDashboardData: one localStorage-backed slice
 * ("routine.sections"), plus a small "routine.lastReset" marker used to
 * roll repeating tasks back to incomplete once per calendar day.
 */
export function useRoutineData() {
  const [sections, setSections] = useLocalStorage<RoutineSection[]>(
    "routine.sections",
    seedRoutineSections
  );
  const [lastReset, setLastReset] = useLocalStorage<string>("routine.lastReset", todayKey());

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
                  id: crypto.randomUUID(),
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
    toggleRepeat,
    setNotes,
    overallPercent,
    doneTasks,
    totalTasks,
    doneMinutes,
    totalMinutes,
  };
}
