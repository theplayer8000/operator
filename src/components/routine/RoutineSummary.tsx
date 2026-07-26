import { Compass } from "lucide-react";
import StatCounter from "@/components/ui/StatCounter";

export default function RoutineSummary({
  overallPercent,
  doneTasks,
  totalTasks,
  doneMinutes,
  totalMinutes,
}: {
  overallPercent: number;
  doneTasks: number;
  totalTasks: number;
  doneMinutes: number;
  totalMinutes: number;
}) {
  return (
    <section className="card-base p-5 flex items-center justify-between gap-6 mb-5 animate-fade-up">
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-badge bg-xp/10 border border-xp/25 flex items-center justify-center text-xp">
          <Compass size={18} />
        </div>
        <div>
          <h1 className="font-display text-lg text-ink-100 leading-tight">Daily Routine</h1>
          <p className="text-xs text-ink-500">
            {doneTasks}/{totalTasks} steps · {doneMinutes}/{totalMinutes} min
          </p>
        </div>
      </div>

      <div className="flex items-center gap-4">
        <div className="hidden sm:block w-40 h-1.5 bg-base-700 rounded-full overflow-hidden">
          <div
            className="h-full bg-xp rounded-full transition-all duration-500"
            style={{ width: `${overallPercent}%` }}
          />
        </div>
        <StatCounter value={overallPercent} suffix="%" className="text-2xl text-ink-100 font-semibold w-16 text-right" />
      </div>
    </section>
  );
}
