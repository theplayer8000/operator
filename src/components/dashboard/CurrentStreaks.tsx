import { useState } from "react";
import { Flame, Pencil, Plus, Minus, Check, X, Zap, ZapOff } from "lucide-react";
import Card from "@/components/ui/Card";
import EmptyState from "@/components/ui/EmptyState";
import ConfirmButton from "@/components/ui/ConfirmButton";
import type { Streak } from "@/lib/types";

/**
 * Current Streaks — how many days a habit has held.
 *
 * ## Breaking a streak keeps the number
 *
 * "Broke it" greys the row but leaves the day count — a 40-day run that ended
 * is worth seeing, and the count is the record of it. Zeroing is a separate
 * edit. Same bargain the widget already made when it rendered a dead streak
 * with its days still showing.
 */
export default function CurrentStreaks({
  streaks,
  onAdd,
  onEdit,
  onBump,
  onSetAlive,
  onDelete,
}: {
  streaks: Streak[];
  onAdd: (label: string) => void;
  onEdit: (id: string, patch: Partial<Omit<Streak, "id">>) => void;
  onBump: (id: string, delta: number) => void;
  onSetAlive: (id: string, alive: boolean) => void;
  onDelete: (id: string) => void;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editLabel, setEditLabel] = useState("");
  const [draft, setDraft] = useState("");

  function startEdit(s: Streak) {
    setEditingId(s.id);
    setEditLabel(s.label);
  }

  function commitEdit() {
    if (editingId && editLabel.trim()) onEdit(editingId, { label: editLabel });
    setEditingId(null);
  }

  function submitAdd() {
    onAdd(draft);
    setDraft("");
  }

  return (
    <Card title="Current Streaks" icon={<Flame size={15} />} span={1}>
      {streaks.length === 0 ? (
        <EmptyState message="No streaks tracked. Add a habit you want to keep alive." />
      ) : (
        <div className="space-y-2 mb-3">
          {streaks.map((s) => (
            <div
              key={s.id}
              className={`flex items-center gap-2 rounded-badge border px-2.5 py-2 ${
                s.alive ? "border-vital-up/30 bg-vital-up/10" : "border-base-600 bg-base-700/30"
              }`}
            >
              <Flame
                size={14}
                className={`shrink-0 ${s.alive ? "text-vital-up" : "text-ink-700"}`}
                fill={s.alive ? "currentColor" : "none"}
              />

              {editingId === s.id ? (
                <input
                  autoFocus
                  value={editLabel}
                  onChange={(e) => setEditLabel(e.target.value)}
                  onBlur={commitEdit}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") commitEdit();
                    if (e.key === "Escape") setEditingId(null);
                  }}
                  className="min-w-0 flex-1 bg-base-700/40 border border-base-600 rounded-badge px-2 py-1 text-base sm:text-sm text-ink-100 outline-none focus:border-xp/50"
                />
              ) : (
                <>
                  <span className="min-w-0 flex-1 truncate text-xs text-ink-300">{s.label}</span>
                  <span
                    className={`shrink-0 font-mono text-sm ${s.alive ? "text-ink-100" : "text-ink-700"}`}
                  >
                    {s.days}d
                  </span>
                  <button
                    onClick={() => onBump(s.id, -1)}
                    disabled={s.days === 0}
                    aria-label={`Lower ${s.label}`}
                    className="h-8 w-8 shrink-0 flex items-center justify-center rounded-badge text-ink-500 hover:text-ink-200 disabled:opacity-30 transition-colors"
                  >
                    <Minus size={13} />
                  </button>
                  <button
                    onClick={() => onBump(s.id, 1)}
                    aria-label={`Add a day to ${s.label}`}
                    className="h-8 w-8 shrink-0 flex items-center justify-center rounded-badge text-ink-500 hover:text-vital-up transition-colors"
                  >
                    <Plus size={13} />
                  </button>
                  <button
                    onClick={() => onSetAlive(s.id, !s.alive)}
                    aria-label={s.alive ? `Mark ${s.label} broken` : `Revive ${s.label}`}
                    title={s.alive ? "Broke it" : "Revive"}
                    className={`h-8 w-8 shrink-0 flex items-center justify-center rounded-badge transition-colors ${
                      s.alive
                        ? "text-ink-700 hover:text-vital-down"
                        : "text-ink-700 hover:text-vital-up"
                    }`}
                  >
                    {s.alive ? <ZapOff size={13} /> : <Zap size={13} />}
                  </button>
                  <button
                    onClick={() => startEdit(s)}
                    aria-label={`Edit ${s.label}`}
                    title="Edit"
                    className="h-8 w-8 shrink-0 flex items-center justify-center rounded-badge text-ink-700 hover:text-ink-300 transition-colors"
                  >
                    <Pencil size={12} />
                  </button>
                  <ConfirmButton onConfirm={() => onDelete(s.id)} label={`Delete ${s.label}`} compact />
                </>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="mt-auto flex items-center gap-2 border-t border-base-600 pt-2">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submitAdd()}
          placeholder="Track a habit…"
          className="min-w-0 flex-1 bg-transparent text-base sm:text-sm text-ink-100 placeholder:text-ink-700 outline-none py-1"
        />
        <button
          onClick={submitAdd}
          aria-label="Add streak"
          className="h-11 w-11 shrink-0 rounded-badge bg-base-700 hover:bg-base-600 flex items-center justify-center text-ink-500 transition-colors"
        >
          <Plus size={16} />
        </button>
      </div>
    </Card>
  );
}
