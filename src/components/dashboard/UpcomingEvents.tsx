import { CalendarClock } from "lucide-react";
import Card from "@/components/ui/Card";
import EmptyState from "@/components/ui/EmptyState";
import type { UpcomingEvent } from "@/lib/types";

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
}

export default function UpcomingEvents({ events }: { events: UpcomingEvent[] }) {
  const sorted = [...events].sort((a, b) => a.date.localeCompare(b.date));

  return (
    <Card title="Upcoming Events" icon={<CalendarClock size={15} />} span={1}>
      {sorted.length === 0 ? (
        <EmptyState message="Nothing on the calendar yet." />
      ) : (
        <ul className="space-y-3">
          {sorted.map((e) => (
            <li key={e.id} className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-badge bg-base-700 border border-base-600 flex flex-col items-center justify-center shrink-0">
                <span className="text-[9px] text-ink-700 uppercase leading-none">
                  {new Date(e.date).toLocaleDateString("en-GB", { month: "short" })}
                </span>
                <span className="text-xs font-mono text-ink-100 leading-none mt-0.5">
                  {new Date(e.date).getDate()}
                </span>
              </div>
              <div className="min-w-0">
                <p className="text-sm text-ink-300 truncate">{e.title}</p>
                <p className="text-xs text-ink-700">{formatDate(e.date)}</p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
