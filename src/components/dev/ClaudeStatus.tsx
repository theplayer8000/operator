import { useCallback, useEffect, useState } from "react";
import { Activity, ExternalLink, RefreshCw } from "lucide-react";

interface ComponentRow {
  name: string;
  status: string;
}

interface IncidentRow {
  name: string;
  status: string;
  impact: string;
  shortlink: string;
  updatedAt: string | null;
}

interface StatusBody {
  ok?: boolean;
  indicator?: string;
  description?: string;
  components?: ComponentRow[];
  incidents?: IncidentRow[];
  pageUrl?: string;
  fetchedAt?: string;
  cached?: boolean;
  stale?: boolean;
  error?: string;
}

/**
 * Statuspage's own vocabulary, mapped onto Operator's tokens. `vital-up` and
 * `vital-down` are reserved for genuinely binary good/bad, which this is —
 * everything between gets the amber accent rather than a third colour.
 */
const INDICATOR: Record<string, { dot: string; text: string }> = {
  none: { dot: "bg-vital-up ring-2 ring-vital-up/20", text: "text-vital-up" },
  minor: { dot: "bg-xp ring-2 ring-xp/20", text: "text-xp" },
  major: { dot: "bg-xp ring-2 ring-xp/20", text: "text-xp" },
  critical: { dot: "bg-vital-down ring-2 ring-vital-down/20", text: "text-vital-down" },
  maintenance: { dot: "bg-rank ring-2 ring-rank/20", text: "text-rank" },
};

const COMPONENT_DOT: Record<string, string> = {
  operational: "bg-vital-up",
  degraded_performance: "bg-xp",
  partial_outage: "bg-xp",
  major_outage: "bg-vital-down",
  under_maintenance: "bg-rank",
};

/** "degraded_performance" → "Degraded performance". */
function humanise(status: string): string {
  const words = status.replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * Whether Anthropic's own services are up.
 *
 * Sits on the Dev page rather than Homelab because Homelab is for boxes the
 * owner runs — a tile there implies something he can restart. This is the
 * opposite: when a Claude Code session starts failing mid-task, the question is
 * "is it me or is it them", and until now that was unanswerable from inside
 * Operator.
 *
 * The fetch goes to Operator's own server, which does the outbound call —
 * see server/status.mjs. Approved external dependency, per CLAUDE.md.
 */
export default function ClaudeStatus() {
  const [body, setBody] = useState<StatusBody | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/claude-status", { headers: { accept: "application/json" } });
      if (!res.ok) throw new Error(`server returned ${res.status}`);
      setBody((await res.json()) as StatusBody);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  // No polling. The server caches for a minute anyway, and a status page that
  // refreshes itself every ten seconds is a page that pulls attention it hasn't
  // earned — this is checked when something has already gone wrong.
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const reachable = body?.ok !== false && !error;
  const indicator = INDICATOR[body?.indicator ?? ""] ?? {
    dot: "bg-ink-700",
    text: "text-ink-500",
  };
  const degraded = (body?.components ?? []).filter((c) => c.status !== "operational");

  return (
    <section className="card-base p-4 sm:p-5 mb-5 animate-fade-up">
      <header className="flex items-center justify-between gap-3 mb-3">
        <div className="flex items-center gap-2 min-w-0">
          <Activity size={15} className="text-ink-500 shrink-0" />
          <div className="min-w-0">
            <h2 className="font-display text-sm font-medium text-ink-300">Claude status</h2>
            <p className="text-xs text-ink-700 truncate">
              {reachable ? "status.claude.com" : "Couldn't reach status.claude.com"}
            </p>
          </div>
        </div>
        <button
          onClick={() => void refresh()}
          aria-label="Refresh Claude status"
          title="Refresh"
          className="w-11 h-11 shrink-0 rounded-badge border border-base-600 flex items-center justify-center text-ink-500 hover:text-ink-100 hover:border-base-500 transition-colors"
        >
          <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
        </button>
      </header>

      {!reachable ? (
        <p className="text-sm text-ink-700 leading-relaxed">
          {error ?? body?.error}
          {" — "}
          which usually means this box has no route out, not that Claude is down.
        </p>
      ) : !body ? (
        <p className="text-sm text-ink-700">Checking…</p>
      ) : (
        <>
          <div className="flex items-center gap-2.5 mb-3">
            <span className={`w-2.5 h-2.5 rounded-full shrink-0 ${indicator.dot}`} aria-hidden />
            <span className={`text-sm ${indicator.text}`}>{body.description}</span>
          </div>

          {/* Only the components that aren't fine. A list of fourteen green
              rows is noise — "All Systems Operational" above already said it. */}
          {degraded.length > 0 && (
            <ul className="space-y-1.5 mb-3">
              {degraded.map((c) => (
                <li key={c.name} className="flex items-center gap-2">
                  <span
                    className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                      COMPONENT_DOT[c.status] ?? "bg-ink-700"
                    }`}
                    aria-hidden
                  />
                  <span className="text-xs text-ink-300 truncate">{c.name}</span>
                  <span className="text-[11px] font-mono text-ink-700 ml-auto shrink-0">
                    {humanise(c.status)}
                  </span>
                </li>
              ))}
            </ul>
          )}

          {(body.incidents ?? []).length > 0 && (
            <ul className="space-y-2 mb-3">
              {body.incidents!.map((incident) => (
                <li
                  key={incident.shortlink + incident.name}
                  className="p-3 rounded-badge border border-base-600 bg-base-700/30"
                >
                  <a
                    href={incident.shortlink}
                    target="_blank"
                    rel="noreferrer"
                    className="flex items-start gap-2 group"
                  >
                    <span className="flex-1 min-w-0">
                      <span className="block text-sm text-ink-300 group-hover:text-ink-100 transition-colors">
                        {incident.name}
                      </span>
                      <span className="block text-[11px] font-mono text-ink-700 mt-0.5">
                        {humanise(incident.status)} · {incident.impact} impact
                        {incident.updatedAt &&
                          ` · ${new Date(incident.updatedAt).toLocaleString("en-GB", {
                            day: "numeric",
                            month: "short",
                            hour: "2-digit",
                            minute: "2-digit",
                          })}`}
                      </span>
                    </span>
                    <ExternalLink size={12} className="text-ink-700 shrink-0 mt-1" />
                  </a>
                </li>
              ))}
            </ul>
          )}

          <p className="text-[11px] text-ink-700 pt-3 border-t border-base-600 leading-relaxed">
            {body.stale ? "Last good check" : "Checked"}{" "}
            {body.fetchedAt
              ? new Date(body.fetchedAt).toLocaleTimeString("en-GB", {
                  hour: "2-digit",
                  minute: "2-digit",
                })
              : "—"}
            {body.cached && " · cached"} · fetched by this server, not your browser.{" "}
            <a
              href={body.pageUrl}
              target="_blank"
              rel="noreferrer"
              className="text-ink-500 hover:text-ink-300 transition-colors"
            >
              Full page
            </a>
          </p>
        </>
      )}
    </section>
  );
}
