import { useMemo } from "react";
import { monthGrid, MONTH_NAMES, WEEKDAY_INITIALS } from "@/lib/time";
import { EVENT_KIND_META } from "./eventMeta";
import type { EventOccurrence } from "@/lib/types";

/**
 * One month. Days carrying events show up to three coloured dots — the count
 * matters more than the detail at this size, and the day panel has the detail.
 *
 * Every cell is a real button rather than a hover target: this has to work with
 * a thumb, and the design system forbids hiding anything behind `hover:`.
 */
export default function MonthGrid({
  year,
  month,
  byDay,
  todayKey,
  selected,
  onSelect,
}: {
  year: number;
  month: number;
  byDay: Map<string, EventOccurrence[]>;
  todayKey: string;
  selected: string | null;
  onSelect: (dateKey: string) => void;
}) {
  const weeks = useMemo(() => monthGrid(year, month), [year, month]);
  const monthHasEvents = weeks
    .flat()
    .some((key) => key !== null && (byDay.get(key)?.length ?? 0) > 0);

  return (
    <div className="card-base p-3 sm:p-4 min-w-0">
      <header className="flex items-baseline justify-between mb-2">
        <h3 className="font-display text-sm text-ink-100">{MONTH_NAMES[month]}</h3>
        {monthHasEvents && <span className="w-1.5 h-1.5 rounded-full bg-xp/60" aria-hidden />}
      </header>

      <div className="grid grid-cols-7 gap-0.5 mb-1">
        {WEEKDAY_INITIALS.map((d, i) => (
          <span
            key={i}
            className="text-center text-[10px] font-mono text-ink-700 leading-5"
            aria-hidden
          >
            {d}
          </span>
        ))}
      </div>

      <div className="grid grid-cols-7 gap-0.5">
        {weeks.flat().map((key, i) => {
          if (key === null) return <span key={`pad-${i}`} className="aspect-square" />;

          const dayEvents = byDay.get(key) ?? [];
          const isToday = key === todayKey;
          const isSelected = key === selected;
          const dayNumber = Number(key.slice(8, 10));

          return (
            <button
              key={key}
              onClick={() => onSelect(key)}
              aria-label={`${dayNumber} ${MONTH_NAMES[month]} ${year}, ${dayEvents.length} events`}
              aria-pressed={isSelected}
              className={`aspect-square min-w-0 rounded-[6px] flex flex-col items-center justify-center gap-0.5 text-[11px] font-mono transition-colors ${
                isSelected
                  ? "bg-xp text-base-950"
                  : isToday
                    ? "bg-xp/15 text-xp border border-xp/40"
                    : dayEvents.length > 0
                      ? "text-ink-100 hover:bg-base-700"
                      : "text-ink-700 hover:bg-base-700/60"
              }`}
            >
              <span className="leading-none">{dayNumber}</span>
              <span className="flex gap-[2px] h-1" aria-hidden>
                {dayEvents.slice(0, 3).map((e) => (
                  <span
                    key={e.id}
                    className={`w-1 h-1 rounded-full ${
                      isSelected ? "bg-base-950/70" : EVENT_KIND_META[e.kind].dot
                    }`}
                  />
                ))}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
