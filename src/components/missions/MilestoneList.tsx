import { useState } from "react";
import { Plus } from "lucide-react";
import type { Milestone, MilestoneStatus } from "@/lib/types";

const STATUS_OPTIONS: MilestoneStatus[] = ["pending", "in_progress", "complete"];
const STATUS_LABEL: Record<MilestoneStatus, string> = {
  pending: "Pending",
  in_progress: "In Progress",
  complete: "Complete",
};
const STATUS_DOT: Record<MilestoneStatus, string> = {
  pending: "bg-ink-700",
  in_progress: "bg-rank",
  complete: "bg-vital-up",
};

export default function MilestoneList({
  milestones,
  onAdd,
  onUpdate,
}: {
  milestones: Milestone[];
  onAdd: (m: Omit<Milestone, "id">) => void;
  onUpdate: (id: string, patch: Partial<Milestone>) => void;
}) {
  const [title, setTitle] = useState("");
  const [duration, setDuration] = useState("");

  function submit() {
    if (!title.trim()) return;
    onAdd({
      title: title.trim(),
      description: "",
      status: "pending",
      progress: 0,
      estimatedDuration: duration.trim() || "—",
      notes: "",
    });
    setTitle("");
    setDuration("");
  }

  function setStatus(id: string, status: MilestoneStatus) {
    // Build the patch key by key. A key present with the value `undefined`
    // still overwrites when the hook spreads it, so "leave this alone" has to
    // mean "omit the key" — not "pass undefined".
    const patch: Partial<Milestone> = { status };

    if (status === "complete") {
      patch.progress = 100;
      patch.completionDate = new Date().toISOString();
    } else {
      // Un-completing clears the date; this undefined IS meant to overwrite.
      patch.completionDate = undefined;
      // "In progress" keeps whatever progress the milestone already had.
      if (status === "pending") patch.progress = 0;
    }

    onUpdate(id, patch);
  }

  return (
    <div>
      {milestones.length === 0 ? (
        <p className="text-sm text-ink-700 mb-4">No milestones yet.</p>
      ) : (
        <ul className="space-y-3 mb-4">
          {milestones.map((m) => (
            <li key={m.id} className="p-3 rounded-badge border border-base-600 bg-base-700/30">
              <div className="flex items-center justify-between gap-3 mb-2">
                <div className="flex items-center gap-2 min-w-0">
                  <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${STATUS_DOT[m.status]}`} />
                  <span className="text-sm text-ink-100 truncate">{m.title}</span>
                </div>
                <select
                  value={m.status}
                  onChange={(e) => setStatus(m.id, e.target.value as MilestoneStatus)}
                  className="bg-base-800 border border-base-600 rounded-badge px-2 min-h-[38px] text-base sm:text-xs text-ink-300 outline-none focus:border-xp/50 shrink-0"
                >
                  {STATUS_OPTIONS.map((s) => (
                    <option key={s} value={s}>
                      {STATUS_LABEL[s]}
                    </option>
                  ))}
                </select>
              </div>
              <div className="h-1 bg-base-700 rounded-full overflow-hidden mb-2">
                <div
                  className="h-full bg-xp rounded-full transition-all duration-500"
                  style={{ width: `${m.progress}%` }}
                />
              </div>
              <div className="flex items-center justify-between text-xs text-ink-700 font-mono">
                <span>{m.estimatedDuration}</span>
                {m.completionDate && (
                  <span>done {new Date(m.completionDate).toLocaleDateString("en-GB")}</span>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      <div className="flex items-center gap-2 pt-2 border-t border-base-600">
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
          placeholder="Milestone title"
          className="flex-1 min-w-0 bg-transparent text-base sm:text-sm text-ink-100 placeholder:text-ink-700 outline-none py-1"
        />
        <input
          value={duration}
          onChange={(e) => setDuration(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
          placeholder="Est. duration"
          className="w-24 sm:w-28 shrink-0 bg-transparent text-base sm:text-sm text-ink-100 placeholder:text-ink-700 outline-none py-1 border-l border-base-600 pl-2"
        />
        <button
          onClick={submit}
          aria-label="Add milestone"
          className="w-11 h-11 rounded-badge bg-base-700 hover:bg-base-600 flex items-center justify-center text-ink-500 transition-colors shrink-0"
        >
          <Plus size={16} />
        </button>
      </div>
    </div>
  );
}
