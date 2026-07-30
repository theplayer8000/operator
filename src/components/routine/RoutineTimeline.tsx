import { useMemo, useState } from "react";
import {
  AlertTriangle,
  CalendarClock,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import {
  formatHHMM,
  formatDuration,
  fromDateKey,
  minutesIntoDay,
  parseHHMM,
  relativeDay,
  toDateKey,
} from "@/lib/time";
import { useNow } from "@/hooks/useNow";
import { useEvents } from "@/hooks/useEvents";
import { EVENT_KIND_META } from "@/components/events/eventMeta";
import { ROUTINE_META } from "./routineMeta";
import type {
  EventOccurrence,
  RoutineSection,
  RoutineSectionKey,
  ScheduleBlock,
} from "@/lib/types";

type Row =
  | { kind: "routine"; block: ScheduleBlock; start: number; end: number }
  | { kind: "event"; event: EventOccurrence; start: number; end: number };

/**
 * The day on a clock rather than in a list.
 *
 * Laid out as a vertical rail, not a horizontal 24h Gantt: a full day at
 * readable scale needs more width than a 390px phone has, and the design
 * system says scroll rather than wrap — but a schedule you have to scroll
 * sideways to read is a schedule you won't read. Vertical costs nothing on
 * either device.
 *
 * Bar length is duration relative to the longest block, so the shape of the
 * day is legible at a glance. It is deliberately *not* proportional to the gap
 * between blocks — a literal 24h scale would render a 2-minute step as a
 * sub-pixel sliver and waste most of the height on the gap before work.
 *
 * Today's timed calendar events are interleaved in, read-only — the same
 * sanctioned cross-feature read `HomelabStatus` and `CurrentTime` already use.
 * Events own `events.records`; nothing here writes to it, and an event
 * overlapping a routine block is normal (a call during the Work block, say),
 * not the planning conflict the `overlapsPrevious` warning is for — that
 * warning stays scoped to routine blocks only.
 *
 * **A day stepper moves the whole card off today**, and what it can honestly
 * show changes with it. The routine itself is the same every day — that's the
 * premise of the feature — so what actually differs per date is the calendar
 * events synced in: which shift, whether there's a gym session. That's the
 * question "what does Tuesday look like" is really asking.
 *
 * What it deliberately does *not* show on another day is tick state.
 * `routine.sections` stores one `done` flag per step, and the daily reset
 * overwrites it — there is no per-date routine history to read (Gym has
 * `gym.completions` for exactly this reason; the routine has no equivalent).
 * So off today, steps render as a plan and the checkboxes are gone rather than
 * present-and-lying — the same call `CLAUDE.md` makes about not shipping the
 * accent picker while the accent is inert.
 */
export default function RoutineTimeline({
  schedule,
  sections,
  onToggleTask,
}: {
  schedule: ScheduleBlock[];
  sections: RoutineSection[];
  onToggleTask: (key: RoutineSectionKey, taskId: string) => void;
}) {
  const now = useNow(30_000);
  const nowMinutes = minutesIntoDay(now);
  const { byDay, todayKey } = useEvents();

  const [dateKey, setDateKey] = useState(todayKey);
  /**
   * One block open at a time. The schedule's job is the shape of the day; a
   * card with all seven blocks expanded is the section list below it, which
   * already exists and does that better.
   */
  const [openKey, setOpenKey] = useState<RoutineSectionKey | null>(null);

  const isToday = dateKey === todayKey;
  const selectedDate = fromDateKey(dateKey);

  const dayEvents = useMemo(
    () => (byDay.get(dateKey) ?? []).filter((e) => e.time),
    [byDay, dateKey]
  );

  const rows = useMemo<Row[]>(() => {
    const routineRows: Row[] = schedule.map((block) => ({
      kind: "routine",
      block,
      start: block.start,
      end: block.end,
    }));
    const eventRows: Row[] = dayEvents.map((event) => {
      const start = parseHHMM(event.time!) ?? 0;
      return { kind: "event", event, start, end: start + (event.durationMinutes ?? 0) };
    });
    return [...routineRows, ...eventRows].sort((a, b) => a.start - b.start);
  }, [schedule, dayEvents]);

  function shiftDay(delta: number) {
    const d = fromDateKey(dateKey);
    if (!d) return;
    d.setDate(d.getDate() + delta);
    setDateKey(toDateKey(d));
    setOpenKey(null);
  }

  // An empty routine still gets the card on another day, because the events on
  // that date are the reason you stepped there — returning null would read as
  // "nothing on Tuesday" when there's a shift on it.
  if (rows.length === 0 && isToday) return null;

  const longest = Math.max(...rows.map((r) => r.end - r.start), 1);
  // "On now" is a fact about today only. On any other date there is no current
  // block, and highlighting one would be inventing one.
  const currentKey = isToday
    ? schedule.find((b) => nowMinutes >= b.start && nowMinutes < b.end)?.key
    : undefined;

  // The next block that hasn't started yet — shown when nothing is active, so
  // the card always answers "what now?" rather than going blank between blocks.
  const upcoming = isToday && !currentKey ? schedule.find((b) => b.start > nowMinutes) : undefined;

  return (
    <div className="card-base p-4 sm:p-5 mb-5 animate-fade-up">
      <header className="flex items-start justify-between gap-3 mb-4">
        <div className="min-w-0">
          <h2 className="font-display text-sm font-medium text-ink-100">Day Schedule</h2>
          <p className="text-xs text-ink-700">
            {isToday ? (
              <>
                <span className="font-mono text-ink-300">{formatHHMM(nowMinutes)}</span>
                {" · "}
                {currentKey
                  ? `In progress · ${schedule.find((b) => b.key === currentKey)?.label}`
                  : upcoming
                    ? `Next up · ${upcoming.label} at ${formatHHMM(upcoming.start)}`
                    : "Nothing scheduled from here"}
              </>
            ) : (
              <>
                {selectedDate?.toLocaleDateString("en-GB", {
                  weekday: "long",
                  day: "numeric",
                  month: "long",
                })}
                {" · "}
                {relativeDay(dateKey)}
              </>
            )}
          </p>
        </div>

        <div className="flex items-center gap-1 shrink-0">
          <button
            onClick={() => shiftDay(-1)}
            aria-label="Previous day"
            className="w-11 h-11 rounded-badge border border-base-600 flex items-center justify-center text-ink-500 hover:text-ink-100 hover:border-base-500 transition-colors"
          >
            <ChevronLeft size={16} />
          </button>
          <button
            onClick={() => {
              setDateKey(todayKey);
              setOpenKey(null);
            }}
            disabled={isToday}
            className="px-3 min-h-[44px] rounded-badge border border-base-600 text-xs text-ink-300 hover:text-ink-100 hover:border-base-500 disabled:text-ink-700 disabled:hover:border-base-600 transition-colors"
          >
            Today
          </button>
          <button
            onClick={() => shiftDay(1)}
            aria-label="Next day"
            className="w-11 h-11 rounded-badge border border-base-600 flex items-center justify-center text-ink-500 hover:text-ink-100 hover:border-base-500 transition-colors"
          >
            <ChevronRight size={16} />
          </button>
        </div>
      </header>

      {rows.length === 0 ? (
        <p className="text-sm text-ink-700">
          Nothing on this day — no routine steps and no calendar events.
        </p>
      ) : (
        <ul className="space-y-1">
          {rows.map((row) => {
            if (row.kind === "event") {
              const { event } = row;
              const isPast = isToday && row.end <= nowMinutes;
              const isNow =
                isToday &&
                row.start <= nowMinutes &&
                nowMinutes < Math.max(row.end, row.start + 1);
              const width = Math.max(4, Math.round(((row.end - row.start) / longest) * 100));

              return (
                <li
                  key={event.id}
                  className={`flex items-center gap-3 px-2 py-2 rounded-badge transition-colors ${
                    isNow ? "bg-rank/10 border border-rank/30" : "border border-transparent"
                  }`}
                >
                  <span
                    className={`font-mono text-xs shrink-0 w-11 ${
                      isNow ? "text-rank" : isPast ? "text-ink-700" : "text-ink-500"
                    }`}
                  >
                    {event.time}
                  </span>
                  <span className={isNow ? "text-rank" : isPast ? "text-ink-700" : "text-ink-500"}>
                    <CalendarClock size={14} />
                  </span>
                  <span className="flex-1 min-w-0">
                    <span className="flex items-center gap-1.5">
                      <span
                        className={`w-1.5 h-1.5 rounded-full shrink-0 ${EVENT_KIND_META[event.kind].dot}`}
                        aria-hidden
                      />
                      <span
                        className={`text-sm truncate ${
                          isPast && !isNow ? "text-ink-700" : "text-ink-300"
                        }`}
                      >
                        {event.title}
                      </span>
                    </span>
                    <span className="block h-1 bg-base-700 rounded-full overflow-hidden mt-1">
                      <span
                        className={`block h-full rounded-full transition-all duration-500 ${
                          isNow ? "bg-rank" : isPast ? "bg-base-500" : "bg-rank/40"
                        }`}
                        style={{ width: `${width}%` }}
                      />
                    </span>
                  </span>
                  <span className="shrink-0 text-right">
                    <span className="block font-mono text-[11px] text-ink-500">
                      {formatDuration(event.durationMinutes ?? 0)}
                    </span>
                    <span className="block font-mono text-[11px] text-ink-700">
                      {EVENT_KIND_META[event.kind].label}
                    </span>
                  </span>
                </li>
              );
            }

            const { block } = row;
            const { icon: Icon } = ROUTINE_META[block.key];
            const isNow = block.key === currentKey;
            const isPast = isToday && block.end <= nowMinutes;
            const width = Math.max(4, Math.round((block.durationMinutes / longest) * 100));
            const isOpen = openKey === block.key;
            const section = sections.find((s) => s.key === block.key);

            return (
              <li
                key={block.key}
                className={`rounded-badge transition-colors ${
                  isNow ? "bg-xp/10 border border-xp/30" : "border border-transparent"
                }`}
              >
                {/*
                  The row itself opens the block. Ticking a step used to mean
                  scrolling past this card to the section list below it, which
                  is the whole complaint — the schedule is where you look to
                  know what you're meant to be doing, so it's where the tick
                  belongs.
                */}
                <button
                  onClick={() => setOpenKey(isOpen ? null : block.key)}
                  aria-expanded={isOpen}
                  className="w-full flex items-center gap-3 px-2 py-2 text-left min-h-[44px]"
                >
                  <span
                    className={`font-mono text-xs shrink-0 w-11 ${
                      isNow ? "text-xp" : isPast ? "text-ink-700" : "text-ink-500"
                    }`}
                  >
                    {formatHHMM(block.start)}
                  </span>

                  <span
                    className={`shrink-0 ${
                      isNow ? "text-xp" : isPast ? "text-ink-700" : "text-ink-500"
                    }`}
                  >
                    <Icon size={14} />
                  </span>

                  <span className="flex-1 min-w-0">
                    <span className="flex items-center gap-1.5">
                      <span
                        className={`text-sm truncate ${
                          isPast && !isNow ? "text-ink-700" : "text-ink-300"
                        }`}
                      >
                        {block.label}
                      </span>
                      {block.overlapsPrevious && (
                        <span
                          className="shrink-0 text-vital-down"
                          title="Starts before the previous block ends"
                        >
                          <AlertTriangle size={12} />
                        </span>
                      )}
                    </span>
                    {/* duration bar — relative to the longest block/event of the day */}
                    <span className="block h-1 bg-base-700 rounded-full overflow-hidden mt-1">
                      <span
                        className={`block h-full rounded-full transition-all duration-500 ${
                          isNow ? "bg-xp" : isPast ? "bg-base-500" : "bg-rank/60"
                        }`}
                        style={{ width: `${width}%` }}
                      />
                    </span>
                  </span>

                  <span className="shrink-0 text-right">
                    <span className="block font-mono text-[11px] text-ink-500">
                      {formatDuration(block.durationMinutes)}
                    </span>
                    <span className="block font-mono text-[11px] text-ink-700">
                      {isToday
                        ? `${block.doneTasks}/${block.totalTasks}`
                        : `${block.totalTasks} step${block.totalTasks === 1 ? "" : "s"}`}
                    </span>
                  </span>

                  <ChevronDown
                    size={14}
                    className={`shrink-0 text-ink-700 transition-transform ${
                      isOpen ? "rotate-180" : ""
                    }`}
                  />
                </button>

                {isOpen && section && (
                  <ul className="pb-1.5 pl-2 pr-2 space-y-0.5">
                    {section.tasks.map((task) =>
                      isToday ? (
                        <li key={task.id} className="group flex items-center gap-1 pl-2">
                          <button
                            onClick={() => onToggleTask(section.key, task.id)}
                            className="flex flex-1 min-w-0 items-center gap-2.5 min-h-[44px] text-left"
                          >
                            <span
                              className={`w-5 h-5 rounded-[6px] border flex items-center justify-center shrink-0 transition-colors ${
                                task.done
                                  ? "bg-xp border-xp"
                                  : "border-base-500 group-hover:border-ink-500"
                              }`}
                            >
                              {task.done && <span className="w-2 h-2 bg-base-950 rounded-[2px]" />}
                            </span>
                            <span
                              className={`flex-1 text-sm truncate ${
                                task.done ? "line-through text-ink-700" : "text-ink-300"
                              }`}
                            >
                              {task.title}
                            </span>
                          </button>
                          {task.estimatedMinutes > 0 && (
                            <span className="text-[11px] font-mono text-ink-700 shrink-0">
                              {task.estimatedMinutes}m
                            </span>
                          )}
                        </li>
                      ) : (
                        <li
                          key={task.id}
                          className="flex items-center gap-2.5 pl-2 min-h-[36px]"
                        >
                          <span
                            className="w-1.5 h-1.5 rounded-full bg-base-500 shrink-0 ml-[7px]"
                            aria-hidden
                          />
                          <span className="flex-1 text-sm text-ink-500 truncate">
                            {task.title}
                          </span>
                          {task.estimatedMinutes > 0 && (
                            <span className="text-[11px] font-mono text-ink-700 shrink-0">
                              {task.estimatedMinutes}m
                            </span>
                          )}
                        </li>
                      )
                    )}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {schedule.some((b) => b.overlapsPrevious) && (
        <p className="flex items-start gap-1.5 text-[11px] text-ink-700 mt-3 pt-3 border-t border-base-600">
          <AlertTriangle size={12} className="text-vital-down shrink-0 mt-0.5" />
          One or more blocks start before the previous one is estimated to finish. Adjust a start
          time, or trim the steps in the earlier block.
        </p>
      )}

      {!isToday && (
        <p className="text-[11px] text-ink-700 mt-3 pt-3 border-t border-base-600 leading-relaxed">
          The plan for this day. Your routine is the same every day, so what changes is the
          calendar — ticking off steps only applies to today, and isn't kept per date.
        </p>
      )}

      {dayEvents.length > 0 && (
        <p className="text-[11px] text-ink-700 mt-3 pt-3 border-t border-base-600">
          <CalendarClock size={11} className="inline mr-1 -mt-0.5" />
          {dayEvents.length} timed event{dayEvents.length === 1 ? "" : "s"} from{" "}
          {isToday ? "today's" : "this day's"} calendar — edit them on the{" "}
          <span className="text-ink-500">Calendar</span> page.
        </p>
      )}
    </div>
  );
}
