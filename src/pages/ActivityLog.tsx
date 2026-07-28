import { useState } from "react";
import { ScrollText } from "lucide-react";
import { useActivityLog } from "@/hooks/useActivityLog";
import LogRow from "@/components/log/LogRow";
import type { LogSource } from "@/lib/types";

const FILTERS: { key: LogSource | "all"; label: string }[] = [
  { key: "all", label: "All" },
  { key: "mission", label: "Missions" },
  { key: "dashboard", label: "Dashboard" },
];

function dayLabel(key: string): string {
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);

  const fmt = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

  if (key === fmt(today)) return "Today";
  if (key === fmt(yesterday)) return "Yesterday";

  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: y === today.getFullYear() ? undefined : "numeric",
  });
}

export default function ActivityLog() {
  const { counts, filterBy } = useActivityLog();
  const [filter, setFilter] = useState<LogSource | "all">("all");

  const days = filterBy(filter);

  return (
    <div className="max-w-2xl mx-auto lg:mx-0">
      <div className="flex items-center gap-3 mb-5">
        <div className="w-10 h-10 shrink-0 rounded-badge bg-xp/10 border border-xp/25 flex items-center justify-center text-xp">
          <ScrollText size={18} />
        </div>
        <div className="min-w-0">
          <h1 className="font-display text-lg text-ink-100 leading-tight">Activity Log</h1>
          <p className="text-xs text-ink-500">
            {counts.all} entries · {counts.mission} mission · {counts.dashboard} dashboard
          </p>
        </div>
      </div>

      <div className="flex items-center gap-2 mb-5 overflow-x-auto scrollbar-none -mx-4 px-4 sm:mx-0 sm:px-0">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            onClick={() => setFilter(f.key)}
            className={`px-3 min-h-[38px] shrink-0 rounded-badge text-xs border transition-colors ${
              filter === f.key
                ? "bg-base-700 border-base-500 text-ink-100"
                : "border-base-600 text-ink-500 hover:text-ink-300"
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      {days.length === 0 ? (
        <p className="text-sm text-ink-700 py-10 text-center">Nothing logged yet.</p>
      ) : (
        <div className="space-y-5">
          {days.map(([day, items]) => (
            <section key={day} className="card-base p-4 sm:p-5 animate-fade-up">
              <header className="flex items-baseline justify-between mb-2 pb-2 border-b border-base-600">
                <h2 className="font-display text-sm text-ink-100">{dayLabel(day)}</h2>
                <span className="text-xs font-mono text-ink-700">{items.length}</span>
              </header>
              <div className="space-y-0.5">
                {items.map((entry) => (
                  <LogRow key={entry.id} entry={entry} />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
