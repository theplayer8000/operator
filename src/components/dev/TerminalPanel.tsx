import { useCallback, useEffect, useRef, useState } from "react";
import { TerminalSquare, Play, Square, RotateCcw, ShieldAlert } from "lucide-react";

interface RunSummary {
  id: string;
  command: string;
  device: string;
  user: string | null;
  startedAt: string;
  endedAt: string | null;
  durationMs: number;
  exitCode: number | null;
  signal: string | null;
  running: boolean;
  truncated: boolean;
}

interface RunsBody {
  enabled: boolean;
  authorised?: boolean;
  reason?: string;
  allowed?: string[];
  authorisedDevices?: string[];
  runs: RunSummary[];
  you?: { device: string | null; method: string | null };
}

function short(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

/**
 * Run a command on the machine, from Operator.
 *
 * On the Dev page and in its register — mono, dots, exit codes, no celebration.
 * A command finishing is not an achievement.
 *
 * The point of this is the owner driving Claude Code from his phone while away
 * from the machine (`claude -p "..."`), so the constraints are mobile ones: the
 * output pane scrolls on its own rather than growing the page, the input stays
 * reachable, and re-opening a run replays its whole log from the server instead
 * of showing an empty box. There is no shell behind this — see
 * `server/terminal.mjs` — so pipes and `&&` are literal text, not operators.
 */
export default function TerminalPanel() {
  const [info, setInfo] = useState<RunsBody | null>(null);
  const [command, setCommand] = useState("");
  const [activeId, setActiveId] = useState<string | null>(null);
  const [output, setOutput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const outputRef = useRef<HTMLPreElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/terminal/runs", { headers: { accept: "application/json" } });
      if (res.status === 401) {
        setError("This device isn't authorised. Open Operator on the Tailscale address.");
        return;
      }
      setInfo((await res.json()) as RunsBody);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /**
   * Read a run's output. Uses `fetch` + a stream reader rather than
   * `EventSource` because EventSource cannot send an Authorization header, and
   * this has to keep working once Operator is behind a token on a real domain.
   * The server replays everything already produced before tailing, so this is
   * also how a finished run is re-read.
   */
  const attach = useCallback(
    async (id: string) => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      setActiveId(id);
      setOutput("");
      setStreaming(true);
      setError(null);

      try {
        const res = await fetch(`/api/terminal/stream?id=${encodeURIComponent(id)}`, {
          signal: controller.signal,
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => ({}))) as { reason?: string; error?: string };
          throw new Error(body.reason ?? body.error ?? `stream returned ${res.status}`);
        }
        const reader = res.body?.getReader();
        if (!reader) throw new Error("this browser can't stream the output");
        const decoder = new TextDecoder();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          setOutput((prev) => prev + decoder.decode(value, { stream: true }));
        }
      } catch (err) {
        if ((err as Error).name !== "AbortError") setError((err as Error).message);
      } finally {
        setStreaming(false);
        void refresh();
      }
    },
    [refresh]
  );

  // Follow the tail while output arrives, the way a console does.
  useEffect(() => {
    const el = outputRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [output]);

  useEffect(() => () => abortRef.current?.abort(), []);

  async function run() {
    const line = command.trim();
    if (!line) return;
    setError(null);
    try {
      const res = await fetch("/api/terminal/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ command: line }),
      });
      const body = (await res.json()) as { id?: string; error?: string; reason?: string };
      if (!res.ok || !body.id) {
        setError(body.reason ?? body.error ?? `server returned ${res.status}`);
        return;
      }
      void attach(body.id);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function stop() {
    if (!activeId) return;
    await fetch(`/api/terminal/stop?id=${encodeURIComponent(activeId)}`, { method: "POST" }).catch(
      () => {}
    );
  }

  const disabled = info !== null && !info.enabled;
  const unauthorised = info !== null && info.enabled && info.authorised === false;

  return (
    <section className="card-base p-4 sm:p-5 mb-5 animate-fade-up">
      <header className="flex items-center justify-between gap-3 mb-3">
        <div className="flex items-center gap-2 min-w-0">
          <TerminalSquare size={15} className="text-ink-500 shrink-0" />
          <div className="min-w-0">
            <h2 className="font-display text-sm font-medium text-ink-300">Terminal</h2>
            <p className="text-xs text-ink-700 truncate">
              {disabled
                ? "Disabled"
                : unauthorised
                  ? "This device can't run commands"
                  : info?.you?.device
                    ? `Running as ${info.you.device}`
                    : "No shell — arguments only"}
            </p>
          </div>
        </div>
        <button
          onClick={() => void refresh()}
          aria-label="Refresh terminal state"
          title="Refresh"
          className="w-11 h-11 shrink-0 rounded-badge border border-base-600 flex items-center justify-center text-ink-500 hover:text-ink-100 hover:border-base-500 transition-colors"
        >
          <RotateCcw size={14} />
        </button>
      </header>

      {disabled && (
        <p className="text-sm text-ink-700 leading-relaxed">
          {info?.reason ??
            "Start the server with OPERATOR_TERMINAL=1 to enable it."}{" "}
          It is off by default so an upgrade can never quietly expose a shell.
        </p>
      )}

      {unauthorised && (
        <div className="flex items-start gap-2 p-3 rounded-badge border border-xp/30 bg-xp/5">
          <ShieldAlert size={14} className="text-xp shrink-0 mt-0.5" />
          <p className="text-xs text-ink-300 leading-relaxed">
            {info?.reason}. Being a known device on the tailnet gets you the app, not a shell — add
            this device to <span className="font-mono text-ink-500">OPERATOR_TERMINAL_DEVICES</span>{" "}
            and restart the server.
          </p>
        </div>
      )}

      {info?.enabled && info.authorised && (
        <>
          <div className="flex items-center gap-2 mb-2">
            <input
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void run();
              }}
              placeholder='claude -p "what changed today?"'
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              aria-label="Command to run"
              className="flex-1 min-w-0 bg-base-700/40 border border-base-600 rounded-badge px-3 min-h-[44px] text-base sm:text-sm font-mono text-ink-100 placeholder:text-ink-700 outline-none focus:border-xp/50 transition-colors"
            />
            {streaming ? (
              <button
                onClick={() => void stop()}
                aria-label="Stop the running command"
                title="Stop"
                className="w-11 h-11 shrink-0 rounded-badge border border-vital-down/40 bg-vital-down/10 flex items-center justify-center text-vital-down hover:bg-vital-down/20 transition-colors"
              >
                <Square size={14} />
              </button>
            ) : (
              <button
                onClick={() => void run()}
                disabled={command.trim() === ""}
                aria-label="Run the command"
                title="Run"
                className="w-11 h-11 shrink-0 rounded-badge border border-xp/40 bg-xp/10 flex items-center justify-center text-xp hover:bg-xp/20 disabled:text-ink-700 disabled:border-base-600 disabled:bg-transparent transition-colors"
              >
                <Play size={14} />
              </button>
            )}
          </div>

          <p className="text-[11px] text-ink-700 mb-3 leading-relaxed">
            No shell: <span className="font-mono">&amp;&amp;</span>,{" "}
            <span className="font-mono">|</span> and <span className="font-mono">;</span> are passed
            through as plain arguments, not run. Allowed:{" "}
            <span className="font-mono text-ink-500">{(info.allowed ?? []).join(" ")}</span>
          </p>

          {error && (
            <p className="text-xs text-vital-down mb-3 leading-relaxed break-words">{error}</p>
          )}

          {(output !== "" || streaming) && (
            <pre
              ref={outputRef}
              className="text-[11px] font-mono text-ink-300 whitespace-pre-wrap break-words bg-base-950/60 border border-base-600 rounded-badge p-3 max-h-72 overflow-auto mb-3"
            >
              {output}
              {streaming && <span className="text-xp">▍</span>}
            </pre>
          )}

          {(info.runs ?? []).length > 0 && (
            <ul className="space-y-1 pt-3 border-t border-base-600">
              {info.runs.slice(0, 8).map((r) => (
                <li key={r.id}>
                  <button
                    onClick={() => void attach(r.id)}
                    className={`w-full flex items-center gap-2 px-2 min-h-[44px] rounded-badge text-left transition-colors ${
                      activeId === r.id ? "bg-base-700/50" : "hover:bg-base-700/30"
                    }`}
                  >
                    <span
                      className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                        r.running
                          ? "bg-xp animate-pulse"
                          : r.exitCode === 0
                            ? "bg-vital-up"
                            : "bg-vital-down"
                      }`}
                      aria-hidden
                    />
                    <span className="flex-1 min-w-0 text-xs font-mono text-ink-300 truncate">
                      {r.command}
                    </span>
                    <span className="shrink-0 text-[11px] font-mono text-ink-700">
                      {r.running ? "running" : `exit ${r.exitCode ?? "?"} · ${short(r.durationMs)}`}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}

          <p className="text-[11px] text-ink-700 pt-3 mt-3 border-t border-base-600 leading-relaxed">
            Runs on the machine hosting Operator, in the repo root. Every run is logged with the
            device that started it. History is in memory and clears when the server restarts.
          </p>
        </>
      )}
    </section>
  );
}
