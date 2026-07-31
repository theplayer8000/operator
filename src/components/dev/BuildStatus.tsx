import { useCallback, useEffect, useState } from "react";
import { Layers, RefreshCw } from "lucide-react";

interface Body {
  checkedAt: string;
  live: { builtAt: string | null; sourceChangedAt: string | null; stale: boolean; missing: boolean };
  server: { startedAt: string; codeChangedAt: string | null; stale: boolean; supervised: boolean };
  dev: { port: number; running: boolean };
}

function ago(iso: string | null): string {
  if (!iso) return "never";
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return `${Math.max(0, Math.round(ms / 1000))}s ago`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h ago`;
  return `${Math.round(ms / 86_400_000)}d ago`;
}

function Dot({ tone }: { tone: "ok" | "warn" | "off" }) {
  const colour =
    tone === "ok" ? "bg-vital-up" : tone === "warn" ? "bg-xp" : "bg-ink-700";
  return <span className={`w-2 h-2 rounded-full shrink-0 ${colour}`} />;
}

/**
 * Which code is actually running.
 *
 * Operator is edited while it runs, so at any moment there are up to three
 * different versions of it in play: the source, the built snapshot this server
 * is handing out, and the server process itself. They drift, and nothing said
 * so — which makes for a genuinely confusing failure, because the change is
 * *there*, on the dev URL, and simply isn't on the real one.
 *
 * Infra register, same as Homelab: a dot and a fact. Being up to date is not an
 * achievement, so there is nothing congratulatory here — the only thing worth
 * drawing the eye is the case where a command still needs running.
 */
export default function BuildStatus() {
  const [body, setBody] = useState<Body | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/build", { headers: { accept: "application/json" } });
      if (!res.ok) throw new Error(`server returned ${res.status}`);
      setBody((await res.json()) as Body);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <section className="card-base p-4 sm:p-5 mb-5 animate-fade-up">
      <header className="flex items-center justify-between gap-3 mb-3">
        <div className="flex items-center gap-2 min-w-0">
          <Layers size={16} className="text-ink-500 shrink-0" />
          <div className="min-w-0">
            <h2 className="font-display text-sm font-medium text-ink-300">Builds</h2>
            <p className="text-xs text-ink-700 truncate">What each URL is actually serving</p>
          </div>
        </div>
        <button
          onClick={() => void refresh()}
          aria-label="Refresh build status"
          title="Refresh"
          className="w-11 h-11 shrink-0 rounded-badge border border-base-600 flex items-center justify-center text-ink-500 hover:text-ink-100 hover:border-base-500 transition-colors"
        >
          <RefreshCw size={14} />
        </button>
      </header>

      {error && <p className="text-sm text-vital-down">Couldn't read build status: {error}</p>}

      {body && (
        <ul className="space-y-2.5">
          <li className="flex items-start gap-2.5">
            <span className="mt-1.5">
              <Dot tone={body.live.missing ? "off" : body.live.stale ? "warn" : "ok"} />
            </span>
            <div className="min-w-0">
              <p className="text-sm text-ink-100">
                Live app{" "}
                <span className="font-mono text-xs text-ink-700">
                  built {ago(body.live.builtAt)}
                </span>
              </p>
              <p className="text-xs text-ink-700">
                {body.live.missing
                  ? "No dist/ — run npm run build."
                  : body.live.stale
                    ? `src/ changed ${ago(body.live.sourceChangedAt)}. Run npm run build to promote it.`
                    : "Matches the source."}
              </p>
            </div>
          </li>

          <li className="flex items-start gap-2.5">
            <span className="mt-1.5">
              <Dot tone={body.server.stale ? "warn" : "ok"} />
            </span>
            <div className="min-w-0">
              <p className="text-sm text-ink-100">
                API server{" "}
                <span className="font-mono text-xs text-ink-700">
                  started {ago(body.server.startedAt)}
                </span>
              </p>
              <p className="text-xs text-ink-700">
                {body.server.stale
                  ? "server/ changed since it started — Restart to load it."
                  : "Running the current server code."}
                {!body.server.supervised && " Not supervised, so Restart will stop it."}
              </p>
            </div>
          </li>

          <li className="flex items-start gap-2.5">
            <span className="mt-1.5">
              <Dot tone={body.dev.running ? "ok" : "off"} />
            </span>
            <div className="min-w-0">
              <p className="text-sm text-ink-100">
                Dev server{" "}
                <span className="font-mono text-xs text-ink-700">:{body.dev.port}</span>
              </p>
              <p className="text-xs text-ink-700">
                {body.dev.running
                  ? "Up — serving src/ directly, no build needed."
                  : "Not running. Start it with npm run dev:web."}
              </p>
            </div>
          </li>
        </ul>
      )}
    </section>
  );
}
