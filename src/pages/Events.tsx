import { useState } from "react";
import { CalendarDays, ChevronLeft, ChevronRight } from "lucide-react";
import { useEvents } from "@/hooks/useEvents";
import MonthGrid from "@/components/events/MonthGrid";
import DayPanel from "@/components/events/DayPanel";
import { EVENT_KIND_META } from "@/components/events/eventMeta";
import { relativeDay } from "@/lib/time";

export default function Events() {
  const { byDay, upcoming, todayKey, addEvent, updateEvent, deleteEvent } = useEvents();

  const [year, setYear] = useState(() => new Date().getFullYear());
  const [selected, setSelected] = useState<string | null>(todayKey);

  const inYear = upcoming.filter((e) => e.date.startsWith(String(year)));

  return (
    <div>
      <div className="flex items-center justify-between mb-5 flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-badge bg-xp/10 border border-xp/25 flex items-center justify-center text-xp">
            <CalendarDays size={18} />
          </div>
          <div>
            <h1 className="font-display text-lg text-ink-100 leading-tight">Events</h1>
            <p className="text-xs text-ink-500">
              {inYear.length} upcoming in {year}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-1">
          <button
            onClick={() => setYear((y) => y - 1)}
            aria-label="Previous year"
            className="w-11 h-11 rounded-badge border border-base-600 flex items-center justify-center text-ink-500 hover:text-ink-100 hover:border-base-500 transition-colors"
          >
            <ChevronLeft size={16} />
          </button>
          <span className="font-mono text-lg text-ink-100 w-16 text-center">{year}</span>
          <button
            onClick={() => setYear((y) => y + 1)}
            aria-label="Next year"
            className="w-11 h-11 rounded-badge border border-base-600 flex items-center justify-center text-ink-500 hover:text-ink-100 hover:border-base-500 transition-colors"
          >
            <ChevronRight size={16} />
          </button>
        </div>
      </div>

      {/* Legend — scrolls rather than wraps, per the responsive rules. */}
      <div className="flex items-center gap-3 mb-5 overflow-x-auto scrollbar-none -mx-4 px-4 sm:mx-0 sm:px-0">
        {Object.entries(EVENT_KIND_META).map(([kind, m]) => (
          <span key={kind} className="flex items-center gap-1.5 text-xs text-ink-700 shrink-0">
            <span className={`w-1.5 h-1.5 rounded-full ${m.dot}`} aria-hidden />
            {m.label}
          </span>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2">
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
            {Array.from({ length: 12 }, (_, month) => (
              <MonthGrid
                key={month}
                year={year}
                month={month}
                byDay={byDay}
                todayKey={todayKey}
                selected={selected}
                onSelect={setSelected}
              />
            ))}
          </div>
        </div>

        <div className="lg:col-span-1 space-y-4">
          {selected && (
            <DayPanel
              dateKey={selected}
              events={byDay.get(selected) ?? []}
              onAdd={addEvent}
              onUpdate={updateEvent}
              onDelete={deleteEvent}
              onMoved={(newDate) => {
                setYear(Number(newDate.slice(0, 4)));
                setSelected(newDate);
              }}
            />
          )}

          <div className="card-base p-4 sm:p-5 animate-fade-up">
            <h2 className="font-display text-sm font-medium text-ink-300 mb-3">Next up</h2>
            {upcoming.length === 0 ? (
              <p className="text-sm text-ink-700">Nothing scheduled.</p>
            ) : (
              <ul className="space-y-2">
                {upcoming.slice(0, 8).map((event) => (
                  <li key={event.id}>
                    <button
                      onClick={() => {
                        setYear(Number(event.date.slice(0, 4)));
                        setSelected(event.date);
                      }}
                      className="w-full flex items-center gap-2 min-h-[44px] px-2 -mx-2 rounded-badge hover:bg-base-700/60 text-left transition-colors"
                    >
                      <span
                        className={`w-1.5 h-1.5 rounded-full shrink-0 ${EVENT_KIND_META[event.kind].dot}`}
                        aria-hidden
                      />
                      <span className="flex-1 min-w-0">
                        <span className="block text-sm text-ink-300 truncate">{event.title}</span>
                        <span className="block text-[11px] font-mono text-ink-700">
                          {relativeDay(event.date)}
                          {event.time && ` · ${event.time}`}
                        </span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
