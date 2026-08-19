import { Fragment, useCallback, useEffect, useState } from "react";
import { NotebookPen, RefreshCw, ChevronDown, ChevronUp } from "lucide-react";
import FilePeek from "./FilePeek";

/**
 * The live handoff, read straight off disk.
 *
 * `docs/handoffs/CURRENT.md` is the note every session is required to keep
 * current — what is in flight, what is verified, what is waiting on the owner.
 * It was only ever readable at the desk, which is the wrong place: the person
 * it is written for reads Operator on a phone.
 *
 * **It is not copied into the store, deliberately.** `CLAUDE.md` forbids a
 * second stored copy of anything that can be derived, and a handoff duplicated
 * into `updates.*` would need keeping in step with the file by hand — so the
 * first time they disagreed, neither could be trusted. This renders the file.
 *
 * No new server route either: `/api/dev/file` already reads repo text safely
 * (path-checked, size-capped, extension-allowlisted) and returns the mtime,
 * which is what makes "how old is this note" answerable.
 */

const HANDOFF_PATH = "docs/handoffs/CURRENT.md";

/** Past this, the note is more likely abandoned than current. */
const STALE_AFTER_HOURS = 72;

interface FileBody {
  path?: string;
  modified?: string;
  content?: string;
  error?: string;
}

function ago(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 3_600_000) return `${Math.max(1, Math.round(ms / 60_000))}m ago`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h ago`;
  return `${Math.round(ms / 86_400_000)}d ago`;
}

/**
 * A code span that is a file in this repo, or null.
 *
 * The handoff names a dozen files a paragraph, and "go to Dev, find scripts,
 * scroll" is not a reference — so the ones that are really paths become links
 * into the Dev browser. Everything else (`canUseTool`, `git push`,
 * `bypassPermissions`) stays plain code.
 *
 * Mirrors what the server will actually serve: an extension it treats as text,
 * and not a directory it refuses. Offering a link that lands on "path not
 * allowed" would be worse than no link.
 */
const DENIED_ROOTS = new Set(["node_modules", ".git", "dist", "data", ".vite", "Darams-CRM"]);
const FILE_LIKE =
  /^[\w.@-]+(?:\/[\w.@-]+)*\.(ts|tsx|js|jsx|mjs|cjs|json|md|css|html|yml|yaml|txt|cmd)$/;

function repoPath(text: string): string | null {
  if (!FILE_LIKE.test(text)) return null;
  if (DENIED_ROOTS.has(text.split("/")[0])) return null;
  return text;
}

/**
 * Inline `**bold**` and `` `code` ``, and nothing else.
 *
 * A markdown library is not in the stack (`CLAUDE.md`) and this does not need
 * one — the handoff is prose, headings, lists and code. Anything unsupported
 * renders as its own source text, which is legible rather than broken.
 */
function inline(text: string, keyPrefix: string, onPeek: (path: string) => void) {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
  return parts.map((part, i) => {
    const key = `${keyPrefix}-${i}`;
    if (part.startsWith("**") && part.endsWith("**") && part.length > 4) {
      return (
        <strong key={key} className="text-ink-100 font-medium">
          {part.slice(2, -2)}
        </strong>
      );
    }
    if (part.startsWith("`") && part.endsWith("`") && part.length > 2) {
      const code = part.slice(1, -1);
      const file = repoPath(code);
      if (file) {
        return (
          <button
            key={key}
            onClick={() => onPeek(file)}
            className="font-mono text-[0.85em] text-xp break-words underline decoration-dotted decoration-xp/40 underline-offset-2 hover:decoration-xp transition-colors"
          >
            {code}
          </button>
        );
      }
      return (
        <code key={key} className="font-mono text-[0.85em] text-xp break-words">
          {code}
        </code>
      );
    }
    return <Fragment key={key}>{part}</Fragment>;
  });
}

/**
 * Markdown, only as far as the handoff actually uses it.
 *
 * Tables and anything else unrecognised fall through to a monospace line, so an
 * unsupported construct is still readable instead of silently dropped.
 */
function render(markdown: string, onPeek: (path: string) => void) {
  const lines = markdown.split(/\r?\n/);
  const out: JSX.Element[] = [];
  let bullets: string[] = [];
  let code: string[] = [];
  let inCode = false;

  const flushBullets = (key: string) => {
    if (!bullets.length) return;
    out.push(
      <ul key={key} className="space-y-1.5 my-2">
        {bullets.map((b, i) => (
          <li key={i} className="flex gap-2 text-sm text-ink-300 leading-relaxed">
            <span className="mt-[0.55rem] w-1 h-1 rounded-full bg-ink-700 shrink-0" aria-hidden />
            <span className="min-w-0">{inline(b, `${key}-${i}`, onPeek)}</span>
          </li>
        ))}
      </ul>
    );
    bullets = [];
  };

  const flushCode = (key: string) => {
    if (!code.length) return;
    out.push(
      <pre
        key={key}
        className="my-2.5 p-3 rounded-badge bg-base-950/60 border border-base-600 overflow-x-auto font-mono text-[11px] leading-relaxed text-ink-300"
      >
        {code.join("\n")}
      </pre>
    );
    code = [];
  };

  lines.forEach((raw, i) => {
    const key = `l${i}`;

    if (raw.trimStart().startsWith("```")) {
      if (inCode) flushCode(key);
      inCode = !inCode;
      return;
    }
    if (inCode) {
      code.push(raw);
      return;
    }

    const line = raw.trim();

    if (!line) {
      flushBullets(key);
      return;
    }

    if (line.startsWith("- ") || line.startsWith("* ")) {
      bullets.push(line.slice(2));
      return;
    }
    flushBullets(`${key}-flush`);

    if (line.startsWith("### ")) {
      out.push(
        <h4 key={key} className="font-display text-xs text-ink-300 mt-3.5 mb-1">
          {inline(line.slice(4), key, onPeek)}
        </h4>
      );
    } else if (line.startsWith("## ")) {
      out.push(
        <h3 key={key} className="font-display text-sm text-ink-100 mt-4 mb-1.5 first:mt-0">
          {inline(line.slice(3), key, onPeek)}
        </h3>
      );
    } else if (line.startsWith("# ")) {
      // The file's own title is the card's title — don't say it twice.
      return;
    } else if (line.startsWith("> ")) {
      out.push(
        <p
          key={key}
          className="my-2 pl-3 border-l border-base-500 text-sm text-ink-500 leading-relaxed"
        >
          {inline(line.slice(2), key, onPeek)}
        </p>
      );
    } else if (line.startsWith("|")) {
      out.push(
        <div key={key} className="overflow-x-auto">
          <p className="font-mono text-[11px] text-ink-500 whitespace-pre">{line}</p>
        </div>
      );
    } else {
      out.push(
        <p key={key} className="my-2 text-sm text-ink-300 leading-relaxed">
          {inline(line, key, onPeek)}
        </p>
      );
    }
  });

  flushBullets("end-b");
  flushCode("end-c");
  return out;
}

