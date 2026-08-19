import { useEffect, useMemo, useRef, useState } from "react";
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
 * Entries per page.
 *
 * **Per entry, not per day.** Paging by day was the obvious reading of "group
 * it by date" and it was wrong for this data: 35 changes sit on four dates, so
 * every page control computed to a single page and none of them ever appeared.
 * A date heading is how the list is *read*; the entry is what there are a lot
 * of, so the entry is what gets paged. A day spanning two pages simply repeats
 * its heading, which is what a paper changelog does too.
 */
const PAGE_SIZE = 8;

const INPUT =
  "w-full bg-base-700/40 border border-base-600 rounded-badge px-3 py-2.5 min-h-[44px] text-base sm:text-sm text-ink-100 placeholder:text-ink-700 outline-none focus:border-xp/50 transition-colors";

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

/** Consecutive runs of one date, in the order given. */
function groupByDate(entries: UpdateEntry[]): { date: string; items: UpdateEntry[] }[] {
  const groups: { date: string; items: UpdateEntry[] }[] = [];
  for (const entry of entries) {
    const date = entry.date ?? "";
    const last = groups[groups.length - 1];
    if (last && last.date === date) last.items.push(entry);
    else groups.push({ date, items: [entry] });
  }
  return groups;
}

/**
 * Pages, not a growing list.
 *
 * "Show earlier" made the page longer every time it was pressed, so getting
 * back to the top of a hundred entries meant scrolling past all of them. Both
 * controls stay mounted and disable at the ends, so the row never reflows under
 * a thumb mid-tap.
 */
