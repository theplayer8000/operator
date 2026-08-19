import { useEffect, useMemo, useState } from "react";
import {
  ClipboardList,
  Plus,
  Check,
  X,
  RotateCcw,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import { useUpdates } from "@/hooks/useUpdates";
import HandoffCard from "@/components/updates/HandoffCard";
import ConfirmButton from "@/components/ui/ConfirmButton";
import { fromDateKey, relativeDay } from "@/lib/time";
import type { UpdateEntry } from "@/lib/types";

/**
 * Days per page of changelog.
 *
 * Paged by day, not by entry: a day is the unit the list is grouped into, and
 * cutting at "20 entries" would slice a date group across a page boundary and
 * imply that was everything that shipped that day. Four days is about one phone
 * screen once a day carries two or three changes.
 */
const PAGE_DAYS = 4;

const INPUT =
  "w-full bg-base-700/40 border border-base-600 rounded-badge px-3 min-h-[44px] text-base sm:text-sm text-ink-100 placeholder:text-ink-700 outline-none focus:border-xp/50 transition-colors";

/** "Today", "Yesterday", else "Mon 27 July" — a changelog date heading. */
function formatChangelogDate(dateKey: string): string {
  const relative = relativeDay(dateKey);
  const date = fromDateKey(dateKey);
  if (relative === "Today" || relative === "Yesterday") {
    return date
      ? `${relative} · ${date.toLocaleDateString("en-GB", { day: "numeric", month: "long" })}`
      : relative;
  }
  return (
    date?.toLocaleDateString("en-GB", {
      weekday: "short",
      day: "numeric",
      month: "long",
      year: "numeric",
    }) ?? dateKey
  );
}

interface RowProps {
  entry: UpdateEntry;
  shipped: boolean;
  editing: boolean;
  onStartEdit: () => void;
  onSave: (title: string, detail: string) => void;
  onCancel: () => void;
  onToggle: () => void;
  onDelete: () => void;
}

/**
 * One entry, queued or shipped.
 *
 * Written once and used by both lists — the two were copies of each other,
 * sixty lines apart, which is how the queue and the changelog drifted into
 * having subtly different edit forms.
 *
 * **Tap the text to edit.** That keeps one 44px control on the row instead of
 * three cramped ones, and puts delete inside the editor where it belongs —
 * without hiding anything behind a hover, which phones do not have.
 */
function EntryRow({
  entry,
  shipped,
  editing,
  onStartEdit,
  onSave,
  onCancel,
  onToggle,
  onDelete,
}: RowProps) {
  const [title, setTitle] = useState(entry.title);
  const [detail, setDetail] = useState(entry.detail);

  useEffect(() => {
    if (editing) {
      setTitle(entry.title);
      setDetail(entry.detail);
    }
  }, [editing, entry.title, entry.detail]);

  if (editing) {
    return (
      <li className="p-3 rounded-badge border border-xp/30 bg-xp/5 space-y-2">
        <input
          autoFocus
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") onCancel();
            if (e.key === "Enter") onSave(title, detail);
          }}
          aria-label="Title"
          className={INPUT}
        />
        <input
          value={detail}
          onChange={(e) => setDetail(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") onCancel();
            if (e.key === "Enter") onSave(title, detail);
          }}
          placeholder="Detail"
          aria-label="Detail"
          className={INPUT}
        />
        <div className="flex items-center gap-2">
          <button
            onClick={() => onSave(title, detail)}
            className="inline-flex items-center gap-1.5 px-3 min-h-[44px] rounded-badge bg-xp text-base-950 text-xs font-medium hover:bg-xp-bright transition-colors"
          >
            <Check size={14} /> Save
          </button>
          <button
            onClick={onCancel}
            className="inline-flex items-center gap-1.5 px-3 min-h-[44px] rounded-badge border border-base-600 text-xs text-ink-300 hover:text-ink-100 transition-colors"
          >
            <X size={14} /> Cancel
          </button>
          <span className="ml-auto">
            <ConfirmButton label={`Delete "${entry.title}"`} onConfirm={onDelete} compact />
          </span>
        </div>
      </li>
    );
  }

  return (
    <li
      className={`flex items-start gap-2 rounded-badge border transition-colors ${
        shipped
          ? "border-base-600 bg-base-700/20 hover:border-base-500"
          : "border-rank/25 bg-rank/5 hover:border-rank/40"
      }`}
    >
      <button
        onClick={onStartEdit}
        aria-label={`Edit "${entry.title}"`}
        className="flex-1 min-w-0 text-left p-3 pr-0 rounded-badge"
      >
        <p className={`text-sm ${shipped ? "text-ink-300" : "text-ink-100"}`}>{entry.title}</p>
        {entry.detail && (
          <p className="text-xs text-ink-700 mt-0.5 leading-relaxed">{entry.detail}</p>
        )}
      </button>
      <button
        onClick={onToggle}
        aria-label={
          shipped ? `Move "${entry.title}" back to the queue` : `Mark "${entry.title}" shipped`
        }
        title={shipped ? "Back to the queue" : "Mark shipped"}
        className={`w-11 h-11 shrink-0 m-1 flex items-center justify-center rounded-badge text-ink-700 transition-colors ${
          shipped ? "hover:text-rank" : "hover:text-vital-up"
        }`}
      >
        {shipped ? <RotateCcw size={15} /> : <CheckCircle2 size={17} />}
      </button>
    </li>
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
 * - **Queue** — what the owner wants doing. The capture box is the point of the
 *   feature: it's how work gets handed over between sessions, rather than being
 *   remembered or retyped into a chat.
 * - **Changelog** — what's shipped, grouped under date headings, newest first,
 *   a page at a time. The dates are what make it read as history rather than a
 *   flat list of finished things.
 *
 * Calm/administrative register, the same as Settings — a utility page, not a
 * feature with a personality of its own.
 */
export default function Updates() {
  const { pending, done, doneByDate, addEntry, updateEntry, markDone, markPending, deleteEntry } =
    useUpdates();

  const [title, setTitle] = useState("");
  const [detail, setDetail] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [page, setPage] = useState(0);

  const pageCount = Math.max(1, Math.ceil(doneByDate.length / PAGE_DAYS));

  // Deleting the last entries on the last page would otherwise strand you on a
  // page that no longer exists, showing nothing.
  useEffect(() => {
    if (page > pageCount - 1) setPage(pageCount - 1);
  }, [page, pageCount]);

  const days = useMemo(
    () => doneByDate.slice(page * PAGE_DAYS, page * PAGE_DAYS + PAGE_DAYS),
    [doneByDate, page]
  );

  const shownOnPage = days.reduce((total, day) => total + day.items.length, 0);

  function submit() {
    if (!title.trim()) return;
    addEntry({ title, detail, status: "pending" });
    setTitle("");
    setDetail("");
  }

  function save(id: string, nextTitle: string, nextDetail: string) {
    if (nextTitle.trim()) updateEntry(id, { title: nextTitle.trim(), detail: nextDetail.trim() });
    setEditingId(null);
  }

  return (
    <div className="max-w-2xl mx-auto lg:mx-0">
      <div className="flex items-center gap-3 mb-5">
        <div className="w-10 h-10 rounded-badge bg-xp/10 border border-xp/25 flex items-center justify-center text-xp">
          <ClipboardList size={18} />
        </div>
        <div className="min-w-0">
          <h1 className="font-display text-lg text-ink-100 leading-tight">Updates</h1>
          <p className="text-xs text-ink-500">
            <span className="font-mono text-ink-300">{pending.length}</span> queued ·{" "}
            <span className="font-mono text-ink-300">{done.length}</span> shipped over{" "}
            <span className="font-mono text-ink-300">{doneByDate.length}</span> days
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

      {/* --- Queue --- */}
      <section className="card-base p-4 sm:p-5 mb-5 animate-fade-up">
        <header className="flex items-baseline justify-between gap-3 mb-3">
          <div>
            <h2 className="font-display text-sm font-medium text-ink-300">Queue</h2>
            <p className="text-xs text-ink-700">Waiting to be built, newest of yours first.</p>
          </div>
          {pending.length > 0 && (
            <span className="font-mono text-[11px] text-ink-700 shrink-0">{pending.length}</span>
          )}
        </header>

        {pending.length === 0 ? (
          <p className="text-sm text-ink-700">Nothing queued.</p>
        ) : (
          <ul className="space-y-2">
            {pending.map((entry) => (
              <EntryRow
                key={entry.id}
                entry={entry}
                shipped={false}
                editing={editingId === entry.id}
                onStartEdit={() => setEditingId(entry.id)}
                onSave={(t, d) => save(entry.id, t, d)}
                onCancel={() => setEditingId(null)}
                onToggle={() => markDone(entry.id)}
                onDelete={() => deleteEntry(entry.id)}
              />
            ))}
          </ul>
        )}
      </section>

      {/* --- Changelog --- */}
      <section className="card-base p-4 sm:p-5 animate-fade-up">
        <header className="flex items-baseline justify-between gap-3 mb-4">
          <div className="min-w-0">
            <h2 className="font-display text-sm font-medium text-ink-300">Changelog</h2>
            <p className="text-xs text-ink-700">Everything that's shipped, newest day first.</p>
          </div>
          {pageCount > 1 && (
            <span className="font-mono text-[11px] text-ink-700 shrink-0">
              page {page + 1}/{pageCount}
            </span>
          )}
        </header>

        {done.length === 0 ? (
          <p className="text-sm text-ink-700">Nothing logged yet.</p>
        ) : (
          days.map(({ date, items }) => (
            <div key={date || "undated"} className="mb-5 last:mb-0">
              {/* The date heading is what makes this read as history rather
                  than a flat list of finished things. */}
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
                  <EntryRow
                    key={entry.id}
                    entry={entry}
                    shipped
                    editing={editingId === entry.id}
                    onStartEdit={() => setEditingId(entry.id)}
                    onSave={(t, d) => save(entry.id, t, d)}
                    onCancel={() => setEditingId(null)}
                    onToggle={() => markPending(entry.id)}
                    onDelete={() => deleteEntry(entry.id)}
                  />
                ))}
              </ul>
            </div>
          ))
        )}

        {/*
          Pages, not a growing list. "Show earlier" made the page longer every
          time it was pressed, so getting back to the top of a hundred entries
          meant scrolling past all of them. Both controls stay mounted and
          disable at the ends, so the row never reflows under a thumb.
        */}
        {pageCount > 1 && (
          <nav className="mt-4 flex items-center gap-2" aria-label="Changelog pages">
            <button
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              disabled={page === 0}
              aria-label="Newer changes"
              className="w-11 h-11 shrink-0 rounded-badge border border-base-600 flex items-center justify-center text-ink-300 hover:text-ink-100 hover:border-base-500 disabled:text-ink-700 disabled:border-base-600 disabled:hover:border-base-600 transition-colors"
            >
              <ChevronLeft size={16} />
            </button>

            <p className="flex-1 text-center text-xs text-ink-700">
              <span className="font-mono">{shownOnPage}</span>{" "}
              {shownOnPage === 1 ? "change" : "changes"} ·{" "}
              <span className="font-mono">
                {page + 1}/{pageCount}
              </span>
            </p>

            <button
              onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
              disabled={page >= pageCount - 1}
              aria-label="Older changes"
              className="w-11 h-11 shrink-0 rounded-badge border border-base-600 flex items-center justify-center text-ink-300 hover:text-ink-100 hover:border-base-500 disabled:text-ink-700 disabled:border-base-600 disabled:hover:border-base-600 transition-colors"
            >
              <ChevronRight size={16} />
            </button>
          </nav>
        )}
      </section>
    </div>
  );
}
