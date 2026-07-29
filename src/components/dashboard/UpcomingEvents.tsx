import { Link } from "react-router-dom";
import { CalendarClock } from "lucide-react";
import Card from "@/components/ui/Card";
import EmptyState from "@/components/ui/EmptyState";
import { useEvents } from "@/hooks/useEvents";
import { fromDateKey, relativeDay } from "@/lib/time";
import { EVENT_KIND_META } from "@/components/events/eventMeta";

/**
 * Reads the real `events.records` feature, read-only — the same shape as the
 * mission widgets and HomelabStatus. It used to render `dashboard.events` seed
 * data with no editor and nothing behind it, which is what the owner meant by
 * "doesn't open up into the events".
 */
export default function UpcomingEvents() {
  const { upcoming } = useEvents();

  return (
    <Card
      title="Upcoming Events"
      icon={<CalendarClock size={15} />}
      span={1}
      action={
        <Link to="/calendar" className="text-xs text-ink-500 hover:text-ink-300 transition-colors">
          Calendar →
        </Link>
      }
    >
      {upcoming.length === 0 ? (
        <EmptyState message="Nothing scheduled — add something on the calendar." />
      ) : (
        <ul className="space-y-1">
          {upcoming.slice(0, 5).map((event) => {
            const date = fromDateKey(event.date);
            return (
              <li key={event.id}>
                <Link
                  to="/calendar"
                  className="flex items-center gap-3 min-h-[44px] px-2 -mx-2 rounded-badge hover:bg-base-700/60 transition-colors"
                >
                  <span className="w-10 h-10 rounded-badge bg-base-700 border border-base-600 flex flex-col items-center justify-center shrink-0">
                    <span className="text-[9px] text-ink-700 uppercase leading-none">
                      {date?.toLocaleDateString("en-GB", { month: "short" }) ?? "—"}
                    </span>
                    <span className="text-xs font-mono text-ink-100 leading-none mt-0.5">
                      {date?.getDate() ?? "?"}
                    </span>
                  </span>
                  <span className="flex-1 min-w-0">
                    <span className="flex items-center gap-1.5">
                      <span
                        className={`w-1.5 h-1.5 rounded-full shrink-0 ${EVENT_KIND_META[event.kind].dot}`}
                        aria-hidden
                      />
                      <span className="text-sm text-ink-300 truncate">{event.title}</span>
                    </span>
                    <span className="block text-[11px] font-mono text-ink-700">
                      {relativeDay(event.date)}
                      {event.time && ` · ${event.time}`}
                    </span>
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
