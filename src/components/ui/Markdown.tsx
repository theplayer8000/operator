import { Fragment, type ReactNode } from "react";

/**
 * A deliberately small markdown renderer.
 *
 * Claude replies in markdown — fenced code, headings, lists, bold — and showing
 * that raw turns a structured answer into a wall of text with stray asterisks
 * and backticks in it. This renders the subset Claude actually uses.
 *
 * **Why hand-rolled rather than a library.** `CLAUDE.md` fixes the stack at
 * React + TS + Vite + Tailwind + Router + Recharts + lucide, "nothing else", and
 * a markdown library is a real dependency with a real surface. The subset below
 * is a few dozen lines and covers what turns up in practice. If something more
 * demanding ever needs rendering — tables, footnotes, embedded HTML — that is a
 * dependency decision to take deliberately, not to sneak in by growing this.
 *
 * Deliberately **not** supported: raw HTML (never dangerouslySetInnerHTML — the
 * text comes from a model, and injecting it as markup is the one shortcut that
 * turns a rendering nicety into an XSS hole), tables, blockquotes, images.
 */

/** Split on fenced code blocks first, so nothing inside a fence gets styled. */
function splitFences(text: string) {
  const parts: { type: "code" | "prose"; text: string; lang?: string }[] = [];
  const fence = /```([\w-]*)\n?([\s\S]*?)```/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = fence.exec(text)) !== null) {
    if (m.index > last) parts.push({ type: "prose", text: text.slice(last, m.index) });
    parts.push({ type: "code", text: m[2].replace(/\n$/, ""), lang: m[1] || undefined });
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push({ type: "prose", text: text.slice(last) });
  return parts;
}

/** Inline: `code`, **bold**, and bare links. Applied to a single line. */
function inline(text: string, keyPrefix: string): ReactNode[] {
  const out: ReactNode[] = [];
  // One pass, alternating between the three patterns, so a URL inside backticks
  // stays code rather than becoming a link.
  const pattern = /(`[^`]+`)|(\*\*[^*]+\*\*)|(https?:\/\/[^\s)]+)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = pattern.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const token = m[0];
    const key = `${keyPrefix}-i${i++}`;
    if (token.startsWith("`")) {
      out.push(
        <code key={key} className="font-mono text-[0.92em] px-1 py-0.5 rounded bg-base-950/60 text-ink-100">
          {token.slice(1, -1)}
        </code>
      );
    } else if (token.startsWith("**")) {
      out.push(
        <strong key={key} className="font-medium text-ink-100">
          {token.slice(2, -2)}
        </strong>
      );
    } else {
      out.push(
        <a
          key={key}
          href={token}
          target="_blank"
          rel="noreferrer"
          className="text-xp underline underline-offset-2 break-all"
        >
          {token}
        </a>
      );
    }
    last = m.index + token.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function Prose({ text, keyPrefix }: { text: string; keyPrefix: string }) {
  const lines = text.split("\n");
  const blocks: ReactNode[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;

  const flushList = (at: number) => {
    if (!list) return;
    const Tag = list.ordered ? "ol" : "ul";
    blocks.push(
      <Tag
        key={`${keyPrefix}-l${at}`}
        className={`${list.ordered ? "list-decimal" : "list-disc"} pl-5 space-y-0.5 my-1.5`}
      >
        {list.items.map((item, n) => (
          <li key={n}>{inline(item, `${keyPrefix}-l${at}-${n}`)}</li>
        ))}
      </Tag>
    );
    list = null;
  };

  lines.forEach((line, n) => {
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);

    if (bullet || numbered) {
      const ordered = Boolean(numbered);
      if (!list || list.ordered !== ordered) flushList(n);
      list = list ?? { ordered, items: [] };
      list.items.push((bullet ? bullet[1] : numbered![1]) ?? "");
      return;
    }
    flushList(n);

    if (heading) {
      blocks.push(
        <p key={`${keyPrefix}-h${n}`} className="font-medium text-ink-100 mt-2 first:mt-0">
          {inline(heading[2], `${keyPrefix}-h${n}`)}
        </p>
      );
      return;
    }
    if (line.trim() === "") return;
    blocks.push(
      <p key={`${keyPrefix}-p${n}`} className="my-1 first:mt-0 last:mb-0">
        {inline(line, `${keyPrefix}-p${n}`)}
      </p>
    );
  });
  flushList(lines.length);

  return <>{blocks}</>;
}

export default function Markdown({ text }: { text: string }) {
  const parts = splitFences(text);
  return (
    <>
      {parts.map((part, i) =>
        part.type === "code" ? (
          <pre
            key={`c${i}`}
            className="my-2 p-2.5 rounded-badge bg-base-950/70 border border-base-600 overflow-x-auto"
          >
            {part.lang && (
              <span className="block text-[10px] font-mono text-ink-700 mb-1">{part.lang}</span>
            )}
            <code className="font-mono text-[11px] text-ink-300 whitespace-pre">{part.text}</code>
          </pre>
        ) : (
          <Fragment key={`p${i}`}>
            <Prose text={part.text} keyPrefix={`p${i}`} />
          </Fragment>
        )
      )}
    </>
  );
}
