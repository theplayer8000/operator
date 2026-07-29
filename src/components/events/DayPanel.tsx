import { useState } from "react";
import { Plus, Pencil, Check, X, Repeat } from "lucide-react";
import ConfirmButton from "@/components/ui/ConfirmButton";
import { formatHHMM, fromDateKey, parseHHMM, relativeDay } from "@/lib/time";
import { EVENT_KIND_META, EVENT_KINDS } from "./eventMeta";
import type { CalendarEvent, EventKind, EventOccurrence } from "@/lib/types";

const INPUT =
  "w-full bg-base-700/40 border border-base-600 rounded-badge px-3 min-h-[44px] text-base sm:text-sm text-ink-100 placeholder:text-ink-700 outline-none focus:border-xp/50 transition-colors";
const INPUT_SM =
  "bg-base-700/40 border border-base-600 rounded-badge px-2 min-h-[44px] text-base sm:text-sm text-ink-100 placeholder:text-ink-700 outline-none focus:border-xp/50 transition-colors";

/**
 * A start + finish pair, not a duration-in-minutes field. The stored shape is
 * still `time` + `durationMinutes` (that's what the Day Schedule sync reads),
 * but typing "60" into a number box is a worse interface than picking two
 * clock times — this just does the subtraction the model doesn't need to see.
 * An end before or equal to the start is dropped rather than rejected: the
 * event still saves as a point-in-time entry with no duration.
 */
function rangeToDuration(startText: string, endText: string): number | undefined {
  const start = parseHHMM(startText);
  const end = parseHHMM(endText);
  if (start === null || end === null || end <= start) return undefined;
  return end - start;
}

