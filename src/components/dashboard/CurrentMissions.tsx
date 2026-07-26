import { Swords } from "lucide-react";
import Card from "@/components/ui/Card";
import ShieldProgress from "@/components/ui/ShieldProgress";
import EmptyState from "@/components/ui/EmptyState";
import type { Mission } from "@/lib/types";

const CATEGORY_LABEL: Record<Mission["category"], string> = {
  server: "Server",
  homelab: "Homelab",
  darams: "Darams",
  gaming: "Gaming",
  ai: "AI",
  custom: "Custom",
};

export default function CurrentMissions({ missions }: { missions: Mission[] }) {
  const active = missions.filter((m) => !m.archived);

  return (
    <Card title="Current Missions" icon={<Swords size={15} />} span={2}>
      {active.length === 0 ? (
        <EmptyState message="No active missions — start one from Projects." />
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {active.map((m) => (
            <div
              key={m.id}
              className="flex items-center gap-3 p-3 rounded-badge border border-base-600 bg-base-700/40 hover:border-base-500 transition-colors"
            >
              <ShieldProgress progress={m.progress} />
              <div className="min-w-0">
                <p className="text-sm text-ink-100 truncate">{m.name}</p>
                <p className="text-xs text-ink-700 font-mono uppercase tracking-wide">
                  {CATEGORY_LABEL[m.category]}
                </p>
              </div>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
