import { useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Plus, Search, Link2, Archive, ArrowUpRight, X } from "lucide-react";
import Card from "@/components/ui/Card";
import EmptyState from "@/components/ui/EmptyState";
import ConfirmButton from "@/components/ui/ConfirmButton";
import { useKnowledge } from "@/hooks/useKnowledge";
import { useMissionBoard } from "@/hooks/useMissionBoard";
import NoteEditor from "@/components/knowledge/NoteEditor";
import NoteRow from "@/components/knowledge/NoteRow";
import { CONFIDENCE_META, KIND_META } from "@/components/knowledge/knowledgeMeta";

/**
 * The Knowledge Vault — search, a list, and one note open beside it.
 *
 * ## Register: reference, not game
 *
 * `CLAUDE.md` asks which of the three registers a new feature sits in before it
 * is built. This one is the calm end, with the Mission Board: no shields, no
 * confetti, no XP language. A vault is somewhere you go when you need an
 * answer, usually while something is broken, and celebrating a lookup would be
 * the wrong note entirely.
 *
 * ## One page, two routes
 *
 * `/knowledge` and `/knowledge/:id` render this same component; the parameter
 * only decides what is open. That keeps the "one page per feature" rule while
 * still giving a note a real URL — which matters because the Mission Board is
 * going to link straight at one.
 *
 * ## Master–detail rather than a list and a separate page
 *
 * The thing you actually do in a wiki is follow a link and come back. A full
 * page navigation per note makes that a page load each way, and on the desk
 * there is room for both. On a phone the list collapses and the note takes the
 * screen, which is the same layout behaving sensibly rather than a second one.
 */
