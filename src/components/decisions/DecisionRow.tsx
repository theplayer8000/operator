import type { DecisionRecord } from "@/lib/types";
import { VERDICT_META } from "./decisionMeta";

/**
 * One decision in the list.
 *
 * Shows the decision, when it was made, its verdict as a dot, and the first
 * line of the reasoning — enough to know whether this is the one you meant
 * without opening it.
 */
export default function DecisionRow({
  record,
  selected,
  onOpen,
}: {
  record: DecisionRecord;
  selected: boolean;
  onOpen: () => void;
}) {
  const verdict = VERDICT_META[record.verdict];

  return (
    <button
      onClick={onOpen}
      // 44px minimum, whole-row target — used from a phone.
      className={`w-full min-h-[44px] text-left px-3 py-3 rounded-badge border transition-colors ${
        selected ? "border-xp/45 bg-xp/[0.07]" : "border-base-600 bg-base-800 hover:border-base-500"
      } ${record.archived ? "opacity-55" : ""}`}
    >
      <div className="flex items-start gap-2.5">
        <span
          className={`mt-1.5 h-2 w-2 rounded-full shrink-0 ${verdict.dot}`}
          title={verdict.help}
          aria-label={verdict.label}
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <h3 className="text-sm text-ink-100 truncate">{record.title || "Untitled decision"}</h3>
            {record.archived && (
              <span className="text-[10px] font-mono text-ink-700 shrink-0">archived</span>
            )}
          </div>

          {record.reasoning && (
            <p className="text-xs text-ink-500 mt-1 line-clamp-2 break-words">
              {record.reasoning.slice(0, 180)}
            </p>
          )}

          <div className="flex items-center gap-2 mt-2 flex-wrap">
            <span className="text-[10px] font-mono text-ink-700">{record.decidedOn}</span>
            <span
              className={`h-6 px-2 rounded-badge border text-[10px] font-mono inline-flex items-center ${verdict.className}`}
            >
              {verdict.label}
            </span>
            {record.topics.slice(0, 3).map((t) => (
              <span key={t} className="text-[10px] font-mono text-ink-700">
                {t}
              </span>
            ))}
          </div>
        </div>
      </div>
    </button>
  );
}
