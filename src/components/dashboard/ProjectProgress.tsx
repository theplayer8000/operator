import { Link } from "react-router-dom";
import { FolderKanban } from "lucide-react";
import Card from "@/components/ui/Card";
import EmptyState from "@/components/ui/EmptyState";
import { useMissionBoard } from "@/hooks/useMissionBoard";

/** Real mission progress, highest first. Read-only — editing happens on the board. */
export default function ProjectProgress() {
  const { active } = useMissionBoard();
  const sorted = [...active].sort((a, b) => b.progress - a.progress);

  return (
    <Card title="Mission Progress" icon={<FolderKanban size={15} />} span={1}>
      {sorted.length === 0 ? (
        <EmptyState message="Nothing to track yet." />
      ) : (
        <div className="space-y-3">
          {sorted.slice(0, 6).map((m) => (
            <Link key={m.id} to={`/missions/${m.id}`} className="flex items-center gap-3 group">
              <span className="text-xs text-ink-300 group-hover:text-ink-100 w-24 truncate transition-colors">
                {m.name}
              </span>
              <span className="flex-1 h-1.5 bg-base-700 rounded-full overflow-hidden">
                <span
                  className="block h-full rounded-full bg-rank transition-all duration-500"
                  style={{ width: `${m.progress}%` }}
                />
              </span>
              <span className="font-mono text-xs text-ink-500 w-8 text-right">{m.progress}%</span>
            </Link>
          ))}
        </div>
      )}
    </Card>
  );
}