function Pager({
  page,
  pageCount,
  count,
  unit,
  onPage,
}: {
  page: number;
  pageCount: number;
  count: number;
  unit: string;
  onPage: (next: number) => void;
}) {
  if (pageCount < 2) return null;
  const button =
    "w-11 h-11 shrink-0 rounded-badge border border-base-600 flex items-center justify-center text-ink-300 hover:text-ink-100 hover:border-base-500 disabled:text-ink-700 disabled:hover:border-base-600 transition-colors";
  return (
    <nav className="mt-4 flex items-center gap-2" aria-label={`${unit} pages`}>
      <button
        onClick={() => onPage(Math.max(0, page - 1))}
        disabled={page === 0}
        aria-label={`Newer ${unit}`}
        className={button}
      >
        <ChevronLeft size={16} />
      </button>
      <p className="flex-1 text-center text-xs text-ink-700">
        <span className="font-mono">{count}</span> of this page ·{" "}
        <span className="font-mono">
          {page + 1}/{pageCount}
        </span>
      </p>
      <button
        onClick={() => onPage(Math.min(pageCount - 1, page + 1))}
        disabled={page >= pageCount - 1}
        aria-label={`Older ${unit}`}
        className={button}
      >
        <ChevronRight size={16} />
      </button>
    </nav>
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
  const [expanded, setExpanded] = useState(false);

  /*
    Whether the clamp is actually cutting anything off.

    Measured rather than guessed from the character count: three lines is a
    different number of characters at every width, and a "Show more" that opens
    to reveal nothing is worse than no control at all.
  */
  const detailRef = useRef<HTMLParagraphElement>(null);
  const [clamped, setClamped] = useState(false);

  useEffect(() => {
    const el = detailRef.current;
    if (!el || expanded) return;
    const check = () => setClamped(el.scrollHeight > el.clientHeight + 1);
    check();
    // The same text clamps at one width and not another, so re-measure when the
    // window changes rather than trusting the first pass.
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, [entry.detail, expanded]);

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
        {/*
          A textarea, not an input. The longest detail here is 1,500 characters
          — a brief, not a sentence — and a single-line input showed forty of
          them at a time with no way to see the rest.
        */}
        <textarea
          value={detail}
          onChange={(e) => setDetail(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") onCancel();
          }}
          rows={4}
          placeholder="Detail"
          aria-label="Detail"
          className={`${INPUT} resize-y leading-relaxed`}
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
      {/*
        Two sibling buttons, not one inside the other — "Show more" cannot be
        nested in the edit button, and a div that behaves like a button is worse
        for a keyboard than either.
      */}
      <div className="flex-1 min-w-0 p-3 pr-0">
        <button
          onClick={onStartEdit}
          aria-label={`Edit "${entry.title}"`}
          className="block w-full text-left rounded-badge"
        >
          <p className={`text-sm ${shipped ? "text-ink-300" : "text-ink-100"}`}>{entry.title}</p>
          {/*
            Clamped. One of these is a 1,500-character standing brief, and
            unclamped it pushed everything else off the screen — which is most
            of why this page read as a wall.
          */}
          {entry.detail && (
            <p
              ref={detailRef}
              className={`text-xs text-ink-700 mt-0.5 leading-relaxed ${
                expanded ? "" : "line-clamp-3"
              }`}
            >
              {entry.detail}
            </p>
          )}
        </button>

        {(clamped || expanded) && (
          <button
            onClick={() => setExpanded((v) => !v)}
            className="mt-1 text-[11px] text-xp/70 hover:text-xp transition-colors"
          >
            {expanded ? "Show less" : "Show more"}
          </button>
        )}
      </div>
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
 * - **Changelog** — what's shipped, under date headings, newest first, a page
 *   at a time. The dates are what make it read as history rather than a flat
 *   list of finished things.
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
  const [queuePage, setQueuePage] = useState(0);
  const [logPage, setLogPage] = useState(0);

  const queuePages = Math.max(1, Math.ceil(pending.length / PAGE_SIZE));
  const logPages = Math.max(1, Math.ceil(done.length / PAGE_SIZE));

  // Clearing the last entries on the last page would otherwise strand you on a
  // page that no longer exists, showing nothing.
  useEffect(() => {
    if (queuePage > queuePages - 1) setQueuePage(queuePages - 1);
  }, [queuePage, queuePages]);
  useEffect(() => {
    if (logPage > logPages - 1) setLogPage(logPages - 1);
  }, [logPage, logPages]);

  const queueItems = useMemo(
    () => pending.slice(queuePage * PAGE_SIZE, queuePage * PAGE_SIZE + PAGE_SIZE),
    [pending, queuePage]
  );

  // Slice first, then group: the headings describe what is on this page.
  const logDays = useMemo(
    () => groupByDate(done.slice(logPage * PAGE_SIZE, logPage * PAGE_SIZE + PAGE_SIZE)),
    [done, logPage]
  );
  const logCount = logDays.reduce((total, day) => total + day.items.length, 0);

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
            {queueItems.map((entry) => (
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

        <Pager
          page={queuePage}
          pageCount={queuePages}
          count={queueItems.length}
          unit="requests"
          onPage={setQueuePage}
        />
      </section>

      {/* --- Changelog --- */}
      <section className="card-base p-4 sm:p-5 animate-fade-up">
        <header className="flex items-baseline justify-between gap-3 mb-4">
          <div className="min-w-0">
            <h2 className="font-display text-sm font-medium text-ink-300">Changelog</h2>
            <p className="text-xs text-ink-700">Everything that's shipped, newest first.</p>
          </div>
          {logPages > 1 && (
            <span className="font-mono text-[11px] text-ink-700 shrink-0">
              page {logPage + 1}/{logPages}
            </span>
          )}
        </header>

        {done.length === 0 ? (
          <p className="text-sm text-ink-700">Nothing logged yet.</p>
        ) : (
          logDays.map(({ date, items }, i) => (
            <div key={`${date || "undated"}-${i}`} className="mb-5 last:mb-0">
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

        <Pager
          page={logPage}
          pageCount={logPages}
          count={logCount}
          unit="changes"
          onPage={setLogPage}
        />
      </section>
    </div>
  );
}
