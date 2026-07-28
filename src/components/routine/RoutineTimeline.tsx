import { AlertTriangle } from "lucide-react";
import { formatHHMM, formatDuration, minutesIntoDay } from "@/lib/time";
import { useNow } from "@/hooks/useNow";
import { ROUTINE_META } from "./routineMeta";
import type { ScheduleBlock } from "@/lib/types";

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
 */
export default function RoutineTimeline({ schedule }: { schedule: ScheduleBlock[] }) {
  const now = useNow(30_000);
  const nowMinutes = minutesIntoDay(now);

  if (schedule.length === 0) return null;

  const longest = Math.max(...schedule.map((b) => b.durationMinutes), 1);
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
        {schedule.map((block) => {
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
                {/* duration bar — relative to the longest block of the day */}
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
    </div>
  );
}
