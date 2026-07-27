import type { Milestone } from "@/lib/types";

const STATUS_DOT: Record<Milestone["status"], string> = {
  pending: "bg-base-600 border-base-500",
  in_progress: "bg-rank/20 border-rank",
  complete: "bg-vital-up/20 border-vital-up",
};

export default function MilestoneTimeline({ milestones }: { milestones: Milestone[] }) {
  if (milestones.length === 0) {
    return <p className="text-sm text-ink-700">No milestones to plot yet.</p>;
  }

  // Completed items first by completion date, then pending/in-progress in list order.
  const sorted = [...milestones].sort((a, b) => {
    if (a.completionDate && b.completionDate) {
      return a.completionDate.localeCompare(b.completionDate);
    }
    if (a.completionDate) return -1;
    if (b.completionDate) return 1;
    return 0;
  });

  return (
    <div>
      {sorted.map((m, i) => (
        <div key={m.id} className="flex gap-3">
          <div className="flex flex-col items-center">
            <span className={`w-3 h-3 rounded-full border-2 shrink-0 mt-1 ${STATUS_DOT[m.status]}`} />
            {i < sorted.length - 1 && <div className="w-px flex-1 bg-base-600 my-1" />}
          </div>
          <div className="pb-5 min-w-0">
            <p className="text-sm text-ink-100">{m.title}</p>
            <p className="text-xs text-ink-700 font-mono mt-0.5">
              {m.completionDate
                ? new Date(m.completionDate).toLocaleDateString("en-GB", {
                    day: "numeric",
                    month: "short",
                    year: "numeric",
                  })
                : `Est. ${m.estimatedDuration}`}
            </p>
          </div>
        </div>
      ))}
    </div>
  );
}
