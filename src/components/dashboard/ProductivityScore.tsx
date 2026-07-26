import { Gauge } from "lucide-react";
import { Area, AreaChart, ResponsiveContainer, Tooltip, YAxis } from "recharts";
import Card from "@/components/ui/Card";
import StatCounter from "@/components/ui/StatCounter";

export default function ProductivityScore({
  score,
  history,
}: {
  score: number;
  history: { day: string; score: number }[];
}) {
  return (
    <Card title="Productivity Score" icon={<Gauge size={15} />} span={1}>
      <div className="flex items-end justify-between mb-2">
        <StatCounter value={score} suffix="%" className="text-3xl text-ink-100 font-semibold" />
        <span className="text-xs text-ink-700 mb-1">7-day avg</span>
      </div>
      <div className="h-16 -mx-1">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={history} margin={{ top: 4, right: 0, left: 0, bottom: 0 }}>
            <defs>
              <linearGradient id="scoreFill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#E8B04D" stopOpacity={0.35} />
                <stop offset="100%" stopColor="#E8B04D" stopOpacity={0} />
              </linearGradient>
            </defs>
            <YAxis domain={[0, 100]} hide />
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
            <Area
              type="monotone"
              dataKey="score"
              stroke="#E8B04D"
              strokeWidth={2}
              fill="url(#scoreFill)"
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </Card>
  );
}
