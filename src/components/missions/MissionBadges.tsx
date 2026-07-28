import type { MissionDifficulty, MissionStatus } from "@/lib/types";

const STATUS_META: Record<MissionStatus, { label: string; dot: string }> = {
  not_started: { label: "Not Started", dot: "bg-ink-700" },
  in_progress: { label: "In Progress", dot: "bg-rank" },
  blocked: { label: "Blocked", dot: "bg-vital-down" },
  complete: { label: "Complete", dot: "bg-vital-up" },
};

/**
 * The same four status colours as hex, for Recharts — which paints to SVG and
 * cannot take a Tailwind class. Keep these in step with `dot` above; they are
 * the token values from tailwind.config.ts (ink-700, rank, vital-down,
 * vital-up), not new colours.
 */
const STATUS_HEX: Record<MissionStatus, string> = {
  not_started: "#5C6577",
  in_progress: "#8D7FE0",
  blocked: "#D9685F",
  complete: "#4FB477",
};

const DIFFICULTY_META: Record<MissionDifficulty, { label: string; pips: number }> = {
  easy: { label: "Easy", pips: 1 },
  moderate: { label: "Moderate", pips: 2 },
  hard: { label: "Hard", pips: 3 },
  epic: { label: "Epic", pips: 4 },
};

export function StatusBadge({ status }: { status: MissionStatus }) {
  const { label, dot } = STATUS_META[status];
  return (
    <span className="inline-flex items-center gap-1.5 px-2 py-1 rounded-badge border border-base-600 bg-base-700/50 text-xs text-ink-300">
      <span className={`w-1.5 h-1.5 rounded-full ${dot}`} />
      {label}
    </span>
  );
}

export function DifficultyPips({ difficulty }: { difficulty: MissionDifficulty }) {
  const { label, pips } = DIFFICULTY_META[difficulty];
  return (
    <span className="inline-flex items-center gap-2 text-xs text-ink-500" title={label}>
      <span className="flex gap-0.5">
        {[0, 1, 2, 3].map((i) => (
          <span
            key={i}
            className={`w-1.5 h-1.5 rounded-full ${i < pips ? "bg-ink-300" : "bg-base-600"}`}
          />
        ))}
      </span>
      {label}
    </span>
  );
}

export const STATUS_OPTIONS: MissionStatus[] = ["not_started", "in_progress", "blocked", "complete"];
export const DIFFICULTY_OPTIONS: MissionDifficulty[] = ["easy", "moderate", "hard", "epic"];
export { STATUS_META, STATUS_HEX, DIFFICULTY_META };
