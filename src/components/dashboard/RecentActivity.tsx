import { History, CheckCircle2, Swords, Flame, StickyNote, Settings2 } from "lucide-react";
import Card from "@/components/ui/Card";
import EmptyState from "@/components/ui/EmptyState";
import type { ActivityItem } from "@/lib/types";

const ICONS: Record<ActivityItem["kind"], typeof CheckCircle2> = {
  task: CheckCircle2,
  mission: Swords,
  streak: Flame,
  note: StickyNote,
  system: Settings2,
};

function timeAgo(iso: string) {
  const diffMs = Date.now() - new Date(iso).getTime();
  const hours = Math.round(diffMs / 3_600_000);
  if (hours < 1) return "just now";
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export default function RecentActivity({ activity }: { activity: ActivityItem[] }) {
  return (
    <Card title="Recent Activity" icon={<History size={15} />} span={1}>
      {activity.length === 0 ? (
        <EmptyState message="Nothing logged yet — completed tasks will show up here." />
      ) : (
        <ul className="space-y-3">
          {activity.slice(0, 6).map((a) => {
            const Icon = ICONS[a.kind];
            return (
              <li key={a.id} className="flex items-start gap-2.5">
                <Icon size={14} className="text-ink-700 mt-0.5 shrink-0" />
                <div className="min-w-0">
                  <p className="text-sm text-ink-300 truncate">{a.label}</p>
                  <p className="text-xs text-ink-700">{timeAgo(a.timestamp)}</p>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
