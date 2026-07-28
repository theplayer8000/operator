import { Link } from "react-router-dom";
import { Swords } from "lucide-react";
import Card from "@/components/ui/Card";
import ShieldProgress from "@/components/ui/ShieldProgress";
import EmptyState from "@/components/ui/EmptyState";
import { useMissionBoard } from "@/hooks/useMissionBoard";
import { STATUS_META } from "@/components/missions/MissionBadges";

/**
 * Reads the real Mission Board (`missions.records`) — read-only, the same
 * aggregator exception as HomelabStatus and the Activity Log. It used to
 * render `dashboard.missions`, a parallel seeded list that never moved
 * (OPS-005); a widget showing numbers that can't change is worse than no
 * widget, because it looks live.
 *
 * Presentation still differs from the board on purpose: shields here, neutral
 * pills there. Same data, two registers — that is ADR 0004, not an accident.
 */
export default function CurrentMissions() {
  const { active } = useMissionBoard();

  // In-progress first, then blocked — the two that want attention today.
  // Not-started and complete are board concerns, not glance concerns.
  const focus = active
    .filter((m) => m.status === "in_progress" || m.status === "blocked")
    .sort((a, b) => b.progress - a.progress);

  const shown = focus.length > 0 ? focus : active;

  return (
    <Card
      title="Current Missions"
      icon={<Swords size={15} />}
      span={2}
      action={
        <Link to="/missions" className="text-xs text-ink-500 hover:text-ink-300 transition-colors">
          {active.length} active →
        </Link>
      }
    >
      {shown.length === 0 ? (
        <EmptyState message="No active missions — start one on the Mission Board." />
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {shown.slice(0, 4).map((m) => (
            <Link
              key={m.id}
              to={`/missions/${m.id}`}
              className="flex items-center gap-3 p-3 rounded-badge border border-base-600 bg-base-700/40 hover:border-base-500 hover:bg-base-700/70 transition-colors min-h-[44px]"
            >
              <ShieldProgress progress={m.progress} />
              <div className="min-w-0">
                <p className="text-sm text-ink-100 truncate">{m.name}</p>
                <p className="flex items-center gap-1.5 text-xs text-ink-700">
                  <span
                    className={`w-1.5 h-1.5 rounded-full shrink-0 ${STATUS_META[m.status].dot}`}
                  />
                  <span className="truncate">{m.nextObjective || STATUS_META[m.status].label}</span>
                </p>
              </div>
            </Link>
          ))}
        </div>
      )}
    </Card>
  );
}
