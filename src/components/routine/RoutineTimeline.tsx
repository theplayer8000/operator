import { useMemo } from "react";
import { AlertTriangle, CalendarClock } from "lucide-react";
import { formatHHMM, formatDuration, minutesIntoDay, parseHHMM } from "@/lib/time";
import { useNow } from "@/hooks/useNow";
import { useEvents } from "@/hooks/useEvents";
import { EVENT_KIND_META } from "@/components/events/eventMeta";
import { ROUTINE_META } from "./routineMeta";
import type { CalendarEvent, ScheduleBlock } from "@/lib/types";

type Row =
  | { kind: "routine"; block: ScheduleBlock; start: number; end: number }
  | { kind: "event"; event: CalendarEvent; start: number; end: number };

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
 */
export default function RoutineTimeline({ schedule }: { schedule: ScheduleBlock[] }) {
  const now = useNow(30_000);
  const nowMinutes = minutesIntoDay(now);
  const { byDay, todayKey } = useEvents();

  const todayEvents = useMemo(
    () => (byDay.get(todayKey) ?? []).filter((e) => e.time),
    [byDay, todayKey]
  );

  const rows = useMemo<Row[]>(() => {
    const routineRows: Row[] = schedule.map((block) => ({
      kind: "routine",
      block,
      start: block.start,
      end: block.end,
    }));
    const eventRows: Row[] = todayEvents.map((event) => {
      const start = parseHHMM(event.time!) ?? 0;
      return { kind: "event", event, start, end: start + (event.durationMinutes ?? 0) };
    });
    return [...routineRows, ...eventRows].sort((a, b) => a.start - b.start);
  }, [schedule, todayEvents]);

  if (rows.length === 0) return null;

  const longest = Math.max(...rows.map((r) => r.end - r.start), 1);
  const currentKey = schedule.find((b) => nowMinutes >= b.start && nowMinutes < b.end)?.key;

  // The next block that hasn't started yet — shown when nothing is active, so
  // the card always answers "what now?" rather than going blank between blocks.
  const upcoming = !currentKey ? schedule.find((b) => b.start > nowMinutes) : undefined;

  return (
    <div className="card-base p-4 sm:p-5 mb-5 animate-fade-up">
      <header className="flex items-center justify-between gap-3 mb-4">
        <div>
          <h2 className="font-display text-sm font-medium text-ink-100">Day Schedule</h2>
          <p className="text-xs text-ink-700">
            {currentKey
              ? `In progress · ${schedule.find((b) => b.key === currentKey)?.label}`
              : upcoming
                ? `Next up · ${upcoming.label} at ${formatHHMM(upcoming.start)}`
                : "Nothing scheduled from here"}
          </p>
        </div>
        <span className="font-mono text-sm text-ink-300 shrink-0">{formatHHMM(nowMinutes)}</span>
      </header>

      <ul className="space-y-1">
        {rows.map((row) => {
          if (row.kind === "event") {
            const { event } = row;
            const isPast = row.end <= nowMinutes;
            const isNow = row.start <= nowMinutes && nowMinutes < Math.max(row.end, row.start + 1);
            const width = Math.max(4, Math.round((row.end - row.start) / longest * 100));

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
          const isPast = block.end <= nowMinutes;
          const width = Math.max(4, Math.round((block.durationMinutes / longest) * 100));

          return (
            <li
              key={block.key}
              className={`flex items-center gap-3 px-2 py-2 rounded-badge transition-colors ${
                isNow ? "bg-xp/10 border border-xp/30" : "border border-transparent"
              }`}
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
                  {block.doneTasks}/{block.totalTasks}
                </span>
              </span>
            </li>
          );
        })}
      </ul>

      {schedule.some((b) => b.overlapsPrevious) && (
        <p className="flex items-start gap-1.5 text-[11px] text-ink-700 mt-3 pt-3 border-t border-base-600">
          <AlertTriangle size={12} className="text-vital-down shrink-0 mt-0.5" />
          One or more blocks start before the previous one is estimated to finish. Adjust a start
          time, or trim the steps in the earlier block.
        </p>
      )}

      {todayEvents.length > 0 && (
        <p className="text-[11px] text-ink-700 mt-3 pt-3 border-t border-base-600">
          <CalendarClock size={11} className="inline mr-1 -mt-0.5" />
          {todayEvents.length} timed event{todayEvents.length === 1 ? "" : "s"} from today's
          calendar — edit them on the <span className="text-ink-500">Calendar</span> page.
        </p>
      )}
    </div>
  );
}
