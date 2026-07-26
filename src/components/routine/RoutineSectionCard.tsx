import { useState } from "react";
import { NotebookPen, Plus, Repeat, Clock } from "lucide-react";
import type { RoutineSection, RoutineSectionKey } from "@/lib/types";
import { ROUTINE_META } from "./routineMeta";

export default function RoutineSectionCard({
  section,
  isLast,
  onToggleTask,
  onAddTask,
  onToggleRepeat,
  onNotesChange,
}: {
  section: RoutineSection;
  isLast: boolean;
  onToggleTask: (key: RoutineSectionKey, taskId: string) => void;
  onAddTask: (key: RoutineSectionKey, title: string) => void;
  onToggleRepeat: (key: RoutineSectionKey, taskId: string) => void;
  onNotesChange: (key: RoutineSectionKey, notes: string) => void;
}) {
  const [draft, setDraft] = useState("");
  const [notesOpen, setNotesOpen] = useState(section.notes.length > 0);
  const { icon: Icon, caption } = ROUTINE_META[section.key];

  const totalMinutes = section.tasks.reduce((a, t) => a + t.estimatedMinutes, 0);
  const doneCount = section.tasks.filter((t) => t.done).length;
  const complete = section.tasks.length > 0 && doneCount === section.tasks.length;

  function submit() {
    onAddTask(section.key, draft);
    setDraft("");
  }

  return (
    <div className="flex gap-4">
      {/* rail */}
      <div className="flex flex-col items-center shrink-0 w-9">
        <div
          className={`w-9 h-9 rounded-badge border flex items-center justify-center transition-colors ${
            complete
              ? "bg-xp/15 border-xp/40 text-xp"
              : "bg-base-800 border-base-600 text-ink-500"
          }`}
        >
          <Icon size={16} />
        </div>
        {!isLast && <div className="w-px flex-1 bg-base-600 my-1" />}
      </div>

      {/* card */}
      <div className="card-base p-5 flex-1 mb-4 animate-fade-up">
        <header className="flex items-center justify-between mb-4">
          <div>
            <h3 className="font-display text-sm font-medium text-ink-100">{section.label}</h3>
            <p className="text-xs text-ink-700">{caption}</p>
          </div>
          <div className="flex items-center gap-3 text-xs text-ink-500 font-mono">
            <span className="flex items-center gap-1">
              <Clock size={12} /> {totalMinutes}m
            </span>
            <span>
              {doneCount}/{section.tasks.length}
            </span>
            <button
              onClick={() => setNotesOpen((v) => !v)}
              className={`w-7 h-7 rounded-badge flex items-center justify-center border transition-colors ${
                notesOpen
                  ? "border-xp/40 text-xp bg-xp/10"
                  : "border-base-600 text-ink-700 hover:text-ink-300"
              }`}
              title="Notes"
            >
              <NotebookPen size={13} />
            </button>
          </div>
        </header>

        {section.tasks.length === 0 ? (
          <p className="text-sm text-ink-700 mb-3">No steps yet — add the first one below.</p>
        ) : (
          <ul className="space-y-1 mb-3">
            {section.tasks.map((t) => (
              <li
                key={t.id}
                className="group flex items-center gap-2.5 px-2 py-1.5 rounded-badge hover:bg-base-700/50 transition-colors"
              >
                <button
                  onClick={() => onToggleTask(section.key, t.id)}
                  className={`w-4 h-4 rounded-[5px] border flex items-center justify-center shrink-0 transition-colors ${
                    t.done ? "bg-xp border-xp" : "border-base-500 group-hover:border-ink-500"
                  }`}
                >
                  {t.done && <span className="w-1.5 h-1.5 bg-base-950 rounded-[2px]" />}
                </button>
                <span
                  className={`flex-1 text-sm truncate ${
                    t.done ? "line-through text-ink-700" : "text-ink-300"
                  }`}
                >
                  {t.title}
                </span>
                {t.estimatedMinutes > 0 && (
                  <span className="text-[11px] font-mono text-ink-700 shrink-0">
                    {t.estimatedMinutes}m
                  </span>
                )}
                <button
                  onClick={() => onToggleRepeat(section.key, t.id)}
                  className={`shrink-0 transition-colors ${
                    t.repeatDaily ? "text-rank" : "text-ink-700 opacity-0 group-hover:opacity-100"
                  }`}
                  title={t.repeatDaily ? "Repeats daily" : "One-off today"}
                >
                  <Repeat size={12} />
                </button>
              </li>
            ))}
          </ul>
        )}

        <div className="flex items-center gap-2 pt-2 border-t border-base-600">
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submit()}
            placeholder="Add a step..."
            className="flex-1 bg-transparent text-sm text-ink-100 placeholder:text-ink-700 outline-none py-1"
          />
          <button
            onClick={submit}
            className="w-7 h-7 rounded-badge bg-base-700 hover:bg-base-600 flex items-center justify-center text-ink-500 transition-colors"
          >
            <Plus size={14} />
          </button>
        </div>

        {notesOpen && (
          <textarea
            value={section.notes}
            onChange={(e) => onNotesChange(section.key, e.target.value)}
            placeholder="Notes for this section..."
            rows={2}
            className="w-full mt-3 bg-base-700/40 border border-base-600 rounded-badge px-3 py-2 text-sm text-ink-300 placeholder:text-ink-700 outline-none focus:border-xp/50 resize-none"
          />
        )}
      </div>
    </div>
  );
}
