import { useState } from "react";
import { ListChecks, Plus } from "lucide-react";
import Card from "@/components/ui/Card";
import EmptyState from "@/components/ui/EmptyState";
import Confetti from "@/components/ui/Confetti";
import type { Task } from "@/lib/types";

const PRIORITY_DOT: Record<Task["priority"], string> = {
  high: "bg-vital-down",
  medium: "bg-xp",
  low: "bg-ink-700",
};

export default function TodayTasks({
  tasks,
  onToggle,
  onAdd,
}: {
  tasks: Task[];
  onToggle: (id: string) => void;
  onAdd: (title: string) => void;
}) {
  const [draft, setDraft] = useState("");
  const [burst, setBurst] = useState(0);

  function handleToggle(t: Task) {
    onToggle(t.id);
    if (!t.done) setBurst((b) => b + 1);
  }

  function submit() {
    onAdd(draft);
    setDraft("");
  }

  const remaining = tasks.filter((t) => !t.done).length;

  return (
    <Card
      title="Today's Tasks"
      icon={<ListChecks size={15} />}
      span={1}
      action={<span className="text-xs font-mono text-ink-700">{remaining} left</span>}
    >
      {burst > 0 && <Confetti key={burst} />}
      {tasks.length === 0 ? (
        <EmptyState message="Nothing queued — add your first task below." />
      ) : (
        <ul className="space-y-1.5 mb-3">
          {tasks.map((t) => (
            <li key={t.id}>
              <button
                onClick={() => handleToggle(t)}
                className="w-full flex items-center gap-2.5 group text-left px-2 min-h-[44px] rounded-badge hover:bg-base-700/60 transition-colors"
              >
                <span
                  className={`w-5 h-5 rounded-[6px] border flex items-center justify-center shrink-0 transition-colors ${
                    t.done ? "bg-xp border-xp" : "border-base-500 group-hover:border-ink-500"
                  }`}
                >
                  {t.done && <span className="w-2 h-2 bg-base-950 rounded-[2px]" />}
                </span>
                <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${PRIORITY_DOT[t.priority]}`} />
                <span
                  className={`text-sm truncate ${
                    t.done ? "line-through text-ink-700" : "text-ink-300"
                  }`}
                >
                  {t.title}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="flex items-center gap-2 mt-auto pt-2 border-t border-base-600">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
          placeholder="Add a task..."
          className="flex-1 min-w-0 bg-transparent text-base sm:text-sm text-ink-100 placeholder:text-ink-700 outline-none py-1"
        />
        <button
          onClick={submit}
          aria-label="Add task"
          className="w-11 h-11 shrink-0 rounded-badge bg-base-700 hover:bg-base-600 flex items-center justify-center text-ink-500 transition-colors"
        >
          <Plus size={16} />
        </button>
      </div>
    </Card>
  );
}
