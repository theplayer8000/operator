import type { MissionRecord } from "@/lib/types";

export default function DependencyEditor({
  current,
  allMissions,
  onToggle,
}: {
  current: MissionRecord;
  allMissions: MissionRecord[];
  onToggle: (dependsOnId: string) => void;
}) {
  const options = allMissions.filter((m) => m.id !== current.id);

  return (
    <div className="flex flex-wrap gap-2">
      {options.map((m) => {
        const on = current.dependsOn.includes(m.id);
        return (
          <button
            key={m.id}
            onClick={() => onToggle(m.id)}
            className={`px-2.5 min-h-[38px] rounded-badge text-xs border transition-colors ${
              on
                ? "bg-rank/15 border-rank/40 text-ink-100"
                : "border-base-600 text-ink-700 hover:text-ink-300"
            }`}
          >
            {m.name}
          </button>
        );
      })}
    </div>
  );
}
