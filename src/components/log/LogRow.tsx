import { Link } from "react-router-dom";
import {
  CheckCircle2,
  Swords,
  Flame,
  StickyNote,
  Settings2,
  Target,
  type LucideIcon,
} from "lucide-react";
import type { LogEntry } from "@/lib/types";

const KIND_ICON: Record<string, LucideIcon> = {
  task: CheckCircle2,
  mission: Swords,
  streak: Flame,
  note: StickyNote,
  system: Settings2,
};

function timeOf(iso: string) {
  return new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}

/**
 * Neutral register — this is an audit trail, not a scoreboard. Dot, label,
 * timestamp. No shields, no confetti, no XP language, matching Mission Board.
 */
export default function LogRow({ entry }: { entry: LogEntry }) {
  const Icon = entry.source === "mission" ? Target : KIND_ICON[entry.kind ?? "system"] ?? Settings2;

  const body = (
    <>
      <span className="w-7 h-7 shrink-0 rounded-badge border border-base-600 bg-base-700/40 flex items-center justify-center text-ink-500">
        <Icon size={13} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm text-ink-300 break-words">{entry.label}</span>
        {entry.missionName && (
          <span className="block text-xs text-ink-700 truncate mt-0.5">{entry.missionName}</span>
        )}
      </span>
      <span className="shrink-0 text-xs font-mono text-ink-700 tabular-nums">
        {timeOf(entry.timestamp)}
      </span>
    </>
  );

  const shared = "flex items-start gap-3 px-2 py-2.5 min-h-[44px] rounded-badge transition-colors";

  return entry.missionId ? (
    <Link to={`/missions/${entry.missionId}`} className={`${shared} hover:bg-base-700/50`}>
      {body}
    </Link>
  ) : (
    <div className={shared}>{body}</div>
  );
}
