import { useMemo } from "react";
import { useRemoteStorage } from "./useRemoteStorage";
import { generateId } from "@/lib/id";
import { seedEvents } from "@/lib/seed";
import { daysFromToday, toDateKey } from "@/lib/time";
import type { CalendarEvent, EventKind } from "@/lib/types";

/**
 * Owns `events.records`. Everything derived here — the by-day index, upcoming,
 * per-year counts — is computed per render and never stored, so an event can't
 * end up in two places that disagree.
 */
export function useEvents() {
  const [events, setEvents] = useRemoteStorage<CalendarEvent[]>("events.records", seedEvents);

  /** date key → events on that day, each day sorted by time (all-day first). */
  const byDay = useMemo(() => {
    const map = new Map<string, CalendarEvent[]>();
    for (const event of events) {
      const list = map.get(event.date);
      if (list) list.push(event);
      else map.set(event.date, [event]);
    }
    for (const list of map.values()) {
      list.sort((a, b) => (a.time ?? "").localeCompare(b.time ?? ""));
    }
    return map;
  }, [events]);

  /** Today onwards, soonest first. Past events stay on the calendar, not here. */
  const upcoming = useMemo(
    () =>
      events
        .filter((e) => (daysFromToday(e.date) ?? -1) >= 0)
        .sort((a, b) =>
          a.date === b.date
            ? (a.time ?? "").localeCompare(b.time ?? "")
            : a.date.localeCompare(b.date)
        ),
    [events]
  );

  const years = useMemo(() => {
    const set = new Set(events.map((e) => Number(e.date.slice(0, 4))).filter(Number.isFinite));
    set.add(new Date().getFullYear());
    return [...set].sort((a, b) => a - b);
  }, [events]);

  function addEvent(input: {
    title: string;
    date: string;
    time?: string;
    durationMinutes?: number;
    kind?: EventKind;
    notes?: string;
  }) {
    if (!input.title.trim() || !input.date) return;
    const record: CalendarEvent = {
      id: generateId(),
      title: input.title.trim(),
      date: input.date,
      notes: input.notes?.trim() ?? "",
      kind: input.kind ?? "other",
      // Omitted keys, not `undefined` — an explicit undefined in a spread
      // overwrites, which is the trap called out in architecture.md. Duration
      // only makes sense alongside a time, so it's dropped whenever time is.
      ...(input.time ? { time: input.time } : {}),
      ...(input.time && input.durationMinutes && input.durationMinutes > 0
        ? { durationMinutes: Math.round(input.durationMinutes) }
        : {}),
    };
    setEvents((prev) => [...prev, record]);
  }

  function updateEvent(id: string, patch: Partial<CalendarEvent>) {
    setEvents((prev) => prev.map((e) => (e.id === id ? { ...e, ...patch } : e)));
  }

  function deleteEvent(id: string) {
    setEvents((prev) => prev.filter((e) => e.id !== id));
  }

  const todayKey = toDateKey(new Date());

  return {
    events,
    byDay,
    upcoming,
    years,
    todayKey,
    addEvent,
    updateEvent,
    deleteEvent,
  };
}
