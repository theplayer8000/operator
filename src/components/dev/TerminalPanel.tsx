import { useEffect, useRef } from "react";
import { TerminalSquare, Play, Square, RotateCcw, RotateCw, ShieldAlert, Power } from "lucide-react";
import ConfirmButton from "@/components/ui/ConfirmButton";
import { useTerminal } from "@/hooks/useTerminal";

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
 *
 * The state and the `/api/terminal/*` calls live in `useTerminal()` — the
 * Sandbox Terminal quadrant on the map page (`components/dashboard/
 * SandboxTerminal.tsx`) is the same capability in a much smaller space, not a
 * second terminal with its own copy of this to drift out of sync. This
 * component owns only its own presentation, unchanged from before the split.
 */
export default function TerminalPanel() {
  const {
    info,
    command,
    setCommand,
    activeId,
    output,
    streaming,
    error,
    restarting,
    canManage,
    armed,
    notListed,
    refresh,
    attach,
    run,
    setArmed,
    restartServer,
    stop,
  } = useTerminal();

  const outputRef = useRef<HTMLPreElement>(null);

  // Follow the tail while output arrives, the way a console does.
  useEffect(() => {
    const el = outputRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [output]);

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
            {/*
              A textarea, not an input, and that is a phone fix rather than a
              preference.

              A single-line input shows about twenty-five characters on an
              iPhone and scrolls the rest out of sight. The owner pasted a
              command with a long Windows path into it twice, both times lost
              the tail without seeing it happen, and got `fatal: No pathspec was
              given` — git receiving a flag with no filename. He could not tell
              from the field that anything was missing.

              Wrapping means the whole command is visible before it runs, which
              is the difference between a typo and a mystery. It grows to four
              lines and then scrolls, so an ordinary short command still looks
              like a prompt rather than a form.
            */}
            <textarea
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              onKeyDown={(e) => {
                // Enter runs, Shift+Enter is a newline. A command that spans
                // lines is rare but `bash -c` heredocs exist, and losing one to
                // an accidental submit would be worse than the extra key.
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void run();
                }
              }}
              rows={command.split("\n").length > 1 ? 3 : 1}
              placeholder={armed ? 'claude -p "what changed today?" · type disarm to lock' : 'claude -p "what changed today?"'}
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              aria-label="Command to run"
              className="flex-1 min-w-0 bg-base-700/40 border border-base-600 rounded-badge px-3 py-2.5 min-h-[44px] max-h-[7.5rem] text-base sm:text-sm font-mono text-ink-100 placeholder:text-ink-700 outline-none focus:border-xp/50 transition-colors resize-none break-all"
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

          {(info?.runs ?? []).length > 0 && (
            <ul className="space-y-1 pt-3 border-t border-base-600">
              {(info?.runs ?? []).slice(0, 8).map((r) => (
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
            Runs in <span className="font-mono text-ink-500">{info?.cwd ?? "the repo root"}</span> on
            the machine hosting Operator. There is no shell, so{" "}
            <span className="font-mono">&amp;&amp;</span>, <span className="font-mono">|</span> and{" "}
            <span className="font-mono">;</span> are passed through as plain text rather than run.
            Ask for a shell explicitly when you want them:{" "}
            <span className="font-mono text-ink-500">bash -c "…"</span>. The first word must be a
            program, not a flag.
            {(info?.allowed ?? []).length > 0 && (
              <>
                {" "}Restricted to:{" "}
                <span className="font-mono text-ink-500">{(info?.allowed ?? []).join(" ")}</span>.
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
