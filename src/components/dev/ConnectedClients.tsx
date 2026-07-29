import { useCallback, useEffect, useState } from "react";
import { Radio, RefreshCw } from "lucide-react";

interface ClientRow {
  ip: string;
  label: string;
  userAgent: string;
  requests: number;
  lastPath: string;
  firstSeen: string;
  lastSeen: string;
  secondsAgo: number;
  active: boolean;
}

function ago(seconds: number): string {
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const mins = Math.round(seconds / 60);
  if (mins < 60) return `${mins}m ago`;
  return `${Math.round(mins / 60)}h ago`;
}

/**
 * Which devices are actually talking to the server.
 *
 * Exists because "the page won't load on my phone" was previously
 * unanswerable from this side — there was no way to tell a network problem
 * from an app problem, or to know whether a request had arrived at all. Now
 * the phone shows up here the moment it connects.
 *
 * Polls rather than streams: this is a diagnostic that gets opened
 * occasionally, and a websocket for it would be more moving parts than the
 * question deserves.
 */
export default function ConnectedClients() {
  const [rows, setRows] = useState<ClientRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/clients", { headers: { accept: "application/json" } });
      if (!res.ok) throw new Error(`server returned ${res.status}`);
      const body = (await res.json()) as { clients: ClientRow[] };
      setRows(body.clients);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 10_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const active = rows.filter((r) => r.active);

  return (
    <section className="card-base p-4 sm:p-5 mb-5 animate-fade-up">
      <header className="flex items-center justify-between gap-3 mb-3">
        <div className="flex items-center gap-2 min-w-0">
          <Radio size={15} className="text-ink-500 shrink-0" />
          <div className="min-w-0">
            <h2 className="font-display text-sm font-medium text-ink-300">Connected clients</h2>
            <p className="text-xs text-ink-700">
              {active.length} active · {rows.length} seen this session
            </p>
          </div>
        </div>
        <button
          onClick={() => void refresh()}
          aria-label="Refresh clients"
          title="Refresh"
          className="w-11 h-11 shrink-0 rounded-badge border border-base-600 flex items-center justify-center text-ink-500 hover:text-ink-100 hover:border-base-500 transition-colors"
        >
          <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
        </button>
      </header>

      {error ? (
        <p className="text-sm text-vital-down">Couldn't read clients: {error}</p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-ink-700">
          Nothing has connected yet. The server only remembers requests since it last started.
        </p>
      ) : (
        <ul className="space-y-2">
          {rows.map((row) => (
            <li
              key={`${row.ip}|${row.userAgent}`}
              className={`p-3 rounded-badge border ${
                row.active ? "border-vital-up/30 bg-vital-up/5" : "border-base-600 bg-base-700/30"
              }`}
            >
              <div className="flex items-center gap-2 mb-1">
                <span
                  className={`w-2 h-2 rounded-full shrink-0 ${
                    row.active ? "bg-vital-up ring-2 ring-vital-up/20" : "bg-ink-700"
                  }`}
                  aria-hidden
                />
                <span className="text-sm text-ink-100 truncate">{row.label}</span>
                <span className="font-mono text-[11px] text-ink-500 ml-auto shrink-0">
                  {ago(row.secondsAgo)}
                </span>
              </div>
              <p className="font-mono text-[11px] text-ink-500 break-all">
                {row.ip} · {row.requests} {row.requests === 1 ? "request" : "requests"}
              </p>
              {row.lastPath && (
                <p className="font-mono text-[11px] text-ink-700 truncate">last: {row.lastPath}</p>
              )}
            </li>
          ))}
        </ul>
      )}

      <p className="text-[11px] text-ink-700 mt-3 pt-3 border-t border-base-600 leading-relaxed">
        Held in memory only and cleared when the server restarts — it's a live diagnostic, not
        history. Nothing about your devices is written to the store.
      </p>
    </section>
  );
}