export default function Knowledge() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const vault = useKnowledge();
  const { missions } = useMissionBoard();

  const [query, setQuery] = useState("");
  const [topic, setTopic] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [showArchived, setShowArchived] = useState(false);

  const hits = useMemo(() => {
    const found = vault.search(query, { includeArchived: showArchived });
    return topic ? found.filter((h) => h.note.topics.includes(topic)) : found;
  }, [vault, query, topic, showArchived]);

  const open = id ? vault.byId(id) : null;
  const backlinks = open ? vault.linkedFrom(open.id) : [];

  const create = () => {
    const note = vault.add({ title: "Untitled note", topics: topic ? [topic] : [] });
    setCreating(false);
    navigate(`/knowledge/${note.id}`);
  };

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl text-ink-100">Knowledge Vault</h1>
          <p className="text-sm text-ink-500 mt-1 font-mono">
            {vault.active.length} note{vault.active.length === 1 ? "" : "s"} ·{" "}
            {vault.topics.length} topic{vault.topics.length === 1 ? "" : "s"}
          </p>
        </div>
        <button
          onClick={create}
          className="h-11 px-4 rounded-badge bg-xp text-base-950 text-sm font-medium flex items-center gap-2 hover:brightness-110 transition"
        >
          <Plus size={16} /> New note
        </button>
      </header>

      {/*
        Search first, and always visible.

        A vault is not browsed, it is queried — you arrive knowing roughly what
        you want. Putting the box at the top and leaving the list underneath
        means the same screen serves "find the Postgres thing" and "what have I
        even written down", without a mode switch between them.
      */}
      <div className="relative">
        <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-700" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search titles, topics and text…"
          className="w-full h-12 pl-10 pr-3 rounded-badge bg-base-800 border border-base-600 text-base sm:text-sm text-ink-100 placeholder:text-ink-700 focus:outline-none focus:ring-2 focus:ring-xp/40"
        />
      </div>

      {vault.topics.length > 0 && (
        // Scrolls rather than wraps — the design system's rule for a long row,
        // and a topic list grows without limit.
        <div className="flex gap-2 overflow-x-auto pb-1 -mx-1 px-1">
          {vault.topics.map(({ topic: t, count }) => (
            <button
              key={t}
              onClick={() => setTopic(topic === t ? null : t)}
              className={`shrink-0 h-9 px-3 rounded-badge border text-xs font-mono transition-colors ${
                topic === t
                  ? "border-xp/50 bg-xp/10 text-xp"
                  : "border-base-600 bg-base-800 text-ink-500 hover:text-ink-300"
              }`}
            >
              {t} <span className="text-ink-700">{count}</span>
            </button>
          ))}
        </div>
      )}

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
        {/* The list. Hidden on a phone while a note is open — see the header. */}
        <div className={`space-y-2 ${open ? "hidden lg:block" : ""}`}>
          {hits.length === 0 ? (
            <EmptyState
              message={
                query
                  ? "Search matches words, not meaning — try the word you would have written down."
                  : "Notes, commands and links you worked out once and do not want to work out again. Start with the last thing you had to look up twice."
              }
            />
          ) : (
            hits.map((hit) => (
              <NoteRow
                key={hit.note.id}
                hit={hit}
                selected={hit.note.id === id}
                onOpen={() => navigate(`/knowledge/${hit.note.id}`)}
              />
            ))
          )}

          {vault.notes.some((n) => n.archived) && (
            <button
              onClick={() => setShowArchived(!showArchived)}
              className="w-full h-10 rounded-badge border border-base-600 text-xs text-ink-700 hover:text-ink-300 transition-colors"
            >
              {showArchived ? "Hide archived" : "Show archived"}
            </button>
          )}
        </div>

        {/* The open note. */}
        <div className={open ? "" : "hidden lg:block"}>
          {open ? (
            <Card className="p-5 space-y-5">
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-center gap-2 flex-wrap">
                  <span
                    className={`h-7 px-2.5 rounded-badge border text-[11px] font-mono inline-flex items-center ${KIND_META[open.kind].className}`}
                  >
                    {KIND_META[open.kind].label}
                  </span>
                  <span
                    className={`h-7 px-2.5 rounded-badge border text-[11px] font-mono inline-flex items-center ${CONFIDENCE_META[open.confidence].className}`}
                    title={CONFIDENCE_META[open.confidence].help}
                  >
                    {CONFIDENCE_META[open.confidence].label}
                  </span>
                </div>
                <button
                  onClick={() => navigate("/knowledge")}
                  aria-label="Close this note"
                  className="h-11 w-11 -mr-2 -mt-2 flex items-center justify-center text-ink-700 hover:text-ink-300 transition-colors"
                >
                  <X size={18} />
                </button>
              </div>

              <NoteEditor
                note={open}
                allNotes={vault.active}
                missions={missions.filter((m) => !m.archived)}
                onChange={(patch) => vault.update(open.id, patch)}
                onToggleLink={(other) => vault.toggleLink(open.id, other)}
                onToggleMission={(missionId) => vault.toggleMission(open.id, missionId)}
                onOpenNote={(noteId) => navigate(`/knowledge/${noteId}`)}
              />

              {/*
                Backlinks are DERIVED, so this is a view rather than a field.
                Same as a mission's successors: nothing here can fall out of
                step with the forward link, because there is only one edge.
              */}
              {backlinks.length > 0 && (
                <section className="pt-4 border-t border-base-600">
                  <h3 className="text-xs font-mono uppercase tracking-wider text-ink-700 mb-2 flex items-center gap-1.5">
                    <Link2 size={13} /> Linked from
                  </h3>
                  <div className="space-y-1">
                    {backlinks.map((n) => (
                      <button
                        key={n.id}
                        onClick={() => navigate(`/knowledge/${n.id}`)}
                        className="w-full min-h-11 px-3 py-2 rounded-badge bg-base-700/40 hover:bg-base-700 text-left text-sm text-ink-300 flex items-center justify-between gap-2 transition-colors"
                      >
                        <span className="truncate">{n.title}</span>
                        <ArrowUpRight size={14} className="shrink-0 text-ink-700" />
                      </button>
                    ))}
                  </div>
                </section>
              )}

              <div className="pt-4 border-t border-base-600 flex items-center justify-between gap-3">
                <p className="text-[11px] font-mono text-ink-700">
                  updated {new Date(open.updatedAt).toLocaleDateString()}
                </p>
                {/*
                  Archive, not delete. There is no undo (OPS-020) and a note is
                  the least recoverable thing in the store — a mission can be
                  described again from the work; something you worked out once
                  and wrote down cannot.
                */}
                <ConfirmButton
                  onConfirm={() => {
                    vault.archive(open.id, !open.archived);
                    if (!open.archived) navigate("/knowledge");
                  }}
                  label={open.archived ? "Restore" : "Archive"}
                  icon={<Archive size={14} />}
                />
              </div>
            </Card>
          ) : (
            <Card className="p-8">
              <EmptyState
                message="Pick a note, or start one. Search matches words rather than meaning — the vocabulary you wrote it in is the vocabulary that finds it."
              />
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
