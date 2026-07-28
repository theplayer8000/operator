import { useState } from "react";
import { ClipboardList, Plus, Pencil, Check, X, RotateCcw, CheckCircle2 } from "lucide-react";
import { useUpdates } from "@/hooks/useUpdates";
import ConfirmButton from "@/components/ui/ConfirmButton";
import { relativeDay } from "@/lib/time";
import type { UpdateEntry } from "@/lib/types";

const INPUT =
  "w-full bg-base-700/40 border border-base-600 rounded-badge px-3 min-h-[44px] text-base sm:text-sm text-ink-100 placeholder:text-ink-700 outline-none focus:border-xp/50 transition-colors";

/**
 * A running log of what's changed in Operator, and what's still queued —
 * meant to be read here, not dug out of git history. Calm/administrative
 * register, the same as Settings: this is a utility page, not a feature with
 * a personality of its own.
 */
export default function Updates() {
  const { pending, done, addEntry, updateEntry, markDone, markPending, deleteEntry } =
    useUpdates();

  const [title, setTitle] = useState("");
  const [detail, setDetail] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editDetail, setEditDetail] = useState("");

  function submit() {
    if (!title.trim()) return;
    addEntry({ title, detail, status: "pending" });
    setTitle("");
    setDetail("");
  }

  function startEdit(entry: UpdateEntry) {
    setEditingId(entry.id);
    setEditTitle(entry.title);
    setEditDetail(entry.detail);
  }

  function commitEdit(id: string) {
    if (editTitle.trim()) updateEntry(id, { title: editTitle.trim(), detail: editDetail.trim() });
    setEditingId(null);
  }

  return (
    <div className="max-w-2xl mx-auto lg:mx-0">
      <div className="flex items-center gap-3 mb-5">
        <div className="w-10 h-10 rounded-badge bg-xp/10 border border-xp/25 flex items-center justify-center text-xp">
          <ClipboardList size={18} />
        </div>
        <div>
          <h1 className="font-display text-lg text-ink-100 leading-tight">Updates</h1>
          <p className="text-xs text-ink-500">
            {done.length} shipped · {pending.length} pending
          </p>
        </div>
      </div>

      {/* --- Quick capture --- */}
      <section className="card-base p-4 sm:p-5 mb-5 animate-fade-up space-y-2">
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
          placeholder="Jot down something to build or fix later…"
          aria-label="New pending update title"
          className={INPUT}
        />
        <div className="flex gap-2">
          <input
            value={detail}
            onChange={(e) => setDetail(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submit()}
            placeholder="Detail (optional)"
            aria-label="Detail"
            className={`${INPUT} flex-1`}
          />
          <button
            onClick={submit}
            aria-label="Add pending update"
            className="w-11 h-11 shrink-0 rounded-badge bg-xp text-base-950 flex items-center justify-center hover:bg-xp-bright transition-colors"
          >
            <Plus size={16} />
          </button>
        </div>
      </section>

      {/* --- Pending --- */}
      <section className="card-base p-4 sm:p-5 mb-5 animate-fade-up">
        <header className="mb-3">
          <h2 className="font-display text-sm font-medium text-ink-300">Pending</h2>
        </header>

        {pending.length === 0 ? (
          <p className="text-sm text-ink-700">Nothing queued.</p>
        ) : (
          <ul className="space-y-2">
            {pending.map((entry) => (
              <li
                key={entry.id}
                className="p-3 rounded-badge border border-rank/30 bg-rank/5"
              >
                {editingId === entry.id ? (
                  <div className="space-y-2">
                    <input
                      autoFocus
                      value={editTitle}
                      onChange={(e) => setEditTitle(e.target.value)}
                      onKeyDown={(e) => e.key === "Escape" && setEditingId(null)}
                      className={INPUT}
                    />
                    <input
                      value={editDetail}
                      onChange={(e) => setEditDetail(e.target.value)}
                      onKeyDown={(e) => e.key === "Escape" && setEditingId(null)}
                      placeholder="Detail"
                      className={INPUT}
                    />
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => commitEdit(entry.id)}
                        className="inline-flex items-center gap-1.5 px-3 min-h-[40px] rounded-badge bg-xp text-base-950 text-xs font-medium hover:bg-xp-bright transition-colors"
                      >
                        <Check size={14} /> Save
                      </button>
                      <button
                        onClick={() => setEditingId(null)}
                        className="inline-flex items-center gap-1.5 px-3 min-h-[40px] rounded-badge border border-base-600 text-xs text-ink-300 hover:text-ink-100 transition-colors"
                      >
                        <X size={14} /> Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="flex items-start gap-2">
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-ink-100">{entry.title}</p>
                      {entry.detail && (
                        <p className="text-xs text-ink-500 mt-0.5 leading-relaxed">
                          {entry.detail}
                        </p>
                      )}
                    </div>
                    <button
                      onClick={() => markDone(entry.id)}
                      aria-label={`Mark "${entry.title}" done`}
                      title="Mark done"
                      className="w-9 h-9 shrink-0 flex items-center justify-center rounded-badge text-ink-700 hover:text-vital-up transition-colors"
                    >
                      <CheckCircle2 size={16} />
                    </button>
                    <button
                      onClick={() => startEdit(entry)}
                      aria-label={`Edit "${entry.title}"`}
                      title="Edit"
                      className="w-9 h-9 shrink-0 flex items-center justify-center rounded-badge text-ink-700 hover:text-ink-300 transition-colors"
                    >
                      <Pencil size={13} />
                    </button>
                    <ConfirmButton
                      label={`Delete "${entry.title}"`}
                      onConfirm={() => deleteEntry(entry.id)}
                      compact
                    />
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* --- Shipped --- */}
      <section className="card-base p-4 sm:p-5 animate-fade-up">
        <header className="mb-3">
          <h2 className="font-display text-sm font-medium text-ink-300">Shipped</h2>
        </header>

        {done.length === 0 ? (
          <p className="text-sm text-ink-700">Nothing logged yet.</p>
        ) : (
          <ul className="space-y-2">
            {done.map((entry) => (
              <li
                key={entry.id}
                className="p-3 rounded-badge border border-base-600 bg-base-700/30"
              >
                {editingId === entry.id ? (
                  <div className="space-y-2">
                    <input
                      autoFocus
                      value={editTitle}
                      onChange={(e) => setEditTitle(e.target.value)}
                      onKeyDown={(e) => e.key === "Escape" && setEditingId(null)}
                      className={INPUT}
                    />
                    <input
                      value={editDetail}
                      onChange={(e) => setEditDetail(e.target.value)}
                      onKeyDown={(e) => e.key === "Escape" && setEditingId(null)}
                      placeholder="Detail"
                      className={INPUT}
                    />
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => commitEdit(entry.id)}
                        className="inline-flex items-center gap-1.5 px-3 min-h-[40px] rounded-badge bg-xp text-base-950 text-xs font-medium hover:bg-xp-bright transition-colors"
                      >
                        <Check size={14} /> Save
                      </button>
                      <button
                        onClick={() => setEditingId(null)}
                        className="inline-flex items-center gap-1.5 px-3 min-h-[40px] rounded-badge border border-base-600 text-xs text-ink-300 hover:text-ink-100 transition-colors"
                      >
                        <X size={14} /> Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="flex items-start gap-2">
                    <span className="w-1.5 h-1.5 rounded-full bg-vital-up shrink-0 mt-1.5" aria-hidden />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-ink-300">{entry.title}</p>
                      {entry.detail && (
                        <p className="text-xs text-ink-700 mt-0.5 leading-relaxed">
                          {entry.detail}
                        </p>
                      )}
                      {entry.date && (
                        <p className="text-[11px] font-mono text-ink-700 mt-1">
                          {relativeDay(entry.date)}
                        </p>
                      )}
                    </div>
                    <button
                      onClick={() => markPending(entry.id)}
                      aria-label={`Move "${entry.title}" back to pending`}
                      title="Move back to pending"
                      className="w-9 h-9 shrink-0 flex items-center justify-center rounded-badge text-ink-700 hover:text-rank transition-colors"
                    >
                      <RotateCcw size={13} />
                    </button>
                    <button
                      onClick={() => startEdit(entry)}
                      aria-label={`Edit "${entry.title}"`}
                      title="Edit"
                      className="w-9 h-9 shrink-0 flex items-center justify-center rounded-badge text-ink-700 hover:text-ink-300 transition-colors"
                    >
                      <Pencil size={13} />
                    </button>
                    <ConfirmButton
                      label={`Delete "${entry.title}"`}
                      onConfirm={() => deleteEntry(entry.id)}
                      compact
                    />
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
