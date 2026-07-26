import { FolderKanban } from "lucide-react";
import Card from "@/components/ui/Card";
import type { Mission } from "@/lib/types";

export default function ProjectProgress({ missions }: { missions: Mission[] }) {
  const sorted = [...missions].filter((m) => !m.archived).sort((a, b) => b.progress - a.progress);

  return (
    <Card title="Project Progress" icon={<FolderKanban size={15} />} span={1}>
      <div className="space-y-3">
        {sorted.map((m) => (
          <div key={m.id} className="flex items-center gap-3">
            <span className="text-xs text-ink-300 w-28 truncate">{m.name}</span>
            <div className="flex-1 h-1.5 bg-base-700 rounded-full overflow-hidden">
              <div
                className="h-full rounded-full bg-rank transition-all duration-500"
                style={{ width: `${m.progress}%` }}
              />
            </div>
            <span className="font-mono text-xs text-ink-500 w-8 text-right">{m.progress}%</span>
          </div>
        ))}
      </div>
    </Card>
  );
}
