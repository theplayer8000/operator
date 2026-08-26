import { useCallback, useEffect, useState } from "react";
import { Radio, RefreshCw } from "lucide-react";

interface ClientRow {
  ip: string;
  label: string;
  /** What the tailnet calls it. Null until something under /api/ authenticates. */
  device: string | null;
  /** "tailscale" | "local" | "token" | null */
  method: string | null;
  user: string | null;
  refusals: number;
  userAgent: string;
  requests: number;
  lastPath: string;
  firstSeen: string;
  lastSeen: string;
  secondsAgo: number;
  active: boolean;
}

/**
 * How it got in, not what it is.
 *
 * `token` is the one worth catching the eye: a bearer token is not a device,
 * carries no name, and works from anywhere. The other two are a machine the
 * tailnet vouched for, or something already on this box.
 */
function methodChip(method: string | null): { text: string; className: string } | null {
  if (!method) return null;
  if (method === "token") {
    return { text: "token", className: "text-xp border-xp/40 bg-xp/10" };
  }
  return { text: method, className: "text-ink-500 border-base-600 bg-base-700/40" };
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
      if (res.status === 401)
        throw new Error(
          "this device isn't authorised — open Operator on the Tailscale address, not a LAN one"
        );
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
                {/* The name the tailnet knows it by, when there is one — that is
                    the thing you scan this list for. Falls back to what the
                    user-agent says, which is all a static-asset-only client
                    ever offers. */}
                <span className="text-sm text-ink-100 truncate">{row.device ?? row.label}</span>
                <span className="font-mono text-[11px] text-ink-500 ml-auto shrink-0">
                  {ago(row.secondsAgo)}
                </span>
              </div>
              {/* Only worth a second line when it says something the title did
                  not. With no device name the title already IS the label, and
                  repeating it just prints every row twice. */}
              {(() => {
                const chip = methodChip(row.method);
                const showLabel = Boolean(row.device) && row.device !== row.label;
                if (!showLabel && !chip && row.refusals === 0) return null;
                return (
                  <div className="flex items-center gap-2 flex-wrap mb-0.5">
                    {showLabel && (
                      <span className="text-[11px] text-ink-500 truncate">{row.label}</span>
                    )}
                    {chip && (
                      <span
                        className={`font-mono text-[10px] px-1.5 py-0.5 rounded-badge border shrink-0 ${chip.className}`}
                      >
                        {chip.text}
                      </span>
                    )}
                    {row.refusals > 0 && (
                      <span className="font-mono text-[10px] px-1.5 py-0.5 rounded-badge border border-vital-down/40 bg-vital-down/10 text-vital-down shrink-0">
                        {row.refusals} refused
                      </span>
                    )}
                  </div>
                );
              })()}
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
      {/* Said plainly because this card looks like an intrusion detector and is
          not one. A device on the tailnet that never opens Operator makes no
          request, so it leaves no row — and reading an empty list as "nobody is
          there" is the one wrong conclusion available here. */}
      <p className="text-[11px] text-ink-700 mt-2 leading-relaxed">
        It shows what <span className="text-ink-500">reached the API</span>, not who is on the
        tailnet — a device that never opens Operator never appears. For that, check Tailscale
        itself. <span className="text-ink-500">token</span> means a bearer token rather than a
        named device, which works from anywhere.
      </p>
    </section>
  );
}
