import { Link } from "react-router-dom";
import { Clock } from "lucide-react";
import Card from "@/components/ui/Card";
import { useNow } from "@/hooks/useNow";
import { useRoutineData } from "@/hooks/useRoutineData";
import { formatHHMM, minutesIntoDay, formatDuration } from "@/lib/time";

/**
 * A clock on a dashboard is decorative — the phone already shows the time.
 * What makes it worth the space is the second line: which routine block you
 * are supposed to be in right now, and how long is left of it.
 *
 * Reads `useRoutineData` and mutates nothing, the same read-only shape as
 * HomelabStatus and the Activity Log. Start times are edited on /routine.
 */
export default function CurrentTime() {
  const now = useNow(1000);
  const { schedule } = useRoutineData();

  const nowMinutes = minutesIntoDay(now);
  const current = schedule.find((b) => nowMinutes >= b.start && nowMinutes < b.end);
  const next = schedule.find((b) => b.start > nowMinutes);

  const dateLabel = now.toLocaleDateString("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
  });

  return (
    <Card title="Now" icon={<Clock size={15} />} span={1}>
      <div className="flex flex-col h-full">
        <p className="font-mono text-3xl sm:text-4xl text-ink-100 leading-none tracking-tight">
          {formatHHMM(nowMinutes)}
          <span className="text-base sm:text-lg text-ink-700">
            :{String(now.getSeconds()).padStart(2, "0")}
          </span>
        </p>
        <p className="text-xs text-ink-500 mt-1.5">{dateLabel}</p>

        <div className="mt-auto pt-3 border-t border-base-600">
          {current ? (
            <Link to="/routine" className="group block">
              <p className="text-xs text-ink-700 mb-0.5">On now</p>
              <p className="text-sm text-ink-300 group-hover:text-ink-100 transition-colors truncate">
                {current.label}
                <span className="font-mono text-ink-700">
                  {" "}
                  · {formatDuration(current.end - nowMinutes)} left
                </span>
              </p>
            </Link>
          ) : next ? (
            <Link to="/routine" className="group block">
              <p className="text-xs text-ink-700 mb-0.5">Next up</p>
              <p className="text-sm text-ink-300 group-hover:text-ink-100 transition-colors truncate">
                {next.label}
                <span className="font-mono text-ink-700"> · {formatHHMM(next.start)}</span>
              </p>
            </Link>
          ) : (
            <p className="text-sm text-ink-700">Nothing scheduled from here.</p>
          )}
        </div>
      </div>
    </Card>
  );
}
