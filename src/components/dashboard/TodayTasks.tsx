import { useState } from "react";
import { ListChecks, Pencil, Plus } from "lucide-react";
import Card from "@/components/ui/Card";
import EmptyState from "@/components/ui/EmptyState";
import Confetti from "@/components/ui/Confetti";
import ConfirmButton from "@/components/ui/ConfirmButton";
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
  onEdit,
  onDelete,
}: {
  tasks: Task[];
  onToggle: (id: string) => void;
  onAdd: (title: string) => void;
  onEdit: (id: string, title: string) => void;
  onDelete: (id: string) => void;
}) {
  const [draft, setDraft] = useState("");
  const [burst, setBurst] = useState(0);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");

  function handleToggle(t: Task) {
    onToggle(t.id);
    if (!t.done) setBurst((b) => b + 1);
  }

  function submit() {
    onAdd(draft);
    setDraft("");
  }

  function startEdit(t: Task) {
    setEditingId(t.id);
    setEditDraft(t.title);
  }

  function commitEdit() {
    if (editingId) onEdit(editingId, editDraft);
    setEditingId(null);
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
              {editingId === t.id ? (
                <div className="flex items-center gap-2 px-2 min-h-[44px]">
                  <input
                    autoFocus
                    value={editDraft}
                    onChange={(e) => setEditDraft(e.target.value)}
                    onBlur={commitEdit}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") commitEdit();
                      if (e.key === "Escape") setEditingId(null);
                    }}
                    className="flex-1 min-w-0 bg-base-700/40 border border-base-600 rounded-badge px-2 py-1.5 text-base sm:text-sm text-ink-100 outline-none focus:border-xp/50"
                  />
                </div>
              ) : (
                <div className="group flex items-center gap-1 rounded-badge hover:bg-base-700/60 transition-colors">
                  <button
                    onClick={() => handleToggle(t)}
                    className="flex flex-1 min-w-0 items-center gap-2.5 text-left px-2 min-h-[44px]"
                  >
                    <span
                      className={`w-5 h-5 rounded-[6px] border flex items-center justify-center shrink-0 transition-colors ${
                        t.done ? "bg-xp border-xp" : "border-base-500 group-hover:border-ink-500"
                      }`}
                    >
                      {t.done && <span className="w-2 h-2 bg-base-950 rounded-[2px]" />}
                    </span>
                    <span
                      className={`w-1.5 h-1.5 rounded-full shrink-0 ${PRIORITY_DOT[t.priority]}`}
                    />
                    <span
                      className={`flex-1 text-sm truncate ${
                        t.done ? "line-through text-ink-700" : "text-ink-300"
                      }`}
                    >
                      {t.title}
                    </span>
                  </button>
                  <button
                    onClick={() => startEdit(t)}
                    aria-label={`Edit "${t.title}"`}
                    title="Edit"
                    className="w-11 h-11 shrink-0 flex items-center justify-center rounded-badge text-ink-700 hover:text-ink-300 transition-colors"
                  >
                    <Pencil size={14} />
                  </button>
                  <ConfirmButton onConfirm={() => onDelete(t.id)} label={`Delete "${t.title}"`} />
                </div>
              )}
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
