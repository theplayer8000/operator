import { useState } from "react";
import { StickyNote, Plus } from "lucide-react";
import Card from "@/components/ui/Card";
import EmptyState from "@/components/ui/EmptyState";
import type { QuickNote } from "@/lib/types";

export default function QuickNotes({
  notes,
  onAdd,
}: {
  notes: QuickNote[];
  onAdd: (text: string) => void;
}) {
  const [draft, setDraft] = useState("");

  function submit() {
    onAdd(draft);
    setDraft("");
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
              className="text-sm text-ink-300 bg-base-700/40 border border-base-600 rounded-badge px-3 py-2"
            >
              {n.text}
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
          className="flex-1 bg-transparent text-sm text-ink-100 placeholder:text-ink-700 outline-none py-1"
        />
        <button
          onClick={submit}
          className="w-7 h-7 rounded-badge bg-base-700 hover:bg-base-600 flex items-center justify-center text-ink-500 transition-colors"
        >
          <Plus size={14} />
        </button>
      </div>
    </Card>
  );
}
