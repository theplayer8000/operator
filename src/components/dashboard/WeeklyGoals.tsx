import { CalendarRange } from "lucide-react";
import Card from "@/components/ui/Card";
import type { WeeklyGoal } from "@/lib/types";

export default function WeeklyGoals({ goals }: { goals: WeeklyGoal[] }) {
  return (
    <Card title="Weekly Goals" icon={<CalendarRange size={15} />} span={1}>
      <div className="space-y-4">
        {goals.map((g) => {
          const pct = Math.min(100, Math.round((g.current / g.target) * 100));
          return (
            <div key={g.id}>
              <div className="flex justify-between text-xs mb-1.5">
                <span className="text-ink-300">{g.label}</span>
                <span className="font-mono text-ink-500">
                  {g.current}
                  {g.unit} / {g.target}
                  {g.unit}
                </span>
              </div>
              <div className="h-1.5 bg-base-700 rounded-full overflow-hidden">
                <div
                  className="h-full bg-xp rounded-full transition-all duration-500"
                  style={{ width: `${pct}%` }}
                />
              </div>
            </div>
          );
        })}
      </div>
    </Card>
  );
}
