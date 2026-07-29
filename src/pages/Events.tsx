import { useEffect, useState } from "react";
import { CalendarDays, ChevronLeft, ChevronRight } from "lucide-react";
import { useEvents } from "@/hooks/useEvents";
import MonthGrid from "@/components/events/MonthGrid";
import DayPanel from "@/components/events/DayPanel";
import { EVENT_KIND_META } from "@/components/events/eventMeta";
import { relativeDay } from "@/lib/time";

export default function Events() {
  const { byDay, upcoming, todayKey, addEvent, updateEvent, deleteEvent, skipOccurrence } =
    useEvents();

  const [year, setYear] = useState(() => new Date().getFullYear());
  const [selected, setSelected] = useState<string | null>(todayKey);

  /**
   * Below `lg`, the day panel is a floating overlay instead of a block that
   * sits after twelve month grids in document flow. It used to be the latter
   * — reachable only by scrolling past however many months came before the
   * one you tapped, which read as broken rather than as a page with a lot on
   * it. `selected` still drives which day is shown; this only controls
   * whether that day's panel is currently visible as an overlay on a narrow
   * screen. On `lg+` the CSS below makes it a normal static block regardless
   * of this flag, so desktop behaviour is unchanged.
   */
  const [mobilePanelOpen, setMobilePanelOpen] = useState(false);

  function openDay(dateKey: string) {
    setSelected(dateKey);
    setMobilePanelOpen(true);
  }

  // Escape closes it, and a locked body stops the page scrolling underneath
  // — same pattern as the Sidebar's mobile drawer. Gated on the actual
  // viewport width (checked once, when the panel opens) because unlike the
  // drawer's hamburger button, a day can be tapped at any screen size —
  // locking the desktop page for an overlay that isn't shown there would be
  // a real bug, not just an unnecessary effect.
  useEffect(() => {
    if (!mobilePanelOpen) return;
    if (window.innerWidth >= 1024) return;

    document.body.style.overflow = "hidden";
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setMobilePanelOpen(false);
    }
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = "";
      window.removeEventListener("keydown", onKey);
    };
  }, [mobilePanelOpen]);

  const inYear = upcoming.filter((e) => e.date.startsWith(String(year)));

  /**
   * Months already gone are hidden by default. Twelve grids is a lot to scroll
   * past on a phone, and most of them are history — by December you'd be
   * scrolling through eleven dead months to reach the one you're in.
   *
   * Only ever hides months strictly before the current one *in the current
   * year*: a past year is entirely history so hiding it all would leave a blank
   * page, and a future year has no past months to hide.
   */
  const [showPast, setShowPast] = useState(false);
  const now = new Date();
  const thisYear = now.getFullYear();
  const thisMonth = now.getMonth();

  const firstVisibleMonth = !showPast && year === thisYear ? thisMonth : 0;
  const hiddenCount = firstVisibleMonth;
  const months = Array.from(
    { length: 12 - firstVisibleMonth },
    (_, i) => i + firstVisibleMonth
  );

  return (
    <div>
      <div className="flex items-center justify-between mb-5 flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-badge bg-xp/10 border border-xp/25 flex items-center justify-center text-xp">
            <CalendarDays size={18} />
          </div>
          <div>
            <h1 className="font-display text-lg text-ink-100 leading-tight">Calendar</h1>
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
          {hiddenCount > 0 && (
            <button
              onClick={() => setShowPast(true)}
              className="w-full mb-3 px-3 min-h-[44px] rounded-badge border border-base-600 border-dashed text-xs text-ink-500 hover:text-ink-300 hover:border-base-500 transition-colors"
            >
              Show {hiddenCount} earlier {hiddenCount === 1 ? "month" : "months"} of {year}
            </button>
          )}
          {showPast && year === thisYear && thisMonth > 0 && (
            <button
              onClick={() => setShowPast(false)}
              className="w-full mb-3 px-3 min-h-[44px] rounded-badge border border-base-600 border-dashed text-xs text-ink-500 hover:text-ink-300 hover:border-base-500 transition-colors"
            >
              Hide earlier months
            </button>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
            {months.map((month) => (
              <MonthGrid
                key={month}
                year={year}
                month={month}
                byDay={byDay}
                todayKey={todayKey}
                selected={selected}
                onSelect={openDay}
              />
            ))}
          </div>
        </div>

        <div className="lg:col-span-1 space-y-4">
          {/* Scrim — mobile only, and only while the panel is actually the
              overlay (it's `lg:hidden`, so it never shows or blocks clicks
              on desktop even though `mobilePanelOpen` can be true there). */}
          {mobilePanelOpen && (
            <div
              onClick={() => setMobilePanelOpen(false)}
              aria-hidden
              className="lg:hidden fixed inset-0 z-40 bg-black/60 backdrop-blur-sm"
            />
          )}

          {selected && (
            <div
              className={
                mobilePanelOpen
                  ? "fixed inset-x-3 bottom-3 z-50 max-h-[80vh] overflow-y-auto lg:static lg:inset-auto lg:z-auto lg:max-h-none lg:overflow-visible"
                  : "hidden lg:block"
              }
            >
              <div className="lg:hidden flex justify-center pb-2" aria-hidden>
                <span className="w-10 h-1 rounded-full bg-base-500" />
              </div>
              <DayPanel
                dateKey={selected}
                events={byDay.get(selected) ?? []}
                onAdd={addEvent}
                onUpdate={updateEvent}
                onDelete={deleteEvent}
                onSkip={skipOccurrence}
                onMoved={(newDate) => {
                  setYear(Number(newDate.slice(0, 4)));
                  setSelected(newDate);
                }}
                onClose={() => setMobilePanelOpen(false)}
              />
            </div>
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
                        openDay(event.date);
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
