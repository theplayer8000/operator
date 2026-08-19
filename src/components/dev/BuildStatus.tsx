import { useCallback, useEffect, useState } from "react";
import { Layers, RefreshCw, Globe, Server, Code2, ExternalLink, GitBranch } from "lucide-react";

interface Body {
  checkedAt: string;
  live: { builtAt: string | null; sourceChangedAt: string | null; stale: boolean; missing: boolean };
  server: { startedAt: string; codeChangedAt: string | null; stale: boolean; supervised: boolean };
  dev: { port: number; running: boolean };
  agent?: { port: number; running: boolean; cwd: string | null; separate: boolean };
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

type Build = "live" | "dev" | "agent";

/**
 * Every build's URL, derived from wherever this page is being served.
 *
 * Two ways in, and which one decides every port: **direct** on the machine
 * (5173/5174/5175) or **through Tailscale** (443/8443/9443). Mixing them is
 * what breaks — a tailnet page linking to `:5175` names a port the proxy isn't
 * listening on. So the entry route is worked out once, and all three URLs come
 * from it.
 *
 * Returns null from anywhere it can't be worked out, rather than guessing a
 * host that won't resolve.
 */
function buildUrls(): Record<Build, string> | null {
  if (typeof window === "undefined") return null;
  const { protocol, hostname, port } = window.location;
  const direct = port === "5173" || port === "5174" || port === "5175";
  const proxied = port === "" || port === "8443" || port === "9443";
  if (!direct && !proxied) return null;
  return {
    live: `${protocol}//${hostname}${direct ? ":5174" : ""}`,
    dev: `${protocol}//${hostname}:${direct ? "5173" : "8443"}`,
    agent: `${protocol}//${hostname}:${direct ? "5175" : "9443"}`,
  };
}

/**
 * Which build you are reading this on.
 *
 * Port first, because the agent build and the dev build are both Vite and
 * `import.meta.env.DEV` cannot tell them apart. Everything else falls back to
 * the build-time flag, which is exact for dev-vs-live.
 */
function currentBuild(): Build {
  const port = typeof window === "undefined" ? "" : window.location.port;
  if (port === "5175" || port === "9443") return "agent";
  return ON_DEV ? "dev" : "live";
}

function Dot({ tone }: { tone: "ok" | "warn" | "off" }) {
  const colour =
    tone === "ok" ? "bg-vital-up" : tone === "warn" ? "bg-xp" : "bg-ink-700";
  return <span className={`w-2 h-2 rounded-full shrink-0 ${colour}`} />;
}

/**
 * The way to a build sits on the build's own row.
 *
 * It used to be one button under the whole list, offering "the other one",
 * which worked while there were two and stopped working at three — the agent
 * build had to grow its own inline link, and the card ended up saying the same
 * thing two different ways. A row is a build; its link belongs to it.
 *
 * 44px, because this is opened from a phone.
 */
function OpenBuild({ href, label }: { href: string; label: string }) {
  return (
    <a
      href={href}
      aria-label={`Open the ${label}`}
      title={href}
      className="w-11 h-11 shrink-0 -mt-1 rounded-badge border border-base-600 flex items-center justify-center text-ink-500 hover:text-xp hover:border-xp/40 transition-colors"
    >
      <ExternalLink size={14} />
    </a>
  );
}

/** The row you are reading this on — a link to itself would be a dead tap. */
function YouAreHere({ hint }: { hint: string }) {
  return (
    <span
      title={hint}
      className="shrink-0 px-2 py-0.5 rounded-badge border border-rank/40 bg-rank/10 text-rank font-mono text-[10px]"
    >
      you
    </span>
  );
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

  const urls = buildUrls();
  const on = currentBuild();

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
            <span className="mt-1 flex items-center gap-2 shrink-0">
              <Dot tone={body.live.missing ? "off" : body.live.stale ? "warn" : "ok"} />
              <Globe size={14} className="text-ink-700" />
            </span>
            <div className="min-w-0 flex-1">
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
            {on === "live" ? (
              <YouAreHere hint="This page is the built snapshot. It changes when you run npm run build." />
            ) : (
              urls && !body.live.missing && <OpenBuild href={urls.live} label="live app" />
            )}
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
            <div className="min-w-0 flex-1">
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
            {on === "dev" ? (
              <YouAreHere hint="This page is Vite, compiling src/ per request — changes show immediately." />
            ) : (
              urls && body.dev.running && <OpenBuild href={urls.dev} label="dev build" />
            )}
          </li>
          {body.agent && (
            <li className="flex items-start gap-2.5">
              <span className="mt-1 flex items-center gap-2 shrink-0">
                <Dot tone={body.agent.running ? "ok" : "off"} />
                <GitBranch size={14} className="text-ink-700" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-sm text-ink-100">
                  Agent build{" "}
                  <span className="font-mono text-xs text-ink-700">:{body.agent.port}</span>
                </p>
                <p className="text-xs text-ink-700">
                  {!body.agent.separate
                    ? "Claude is editing THIS checkout — set OPERATOR_JOB_CWD to a worktree."
                    : body.agent.running
                      ? "What Claude is writing, on its own branch. Nothing here is live until it's merged."
                      : "Its checkout exists, but nothing is serving it — npx vite --port 5175 --host in the worktree."}
                </p>
              </div>
              {on === "agent" ? (
                <YouAreHere hint="This page is the agent's checkout, on branch `agent`. Nothing here is live until it's merged." />
              ) : (
                urls &&
                body.agent.separate &&
                body.agent.running && <OpenBuild href={urls.agent} label="agent build" />
              )}
            </li>
          )}
        </ul>
      )}

    </section>
  );
}
