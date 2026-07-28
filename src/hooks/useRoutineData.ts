import { useEffect, useMemo } from "react";
import { useRemoteStorage } from "./useRemoteStorage";
import { generateId } from "@/lib/id";
import { parseHHMM, toDateKey } from "@/lib/time";
import { seedRoutineSections } from "@/lib/seed";
import type {
  RoutineSection,
  RoutineSectionKey,
  RoutineTask,
  ScheduleBlock,
} from "@/lib/types";

/**
 * Fallback when a section has no usable startTime. The server migrates stores
 * to schema v2 on load, but the offline localStorage mirror is never migrated
 * — so a cold start with the server down can still hand us pre-v2 sections.
 * Reading those as 09:00 is wrong-but-harmless; crashing on them is not.
 */
const FALLBACK_START = 9 * 60;

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
  const [lastReset, setLastReset] = useRemoteStorage<string>(
    "routine.lastReset",
    toDateKey(new Date())
  );

  /**
   * The daily reset — **OPS-009**, fixed in v10. It had two defects:
   *
   * 1. It compared `new Date().toISOString().slice(0, 10)`, which is the *UTC*
   *    day. Between midnight and 01:00 during BST that reports yesterday, so
   *    the routine rolled an hour late for half the year. `toDateKey` reads the
   *    local parts instead — verified against `TZ=Europe/London`.
   * 2. It ran on mount only, so a tab left open across midnight never reset.
   *    Now it re-checks whenever the tab becomes visible or regains focus,
   *    which is the case that actually happens: a phone in a pocket overnight.
   *
   * `lastReset` is the guard, so re-checking often is free — the work only
   * happens when the stored day differs from today.
   */
  useEffect(() => {
    function rollIfNewDay() {
      const today = toDateKey(new Date());
      if (lastReset === today) return;

      setSections((prev) =>
        prev.map((s) => ({
          ...s,
          tasks: s.tasks.map((t) => (t.repeatDaily ? { ...t, done: false } : t)),
        }))
      );
      setLastReset(today);
    }

    rollIfNewDay();

    function onVisible() {
      if (!document.hidden) rollIfNewDay();
    }

    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onVisible);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastReset]);

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

  function setStartTime(sectionKey: RoutineSectionKey, startTime: string) {
    if (parseHHMM(startTime) === null) return;
    setSections((prev) =>
      prev.map((s) => (s.key === sectionKey ? { ...s, startTime } : s))
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

  /**
   * The day laid out on a clock. Derived, never stored — a block's end moves
   * when tasks are added or re-estimated, and storing it would let the two
   * drift. Sorted by start time rather than by array order, because the day is
   * the sections' times, not the order they happen to sit in the array.
   */
  const schedule = useMemo<ScheduleBlock[]>(() => {
    const blocks = sections
      .map((s) => {
        const start = parseHHMM(s.startTime ?? "") ?? FALLBACK_START;
        const durationMinutes = s.tasks.reduce((a, t) => a + t.estimatedMinutes, 0);
        return {
          key: s.key,
          label: s.label,
          start,
          end: start + durationMinutes,
          durationMinutes,
          doneTasks: s.tasks.filter((t) => t.done).length,
          totalTasks: s.tasks.length,
          overlapsPrevious: false,
        };
      })
      .sort((a, b) => a.start - b.start);

    // A block that begins before its predecessor has finished is a real
    // planning conflict, and the one thing a schedule can tell you that a
    // list cannot. Flag it rather than silently drawing them on top of
    // each other.
    for (let i = 1; i < blocks.length; i++) {
      blocks[i].overlapsPrevious = blocks[i].start < blocks[i - 1].end;
    }

    return blocks;
  }, [sections]);

  return {
    sections,
    schedule,
    setStartTime,
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
