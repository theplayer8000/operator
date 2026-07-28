import { useMemo, useState } from "react";
import { Swords } from "lucide-react";
import { useMissionBoard } from "@/hooks/useMissionBoard";
import MissionCard from "@/components/missions/MissionCard";
import NewMissionForm from "@/components/missions/NewMissionForm";
import type { MissionStatus } from "@/lib/types";
import { STATUS_META } from "@/components/missions/MissionBadges";

const FILTERS: { key: MissionStatus | "all"; label: string }[] = [
  { key: "all", label: "All" },
  { key: "in_progress", label: STATUS_META.in_progress.label },
  { key: "blocked", label: STATUS_META.blocked.label },
  { key: "not_started", label: STATUS_META.not_started.label },
  { key: "complete", label: STATUS_META.complete.label },
];

export default function MissionBoard() {
  const { active, addMission } = useMissionBoard();
  const [filter, setFilter] = useState<MissionStatus | "all">("all");

  const filtered = useMemo(
    () => (filter === "all" ? active : active.filter((m) => m.status === filter)),
    [active, filter]
  );

  const inProgress = active.filter((m) => m.status === "in_progress").length;

  return (
    <div>
      <div className="flex items-center justify-between mb-5 flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-badge bg-xp/10 border border-xp/25 flex items-center justify-center text-xp">
            <Swords size={18} />
          </div>
          <div>
            <h1 className="font-display text-lg text-ink-100 leading-tight">Mission Board</h1>
            <p className="text-xs text-ink-500">
              {active.length} missions · {inProgress} in progress
            </p>
          </div>
        </div>
        <NewMissionForm onCreate={addMission} />
      </div>

      <div className="flex items-center gap-2 mb-5 flex-wrap">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            onClick={() => setFilter(f.key)}
            className={`px-3 py-1.5 rounded-badge text-xs border transition-colors ${
              filter === f.key
                ? "bg-base-700 border-base-500 text-ink-100"
                : "border-base-600 text-ink-500 hover:text-ink-300"
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      {filtered.length === 0 ? (
        <p className="text-sm text-ink-700 py-10 text-center">No missions match this filter.</p>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {filtered.map((m) => (
            <MissionCard key={m.id} mission={m} />
          ))}
        </div>
      )}
    </div>
  );
}
