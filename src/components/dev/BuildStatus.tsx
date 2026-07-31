import { useCallback, useEffect, useState } from "react";
import { Layers, RefreshCw, Globe, Server, Code2, ExternalLink } from "lucide-react";

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

/**
 * Which build is this page? `import.meta.env.DEV` is set by Vite at build time
 * — true in the dev server's bundle, false in the one `npm run build` writes.
 * That is exact, unlike guessing from the port, which breaks the moment
 * anything is proxied. And it is proxied: `tailscale serve` puts 8443 and 443
 * in front of both.
 */
const ON_DEV = import.meta.env.DEV;

/**
 * The other build's URL, derived from wherever this page is being served.
 *
 * Four ways in, because of the proxy: 5173/5174 direct on the machine, and
 * 8443/443 through Tailscale. Each maps to its opposite number.
 */
function otherUrl(): string | null {
  if (typeof window === "undefined") return null;
  const { protocol, hostname, port } = window.location;
  const swap: Record<string, string> = {
    "5173": "5174",
    "5174": "5173",
    "8443": "", // dev over Tailscale → live is the bare name on 443
    "": "8443", // live over Tailscale → dev is 8443
  };
  const next = swap[port];
  if (next === undefined) return null;
  return `${protocol}//${hostname}${next ? `:${next}` : ""}`;
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
          <span
            title={
              ON_DEV
                ? "This page is Vite, compiling src/ per request — changes show immediately."
                : "This page is the built snapshot. It changes when you run npm run build."
            }
            className={`shrink-0 px-2 py-0.5 rounded-badge border font-mono text-[10px] ${
              ON_DEV
                ? "border-rank/40 bg-rank/10 text-rank"
                : "border-xp/40 bg-xp/10 text-xp"
            }`}
          >
            {ON_DEV ? "you: dev" : "you: live"}
          </span>
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
            <span className="mt-1 flex items-center gap-2 shrink-0">
              <Dot tone={body.live.missing ? "off" : body.live.stale ? "warn" : "ok"} />
              <Globe size={14} className="text-ink-700" />
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
            <span className="mt-1 flex items-center gap-2 shrink-0">
              <Dot tone={body.server.stale ? "warn" : "ok"} />
              <Server size={14} className="text-ink-700" />
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
            <span className="mt-1 flex items-center gap-2 shrink-0">
              <Dot tone={body.dev.running ? "ok" : "off"} />
              <Code2 size={14} className="text-ink-700" />
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

      {/*
        One link, to the build you are not on. Two links would mean reading the
        labels to work out which one you already have open — the only move worth
        offering here is the other one.
      */}
      {otherUrl() && (
        <a
          href={otherUrl() as string}
          className="mt-3 flex items-center justify-center gap-2 min-h-[44px] rounded-badge border border-base-600 text-sm text-ink-500 hover:text-ink-100 hover:border-base-500 transition-colors"
        >
          <ExternalLink size={14} />
          Open the {ON_DEV ? "live" : "dev"} build
          <span className="font-mono text-xs text-ink-700 truncate">{otherUrl()}</span>
        </a>
      )}
    </section>
  );
}
