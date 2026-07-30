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
  const occurrenceNote = event.occurrenceNotes?.[date];
  return {
    ...event,
    id: `${event.id}@${date}`,
    date,
    seriesId: event.id,
    // Omit the key rather than setting it to undefined — this spreads over a
    // CalendarEvent, and an explicit undefined in a spread overwrites (the
    // OPS-002 trap). Nothing reads `occurrenceNotes` off an occurrence, so it
    // is left on for free rather than stripped.
    ...(occurrenceNote ? { occurrenceNote } : {}),
  };
}

/**
 * Every day a series lands on. `want` picks which side of `skipDates` to
 * return: the live occurrences (the default) or the skipped ones, which the
 * calendar still needs so a skip can be undone from the day it happened on.
 */
function expandSeries(event: CalendarEvent, want: "live" | "skipped" = "live"): EventOccurrence[] {
  const rule = event.recurrence;
  if (!rule) return [];

  const skipped = new Set(event.skipDates ?? []);
  const wanted = new Set(rule.weekdays);

  return dateKeysBetween(event.date, rule.until)
    .filter((key) => {
      if (skipped.has(key) !== (want === "skipped")) return false;
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

  /**
   * date key → the occurrences skipped on that day.
   *
   * Skipping used to be one-way in the UI: the day it happened on stopped
   * showing the event at all, so `unskipOccurrence` existed with nothing able
   * to call it — a skipped shift was unrecoverable without editing the store by
   * hand. These rows are what make it undoable.
   */
  const skippedByDay = useMemo(() => {
    const map = new Map<string, EventOccurrence[]>();
    for (const event of events) {
      if (!event.recurrence || !event.skipDates?.length) continue;
      for (const occurrence of expandSeries(event, "skipped")) {
        const list = map.get(occurrence.date);
        if (list) list.push(occurrence);
        else map.set(occurrence.date, [occurrence]);
      }
    }
    return map;
  }, [events]);

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

  /**
   * Write a note against **one day** of a series, leaving `notes` (the
   * series-wide note) and every other occurrence alone.
   *
   * A blank note deletes its key rather than storing `""`, so an absent key
   * always means "nothing written that day" — the same convention `skipDates`
   * and `gym.completions` follow, and what keeps the map from filling with
   * empty strings from opened-then-abandoned editors.
   */
  function setOccurrenceNote(seriesId: string, date: string, text: string) {
    const realId = resolveId(seriesId);
    const trimmed = text.trim();
    setEvents((prev) =>
      prev.map((e) => {
        if (e.id !== realId) return e;
        const current = e.occurrenceNotes ?? {};
        if (!trimmed) {
          if (!(date in current)) return e;
          const { [date]: _dropped, ...rest } = current;
          return { ...e, occurrenceNotes: rest };
        }
        if (current[date] === trimmed) return e;
        return { ...e, occurrenceNotes: { ...current, [date]: trimmed } };
      })
    );
  }

  const todayKey = toDateKey(new Date());

  return {
    /** The stored records — one per series, not per occurrence. */
    events,
    occurrences,
    byDay,
    skippedByDay,
    upcoming,
    years,
    todayKey,
    addEvent,
    updateEvent,
    deleteEvent,
    skipOccurrence,
    unskipOccurrence,
    setOccurrenceNote,
  };
}
