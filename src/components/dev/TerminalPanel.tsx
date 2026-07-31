import { useCallback, useEffect, useRef, useState } from "react";
import { TerminalSquare, Play, Square, RotateCcw, RotateCw, ShieldAlert, Power } from "lucide-react";
import ConfirmButton from "@/components/ui/ConfirmButton";

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
  canManage?: boolean;
  reason?: string;
  allowed?: string[];
  authorisedDevices?: string[];
  runs: RunSummary[];
  cwd?: string;
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
  const [restarting, setRestarting] = useState(false);

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
   * Read a run's output by polling, not streaming.
   *
   * The first version used `fetch` + `response.body.getReader()`. It worked on
   * the desktop and failed on the owner's iPhone: `git status --short` ran and
   * exited 0, but no text ever arrived. A terminal whose output silently never
   * appears is worse than no terminal, and the phone is the primary client — so
   * this polls `/api/terminal/output?from=` and appends what is new.
   *
   * Polling is also what makes re-opening an old run work, and what survives the
   * phone locking mid-run: the server holds the whole buffer, so the next poll
   * catches up rather than losing the gap.
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

      let offset = 0;
      try {
        for (;;) {
          if (controller.signal.aborted) return;
          const res = await fetch(
            `/api/terminal/output?id=${encodeURIComponent(id)}&from=${offset}`,
            { signal: controller.signal, headers: { accept: "application/json" } }
          );
          if (!res.ok) {
            const body = (await res.json().catch(() => ({}))) as {
              reason?: string;
              error?: string;
            };
            throw new Error(body.reason ?? body.error ?? `server returned ${res.status}`);
          }
          const body = (await res.json()) as {
            output: string;
            offset: number;
            running: boolean;
          };
          if (body.output) setOutput((prev) => prev + body.output);
          offset = body.offset;
          if (!body.running) break;
          await new Promise((r) => setTimeout(r, 600));
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

    // `disarm` is handled here rather than being sent anywhere. Locking up
    // should be the fastest thing on the page — one word into the box you are
    // already typing in, rather than scrolling back to find a button. There is
    // deliberately no `arm` counterpart: arming is the direction that grants
    // execution, and it should stay a deliberate press rather than something
    // you can fire from muscle memory or a pasted line.
    if (/^(disarm|lock)$/i.test(line)) {
      setCommand("");
      await setArmed(false);
      return;
    }

    // `clear` is a real program, and running it does exactly what it is meant
    // to: emit the escape codes that tell a terminal to wipe itself. This pane
    // is a <pre>, so it printed them instead. Handled here because what the
    // command means — empty the output — is something only the client can do.
    if (/^(clear|cls)$/i.test(line)) {
      setCommand("");
      abortRef.current?.abort();
      setActiveId(null);
      setOutput("");
      return;
    }
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

  /**
   * Arm or disarm from the app.
   *
   * This exists because requiring an environment variable set *at the machine*
   * to enable the feature built for being *away* from it was self-defeating. The
   * device list still comes from the environment, so this switches on a
   * capability the device already has — it cannot grant itself one.
   */
  async function setArmed(next: boolean) {
    setError(null);
    try {
      const res = await fetch("/api/terminal/enable", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: next }),
      });
      const body = (await res.json()) as { enabled?: boolean; error?: string; reason?: string };
      if (!res.ok) {
        setError(body.reason ?? body.error ?? `server returned ${res.status}`);
        return;
      }
      if (!next) {
        abortRef.current?.abort();
        setActiveId(null);
        setOutput("");
      }
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  /**
   * Restart the storage server, so it picks up changes to its own code.
   *
   * The one thing the agent could never do for itself: it is spawned by this
   * server, so editing `server/*.mjs` left the change on disk and the old code
   * running. Frontend edits never had the problem — `dist/` is read from disk,
   * so a rebuild is enough.
   *
   * Deliberately optimistic about the failure: the connection dying *is* the
   * expected outcome, so a fetch error here means it worked. What matters is
   * telling the two apart afterwards, which the poll below does by waiting for
   * the server to answer again rather than assuming it will.
   */
  async function restartServer() {
    setError(null);
    setRestarting(true);
    try {
      await fetch("/api/restart", { method: "POST" }).catch(() => {});
      // Give it a moment to actually go away before asking whether it's back,
      // or the first poll answers from the process that's on its way out.
      await new Promise((r) => setTimeout(r, 700));
      for (let attempt = 0; attempt < 20; attempt++) {
        try {
          const res = await fetch("/api/health", { cache: "no-store" });
          if (res.ok) {
            setRestarting(false);
            await refresh();
            return;
          }
        } catch {
          /* still down — expected */
        }
        await new Promise((r) => setTimeout(r, 500));
      }
      setRestarting(false);
      setError("Restarted, but it hasn't come back. It may not be supervised — check the machine.");
    } catch (err) {
      setRestarting(false);
      setError((err as Error).message);
    }
  }

  async function stop() {
    if (!activeId) return;
    await fetch(`/api/terminal/stop?id=${encodeURIComponent(activeId)}`, { method: "POST" }).catch(
      () => {}
    );
  }

  const canManage = info?.canManage === true;
  const armed = info?.enabled === true;
  // Listed but not armed is the normal resting state, not an error.
  const notListed = info !== null && !canManage;

  return (
    <section className="card-base p-4 sm:p-5 mb-5 animate-fade-up">
      <header className="flex items-center justify-between gap-3 mb-3">
        <div className="flex items-center gap-2 min-w-0">
          <TerminalSquare size={15} className="text-ink-500 shrink-0" />
          <div className="min-w-0">
            <h2 className="font-display text-sm font-medium text-ink-300">Terminal</h2>
            <p className="text-xs text-ink-700 truncate">
              {notListed
                ? "This device can't run commands"
                : restarting
                  ? "Restarting the server…"
                  : armed
                    ? `Armed${info?.you?.device ? ` · ${info.you.device}` : ""} — no shell`
                    : "Disarmed"}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {canManage && (
            <ConfirmButton
              onConfirm={() => void restartServer()}
              label="Restart the server"
              icon={<RotateCw size={14} />}
              compact
            />
          )}
          {canManage && (
            <button
              onClick={() => void setArmed(!armed)}
              aria-pressed={armed}
              aria-label={armed ? "Disarm the terminal" : "Arm the terminal"}
              title={
                armed
                  ? "Disarm — no commands can be run until it's switched back on"
                  : "Arm the terminal for this session. A server restart disarms it again."
              }
              className={`flex items-center gap-2 px-3 min-h-[44px] rounded-badge border text-xs transition-colors ${
                armed
                  ? "border-xp/40 bg-xp/10 text-xp hover:bg-xp/20"
                  : "border-base-600 text-ink-500 hover:text-ink-100 hover:border-base-500"
              }`}
            >
              <Power size={14} />
              <span className="hidden sm:inline">{armed ? "Armed" : "Arm"}</span>
            </button>
          )}
          <button
            onClick={() => void refresh()}
            aria-label="Refresh terminal state"
            title="Refresh"
            className="w-11 h-11 shrink-0 rounded-badge border border-base-600 flex items-center justify-center text-ink-500 hover:text-ink-100 hover:border-base-500 transition-colors"
          >
            <RotateCcw size={14} />
          </button>
        </div>
      </header>

      {notListed && (
        <div className="flex items-start gap-2 p-3 rounded-badge border border-xp/30 bg-xp/5">
          <ShieldAlert size={14} className="text-xp shrink-0 mt-0.5" />
          <p className="text-xs text-ink-300 leading-relaxed">
            {info?.reason}. Being a known device on the tailnet gets you the app, not a shell — add
            this device to <span className="font-mono text-ink-500">OPERATOR_TERMINAL_DEVICES</span>{" "}
            and restart the server. That list is deliberately not editable from here, so a device
            can never grant itself execution.
          </p>
        </div>
      )}

      {canManage && !armed && (
        <p className="text-sm text-ink-700 leading-relaxed">
          Disarmed. Press <span className="text-ink-500">Arm</span> to enable it for this session —
          a server restart disarms it again, so it is never left on by accident.
        </p>
      )}


      {canManage && armed && (
        <>
          <div className="flex items-center gap-2 mb-2">
            <input
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void run();
              }}
              placeholder={armed ? 'claude -p "what changed today?" · type disarm to lock' : 'claude -p "what changed today?"'}
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
            Runs in <span className="font-mono text-ink-500">{info.cwd ?? "the repo root"}</span> on
            the machine hosting Operator. There is no shell, so{" "}
            <span className="font-mono">&amp;&amp;</span>, <span className="font-mono">|</span> and{" "}
            <span className="font-mono">;</span> are passed through as plain text rather than run.
            Ask for a shell explicitly when you want them:{" "}
            <span className="font-mono text-ink-500">bash -c "…"</span>. The first word must be a
            program, not a flag.
            {(info.allowed ?? []).length > 0 && (
              <>
                {" "}Restricted to:{" "}
                <span className="font-mono text-ink-500">{(info.allowed ?? []).join(" ")}</span>.
              </>
            )}{" "}
            Every run is logged with the device that started it; history is in memory and clears on
            restart.
          </p>
        </>
      )}
      {/*
        Kept on the panel rather than in the docs, because the moment you need
        it is the moment you are about to press Restart — not a moment you are
        reading /docs. Two rules, and which one applies depends only on which
        folder changed.
      */}
      {canManage && (
        <dl className="mt-3 pt-3 border-t border-base-600 text-xs text-ink-700 space-y-1.5">
          <div className="flex gap-2">
            <dt className="font-mono text-ink-500 shrink-0 w-[52px]">src/</dt>
            <dd>
              The app. Live instantly on the dev URL. Reaches the real one when you run{" "}
              <span className="font-mono text-ink-500">npm run build</span> — no restart, the
              server reads the built files off disk each time.
            </dd>
          </div>
          <div className="flex gap-2">
            <dt className="font-mono text-ink-500 shrink-0 w-[52px]">server/</dt>
            <dd>
              The API itself. Loaded into memory at boot, so nothing picks it up until this
              process is replaced — that is what <span className="text-ink-500">Restart</span> is
              for, and the only thing it is for.
            </dd>
          </div>
        </dl>
      )}
    </section>
  );
}
