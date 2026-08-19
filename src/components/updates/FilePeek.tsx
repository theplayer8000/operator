import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { X, FileText, ExternalLink } from "lucide-react";

/**
 * A file, over the page you were reading.
 *
 * The handoff names a dozen files a paragraph. Sending you to the Dev browser
 * to read one costs your place in the note and the scroll position back — so
 * the file comes to you instead, and closing it puts you exactly where you
 * were. Same read-only `/api/dev/file` the Dev page uses; nothing here can
 * write.
 *
 * "Open in Dev" stays for when you actually want to browse around it rather
 * than check one line.
 */
interface Body {
  path?: string;
  size?: number;
  modified?: string;
  content?: string;
  error?: string;
}

export default function FilePeek({ path, onClose }: { path: string; onClose: () => void }) {
  const [body, setBody] = useState<Body | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    setBody(null);
    setError(null);
    void (async () => {
      try {
        const res = await fetch(`/api/dev/file?path=${encodeURIComponent(path)}`, {
          headers: { accept: "application/json" },
        });
        if (!res.ok) throw new Error(`server returned ${res.status}`);
        const json = (await res.json()) as Body;
        if (live) setBody(json);
      } catch (err) {
        if (live) setError((err as Error).message);
      }
    })();
    return () => {
      live = false;
    };
  }, [path]);

  // Escape closes, and the page behind stops scrolling while this is open —
  // otherwise a flick inside the file scrolls the handoff underneath it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = previous;
    };
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-6 bg-black/60 backdrop-blur-sm animate-fade-up"
      onClick={onClose}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={path}
        onClick={(e) => e.stopPropagation()}
        className="card-base w-full sm:max-w-2xl max-h-[85vh] flex flex-col rounded-b-none sm:rounded-card pb-[env(safe-area-inset-bottom)]"
      >
        <header className="flex items-center gap-2 p-3 border-b border-base-600 shrink-0">
          <FileText size={15} className="text-ink-700 shrink-0" />
          <div className="min-w-0 flex-1">
            <p className="font-mono text-xs text-ink-100 truncate">{body?.path ?? path}</p>
            {body?.size != null && (
              <p className="font-mono text-[11px] text-ink-700">
                {body.size < 1024 ? `${body.size} B` : `${(body.size / 1024).toFixed(1)} KB`}
                {body.modified &&
                  ` · ${new Date(body.modified).toLocaleDateString("en-GB", {
                    day: "numeric",
                    month: "short",
                  })}`}
              </p>
            )}
          </div>
          <Link
            to={`/dev?file=${encodeURIComponent(path)}`}
            onClick={onClose}
            aria-label="Open in Dev"
            title="Open in Dev"
            className="w-11 h-11 shrink-0 flex items-center justify-center rounded-badge text-ink-700 hover:text-xp transition-colors"
          >
            <ExternalLink size={15} />
          </Link>
          <button
            onClick={onClose}
            aria-label="Close file"
            className="w-11 h-11 shrink-0 flex items-center justify-center rounded-badge text-ink-700 hover:text-ink-300 transition-colors"
          >
            <X size={16} />
          </button>
        </header>

        {error && <p className="p-4 text-sm text-vital-down">Couldn't read it: {error}</p>}
        {body?.error && <p className="p-4 text-sm text-vital-down">{body.error}</p>}
        {!body && !error && <p className="p-4 text-sm text-ink-700">Reading…</p>}

        {body?.content != null && (
          <pre className="p-4 overflow-auto text-xs font-mono text-ink-300 leading-relaxed">
            {body.content}
          </pre>
        )}
      </div>
    </div>
  );
}
