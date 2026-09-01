import { useMemo } from "react";
import { useRemoteStorage } from "./useRemoteStorage";
import { seedGymSessions } from "@/lib/seed";
import { isoWeekday, toDateKey } from "@/lib/time";
import type { GymCompletions, GymSession } from "@/lib/types";

/**
 * Owns `gym.sessions` (the templates), `gym.completions` (what's been ticked,
 * keyed by local date) and `gym.skipped` (dates trained on paper but not in
 * practice).
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
  /**
   * Dates the session was scheduled and deliberately not done.
   *
   * Deliberately *not* the same thing as skipping the gym block on the
   * calendar. That says "the block wasn't there"; this says "the block was
   * there and I didn't train". Adherence has to be able to tell those apart, or
   * a rest week you planned reads identically to a week you dropped. Writes
   * stay inside this hook either way — the Gym feature never reaches into
   * `events.records`.
   */
  const [skipped, setSkipped] = useRemoteStorage<string[]>("gym.skipped", []);

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

  function isSkipped(dateKey: string): boolean {
    return skipped.includes(dateKey);
  }

  /**
   * Mark a day as not-trained. Clears its ticks too — a session that's half
   * ticked and also skipped is two answers to one question, and the tick state
   * is the one that's just leftover.
   */
  function skipDay(dateKey: string) {
    setSkipped((prev) => (prev.includes(dateKey) ? prev : [...prev, dateKey]));
    clearDay(dateKey);
  }

  function unskipDay(dateKey: string) {
    setSkipped((prev) => prev.filter((d) => d !== dateKey));
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
    /*
      The whole record, read-only, for aggregators.

      Statistics needs totals across every day and this hook only exposed
      per-day accessors, which would have forced it to read `gym.completions`
      directly — the thing CLAUDE.md's one-hook-per-namespace rule exists to
      prevent, and how a second copy of the truth starts. Exposing what it
      already owns is cheaper than a second reader.
    */
    completions,
    skipped,
    todayKey,
    sessionOn,
    doneOn,
    isDone,
    toggleExercise,
    clearDay,
    progressOn,
    isSkipped,
    skipDay,
    unskipDay,
  };
}
