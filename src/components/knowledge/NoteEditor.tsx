import { useState } from "react";
import { ArrowUpRight, Link2, Swords } from "lucide-react";
import type { KnowledgeNote, MissionRecord } from "@/lib/types";
import { CONFIDENCE_META, CONFIDENCE_ORDER, KIND_META, KIND_ORDER } from "./knowledgeMeta";

/**
 * Editing one note, in place.
 *
 * ## Everything saves as you type — no Save button
 *
 * The rest of Operator works this way (`EditableField` on a mission, the
 * routine's notes) and a vault has a specific reason to match it: you write a
 * note while doing the thing it is about, usually with something else on fire.
 * A Save button is one more thing to forget, and the failure is losing exactly
 * the note that was worth having.
 *
 * The cost is that there is no draft state to discard, which is the bargain
 * everywhere else here too.
 *
 * ## Links are picked, never typed
 *
 * The obvious design is Obsidian's `[[wiki link]]` syntax in the body. It was
 * not built that way on purpose: that stores the relationship inside prose, so
 * renaming a note breaks every link to it and nothing can tell you it did.
 * `links` holds ids, the picker resolves titles, and a rename is a rename.
 */
export default function NoteEditor({
  note,
  allNotes,
  missions,
  onChange,
  onToggleLink,
  onToggleMission,
  onOpenNote,
}: {
  note: KnowledgeNote;
  allNotes: KnowledgeNote[];
  missions: MissionRecord[];
  onChange: (patch: Partial<KnowledgeNote>) => void;
  onToggleLink: (otherId: string) => void;
  onToggleMission: (missionId: string) => void;
  onOpenNote: (id: string) => void;
}) {
  const [linkQuery, setLinkQuery] = useState("");
  const [showMissions, setShowMissions] = useState(false);

  const linked = note.links.map((id) => allNotes.find((n) => n.id === id)).filter(Boolean) as KnowledgeNote[];

  const linkCandidates = linkQuery.trim()
    ? allNotes
        .filter(
          (n) =>
            n.id !== note.id &&
            !note.links.includes(n.id) &&
            n.title.toLowerCase().includes(linkQuery.trim().toLowerCase()),
        )
        .slice(0, 6)
    : [];

  return (
    <div className="space-y-4">
      <input
        value={note.title}
        onChange={(e) => onChange({ title: e.target.value })}
        placeholder="What is this about?"
        // text-base on small screens, or iOS zooms the page on focus.
        className="w-full bg-transparent font-display text-xl text-ink-100 placeholder:text-ink-700 focus:outline-none"
      />

      {/* Kind and confidence, as two rows of chips rather than selects — a
          native select on iOS is a full-screen wheel for three options. */}
      <div className="flex flex-wrap gap-2">
        {KIND_ORDER.map((k) => (
          <button
            key={k}
            onClick={() => onChange({ kind: k })}
            className={`h-9 px-3 rounded-badge border text-[11px] font-mono transition-colors ${
              note.kind === k
                ? KIND_META[k].className
                : "border-base-600 bg-base-800 text-ink-700 hover:text-ink-300"
            }`}
          >
            {KIND_META[k].label}
          </button>
        ))}
        <span className="w-px bg-base-600 mx-1" />
        {CONFIDENCE_ORDER.map((c) => (
          <button
            key={c}
            onClick={() => onChange({ confidence: c })}
            title={CONFIDENCE_META[c].help}
            className={`h-9 px-3 rounded-badge border text-[11px] font-mono transition-colors ${
              note.confidence === c
                ? CONFIDENCE_META[c].className
                : "border-base-600 bg-base-800 text-ink-700 hover:text-ink-300"
            }`}
          >
            {CONFIDENCE_META[c].label}
          </button>
        ))}
      </div>

      <textarea
        value={note.body}
        onChange={(e) => onChange({ body: e.target.value })}
        rows={12}
        placeholder="What you worked out. Markdown is fine — it is stored as text and read by you and by workers."
        className="w-full rounded-badge bg-base-900/60 border border-base-600 px-3 py-2.5 text-base sm:text-sm text-ink-300 placeholder:text-ink-700 font-mono leading-relaxed resize-y focus:outline-none focus:ring-2 focus:ring-xp/30"
      />

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block">
          <span className="text-[11px] font-mono uppercase tracking-wider text-ink-700">
            Topics
          </span>
          <input
            // Stored as an array; edited as a comma list, which is what people
            // type. Lowercasing happens in the hook so the capability layer
            // gets it too.
            value={note.topics.join(", ")}
            onChange={(e) => onChange({ topics: e.target.value.split(",") })}
            placeholder="docker, postgres"
            className="mt-1 w-full h-11 px-3 rounded-badge bg-base-800 border border-base-600 text-base sm:text-sm text-ink-300 placeholder:text-ink-700 font-mono focus:outline-none focus:ring-2 focus:ring-xp/30"
          />
        </label>
        <label className="block">
          <span className="text-[11px] font-mono uppercase tracking-wider text-ink-700">
            Source
          </span>
          <input
            value={note.source ?? ""}
            onChange={(e) => onChange({ source: e.target.value })}
            placeholder="https://…"
            className="mt-1 w-full h-11 px-3 rounded-badge bg-base-800 border border-base-600 text-base sm:text-sm text-ink-300 placeholder:text-ink-700 font-mono focus:outline-none focus:ring-2 focus:ring-xp/30"
          />
        </label>
      </div>

      {/* --- links ------------------------------------------------------- */}
      <section className="pt-4 border-t border-base-600">
        <h3 className="text-xs font-mono uppercase tracking-wider text-ink-700 mb-2 flex items-center gap-1.5">
          <Link2 size={13} /> Links to
        </h3>
        <div className="space-y-1 mb-2">
          {linked.map((n) => (
            <div key={n.id} className="flex items-center gap-1">
              <button
                onClick={() => onOpenNote(n.id)}
                className="flex-1 min-h-11 px-3 py-2 rounded-badge bg-base-700/40 hover:bg-base-700 text-left text-sm text-ink-300 flex items-center justify-between gap-2 transition-colors"
              >
                <span className="truncate">{n.title}</span>
                <ArrowUpRight size={14} className="shrink-0 text-ink-700" />
              </button>
              <button
                onClick={() => onToggleLink(n.id)}
                aria-label={`Unlink ${n.title}`}
                className="h-11 w-11 shrink-0 flex items-center justify-center text-ink-700 hover:text-vital-down transition-colors"
              >
                ×
              </button>
            </div>
          ))}
        </div>
        <input
          value={linkQuery}
          onChange={(e) => setLinkQuery(e.target.value)}
          placeholder="Link to another note…"
          className="w-full h-11 px-3 rounded-badge bg-base-800 border border-base-600 text-base sm:text-sm text-ink-300 placeholder:text-ink-700 focus:outline-none focus:ring-2 focus:ring-xp/30"
        />
        {linkCandidates.length > 0 && (
          <div className="mt-1 space-y-1">
            {linkCandidates.map((n) => (
              <button
                key={n.id}
                onClick={() => {
                  onToggleLink(n.id);
                  setLinkQuery("");
                }}
                className="w-full min-h-11 px-3 py-2 rounded-badge bg-base-700/30 hover:bg-base-700 text-left text-sm text-ink-500 truncate transition-colors"
              >
                {n.title}
              </button>
            ))}
          </div>
        )}
      </section>

      {/* --- missions ----------------------------------------------------- */}
      <section className="pt-4 border-t border-base-600">
        <h3 className="text-xs font-mono uppercase tracking-wider text-ink-700 mb-2 flex items-center gap-1.5">
          <Swords size={13} /> Knowledge for
        </h3>
        <div className="flex flex-wrap gap-2">
          {missions
            .filter((m) => note.missions.includes(m.id) || showMissions)
            .map((m) => (
              <button
                key={m.id}
                onClick={() => onToggleMission(m.id)}
                className={`h-9 px-3 rounded-badge border text-[11px] transition-colors ${
                  note.missions.includes(m.id)
                    ? "border-xp/45 bg-xp/10 text-xp"
                    : "border-base-600 bg-base-800 text-ink-700 hover:text-ink-300"
                }`}
              >
                {m.name}
              </button>
            ))}
          <button
            onClick={() => setShowMissions(!showMissions)}
            className="h-9 px-3 rounded-badge border border-base-600 bg-base-800 text-[11px] text-ink-700 hover:text-ink-300 transition-colors"
          >
            {showMissions ? "done" : "attach…"}
          </button>
        </div>
      </section>
    </div>
  );
}
