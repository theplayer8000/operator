import { useMemo } from "react";
import { useRemoteStorage } from "./useRemoteStorage";
import { generateId } from "@/lib/id";
import { seedEvents } from "@/lib/seed";
import { dateKeysBetween, daysFromToday, isoWeekday, toDateKey } from "@/lib/time";
import type { CalendarEvent, EventKind, EventOccurrence, EventRecurrence } from "@/lib/types";

/**
 * Materialise one day's instance of a series. The synthetic id keeps React
 * keys unique across occurrences; `seriesId` is what every mutator writes
 * through to.
 */
function occurrenceOn(event: CalendarEvent, date: string): EventOccurrence {
  return { ...event, id: `${event.id}@${date}`, date, seriesId: event.id };
}

/** Every day a series lands on, minus its skipped dates. */
function expandSeries(event: CalendarEvent): EventOccurrence[] {
  const rule = event.recurrence;
  if (!rule) return [];

  const skipped = new Set(event.skipDates ?? []);
  const wanted = new Set(rule.weekdays);

  return dateKeysBetween(event.date, rule.until)
    .filter((key) => {
      if (skipped.has(key)) return false;
      const weekday = isoWeekday(key);
      return weekday !== null && wanted.has(weekday);
    })
    .map((key) => occurrenceOn(event, key));
}

/**
 * Owns `events.records`. Everything derived here — the by-day index, upcoming,
 * per-year counts, and every occurrence of a recurring series — is computed
 * per render and never stored, so an event can't end up in two places that
 * disagree.
 */
export function useEvents() {
  const [events, setEvents] = useRemoteStorage<CalendarEvent[]>("events.records", seedEvents);

  /** Flat list of every occurrence: one-offs as themselves, series expanded. */
  const occurrences = useMemo<EventOccurrence[]>(
    () => events.flatMap((event) => (event.recurrence ? expandSeries(event) : [event])),
    [events]
  );

  /** date key → occurrences on that day, each day sorted by time (all-day first). */
  const byDay = useMemo(() => {
    const map = new Map<string, EventOccurrence[]>();
    for (const occurrence of occurrences) {
      const list = map.get(occurrence.date);
      if (list) list.push(occurrence);
      else map.set(occurrence.date, [occurrence]);
    }
    for (const list of map.values()) {
      list.sort((a, b) => (a.time ?? "").localeCompare(b.time ?? ""));
    }
    return map;
  }, [occurrences]);

  /** Today onwards, soonest first. Past occurrences stay on the calendar, not here. */
  const upcoming = useMemo(
    () =>
      occurrences
        .filter((e) => (daysFromToday(e.date) ?? -1) >= 0)
        .sort((a, b) =>
          a.date === b.date
            ? (a.time ?? "").localeCompare(b.time ?? "")
            : a.date.localeCompare(b.date)
        ),
    [occurrences]
  );

  const years = useMemo(() => {
    const set = new Set(occurrences.map((e) => Number(e.date.slice(0, 4))).filter(Number.isFinite));
    set.add(new Date().getFullYear());
    return [...set].sort((a, b) => a - b);
  }, [occurrences]);

  function addEvent(input: {
    title: string;
    date: string;
    time?: string;
    durationMinutes?: number;
    kind?: EventKind;
    notes?: string;
    recurrence?: EventRecurrence;
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
      ...(input.recurrence ? { recurrence: input.recurrence } : {}),
    };
    setEvents((prev) => [...prev, record]);
  }

  /**
   * Every mutator takes an id that may be either a real record id or a
   * synthetic `ruleId@date` one, and resolves it before writing — so callers
   * can pass whatever they were rendering without knowing which they hold.
   */
  function resolveId(id: string): string {
    return id.includes("@") ? id.slice(0, id.indexOf("@")) : id;
  }

  function updateEvent(id: string, patch: Partial<CalendarEvent>) {
    const realId = resolveId(id);
    setEvents((prev) => prev.map((e) => (e.id === realId ? { ...e, ...patch } : e)));
  }

  /** Removes the whole record — for a series, every occurrence of it. */
  function deleteEvent(id: string) {
    const realId = resolveId(id);
    setEvents((prev) => prev.filter((e) => e.id !== realId));
  }

  /**
   * Drop a single day out of a series without touching the rule — annual
   * leave, a swapped shift, a bank holiday. This is what "delete" means on
   * one occurrence of a repeating event.
   */
  function skipOccurrence(seriesId: string, date: string) {
    const realId = resolveId(seriesId);
    setEvents((prev) =>
      prev.map((e) =>
        e.id === realId && !(e.skipDates ?? []).includes(date)
          ? { ...e, skipDates: [...(e.skipDates ?? []), date] }
          : e
      )
    );
  }

  /** Put a previously skipped day back. */
  function unskipOccurrence(seriesId: string, date: string) {
    const realId = resolveId(seriesId);
    setEvents((prev) =>
      prev.map((e) =>
        e.id === realId ? { ...e, skipDates: (e.skipDates ?? []).filter((d) => d !== date) } : e
      )
    );
  }

  const todayKey = toDateKey(new Date());

  return {
    /** The stored records — one per series, not per occurrence. */
    events,
    occurrences,
    byDay,
    upcoming,
    years,
    todayKey,
    addEvent,
    updateEvent,
    deleteEvent,
    skipOccurrence,
    unskipOccurrence,
  };
}
