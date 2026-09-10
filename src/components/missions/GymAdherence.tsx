import { Dumbbell } from "lucide-react";

/**
 * A read-only line on the gym mission: what this month's training says the
 * progress should be, and a one-tap way to apply it.
 *
 * ## Why it is here and not automatic
 *
 * `gym_log_session` (voice / a worker) moves the slider on every session
 * logged. A tap on the Gym page can't do that — features stay write-independent
 * (CLAUDE.md), the Gym feature never reaches into `missions.records`. So the
 * Gym-page path gets this instead: the number is derived live from
 * `useGym().monthAdherence()`, and Apply is the one place it's written, through
 * the mission's own mutator.
 *
 * ## Why not a second slider
 *
 * The progress field is one number, edited one way. This is a suggestion with a
 * reason attached, not a competing control — it shows only when it disagrees
 * with what's stored, and applying it is a normal progress write.
 */
export default function GymAdherence({
  trained,
  scheduled,
  percent,
  current,
  onApply,
}: {
  trained: number;
  scheduled: number;
  percent: number;
  current: number;
  onApply: () => void;
}) {
  const matches = percent === current;

  return (
    <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-badge border border-base-600 bg-base-700/30 px-3 py-2 text-xs">
      <span className="flex items-center gap-1.5 text-ink-500">
        <Dumbbell size={13} className="text-ink-700" />
        Training this month
      </span>
      {scheduled === 0 ? (
        <span className="font-mono text-ink-700">no sessions scheduled yet</span>
      ) : (
        <span className="font-mono text-ink-300">
          {trained}/{scheduled} · {percent}%
        </span>
      )}
      {scheduled > 0 && !matches && (
        <button
          onClick={onApply}
          className="ml-auto min-h-[32px] rounded-badge border border-xp/40 bg-xp/10 px-2.5 font-mono text-[11px] text-xp transition-colors hover:bg-xp/20"
        >
          Apply to progress
        </button>
      )}
      {scheduled > 0 && matches && (
        <span className="ml-auto font-mono text-[11px] text-ink-700">in step</span>
      )}
    </div>
  );
}
