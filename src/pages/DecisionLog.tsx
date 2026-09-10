import { useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Plus, Search, Archive, X } from "lucide-react";
import Card from "@/components/ui/Card";
import EmptyState from "@/components/ui/EmptyState";
import ConfirmButton from "@/components/ui/ConfirmButton";
import { useDecisionLog } from "@/hooks/useDecisionLog";
import { useMissionBoard } from "@/hooks/useMissionBoard";
import DecisionEditor from "@/components/decisions/DecisionEditor";
import DecisionRow from "@/components/decisions/DecisionRow";
import { VERDICT_META } from "@/components/decisions/decisionMeta";

/**
 * The Decision Log — a list of calls made, the reasoning at the time, and how
 * each one turned out.
 *
 * ## Register: reference, not game
 *
 * The calm end, with the Mission Board and the Knowledge Vault. Looking back at
 * a decision that backfired is not a moment for confetti.
 *
 * ## One page, two routes
 *
 * `/decisions` and `/decisions/:id` render this same component; the parameter
 * only decides what is open — same as the vault, and same reason (a mission
 * links straight at one).
 *
 * ## Master–detail
 *
 * On the desk, the list and the open record sit side by side. On a phone the
 * list collapses while a record is open — one layout behaving sensibly, not two.
 */
export default function DecisionLog() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const log = useDecisionLog();
  const { missions } = useMissionBoard();

  const [query, setQuery] = useState("");
  const [topic, setTopic] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);

  const hits = useMemo(() => {
    const found = log.search(query, { includeArchived: showArchived });
    return topic ? found.filter((d) => d.topics.includes(topic)) : found;
  }, [log, query, topic, showArchived]);

  const open = id ? log.byId(id) : null;

  const create = () => {
    const record = log.add({ title: "Untitled decision", topics: topic ? [topic] : [] });
    navigate(`/decisions/${record.id}`);
  };

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-2xl text-ink-100">Decision Log</h1>
          <p className="text-sm text-ink-500 mt-1 font-mono">
            {log.active.length} decision{log.active.length === 1 ? "" : "s"} ·{" "}
            {log.active.filter((d) => d.verdict === "pending").length} awaiting an outcome
          </p>
        </div>
        <button
          onClick={create}
          className="h-11 px-4 rounded-badge bg-xp text-base-950 text-sm font-medium flex items-center gap-2 hover:brightness-110 transition"
        >
          <Plus size={16} /> New decision
        </button>
      </header>

      <div className="relative">
        <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-700" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search decisions, reasoning and outcomes…"
          className="w-full h-12 pl-10 pr-3 rounded-badge bg-base-800 border border-base-600 text-base sm:text-sm text-ink-100 placeholder:text-ink-700 focus:outline-none focus:ring-2 focus:ring-xp/40"
        />
      </div>

      {log.topics.length > 0 && (
        // Scrolls rather than wraps — the design system's rule for a long row.
        <div className="flex gap-2 overflow-x-auto pb-1 -mx-1 px-1">
          {log.topics.map(({ topic: t, count }) => (
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
        {/* The list. Hidden on a phone while a record is open. */}
        <div className={`space-y-2 ${open ? "hidden lg:block" : ""}`}>
          {hits.length === 0 ? (
            <EmptyState
              message={
                query
                  ? "Nothing matches those words. Search matches text, not meaning — try the words you'd have written."
                  : "Calls you've made, why you made them, and how they turned out. Start with the last decision you're still second-guessing."
              }
            />
          ) : (
            hits.map((record) => (
              <DecisionRow
                key={record.id}
                record={record}
                selected={record.id === id}
                onOpen={() => navigate(`/decisions/${record.id}`)}
              />
            ))
          )}

          {log.records.some((d) => d.archived) && (
            <button
              onClick={() => setShowArchived(!showArchived)}
              className="w-full h-10 rounded-badge border border-base-600 text-xs text-ink-700 hover:text-ink-300 transition-colors"
            >
              {showArchived ? "Hide archived" : "Show archived"}
            </button>
          )}
        </div>

        {/* The open decision. */}
        <div className={open ? "" : "hidden lg:block"}>
          {open ? (
            <Card className="p-5 space-y-5">
              <div className="flex items-start justify-between gap-3">
                <span
                  className={`h-7 px-2.5 rounded-badge border text-[11px] font-mono inline-flex items-center ${VERDICT_META[open.verdict].className}`}
                  title={VERDICT_META[open.verdict].help}
                >
                  {VERDICT_META[open.verdict].label}
                </span>
                <button
                  onClick={() => navigate("/decisions")}
                  aria-label="Close this decision"
                  className="h-11 w-11 -mr-2 -mt-2 flex items-center justify-center text-ink-700 hover:text-ink-300 transition-colors"
                >
                  <X size={18} />
                </button>
              </div>

              <DecisionEditor
                record={open}
                missions={missions.filter((m) => !m.archived)}
                onChange={(patch) => log.update(open.id, patch)}
                onToggleMission={(missionId) => log.toggleMission(open.id, missionId)}
              />

              <div className="pt-4 border-t border-base-600 flex items-center justify-between gap-3">
                <p className="text-[11px] font-mono text-ink-700">
                  updated {new Date(open.updatedAt).toLocaleDateString()}
                </p>
                {/* Archive, not delete — OPS-020. A decision and its outcome is
                    a piece of history nothing else can recreate. */}
                <ConfirmButton
                  onConfirm={() => {
                    log.archive(open.id, !open.archived);
                    if (!open.archived) navigate("/decisions");
                  }}
                  label={open.archived ? "Restore" : "Archive"}
                  icon={<Archive size={14} />}
                />
              </div>
            </Card>
          ) : (
            <Card className="p-8">
              <EmptyState message="Pick a decision, or start one. The outcome field stays empty until you know — that's the point of it." />
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
