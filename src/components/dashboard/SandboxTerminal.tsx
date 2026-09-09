import { useEffect, useRef } from "react";
import { Play, Power, Square, SquareTerminal } from "lucide-react";
import { useTerminal } from "@/hooks/useTerminal";

/**
 * The Sandbox Terminal quadrant — the same capability as the Dev page's
 * `TerminalPanel`, through the same `useTerminal()` hook, in the ~300x110px
 * this quadrant actually has. Not a second terminal: same `/api/terminal/*`
 * calls, same arm/disarm semantics, same "no shell" constraint. What's
 * different is presentation only, because the Dev page's card — header,
 * growing textarea, run history, a two-row build-rules legend — assumes far
 * more room than a HUD quadrant has.
 *
 * Deliberately dropped for space, not forgotten:
 *   - the runs history list (Dev page still has it)
 *   - the "restart the server" button — a real, distinct capability that
 *     deserves the Dev page's surrounding context and confirm-button
 *     friction, not a tap-away spot in a draggable corner widget
 *   - the build-rules legend (src/ vs server/) — static text, Dev page owns it
 *
 * Artifacts (the other half of this quadrant's wireframe label) is not
 * addressed here — nothing in the app produces or lists "artifacts" yet, so
 * there is nothing real to wire in without inventing a feature that was not
 * asked for.
 */
export default function SandboxTerminal() {
  const { info, command, setCommand, output, streaming, error, canManage, armed, notListed, run, stop, setArmed } =
    useTerminal();

  const outputRef = useRef<HTMLPreElement>(null);
  useEffect(() => {
    const el = outputRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [output]);

  return (
    <div className="flex h-full min-h-0 flex-col p-2.5">
      <header className="mb-1 flex shrink-0 items-center justify-between gap-1.5">
        <span className="flex min-w-0 items-center gap-1.5">
          <SquareTerminal size={11} className="shrink-0 text-ink-600" />
          <h2 className="truncate font-mono text-[10px] uppercase tracking-wide text-ink-500">Sandbox terminal</h2>
        </span>
        {canManage && (
          <button
            onClick={() => void setArmed(!armed)}
            aria-pressed={armed}
            aria-label={armed ? "Disarm the terminal" : "Arm the terminal"}
            title={armed ? "Disarm — no commands can run until it's switched back on" : "Arm for this session"}
            className={`flex shrink-0 items-center gap-1 rounded-badge border px-1.5 py-0.5 font-mono text-[9px] transition-colors ${
              armed ? "border-xp/40 bg-xp/10 text-xp" : "border-base-600 text-ink-600 hover:text-ink-300"
            }`}
          >
            <Power size={9} />
            {armed ? "armed" : "arm"}
          </button>
        )}
      </header>

      {info === null ? (
        <p className="text-[10px] text-ink-700">Checking…</p>
      ) : notListed ? (
        <p className="text-[10px] leading-relaxed text-ink-700">
          This device can&apos;t run commands — add it to{" "}
          <span className="font-mono text-ink-600">OPERATOR_TERMINAL_DEVICES</span>.
        </p>
      ) : !armed ? (
        <p className="text-[10px] text-ink-700">Disarmed — tap arm to enable for this session.</p>
      ) : (
        <>
          <div className="mb-1 flex shrink-0 items-center gap-1">
            <input
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void run();
              }}
              placeholder='claude -p "…"'
              spellCheck={false}
              autoCapitalize="off"
              autoCorrect="off"
              aria-label="Command to run"
              className="min-w-0 flex-1 rounded-badge border border-base-600 bg-base-700/40 px-1.5 py-0.5 font-mono text-[10px] text-ink-100 placeholder:text-ink-700 outline-none focus:border-xp/50"
            />
            {streaming ? (
              <button
                onClick={() => void stop()}
                aria-label="Stop the running command"
                title="Stop"
                className="shrink-0 rounded-badge border border-vital-down/40 bg-vital-down/10 p-1 text-vital-down"
              >
                <Square size={10} />
              </button>
            ) : (
              <button
                onClick={() => void run()}
                disabled={command.trim() === ""}
                aria-label="Run the command"
                title="Run"
                className="shrink-0 rounded-badge border border-xp/40 bg-xp/10 p-1 text-xp disabled:border-base-600 disabled:bg-transparent disabled:text-ink-700"
              >
                <Play size={10} />
              </button>
            )}
          </div>

          {error && <p className="mb-1 shrink-0 text-[9px] leading-snug text-vital-down">{error}</p>}

          {(output !== "" || streaming) && (
            <pre
              ref={outputRef}
              className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words rounded-badge border border-base-600 bg-base-950/60 p-1.5 font-mono text-[9px] text-ink-300"
            >
              {output}
              {streaming && <span className="text-xp">▍</span>}
            </pre>
          )}
        </>
      )}
    </div>
  );
}
