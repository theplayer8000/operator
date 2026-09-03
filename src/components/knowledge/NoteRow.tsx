import { Link2 } from "lucide-react";
import type { SearchHit } from "@/lib/search";
import { CONFIDENCE_META, KIND_META } from "./knowledgeMeta";

/**
 * One note in the search results.
 *
 * ## It says WHY it matched
 *
 * `matched` comes back from the search service and is shown as a small hint.
 * Without it a result list is a list of assertions: a note whose title has
 * nothing to do with what you typed appears next to one that is exactly it,
 * and you have to open both to find out which is which. Saying "body" tells
 * you the word is buried in there somewhere, which is usually enough to skip it.
 *
 * That matters more here than it would elsewhere, because the search is a word
 * scan — see `lib/search.ts`. Being honest about the weakest kind of match is
 * how the UI avoids implying it understood the question.
 */
export default function NoteRow({
  hit,
  selected,
  onOpen,
}: {
  hit: SearchHit;
  selected: boolean;
  onOpen: () => void;
}) {
  const { note, matched } = hit;
  const confidence = CONFIDENCE_META[note.confidence];

  return (
    <button
      onClick={onOpen}
      // 44px minimum, and a real target the whole width of the row rather than
      // a link on the title — this list is used from a phone.
      className={`w-full min-h-[44px] text-left px-3 py-3 rounded-badge border transition-colors ${
        selected
          ? "border-xp/45 bg-xp/[0.07]"
          : "border-base-600 bg-base-800 hover:border-base-500"
      } ${note.archived ? "opacity-55" : ""}`}
    >
      <div className="flex items-start gap-2.5">
        <span
          className={`mt-1.5 h-2 w-2 rounded-full shrink-0 ${confidence.dot}`}
          title={confidence.help}
          aria-label={confidence.label}
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <h3 className="text-sm text-ink-100 truncate">{note.title || "Untitled note"}</h3>
            {note.archived && (
              <span className="text-[10px] font-mono text-ink-700 shrink-0">archived</span>
            )}
          </div>

          {note.body && (
            <p className="text-xs text-ink-500 mt-1 line-clamp-2 break-words">
              {note.body.slice(0, 180)}
            </p>
          )}

          <div className="flex items-center gap-2 mt-2 flex-wrap">
            <span
              className={`h-6 px-2 rounded-badge border text-[10px] font-mono inline-flex items-center ${KIND_META[note.kind].className}`}
            >
              {KIND_META[note.kind].label}
            </span>
            {note.topics.slice(0, 3).map((t) => (
              <span key={t} className="text-[10px] font-mono text-ink-700">
                {t}
              </span>
            ))}
            {note.links.length > 0 && (
              <span className="text-[10px] font-mono text-ink-700 inline-flex items-center gap-1">
                <Link2 size={10} /> {note.links.length}
              </span>
            )}
            {/*
              Only shown for the weak matches. "Matched: title" is noise — you
              can see the title. "Matched: body" is the one that changes whether
              you bother opening it.
            */}
            {(matched === "body" || matched === "source") && (
              <span className="text-[10px] font-mono text-ink-700 ml-auto">in {matched}</span>
            )}
          </div>
        </div>
      </div>
    </button>
  );
}
