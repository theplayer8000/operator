import { useMemo } from "react";
import { Link } from "react-router-dom";
import { PieChart as PieIcon } from "lucide-react";
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from "recharts";
import Card from "@/components/ui/Card";
import EmptyState from "@/components/ui/EmptyState";
import { useMissionBoard } from "@/hooks/useMissionBoard";
import { STATUS_META, STATUS_HEX, STATUS_OPTIONS } from "@/components/missions/MissionBadges";

/**
 * Replaces the old Productivity Score card, which charted
 * `dashboard.productivityHistory` — seven seeded numbers that never changed.
 * A chart that cannot move is worse than no chart, because it reads as live.
 *
 * This one is derived from `missions.records` per render and stores nothing.
 */
export default function MissionStatusChart() {
  const { active } = useMissionBoard();

  const data = useMemo(
    () =>
      STATUS_OPTIONS.map((status) => ({
        status,
        name: STATUS_META[status].label,
        value: active.filter((m) => m.status === status).length,
      })).filter((d) => d.value > 0),
    [active]
  );

  const blocked = active.filter((m) => m.status === "blocked");

  return (
    <Card
      title="Mission Status"
      icon={<PieIcon size={15} />}
      span={1}
      action={
        <Link to="/missions" className="text-xs text-ink-500 hover:text-ink-300 transition-colors">
          {active.length} active →
        </Link>
      }
    >
      {data.length === 0 ? (
        <EmptyState message="No active missions yet." />
      ) : (
        <>
          <div className="h-28">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={data}
                  dataKey="value"
                  nameKey="name"
                  innerRadius="58%"
                  outerRadius="88%"
                  paddingAngle={2}
                  stroke="none"
                  isAnimationActive={false}
                >
                  {data.map((d) => (
                    <Cell key={d.status} fill={STATUS_HEX[d.status]} />
                  ))}
                </Pie>
                <Tooltip
                  contentStyle={{
                    background: "#161B24",
                    border: "1px solid #2A3240",
                    borderRadius: 10,
                    fontSize: 12,
                  }}
                  labelStyle={{ color: "#8892A3" }}
                  itemStyle={{ color: "#F3F5F8" }}
                />
              </PieChart>
            </ResponsiveContainer>
          </div>

          <ul className="mt-3 space-y-1.5">
            {data.map((d) => (
              <li key={d.status} className="flex items-center gap-2 text-xs">
                <span
                  className="w-2 h-2 rounded-full shrink-0"
                  style={{ backgroundColor: STATUS_HEX[d.status] }}
                  aria-hidden
                />
                <span className="flex-1 text-ink-500 truncate">{d.name}</span>
                <span className="font-mono text-ink-300">{d.value}</span>
              </li>
            ))}
          </ul>

          {blocked.length > 0 && (
            <p className="text-[11px] text-ink-700 mt-3 pt-3 border-t border-base-600 truncate">
              Blocked: {blocked.map((m) => m.name).join(", ")}
            </p>
          )}
        </>
      )}
    </Card>
  );
}
