import { Flame } from "lucide-react";
import Card from "@/components/ui/Card";
import type { Streak } from "@/lib/types";

export default function CurrentStreaks({ streaks }: { streaks: Streak[] }) {
  return (
    <Card title="Current Streaks" icon={<Flame size={15} />} span={1}>
      <div className="flex flex-wrap gap-2">
        {streaks.map((s) => (
          <div
            key={s.id}
            className={`flex items-center gap-2 px-3 py-2 rounded-badge border ${
              s.alive ? "border-vital-up/30 bg-vital-up/10" : "border-base-600 bg-base-700/30"
            }`}
          >
            <Flame
              size={14}
              className={s.alive ? "text-vital-up" : "text-ink-700"}
              fill={s.alive ? "currentColor" : "none"}
            />
            <div>
              <p className="text-xs text-ink-300 leading-tight">{s.label}</p>
              <p
                className={`text-sm font-mono leading-tight ${
                  s.alive ? "text-ink-100" : "text-ink-700"
                }`}
              >
                {s.days}d
              </p>
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}