/** The selected day: what's on it, and the form to put something there. */
export default function DayPanel({
  dateKey,
  events,
  onAdd,
  onUpdate,
  onDelete,
  onSkip,
  onMoved,
  onClose,
}: {
  dateKey: string;
  events: EventOccurrence[];
  onAdd: (input: {
    title: string;
    date: string;
    time?: string;
    durationMinutes?: number;
    kind: EventKind;
  }) => void;
  onUpdate: (id: string, patch: Partial<CalendarEvent>) => void;
  onDelete: (id: string) => void;
  /**
   * Drop one day out of a repeating series. This is what deleting a single
   * occurrence means — the rule survives, that date doesn't.
   */
  onSkip: (seriesId: string, date: string) => void;
  /** Called with the new date when an edit moves an event off this day. */
  onMoved?: (newDate: string) => void;
  /**
   * Present only when this panel is being shown as the mobile overlay — see
   * Events.tsx. The button it renders is `lg:hidden`, so passing it has no
   * effect on the desktop inline layout even though the same component
   * instance is used for both.
   */
  onClose?: () => void;
}) {
  const [title, setTitle] = useState("");
  const [start, setStart] = useState("");
  const [finish, setFinish] = useState("");
  const [kind, setKind] = useState<EventKind>("work");

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editDate, setEditDate] = useState("");
  const [editStart, setEditStart] = useState("");
  const [editFinish, setEditFinish] = useState("");
  const [editKind, setEditKind] = useState<EventKind>("other");

  const date = fromDateKey(dateKey);
  const longDate = date
    ? date.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" })
    : dateKey;

  function submit() {
    if (!title.trim()) return;
    const durationMinutes = start ? rangeToDuration(start, finish) : undefined;
    onAdd({
      title,
      date: dateKey,
      kind,
      ...(start ? { time: start } : {}),
      ...(durationMinutes ? { durationMinutes } : {}),
    });
    setTitle("");
    setStart("");
    setFinish("");
  }

  function startEdit(event: EventOccurrence) {
    setEditingId(event.id);
    setEditTitle(event.title);
    setEditDate(event.date);
    setEditStart(event.time ?? "");
    // Reconstruct the finish time from start + duration — the field the
    // record stores and the field this form shows aren't the same one.
    const startMinutes = event.time ? parseHHMM(event.time) : null;
    setEditFinish(
      startMinutes !== null && event.durationMinutes
        ? formatHHMM(startMinutes + event.durationMinutes)
        : ""
    );
    setEditKind(event.kind);
  }

  function commitEdit(event: EventOccurrence) {
    if (!editTitle.trim() || !editDate) {
      setEditingId(null);
      return;
    }
    const trimmedStart = editStart.trim();
    const durationMinutes = trimmedStart ? rangeToDuration(trimmedStart, editFinish) : undefined;

    // `onUpdate` resolves a synthetic occurrence id back to the real record,
    // so passing event.id is safe either way. But `date` must be omitted for a
    // series: this occurrence's date is a derived day, and writing it back
    // would move the rule's anchor and silently reshape every other
    // occurrence.
    onUpdate(event.id, {
      title: editTitle.trim(),
      kind: editKind,
      ...(event.seriesId ? {} : { date: editDate }),
      // A cleared field is an explicit `undefined`, not an omitted key —
      // here that's the intent: it overwrites the stored value and is
      // dropped on serialisation. Duration only survives alongside a start.
      time: trimmedStart || undefined,
      durationMinutes,
    });
    setEditingId(null);
    if (!event.seriesId && editDate !== event.date) onMoved?.(editDate);
  }

  return (
    <div className="card-base p-4 sm:p-5 animate-fade-up">
      <header className="mb-4 flex items-start justify-between gap-3">
        <div>
          <h2 className="font-display text-sm font-medium text-ink-100">{longDate}</h2>
          <p className="text-xs text-ink-700">
            {relativeDay(dateKey)}
            {events.length > 0 && ` · ${events.length} event${events.length === 1 ? "" : "s"}`}
          </p>
        </div>
        {onClose && (
          <button
            onClick={onClose}
            aria-label="Close"
            title="Close"
            className="lg:hidden w-9 h-9 shrink-0 flex items-center justify-center rounded-badge text-ink-700 hover:text-ink-300 transition-colors"
          >
            <X size={16} />
          </button>
        )}
      </header>

      {events.length === 0 ? (
        <p className="text-sm text-ink-700 mb-4">Nothing on this day yet.</p>
      ) : (
        <ul className="space-y-2 mb-4">
          {events.map((event) => {
            const startMinutes = event.time ? parseHHMM(event.time) : null;
            const rangeLabel =
              startMinutes !== null && event.durationMinutes
                ? `${event.time}–${formatHHMM(startMinutes + event.durationMinutes)}`
                : (event.time ?? "All day");

            return (
              <li
                key={event.id}
                className="p-2 pl-3 rounded-badge border border-base-600 bg-base-700/30"
              >
                {editingId === event.id ? (
                  <div className="space-y-2">
                    <input
                      autoFocus
                      value={editTitle}
                      onChange={(e) => setEditTitle(e.target.value)}
                      onKeyDown={(e) => e.key === "Escape" && setEditingId(null)}
                      aria-label="Event title"
                      placeholder="Title"
                      className={INPUT}
                    />
                    <div className="flex flex-wrap gap-2">
                      {/*
                        A series has no single date to move — its `date` is the
                        rule's start, not this occurrence. Editing one day's
                        date would silently shift the whole series' anchor, so
                        the field is hidden and the rule is stated instead.
                      */}
                      {!event.seriesId && (
                        <input
                          type="date"
                          value={editDate}
                          onChange={(e) => setEditDate(e.target.value)}
                          aria-label="Date"
                          title="Change the date to move this event"
                          className={`${INPUT_SM} font-mono flex-1 min-w-[128px]`}
                        />
                      )}
                      <select
                        value={editKind}
                        onChange={(e) => setEditKind(e.target.value as EventKind)}
                        aria-label="Kind"
                        className={`${INPUT_SM} flex-1 min-w-[100px]`}
                      >
                        {EVENT_KINDS.map((k) => (
                          <option key={k} value={k}>
                            {EVENT_KIND_META[k].label}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="flex items-center gap-2">
                      <input
                        type="time"
                        value={editStart}
                        onChange={(e) => setEditStart(e.target.value)}
                        aria-label="Start time"
                        title="Leave empty for an all-day event"
                        className={`${INPUT_SM} font-mono flex-1 min-w-[100px]`}
                      />
                      <span className="text-ink-700 text-sm shrink-0">–</span>
                      <input
                        type="time"
                        value={editFinish}
                        onChange={(e) => setEditFinish(e.target.value)}
                        disabled={!editStart}
                        aria-label="Finish time"
                        title={editStart ? "When it ends" : "Set a start time first"}
                        className={`${INPUT_SM} font-mono flex-1 min-w-[100px] disabled:opacity-40`}
                      />
                    </div>
                    {event.seriesId && (
                      <p className="text-[11px] text-rank">
                        <Repeat size={10} className="inline mr-1 -mt-0.5" />
                        Repeating — saving changes every occurrence. To drop
                        just this day, cancel and use delete.
                      </p>
                    )}
                    <div className="flex items-center gap-2 pt-1">
                      <button
                        onClick={() => commitEdit(event)}
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
                  <div className="flex items-center gap-2">
                    <span
                      className={`w-1.5 h-1.5 rounded-full shrink-0 ${EVENT_KIND_META[event.kind].dot}`}
                      aria-hidden
                    />
                    <span className="flex-1 min-w-0">
                      <span className="flex items-center gap-1.5">
                        <span className="text-sm text-ink-300 truncate">{event.title}</span>
                        {event.seriesId && (
                          <span
                            className="shrink-0 text-rank"
                            title="Part of a repeating series"
                            aria-label="Repeating"
                          >
                            <Repeat size={11} />
                          </span>
                        )}
                      </span>
                      <span className="block text-[11px] font-mono text-ink-700">
                        {rangeLabel} · {EVENT_KIND_META[event.kind].label}
                      </span>
                    </span>
                    <button
                      onClick={() => startEdit(event)}
                      aria-label={`Edit "${event.title}"`}
                      title={
                        event.seriesId
                          ? "Edit — changes every occurrence in the series"
                          : "Edit — including its date"
                      }
                      className="w-9 h-9 shrink-0 flex items-center justify-center rounded-badge text-ink-700 hover:text-ink-300 transition-colors"
                    >
                      <Pencil size={13} />
                    </button>
                    {/*
                      On a repeating occurrence, delete skips this one day and
                      leaves the rule alone — that's annual leave, and it's the
                      action wanted 99% of the time. Removing the whole series
                      is deliberately not a one-tap action from a single day.
                    */}
                    <ConfirmButton
                      label={
                        event.seriesId
                          ? `Skip "${event.title}" on this day`
                          : `Delete "${event.title}"`
                      }
                      onConfirm={() =>
                        event.seriesId
                          ? onSkip(event.seriesId, event.date)
                          : onDelete(event.id)
                      }
                      compact
                    />
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <div className="pt-3 border-t border-base-600 space-y-2">
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && submit()}
          placeholder="Add an event…"
          aria-label="New event title"
          className={INPUT}
        />
        <div className="flex items-center gap-2">
          <input
            type="time"
            value={start}
            onChange={(e) => setStart(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submit()}
            aria-label="Start time (optional)"
            title="Leave empty for an all-day event"
            className={`${INPUT_SM} font-mono flex-1 min-w-[100px]`}
          />
          <span className="text-ink-700 text-sm shrink-0">–</span>
          <input
            type="time"
            value={finish}
            onChange={(e) => setFinish(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submit()}
            disabled={!start}
            aria-label="Finish time"
            title={start ? "When it ends (optional)" : "Set a start time first"}
            className={`${INPUT_SM} font-mono flex-1 min-w-[100px] disabled:opacity-40`}
          />
        </div>
        <div className="flex gap-2">
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value as EventKind)}
            aria-label="Kind"
            className={`${INPUT} flex-1`}
          >
            {EVENT_KINDS.map((k) => (
              <option key={k} value={k}>
                {EVENT_KIND_META[k].label}
              </option>
            ))}
          </select>
          <button
            onClick={submit}
            aria-label="Add event"
            className="w-11 h-11 shrink-0 rounded-badge bg-xp text-base-950 flex items-center justify-center hover:bg-xp-bright transition-colors"
          >
            <Plus size={16} />
          </button>
        </div>
        {start && (
          <p className="text-[11px] text-ink-700">
            Give it a finish time and it'll show up on today's Day Schedule alongside your
            routine.
          </p>
        )}
      </div>
    </div>
  );
}
