import { Link } from "react-router-dom";
import { Clock, Target } from "lucide-react";
import type { MissionRecord } from "@/lib/types";
import { StatusBadge, DifficultyPips } from "./MissionBadges";

function formatEta(iso?: string) {
  if (!iso) return "No target date";
  return new Date(iso).toLocaleDateString("en-GB", { month: "short", year: "numeric" });
}

export default function MissionCard({ mission }: { mission: MissionRecord }) {
  return (
    <Link
      to={`/missions/${mission.id}`}
      className="card-base p-4 sm:p-5 flex flex-col gap-4 min-w-0 hover:border-base-500 transition-colors animate-fade-up"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="font-display text-base text-ink-100 truncate">{mission.name}</h3>
          <p className="text-sm text-ink-500 line-clamp-2 mt-1">{mission.description}</p>
        </div>
        <span className="font-mono text-sm text-ink-100 shrink-0">{mission.progress}%</span>
      </div>

      <div className="h-1.5 bg-base-700 rounded-full overflow-hidden">
        <div
          className="h-full bg-xp rounded-full transition-all duration-500"
          style={{ width: `${mission.progress}%` }}
        />
      </div>

      <div className="flex items-center gap-1.5 text-xs text-ink-500">
        <Target size={12} className="shrink-0" />
        <span className="truncate">{mission.nextObjective || "No next objective set"}</span>
      </div>

      <div className="flex items-center justify-between pt-3 border-t border-base-600">
        <div className="flex items-center gap-3">
          <StatusBadge status={mission.status} />
          <DifficultyPips difficulty={mission.difficulty} />
        </div>
        <div className="flex items-center gap-3 text-xs text-ink-700 font-mono">
          <span className="flex items-center gap-1">
            <Clock size={11} /> {mission.timeInvestedHours}h
          </span>
          <span>{formatEta(mission.estimatedCompletion)}</span>
        </div>
      </div>
    </Link>
  );
}
