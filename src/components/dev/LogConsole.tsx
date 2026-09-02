import { useCallback, useEffect, useRef, useState } from "react";
import { ScrollText, RefreshCw } from "lucide-react";

/**
 * Operator's own logs, in Operator.
 *
 * ## Why this exists
 *
 * The owner asked for it twice. The first time it was answered by HIDING the
 * console windows — which stopped them cluttering the desktop and also stopped
 * anyone reading them. Then the desktop shell began writing its own file and
 * there were two logs, neither visible from the app.
 *
 * A log only readable from a terminal helps exactly the person who least needs
 * it: whoever is already sitting at the machine. He reviews from a phone.
 *
 * ## Truncated on purpose, and it says so
 *
 * The tail only, with the real total alongside it. A truncated log that looks
 * complete is how someone concludes a thing never happened — and this is the
 * surface people reach for precisely when they are trying to work out whether
 * something ran.
 */

interface LogMeta {
  id: string;
  label: string;
  what: string;
}

interface LogTail {
  id: string;
  label: string;
  missing: boolean;
  bytes: number;
  totalLines?: number;
  lines: string[];
}

/** Lines that are worth seeing at a glance rather than reading. */
function toneFor(line: string): string {
  if (/\b(error|failed|refused|cannot|not registered|threw)\b/i.test(line)) return "text-vital-down/80";
  if (/\b(warn|ignoring|stopped|cancelled|out of quota)\b/i.test(line)) return "text-xp/70";
  if (/\b(ARMED|RAN|registered|listening|subscribed)\b/.test(line)) return "text-vital-up/70";
  return "text-ink-600";
}

export default function LogConsole() {
  const [logs, setLogs] = useState<LogMeta[]>([]);
  const [active, setActive] = useState<string>("server");
  const [tail, setTail] = useState<LogTail | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void fetch("/api/logs")
      .then((r) => r.json())
      .then((b) => setLogs(b.logs ?? []))
      .catch(() => {});
  }, []);

  const load = useCallback(async (id: string) => {
    setBusy(true);
    try {
      const res = await fetch(`/api/logs/${id}?lines=150`);
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error ?? `server said ${res.status}`);
      setTail(body);
      setError(null);
    } catch (err) {
      setError((err as Error)?.message ?? "Could not read it.");
      setTail(null);
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    void load(active);
  }, [active, load]);

  /*
    Pin to the bottom after each load. The newest line is the one being looked
    for, and a log that opens at the top makes you scroll to find out whether
    anything happened.
  */
  useEffect(() => {
    if (box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [tail]);

  return (
    <section className="card-base p-4 sm:p-5 animate-fade-up">
      <header className="flex items-center justify-between gap-3 mb-1">
        <div className="flex items-center gap-2 min-w-0">
          <ScrollText size={16} className="text-xp shrink-0" />
          <h2 className="font-display text-sm text-ink-100">Logs</h2>
        </div>
        <button
          onClick={() => void load(active)}
          disabled={busy}
          aria-label="Reload the log"
          className="min-w-[44px] min-h-[44px] flex items-center justify-center rounded-badge border border-base-600 text-ink-500 hover:text-ink-100 hover:bg-base-700/60 transition-colors disabled:opacity-40"
        >
          <RefreshCw size={14} className={busy ? "animate-spin" : ""} />
        </button>
      </header>

      {/*
        Scrolled, not wrapped. A log line is long and wrapping it turns a
        readable column of timestamps into a wall — the same rule the Dev file
        browser follows on a phone.
      */}
      <div className="flex gap-2 overflow-x-auto pb-1 mb-3 -mx-1 px-1">
        {logs.map((l) => (
          <button
            key={l.id}
            onClick={() => setActive(l.id)}
            title={l.what}
            className={`shrink-0 px-3 min-h-[44px] rounded-badge border text-xs font-mono transition-colors ${
              active === l.id
                ? "border-xp/50 bg-xp/10 text-xp"
                : "border-base-600 text-ink-600 hover:text-ink-300 hover:bg-base-700/40"
            }`}
          >
            {l.label}
          </button>
        ))}
      </div>

      {error && <p className="text-sm text-vital-down/80 mb-2">{error}</p>}

      {tail?.missing && (
        <p className="text-sm text-ink-700">
          Nothing written yet — this one only appears once that part has run.
        </p>
      )}

      {tail && !tail.missing && (
        <>
          <div
            ref={box}
            className="rounded-badge border border-base-600 bg-base-950/60 p-3 max-h-[22rem] overflow-auto"
          >
            <pre className="font-mono text-[11px] leading-relaxed whitespace-pre min-w-max">
              {tail.lines.map((line, i) => (
                <div key={i} className={toneFor(line)}>
                  {line}
                </div>
              ))}
            </pre>
          </div>
          {/*
            The real total, so the truncation is visible. A tail that looks
            complete is how someone concludes a thing never happened.
          */}
          <p className="font-mono text-[11px] text-ink-700 mt-2">
            last {tail.lines.length.toLocaleString()} of{" "}
            {(tail.totalLines ?? tail.lines.length).toLocaleString()} lines ·{" "}
            {(tail.bytes / 1024).toFixed(0)} KB
          </p>
        </>
      )}
    </section>
  );
}
