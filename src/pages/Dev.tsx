import {
  Terminal,
  Folder,
  FileText,
  ChevronRight,
  Github,
  X,
  CornerLeftUp,
  GitCommitHorizontal,
} from "lucide-react";
import { useDevBrowser } from "@/hooks/useDevBrowser";
import ConnectedClients from "@/components/dev/ConnectedClients";
import ClaudeStatus from "@/components/dev/ClaudeStatus";

const DOC_SHORTCUTS = [
  { path: "CLAUDE.md", label: "CLAUDE.md" },
  { path: "docs/vision.md", label: "Vision" },
  { path: "docs/architecture.md", label: "Architecture" },
  { path: "docs/known-issues.md", label: "Known issues" },
  { path: "docs/roadmap.md", label: "Roadmap" },
];

function formatBytes(n: number) {
  return n < 1024 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`;
}

export default function Dev() {
  const { meta, path, crumbs, items, file, error, loading, openFile, openDir, setFile } =
    useDevBrowser();

  const parent = path === "." ? null : crumbs.slice(0, -1).map((c) => c.name).join("/") || ".";

  return (
    <div className="max-w-3xl mx-auto lg:mx-0">
      <div className="flex items-center gap-3 mb-5">
        <div className="w-10 h-10 shrink-0 rounded-badge bg-xp/10 border border-xp/25 flex items-center justify-center text-xp">
          <Terminal size={18} />
        </div>
        <div className="min-w-0">
          <h1 className="font-display text-lg text-ink-100 leading-tight">Dev</h1>
          <p className="text-xs text-ink-500 truncate">
            Read-only view of the project. No editing from here.
          </p>
        </div>
      </div>

      <ConnectedClients />
      <ClaudeStatus />

      {/* Repo status */}
      <section className="card-base p-4 sm:p-5 mb-5 animate-fade-up">
        {meta?.commit ? (
          <>
            <div className="flex items-start justify-between gap-3 mb-3">
              <div className="min-w-0">
                <p className="text-sm text-ink-100 break-words">{meta.subject}</p>
                <p className="text-xs text-ink-700 font-mono mt-1">
                  {meta.branch} · {meta.commit}
                  {meta.committedAt &&
                    ` · ${new Date(meta.committedAt).toLocaleString("en-GB", {
                      day: "numeric",
                      month: "short",
                      hour: "2-digit",
                      minute: "2-digit",
                    })}`}
                </p>
              </div>
              <GitCommitHorizontal size={16} className="text-ink-700 shrink-0 mt-0.5" />
            </div>
            {meta.webUrl && (
              <div className="flex flex-wrap gap-2">
                <a
                  href={meta.webUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center gap-2 px-3 min-h-[38px] rounded-badge border border-base-600 text-xs text-ink-300 hover:border-base-500 transition-colors"
                >
                  <Github size={13} /> Repository
                </a>
                <a
                  href={`${meta.webUrl}/commits/${meta.branch ?? "main"}`}
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center gap-2 px-3 min-h-[38px] rounded-badge border border-base-600 text-xs text-ink-300 hover:border-base-500 transition-colors"
                >
                  Commits
                </a>
                {meta.commit && (
                  <a
                    href={`${meta.webUrl}/commit/${meta.commit}`}
                    target="_blank"
                    rel="noreferrer"
                    className="flex items-center gap-2 px-3 min-h-[38px] rounded-badge border border-base-600 text-xs text-ink-300 hover:border-base-500 transition-colors font-mono"
                  >
                    {meta.commit}
                  </a>
                )}
              </div>
            )}
          </>
        ) : (
          <p className="text-sm text-ink-700">
            No git metadata — the storage server may be down, or this isn't a git checkout.
          </p>
        )}
      </section>

      {/* Doc shortcuts */}
      <div className="flex items-center gap-2 mb-5 overflow-x-auto scrollbar-none -mx-4 px-4 sm:mx-0 sm:px-0">
        {DOC_SHORTCUTS.map((d) => (
          <button
            key={d.path}
            onClick={() => void openFile(d.path)}
            className={`px-3 min-h-[38px] shrink-0 rounded-badge text-xs border transition-colors ${
              file?.path === d.path
                ? "bg-base-700 border-base-500 text-ink-100"
                : "border-base-600 text-ink-500 hover:text-ink-300"
            }`}
          >
            {d.label}
          </button>
        ))}
      </div>

      {error && (
        <p className="mb-4 px-3 py-2 rounded-badge border border-vital-down/40 bg-vital-down/10 text-vital-down text-xs">
          {error}
        </p>
      )}

      {file ? (
        <section className="card-base overflow-hidden animate-fade-up">
          <header className="flex items-center gap-3 px-4 py-3 border-b border-base-600">
            <FileText size={14} className="text-ink-500 shrink-0" />
            <div className="min-w-0 flex-1">
              <p className="text-sm text-ink-100 font-mono truncate">{file.path}</p>
              <p className="text-xs text-ink-700">
                {formatBytes(file.size)} ·{" "}
                {new Date(file.modified).toLocaleString("en-GB", {
                  day: "numeric",
                  month: "short",
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </p>
            </div>
            {meta?.webUrl && (
              <a
                href={`${meta.webUrl}/blob/${meta.branch ?? "main"}/${file.path}`}
                target="_blank"
                rel="noreferrer"
                aria-label="View on GitHub"
                className="w-11 h-11 shrink-0 flex items-center justify-center text-ink-700 hover:text-ink-300 transition-colors"
              >
                <Github size={15} />
              </a>
            )}
            <button
              onClick={() => setFile(null)}
              aria-label="Close file"
              className="w-11 h-11 shrink-0 flex items-center justify-center text-ink-700 hover:text-ink-300 transition-colors"
            >
              <X size={16} />
            </button>
          </header>
          <pre className="p-4 overflow-x-auto text-xs font-mono text-ink-300 leading-relaxed max-h-[60vh] overflow-y-auto">
            {file.content}
          </pre>
        </section>
      ) : (
        <section className="card-base p-4 sm:p-5 animate-fade-up">
          {/* Breadcrumbs */}
          <header className="flex items-center gap-1 flex-wrap mb-2 pb-2 border-b border-base-600 text-xs">
            <button
              onClick={() => openDir(".")}
              className="font-mono text-ink-500 hover:text-ink-100 transition-colors"
            >
              operator
            </button>
            {crumbs.map((c) => (
              <span key={c.path} className="flex items-center gap-1">
                <ChevronRight size={11} className="text-ink-700" />
                <button
                  onClick={() => openDir(c.path)}
                  className="font-mono text-ink-500 hover:text-ink-100 transition-colors"
                >
                  {c.name}
                </button>
              </span>
            ))}
          </header>

          {loading ? (
            <p className="text-sm text-ink-700 py-6 text-center">Loading…</p>
          ) : (
            <div className="space-y-0.5">
              {parent !== null && (
                <button
                  onClick={() => openDir(parent)}
                  className="w-full flex items-center gap-3 px-2 min-h-[44px] rounded-badge text-left hover:bg-base-700/50 transition-colors"
                >
                  <CornerLeftUp size={15} className="text-ink-700 shrink-0" />
                  <span className="text-sm text-ink-500 font-mono">..</span>
                </button>
              )}
              {items.map((item) => (
                <button
                  key={item.path}
                  onClick={() => (item.type === "dir" ? openDir(item.path) : void openFile(item.path))}
                  className="w-full flex items-center gap-3 px-2 min-h-[44px] rounded-badge text-left hover:bg-base-700/50 transition-colors"
                >
                  {item.type === "dir" ? (
                    <Folder size={15} className="text-xp shrink-0" />
                  ) : (
                    <FileText size={15} className="text-ink-700 shrink-0" />
                  )}
                  <span className="flex-1 min-w-0 text-sm text-ink-300 font-mono truncate">
                    {item.name}
                  </span>
                  {item.type === "file" && (
                    <span className="text-xs font-mono text-ink-700 shrink-0">
                      {formatBytes(item.size)}
                    </span>
                  )}
                </button>
              ))}
            </div>
          )}
        </section>
      )}
    </div>
  );
}
