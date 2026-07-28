import { useState } from "react";
import { NotebookPen, Pencil, Plus, Repeat, Clock, Check, X } from "lucide-react";
import ConfirmButton from "@/components/ui/ConfirmButton";
import type { RoutineSection, RoutineSectionKey } from "@/lib/types";
import { ROUTINE_META } from "./routineMeta";

export default function RoutineSectionCard({
  section,
  isLast,
  onToggleTask,
  onAddTask,
  onEditTask,
  onDeleteTask,
  onToggleRepeat,
  onNotesChange,
}: {
  section: RoutineSection;
  isLast: boolean;
  onToggleTask: (key: RoutineSectionKey, taskId: string) => void;
  onAddTask: (key: RoutineSectionKey, title: string) => void;
  onEditTask: (
    key: RoutineSectionKey,
    taskId: string,
    patch: { title?: string; estimatedMinutes?: number }
  ) => void;
  onDeleteTask: (key: RoutineSectionKey, taskId: string) => void;
  onToggleRepeat: (key: RoutineSectionKey, taskId: string) => void;
  onNotesChange: (key: RoutineSectionKey, notes: string) => void;
}) {
  const [draft, setDraft] = useState("");
  const [notesOpen, setNotesOpen] = useState(section.notes.length > 0);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editMinutes, setEditMinutes] = useState("");
  const { icon: Icon, caption } = ROUTINE_META[section.key];

  const totalMinutes = section.tasks.reduce((a, t) => a + t.estimatedMinutes, 0);
  const doneCount = section.tasks.filter((t) => t.done).length;
  const complete = section.tasks.length > 0 && doneCount === section.tasks.length;

  function submit() {
    onAddTask(section.key, draft);
    setDraft("");
  }

  function startEdit(taskId: string, title: string, minutes: number) {
    setEditingId(taskId);
    setEditTitle(title);
    setEditMinutes(String(minutes));
  }

  function commitEdit(taskId: string) {
    const minutes = Number(editMinutes);
    onEditTask(section.key, taskId, {
      title: editTitle,
      // An empty or non-numeric box means "leave the estimate alone", which
      // has to be an omitted key rather than an undefined one.
      ...(editMinutes.trim() !== "" && Number.isFinite(minutes)
        ? { estimatedMinutes: minutes }
        : {}),
    });
    setEditingId(null);
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
      <div className="card-base p-4 sm:p-5 flex-1 min-w-0 mb-4 animate-fade-up">
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
              aria-label="Section notes"
              className={`w-9 h-9 shrink-0 rounded-badge flex items-center justify-center border transition-colors ${
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
            {section.tasks.map((t) =>
              editingId === t.id ? (
                /*
                  Edit mode replaces the row rather than adding two more
                  controls to it. A routine row already carries a checkbox, a
                  minute estimate and the repeat toggle; on a 390px phone a
                  fourth and fifth target leaves no room for the title. Delete
                  lives in here for the same reason — and being one step in
                  suits it, since it is the destructive one.
                */
                <li
                  key={t.id}
                  className="flex items-center gap-2 pl-2 py-2 rounded-badge bg-base-700/40 border border-base-600"
                >
                  <input
                    autoFocus
                    value={editTitle}
                    onChange={(e) => setEditTitle(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") commitEdit(t.id);
                      if (e.key === "Escape") setEditingId(null);
                    }}
                    aria-label="Step title"
                    className="flex-1 min-w-0 bg-transparent text-base sm:text-sm text-ink-100 outline-none"
                  />
                  <input
                    value={editMinutes}
                    onChange={(e) => setEditMinutes(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") commitEdit(t.id);
                      if (e.key === "Escape") setEditingId(null);
                    }}
                    inputMode="numeric"
                    aria-label="Estimated minutes"
                    className="w-12 shrink-0 bg-transparent text-base sm:text-sm font-mono text-ink-300 outline-none border-l border-base-600 pl-2"
                  />
                  <button
                    onClick={() => commitEdit(t.id)}
                    aria-label="Save step"
                    title="Save"
                    className="w-11 h-11 shrink-0 flex items-center justify-center rounded-badge text-xp hover:bg-base-700 transition-colors"
                  >
                    <Check size={15} />
                  </button>
                  <button
                    onClick={() => setEditingId(null)}
                    aria-label="Cancel"
                    title="Cancel"
                    className="w-11 h-11 shrink-0 flex items-center justify-center rounded-badge text-ink-700 hover:text-ink-300 transition-colors"
                  >
                    <X size={15} />
                  </button>
                  <ConfirmButton
                    onConfirm={() => {
                      setEditingId(null);
                      onDeleteTask(section.key, t.id);
                    }}
                    label={`Delete "${t.title}"`}
                  />
                </li>
              ) : (
              <li
                key={t.id}
                className="group flex items-center gap-1 pl-2 rounded-badge hover:bg-base-700/50 transition-colors"
              >
                <button
                  onClick={() => onToggleTask(section.key, t.id)}
                  className="flex flex-1 min-w-0 items-center gap-2.5 min-h-[44px] text-left"
                >
                  <span
                    className={`w-5 h-5 rounded-[6px] border flex items-center justify-center shrink-0 transition-colors ${
                      t.done ? "bg-xp border-xp" : "border-base-500 group-hover:border-ink-500"
                    }`}
                  >
                    {t.done && <span className="w-2 h-2 bg-base-950 rounded-[2px]" />}
                  </span>
                  <span
                    className={`flex-1 text-sm truncate ${
                      t.done ? "line-through text-ink-700" : "text-ink-300"
                    }`}
                  >
                    {t.title}
                  </span>
                </button>
                {t.estimatedMinutes > 0 && (
                  <span className="text-[11px] font-mono text-ink-700 shrink-0">
                    {t.estimatedMinutes}m
                  </span>
                )}
                {/*
                  Always rendered, never hover-gated. This used to be
                  opacity-0 group-hover:opacity-100, which made it invisible
                  and unreachable on touch — a core workflow that required a
                  desktop, contradicting vision.md.
                */}
                <button
                  onClick={() => onToggleRepeat(section.key, t.id)}
                  aria-pressed={t.repeatDaily}
                  className={`shrink-0 w-11 h-11 flex items-center justify-center transition-colors ${
                    t.repeatDaily ? "text-rank" : "text-ink-700 hover:text-ink-500"
                  }`}
                  title={t.repeatDaily ? "Repeats daily" : "One-off today"}
                >
                  <Repeat size={14} />
                </button>
                <button
                  onClick={() => startEdit(t.id, t.title, t.estimatedMinutes)}
                  aria-label={`Edit "${t.title}"`}
                  title="Edit"
                  className="shrink-0 w-11 h-11 flex items-center justify-center text-ink-700 hover:text-ink-300 transition-colors"
                >
                  <Pencil size={14} />
                </button>
              </li>
              )
            )}
          </ul>
        )}

        <div className="flex items-center gap-2 pt-2 border-t border-base-600">
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submit()}
            placeholder="Add a step..."
            className="flex-1 min-w-0 bg-transparent text-base sm:text-sm text-ink-100 placeholder:text-ink-700 outline-none py-1"
          />
          <button
            onClick={submit}
            aria-label="Add step"
            className="w-11 h-11 shrink-0 rounded-badge bg-base-700 hover:bg-base-600 flex items-center justify-center text-ink-500 transition-colors"
          >
            <Plus size={16} />
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
