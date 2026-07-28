import { useState } from "react";
import { Plus, Pencil, Check, X } from "lucide-react";
import ConfirmButton from "@/components/ui/ConfirmButton";
import { fromDateKey, relativeDay } from "@/lib/time";
import { EVENT_KIND_META, EVENT_KINDS } from "./eventMeta";
import type { CalendarEvent, EventKind } from "@/lib/types";

const INPUT =
  "w-full bg-base-700/40 border border-base-600 rounded-badge px-3 min-h-[44px] text-base sm:text-sm text-ink-100 placeholder:text-ink-700 outline-none focus:border-xp/50 transition-colors";

/** The selected day: what's on it, and the form to put something there. */
export default function DayPanel({
  dateKey,
  events,
  onAdd,
  onUpdate,
  onDelete,
}: {
  dateKey: string;
  events: CalendarEvent[];
  onAdd: (input: { title: string; date: string; time?: string; kind: EventKind }) => void;
  onUpdate: (id: string, patch: Partial<CalendarEvent>) => void;
  onDelete: (id: string) => void;
}) {
  const [title, setTitle] = useState("");
  const [time, setTime] = useState("");
  const [kind, setKind] = useState<EventKind>("work");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState("");

  const date = fromDateKey(dateKey);
  const longDate = date
    ? date.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" })
    : dateKey;

  function submit() {
    if (!title.trim()) return;
    onAdd({ title, date: dateKey, kind, ...(time ? { time } : {}) });
    setTitle("");
    setTime("");
  }

  function commitEdit(id: string) {
    if (editTitle.trim()) onUpdate(id, { title: editTitle.trim() });
    setEditingId(null);
  }

  return (
    <div className="card-base p-4 sm:p-5 animate-fade-up">
      <header className="mb-4">
        <h2 className="font-display text-sm font-medium text-ink-100">{longDate}</h2>
        <p className="text-xs text-ink-700">
          {relativeDay(dateKey)}
          {events.length > 0 && ` · ${events.length} event${events.length === 1 ? "" : "s"}`}
        </p>
      </header>

      {events.length === 0 ? (
        <p className="text-sm text-ink-700 mb-4">Nothing on this day yet.</p>
      ) : (
        <ul className="space-y-2 mb-4">
          {events.map((event) => (
            <li
              key={event.id}
              className="flex items-center gap-2 p-2 pl-3 rounded-badge border border-base-600 bg-base-700/30"
            >
              {editingId === event.id ? (
                <>
                  <input
                    autoFocus
                    value={editTitle}
                    onChange={(e) => setEditTitle(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") commitEdit(event.id);
                      if (e.key === "Escape") setEditingId(null);
                    }}
                    aria-label="Event title"
                    className="flex-1 min-w-0 bg-transparent text-base sm:text-sm text-ink-100 outline-none"
                  />
                  <button
                    onClick={() => commitEdit(event.id)}
                    aria-label="Save"
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
                </>
              ) : (
                <>
                  <span
                    className={`w-1.5 h-1.5 rounded-full shrink-0 ${EVENT_KIND_META[event.kind].dot}`}
                    aria-hidden
                  />
                  <span className="flex-1 min-w-0">
                    <span className="block text-sm text-ink-300 truncate">{event.title}</span>
                    <span className="block text-[11px] font-mono text-ink-700">
                      {event.time ?? "All day"} · {EVENT_KIND_META[event.kind].label}
                    </span>
                  </span>
                  <button
                    onClick={() => {
                      setEditingId(event.id);
                      setEditTitle(event.title);
                    }}
                    aria-label={`Edit "${event.title}"`}
                    title="Edit"
                    className="w-9 h-9 shrink-0 flex items-center justify-center rounded-badge text-ink-700 hover:text-ink-300 transition-colors"
                  >
                    <Pencil size={13} />
                  </button>
                  <ConfirmButton
                    label={`Delete "${event.title}"`}
                    onConfirm={() => onDelete(event.id)}
                    compact
                  />
                </>
              )}
            </li>
          ))}
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
        <div className="flex gap-2">
          <input
            type="time"
            value={time}
            onChange={(e) => setTime(e.target.value)}
            aria-label="Time (optional)"
            title="Leave empty for an all-day event"
            className={`${INPUT} font-mono flex-1`}
          />
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
      </div>
    </div>
  );
}