/**
 * The header block plus the first section — the part a handoff puts first on
 * purpose. Everything after it is behind "Show all", because the whole note is
 * a long read on a phone and the top is the bit that changes what you do next.
 */
function firstSection(markdown: string): { head: string; rest: string } {
  const lines = markdown.split(/\r?\n/);
  const headings: number[] = [];
  lines.forEach((l, i) => {
    if (l.startsWith("## ")) headings.push(i);
  });
  if (headings.length < 2) return { head: markdown, rest: "" };
  const cut = headings[1];
  return { head: lines.slice(0, cut).join("\n"), rest: lines.slice(cut).join("\n") };
}

export default function HandoffCard() {
  const [body, setBody] = useState<FileBody | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [peek, setPeek] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`/api/dev/file?path=${encodeURIComponent(HANDOFF_PATH)}`, {
        headers: { accept: "application/json" },
      });
      if (!res.ok) throw new Error(`server returned ${res.status}`);
      setBody((await res.json()) as FileBody);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const content = body?.content?.trim() ?? "";
  const stale =
    body?.modified != null &&
    Date.now() - new Date(body.modified).getTime() > STALE_AFTER_HOURS * 3_600_000;
  const { head, rest } = firstSection(content);

  return (
    <section className="card-base p-4 sm:p-5 mb-5 animate-fade-up">
      <header className="flex items-start justify-between gap-3 mb-3">
        <div className="flex items-center gap-2 min-w-0">
          <NotebookPen size={16} className="text-ink-500 shrink-0" />
          <div className="min-w-0">
            <h2 className="font-display text-sm font-medium text-ink-300">Handoff</h2>
            <p className="text-xs text-ink-700 truncate">
              Where the work actually is
              {body?.modified && (
                <span className="font-mono"> · updated {ago(body.modified)}</span>
              )}
            </p>
          </div>
        </div>
        <button
          onClick={() => void refresh()}
          aria-label="Refresh handoff"
          title="Refresh"
          className="w-11 h-11 shrink-0 rounded-badge border border-base-600 flex items-center justify-center text-ink-500 hover:text-ink-100 hover:border-base-500 transition-colors"
        >
          <RefreshCw size={14} />
        </button>
      </header>

      {error && (
        <p className="text-sm text-vital-down">Couldn't read the handoff: {error}</p>
      )}
      {body?.error && <p className="text-sm text-vital-down">{body.error}</p>}

      {/*
        An empty note is reported, never papered over. `CLAUDE.md`: "If it is
        empty or stale, say so rather than guessing — a confident summary
        reconstructed from the diff is worse than 'the last session left no
        note'." The card obeys the same rule the writer does.
      */}
      {body && !body.error && !content && (
        <p className="text-sm text-ink-500">
          The last session left no note. Nothing here is in flight as far as the file knows.
        </p>
      )}

      {stale && content && (
        <p className="mb-3 px-3 py-2 rounded-badge border border-xp/30 bg-xp/5 text-xs text-xp">
          Not touched in over {STALE_AFTER_HOURS / 24} days — treat it as history, not as what's
          happening now.
        </p>
      )}

      {content && (
        <>
          <div className="min-w-0">{render(expanded ? content : head, setPeek)}</div>

          {rest && (
            <button
              onClick={() => setExpanded((v) => !v)}
              className="mt-3 w-full min-h-[44px] rounded-badge border border-base-600 bg-base-700/30 flex items-center justify-center gap-2 text-sm text-ink-300 hover:text-ink-100 hover:border-base-500 transition-colors"
            >
              {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
              {expanded ? "Show less" : "Show the whole note"}
            </button>
          )}
        </>
      )}

      {peek && <FilePeek path={peek} onClose={() => setPeek(null)} />}
    </section>
  );
}
