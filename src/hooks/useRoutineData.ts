import { useRemoteStorage } from "./useRemoteStorage";
import { generateId } from "@/lib/id";
import { parseHHMM, toDateKey } from "@/lib/time";
import { seedRoutineSections } from "@/lib/seed";
import type {
  RoutineCompletions,
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
 * Owns `routine.sections` (the template — the shape of a day) and
 * `routine.completions` (what was ticked, keyed by local date).
 *
 * **The nightly reset is gone as of v16, and its absence is the feature.**
 * Completion used to be a single `done` flag per step, flipped back for every
 * repeating step once per calendar day — so the routine had no history at all,
 * only current state that was overwritten each midnight (see **OPS-009**, which
 * fixed *when* that reset ran but not the fact that it destroyed the record).
 * Keying by date means a date with no entry is simply a date nothing was ticked
 * on: there is nothing to roll back, no marker to keep, and last Tuesday stays
 * readable. `gym.completions` established the shape; this is the same thing.
 *
 * `RoutineTask.done` is still the truth for **one-off** steps, which is why it
 * survives: a step that doesn't repeat is done once and stays done, so its
 * state belongs to the step rather than to a date. For repeating steps it is
 * ignored.
 */
export function useRoutineData() {
  const [sections, setSections] = useRemoteStorage<RoutineSection[]>(
    "routine.sections",
    seedRoutineSections
  );
  const [completions, setCompletions] = useRemoteStorage<RoutineCompletions>(
    "routine.completions",
    {}
  );

  const todayKey = toDateKey(new Date());

  /** Whether a step counts as done on a given date. */
  function isDoneOn(dateKey: string, task: RoutineTask): boolean {
    if (!task.repeatDaily) return task.done;
    return (completions[dateKey] ?? []).includes(task.id);
  }

  /**
   * Tick or untick a step on a date.
   *
   * Two stores, because the two kinds of step mean different things. A
   * repeating step is a fact about a day, so it goes in `completions` under
   * that date. A one-off is a fact about the step, so it stays on the task and
   * the date is irrelevant — ticking "work at Darams" on Tuesday and looking
   * at Friday should still show it done.
   */
  function toggleTask(dateKey: string, sectionKey: RoutineSectionKey, task: RoutineTask) {
    if (!task.repeatDaily) {
      setSections((prev) =>
        prev.map((s) =>
          s.key !== sectionKey
            ? s
            : {
                ...s,
                tasks: s.tasks.map((t) => (t.id === task.id ? { ...t, done: !t.done } : t)),
              }
        )
      );
      return;
    }

    setCompletions((prev) => {
      const current = prev[dateKey] ?? [];
      const next = current.includes(task.id)
        ? current.filter((id) => id !== task.id)
        : [...current, task.id];

      // Drop the key rather than storing an empty array, so an untouched day
      // leaves no trace — same as gym.completions.
      if (next.length === 0) {
        const { [dateKey]: _dropped, ...rest } = prev;
        return rest;
      }
      return { ...prev, [dateKey]: next };
    });
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

  /**
   * Totals for one date. Every number the page shows is now date-scoped —
   * "0/19 steps" is a statement about a day, and before v16 it silently meant
   * "today" because today was the only day that existed.
   */
  function statsFor(dateKey: string) {
    const all = sections.flatMap((s) => s.tasks);
    const done = all.filter((t) => isDoneOn(dateKey, t));
    const totalTasks = all.length;
    return {
      totalTasks,
      doneTasks: done.length,
      totalMinutes: all.reduce((a, t) => a + t.estimatedMinutes, 0),
      doneMinutes: done.reduce((a, t) => a + t.estimatedMinutes, 0),
      overallPercent: totalTasks === 0 ? 0 : Math.round((done.length / totalTasks) * 100),
    };
  }

  /**
   * The day laid out on a clock. Derived, never stored — a block's end moves
   * when tasks are added or re-estimated, and storing it would let the two
   * drift. Sorted by start time rather than by array order, because the day is
   * the sections' times, not the order they happen to sit in the array.
   *
   * Takes a date because `doneTasks` is per-date now. Not memoised: it is seven
   * sections of arithmetic, and memoising on a changing date key would cost
   * more than it saves.
   */
  function scheduleFor(dateKey: string): ScheduleBlock[] {
    const blocks = sections
      // A section with no steps has nothing to do in it, so it's noise on the
      // schedule — it still renders as a card on /routine, where you can add
      // steps back. This is also how you retire a block you don't use: empty
      // it. The seven sections are fixed by the type and can't be deleted, so
      // emptying is the only "remove" available.
      .filter((s) => s.tasks.length > 0)
      .map((s) => {
        const start = parseHHMM(s.startTime ?? "") ?? FALLBACK_START;
        const durationMinutes = s.tasks.reduce((a, t) => a + t.estimatedMinutes, 0);
        return {
          key: s.key,
          label: s.label,
          start,
          end: start + durationMinutes,
          durationMinutes,
          doneTasks: s.tasks.filter((t) => isDoneOn(dateKey, t)).length,
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
  }

  return {
    sections,
    completions,
    todayKey,
    isDoneOn,
    scheduleFor,
    statsFor,
    setStartTime,
    toggleTask,
    addTask,
    editTask,
    deleteTask,
    toggleRepeat,
    setNotes,
  };
}
