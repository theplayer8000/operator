import { useMemo } from "react";
import { useRemoteStorage } from "./useRemoteStorage";
import { seedGymSessions } from "@/lib/seed";
import { isoWeekday, toDateKey } from "@/lib/time";
import type { GymCompletions, GymSession } from "@/lib/types";

/**
 * Owns `gym.sessions` (the templates) and `gym.completions` (what's been
 * ticked, keyed by local date).
 *
 * Separate from the Daily Routine's `gym` block on purpose: routine sections
 * are identical every day, and a training split isn't. Tuesday is Heavy Pull,
 * Wednesday is Heavy Push — a fixed daily checklist can't express that, which
 * is exactly why this exists.
 *
 * Ticks are stored per date rather than as a `done` flag on the exercise, so
 * nothing needs resetting between sessions and last Tuesday's session stays
 * readable.
 */
export function useGym() {
  const [sessions, setSessions] = useRemoteStorage<GymSession[]>(
    "gym.sessions",
    seedGymSessions
  );
  const [completions, setCompletions] = useRemoteStorage<GymCompletions>(
    "gym.completions",
    {}
  );

  const byWeekday = useMemo(() => {
    const map = new Map<number, GymSession>();
    for (const s of sessions) map.set(s.weekday, s);
    return map;
  }, [sessions]);

  /** The session scheduled on a given date, if any. Rest days return null. */
  function sessionOn(dateKey: string): GymSession | null {
    const weekday = isoWeekday(dateKey);
    return weekday === null ? null : (byWeekday.get(weekday) ?? null);
  }

  function doneOn(dateKey: string): string[] {
    return completions[dateKey] ?? [];
  }

  function isDone(dateKey: string, exerciseId: string): boolean {
    return doneOn(dateKey).includes(exerciseId);
  }

  function toggleExercise(dateKey: string, exerciseId: string) {
    setCompletions((prev) => {
      const current = prev[dateKey] ?? [];
      const next = current.includes(exerciseId)
        ? current.filter((id) => id !== exerciseId)
        : [...current, exerciseId];
      // Drop the key entirely when a day is emptied, so the store doesn't
      // accumulate a growing map of empty arrays over months of use.
      if (next.length === 0) {
        const { [dateKey]: _removed, ...rest } = prev;
        return rest;
      }
      return { ...prev, [dateKey]: next };
    });
  }

  function clearDay(dateKey: string) {
    setCompletions((prev) => {
      const { [dateKey]: _removed, ...rest } = prev;
      return rest;
    });
  }

  /** Completed / total for a date. Returns null on a rest day. */
  function progressOn(dateKey: string): { done: number; total: number; percent: number } | null {
    const session = sessionOn(dateKey);
    if (!session) return null;
    const done = doneOn(dateKey).filter((id) =>
      session.exercises.some((e) => e.id === id)
    ).length;
    const total = session.exercises.length;
    return { done, total, percent: total === 0 ? 0 : Math.round((done / total) * 100) };
  }

  const todayKey = toDateKey(new Date());

  return {
    sessions,
    setSessions,
    todayKey,
    sessionOn,
    doneOn,
    isDone,
    toggleExercise,
    clearDay,
    progressOn,
  };
}
