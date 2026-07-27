import { Link } from "react-router-dom";
import { ChevronRight } from "lucide-react";
import type { MissionRecord } from "@/lib/types";

function Pill({
  label,
  active = false,
  to,
}: {
  label: string;
  active?: boolean;
  to?: string;
}) {
  const classes = `px-3 py-1.5 rounded-badge text-xs whitespace-nowrap border transition-colors ${
    active
      ? "bg-xp/15 border-xp/40 text-ink-100 font-medium"
      : "bg-base-700/50 border-base-600 text-ink-500 hover:text-ink-300"
  }`;
  return to ? (
    <Link to={to} className={classes}>
      {label}
    </Link>
  ) : (
    <span className={classes}>{label}</span>
  );
}

export default function DependencyChain({
  current,
  predecessors,
  successors,
}: {
  current: MissionRecord;
  predecessors: MissionRecord[];
  successors: MissionRecord[];
}) {
  if (predecessors.length === 0 && successors.length === 0) {
    return (
      <p className="text-sm text-ink-700">This mission has no dependencies in either direction.</p>
    );
  }

  return (
    <div className="flex items-center gap-2 flex-wrap">
      {predecessors.map((p, i) => (
        <span key={p.id} className="flex items-center gap-2">
          <Pill label={p.name} to={`/missions/${p.id}`} />
          <ChevronRight size={13} className="text-ink-700" />
        </span>
      ))}
      <Pill label={current.name} active />
      {successors.map((s) => (
        <span key={s.id} className="flex items-center gap-2">
          <ChevronRight size={13} className="text-ink-700" />
          <Pill label={s.name} to={`/missions/${s.id}`} />
        </span>
      ))}
    </div>
  );
}
