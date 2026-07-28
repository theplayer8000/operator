import { useState } from "react";
import { StickyNote, Pencil, Plus } from "lucide-react";
import Card from "@/components/ui/Card";
import EmptyState from "@/components/ui/EmptyState";
import ConfirmButton from "@/components/ui/ConfirmButton";
import type { QuickNote } from "@/lib/types";

export default function QuickNotes({
  notes,
  onAdd,
  onEdit,
  onDelete,
}: {
  notes: QuickNote[];
  onAdd: (text: string) => void;
  onEdit: (id: string, text: string) => void;
  onDelete: (id: string) => void;
}) {
  const [draft, setDraft] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");

  function submit() {
    onAdd(draft);
    setDraft("");
  }

  function startEdit(n: QuickNote) {
    setEditingId(n.id);
    setEditDraft(n.text);
  }

  function commitEdit() {
    if (editingId) onEdit(editingId, editDraft);
    setEditingId(null);
  }

  return (
    <Card title="Quick Notes" icon={<StickyNote size={15} />} span={1}>
      {notes.length === 0 ? (
        <EmptyState message="Capture a stray thought before it's gone." />
      ) : (
        <ul className="space-y-2 mb-3 max-h-40 overflow-y-auto scrollbar-none">
          {notes.map((n) => (
            <li
              key={n.id}
              className="bg-base-700/40 border border-base-600 rounded-badge px-3 py-2"
            >
              {editingId === n.id ? (
                <textarea
                  autoFocus
                  value={editDraft}
                  onChange={(e) => setEditDraft(e.target.value)}
                  onBlur={commitEdit}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      commitEdit();
                    }
                    if (e.key === "Escape") setEditingId(null);
                  }}
                  rows={2}
                  className="w-full bg-transparent text-base sm:text-sm text-ink-100 outline-none resize-none"
                />
              ) : (
                <div className="flex items-start gap-1">
                  <p className="flex-1 min-w-0 text-sm text-ink-300 break-words py-1.5">{n.text}</p>
                  <button
                    onClick={() => startEdit(n)}
                    aria-label="Edit note"
                    title="Edit"
                    className="w-9 h-9 shrink-0 flex items-center justify-center rounded-badge text-ink-700 hover:text-ink-300 transition-colors"
                  >
                    <Pencil size={13} />
                  </button>
                  <ConfirmButton onConfirm={() => onDelete(n.id)} label="Delete note" compact />
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
          placeholder="Jot something down..."
          className="flex-1 min-w-0 bg-transparent text-base sm:text-sm text-ink-100 placeholder:text-ink-700 outline-none py-1"
        />
        <button
          onClick={submit}
          aria-label="Add note"
          className="w-11 h-11 shrink-0 rounded-badge bg-base-700 hover:bg-base-600 flex items-center justify-center text-ink-500 transition-colors"
        >
          <Plus size={16} />
        </button>
      </div>
    </Card>
  );
}
