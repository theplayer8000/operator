import { useState } from "react";
import { ClipboardList, Plus, Pencil, Check, X, RotateCcw, CheckCircle2 } from "lucide-react";
import { useUpdates } from "@/hooks/useUpdates";
import HandoffCard from "@/components/updates/HandoffCard";
import ConfirmButton from "@/components/ui/ConfirmButton";
import { fromDateKey, relativeDay } from "@/lib/time";
import type { UpdateEntry } from "@/lib/types";

/**
 * The changelog opens showing this many days and grows by the same step.
 *
 * By day rather than by entry, because a day is the unit the list is grouped
 * into — cutting at "20 entries" would slice a date group in half and imply
 * that was everything that shipped that day. Three days is roughly one screen
 * on a phone, which is the device it was unreadable on.
 */
const DAY_WINDOW = 3;
const DAY_STEP = 5;

const INPUT =
  "w-full bg-base-700/40 border border-base-600 rounded-badge px-3 min-h-[44px] text-base sm:text-sm text-ink-100 placeholder:text-ink-700 outline-none focus:border-xp/50 transition-colors";

/** "Today", "Yesterday", else "Mon 27 July" — a changelog date heading. */
function formatChangelogDate(dateKey: string): string {
  const relative = relativeDay(dateKey);
  if (relative === "Today" || relative === "Yesterday") {
    const date = fromDateKey(dateKey);
    return date
      ? `${relative} · ${date.toLocaleDateString("en-GB", { day: "numeric", month: "long" })}`
      : relative;
  }
  const date = fromDateKey(dateKey);
  return (
    date?.toLocaleDateString("en-GB", {
      weekday: "short",
      day: "numeric",
      month: "long",
      year: "numeric",
    }) ?? dateKey
  );
}

/**
 * Three jobs on one page, and they're deliberately different shapes:
 *
 * - **Handoff** — where the work actually is, read off disk from
 *   `docs/handoffs/CURRENT.md` rather than stored here. Read-only on purpose:
 *   the session doing the work owns that file, and a copy editable from two
 *   places is a copy that goes wrong. It sits first because "what's happening"
 *   comes before "what do you want doing".
 *
 * - **Queue** — what the owner wants doing. The capture box at the top is the
 *   point of the feature: it's how work gets handed over between sessions,
 *   rather than being remembered or retyped into a chat. Anything added here
 *   gets picked up next time.
 * - **Changelog** — what's shipped, grouped under date headings, newest day
 *   first. A flat list of finished items isn't a changelog; the dates are what
 *   make it readable as history.
 *
 * Calm/administrative register, the same as Settings — a utility page, not a
 * feature with a personality of its own.
 */
export default function Updates() {
  const { pending, done, doneByDate, addEntry, updateEntry, markDone, markPending, deleteEntry } =
    useUpdates();

  const [dayLimit, setDayLimit] = useState(DAY_WINDOW);
  const visibleDays = doneByDate.slice(0, dayLimit);
  const hiddenDays = doneByDate.length - visibleDays.length;
  const hiddenChanges = doneByDate
    .slice(dayLimit)
    .reduce((total, day) => total + day.items.length, 0);

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
            {pending.length} queued · {done.length} shipped
          </p>
        </div>
      </div>

      {/* --- Handoff (read-only, from docs/handoffs/CURRENT.md) --- */}
      <HandoffCard />

      {/* --- Quick capture --- */}
      <section className="card-base p-4 sm:p-5 mb-5 animate-fade-up space-y-2">
        <p className="text-xs text-ink-700 leading-relaxed">
          Anything you add here lands in the queue below, and I pick it up next time we work on
          Operator. Feature, bug, half-formed idea — it doesn't need to be tidy.
        </p>
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
          placeholder="What do you want doing?"
          aria-label="New request title"
          className={INPUT}
        />
        <div className="flex gap-2">
          <input
            value={detail}
            onChange={(e) => setDetail(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submit()}
            placeholder="Any detail (optional)"
            aria-label="Detail"
            className={`${INPUT} flex-1`}
          />
          <button
            onClick={submit}
            aria-label="Add request"
            className="w-11 h-11 shrink-0 rounded-badge bg-xp text-base-950 flex items-center justify-center hover:bg-xp-bright transition-colors"
          >
            <Plus size={16} />
          </button>
        </div>
      </section>

      {/* --- Pending --- */}
      <section className="card-base p-4 sm:p-5 mb-5 animate-fade-up">
        <header className="mb-3">
          <h2 className="font-display text-sm font-medium text-ink-300">Queue</h2>
          <p className="text-xs text-ink-700">Waiting to be built, newest of yours first.</p>
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

      {/* --- Changelog --- */}
      <section className="card-base p-4 sm:p-5 animate-fade-up">
        <header className="mb-4">
          <h2 className="font-display text-sm font-medium text-ink-300">Changelog</h2>
          <p className="text-xs text-ink-700">Everything that's shipped, newest day first.</p>
        </header>

        {done.length === 0 ? (
          <p className="text-sm text-ink-700">Nothing logged yet.</p>
        ) : (
          visibleDays.map(({ date, items }) => (
            <div key={date || "undated"} className="mb-5 last:mb-0">
              {/* Date heading — this is what makes it read as a changelog
                  rather than a flat list of finished things. */}
              <div className="flex items-baseline gap-2 mb-2 pb-1.5 border-b border-base-600">
                <h3 className="font-display text-xs text-ink-100">
                  {date ? formatChangelogDate(date) : "Undated"}
                </h3>
                <span className="font-mono text-[11px] text-ink-700">
                  {items.length} {items.length === 1 ? "change" : "changes"}
                </span>
              </div>

              <ul className="space-y-2">
                {items.map((entry) => (
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
            </div>
          ))
        )}

        {hiddenDays > 0 && (
          <button
            onClick={() => setDayLimit((n) => n + DAY_STEP)}
            className="mt-4 w-full min-h-[44px] rounded-badge border border-base-600 bg-base-700/30 text-sm text-ink-300 hover:text-ink-100 hover:border-base-500 transition-colors"
          >
            Show earlier — {hiddenDays} more {hiddenDays === 1 ? "day" : "days"},{" "}
            <span className="font-mono text-xs">{hiddenChanges}</span>{" "}
            {hiddenChanges === 1 ? "change" : "changes"}
          </button>
        )}
      </section>
    </div>
  );
}
