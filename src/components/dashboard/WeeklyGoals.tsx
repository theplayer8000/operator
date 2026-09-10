import { useState } from "react";
import { CalendarRange, Pencil, Plus, Minus, Check, X } from "lucide-react";
import Card from "@/components/ui/Card";
import EmptyState from "@/components/ui/EmptyState";
import ConfirmButton from "@/components/ui/ConfirmButton";
import type { WeeklyGoal } from "@/lib/types";

/**
 * Weekly Goals — hand-tracked counters towards a target.
 *
 * ## The −/+ is the point
 *
 * The daily operation on a goal is "I did one more" — bumping `current` by one.
 * That gets an always-visible stepper; everything else (renaming, moving the
 * target, resetting for a new week) is behind the pencil. Same "one tap for the
 * common thing, expand for the rest" split the Gym mission's adherence line
 * uses.
 */
export default function WeeklyGoals({
  goals,
  onAdd,
  onEdit,
  onBump,
  onDelete,
}: {
  goals: WeeklyGoal[];
  onAdd: (input: { label: string; target: number; unit: string }) => void;
  onEdit: (id: string, patch: Partial<Omit<WeeklyGoal, "id">>) => void;
  onBump: (id: string, delta: number) => void;
  onDelete: (id: string) => void;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<{ label: string; target: string; unit: string }>({
    label: "",
    target: "",
    unit: "",
  });
  const [adding, setAdding] = useState({ label: "", target: "", unit: "" });

  function startEdit(g: WeeklyGoal) {
    setEditingId(g.id);
    setDraft({ label: g.label, target: String(g.target), unit: g.unit });
  }

  function commitEdit() {
    if (!editingId) return;
    onEdit(editingId, {
      label: draft.label,
      target: Number(draft.target) || 1,
      unit: draft.unit,
    });
    setEditingId(null);
  }

  function submitAdd() {
    if (!adding.label.trim()) return;
    onAdd({ label: adding.label, target: Number(adding.target) || 1, unit: adding.unit });
    setAdding({ label: "", target: "", unit: "" });
  }

  return (
    <Card title="Weekly Goals" icon={<CalendarRange size={15} />} span={1}>
      {goals.length === 0 ? (
        <EmptyState message="No goals set. Add one below — study hours, gym sessions, whatever the week is for." />
      ) : (
        <div className="space-y-3.5 mb-3">
          {goals.map((g) => {
            const pct = Math.min(100, Math.round((g.current / Math.max(1, g.target)) * 100));

            if (editingId === g.id) {
              return (
                <div key={g.id} className="space-y-2 rounded-badge border border-base-600 p-2">
                  <input
                    autoFocus
                    value={draft.label}
                    onChange={(e) => setDraft((d) => ({ ...d, label: e.target.value }))}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") commitEdit();
                      if (e.key === "Escape") setEditingId(null);
                    }}
                    placeholder="Goal"
                    className="w-full bg-base-700/40 border border-base-600 rounded-badge px-2 py-1.5 text-base sm:text-sm text-ink-100 outline-none focus:border-xp/50"
                  />
                  <div className="flex items-center gap-2">
                    <input
                      type="number"
                      min={1}
                      value={draft.target}
                      onChange={(e) => setDraft((d) => ({ ...d, target: e.target.value }))}
                      placeholder="Target"
                      className="w-20 bg-base-700/40 border border-base-600 rounded-badge px-2 py-1.5 text-base sm:text-sm text-ink-100 font-mono outline-none focus:border-xp/50"
                    />
                    <input
                      value={draft.unit}
                      onChange={(e) => setDraft((d) => ({ ...d, unit: e.target.value }))}
                      placeholder="unit (h, km…)"
                      className="flex-1 min-w-0 bg-base-700/40 border border-base-600 rounded-badge px-2 py-1.5 text-base sm:text-sm text-ink-100 font-mono outline-none focus:border-xp/50"
                    />
                    <button
                      onClick={commitEdit}
                      aria-label="Save goal"
                      className="h-11 w-11 shrink-0 flex items-center justify-center rounded-badge text-vital-up hover:bg-vital-up/10 transition-colors"
                    >
                      <Check size={16} />
                    </button>
                    <button
                      onClick={() => setEditingId(null)}
                      aria-label="Cancel"
                      className="h-11 w-11 shrink-0 flex items-center justify-center rounded-badge text-ink-700 hover:text-ink-300 transition-colors"
                    >
                      <X size={16} />
                    </button>
                  </div>
                </div>
              );
            }

            return (
              <div key={g.id}>
                <div className="flex items-center justify-between gap-2 text-xs mb-1.5">
                  <span className="truncate text-ink-300">{g.label}</span>
                  <span className="shrink-0 font-mono text-ink-500">
                    {g.current}
                    {g.unit} / {g.target}
                    {g.unit}
                  </span>
                </div>
                <div className="flex items-center gap-1.5">
                  <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-base-700">
                    <div
                      className="h-full rounded-full bg-xp transition-all duration-500"
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                  <button
                    onClick={() => onBump(g.id, -1)}
                    disabled={g.current === 0}
                    aria-label={`Lower ${g.label}`}
                    className="h-8 w-8 shrink-0 flex items-center justify-center rounded-badge text-ink-500 hover:text-ink-200 disabled:opacity-30 transition-colors"
                  >
                    <Minus size={14} />
                  </button>
                  <button
                    onClick={() => onBump(g.id, 1)}
                    aria-label={`Raise ${g.label}`}
                    className="h-8 w-8 shrink-0 flex items-center justify-center rounded-badge text-ink-500 hover:text-xp transition-colors"
                  >
                    <Plus size={14} />
                  </button>
                  <button
                    onClick={() => startEdit(g)}
                    aria-label={`Edit ${g.label}`}
                    title="Edit"
                    className="h-8 w-8 shrink-0 flex items-center justify-center rounded-badge text-ink-700 hover:text-ink-300 transition-colors"
                  >
                    <Pencil size={13} />
                  </button>
                  <ConfirmButton onConfirm={() => onDelete(g.id)} label={`Delete ${g.label}`} compact />
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div className="mt-auto flex flex-wrap items-center gap-2 border-t border-base-600 pt-2">
        <input
          value={adding.label}
          onChange={(e) => setAdding((a) => ({ ...a, label: e.target.value }))}
          onKeyDown={(e) => e.key === "Enter" && submitAdd()}
          placeholder="New goal…"
          className="min-w-0 flex-1 bg-transparent text-base sm:text-sm text-ink-100 placeholder:text-ink-700 outline-none py-1"
        />
        <input
          type="number"
          min={1}
          value={adding.target}
          onChange={(e) => setAdding((a) => ({ ...a, target: e.target.value }))}
          onKeyDown={(e) => e.key === "Enter" && submitAdd()}
          placeholder="target"
          className="w-16 bg-base-700/40 border border-base-600 rounded-badge px-2 py-1 text-base sm:text-xs text-ink-300 font-mono outline-none focus:border-xp/50"
        />
        <input
          value={adding.unit}
          onChange={(e) => setAdding((a) => ({ ...a, unit: e.target.value }))}
          onKeyDown={(e) => e.key === "Enter" && submitAdd()}
          placeholder="unit"
          className="w-14 bg-base-700/40 border border-base-600 rounded-badge px-2 py-1 text-base sm:text-xs text-ink-300 font-mono outline-none focus:border-xp/50"
        />
        <button
          onClick={submitAdd}
          aria-label="Add goal"
          className="h-11 w-11 shrink-0 rounded-badge bg-base-700 hover:bg-base-600 flex items-center justify-center text-ink-500 transition-colors"
        >
          <Plus size={16} />
        </button>
      </div>
    </Card>
  );
}
