import { useEffect, useRef, useState } from "react";
import {
  CheckCircle2,
  Circle,
  MessageSquare,
  Route,
  RotateCcw,
  ScrollText,
  Send,
  ShieldAlert,
  ShieldCheck,
  ShieldX,
  Square,
  Wrench,
  XCircle,
  Zap,
} from "lucide-react";
import type { JobEvent, JobProvider, JobSummary } from "@/hooks/useJobs";

/**
 * LIVE JOB EVENT STREAM — pulled out of OperatorControl.tsx (2026-09-09), the
 * same move as the other two panels: one component the desktop dock and the
 * new mobile dock both mount, instead of two copies of the event-rendering
 * logic (nine event-type branches, the five-button permission card) to keep
 * in sync by hand.
 *
 * Owns the permission-answer handlers (`answer`/`autoThisJob`/
 * `autoEverywhere`) and their own error state internally — those were only
 * ever used here, never by the rest of OperatorControl — taking
 * `answerPermission` and `flip` as the two mutators they actually depend on.
 */
export default function EventStreamPanel({
  jobList,
  runningIds,
  selectedId,
  selected,
  events,
  models,
  providers,
  select,
  cancel,
  retryJob,
  setModel,
  answerPermission,
  flip,
}: {
  jobList: JobSummary[];
  runningIds: string[];
  selectedId: string | null;
  selected: JobSummary | null;
  events: JobEvent[] | undefined;
  models: { id: string; label: string }[];
  providers: JobProvider[];
  select: (id: string) => Promise<void> | void;
  cancel: (id: string) => Promise<void> | void;
  retryJob: (id: string) => Promise<void> | void;
  setModel: (id: string, model: string) => Promise<void> | void;
  answerPermission: (
    jobId: string,
    permissionId: string,
    decision: "allow" | "deny",
    remember?: boolean,
  ) => Promise<string | null>;
  flip: (next: boolean) => Promise<void>;
}) {
  const [error, setError] = useState<string | null>(null);

  async function answer(jobId: string, permissionId: string, decision: "allow" | "deny", remember = false) {
    setError(null);
    const problem = await answerPermission(jobId, permissionId, decision, remember);
    if (problem) setError(problem);
  }

  /*
    The wireframe's five permission-card semantics (edf1f3b2, owner-corrected
    8 Sep): Approve / Deny / Don't ask again / Allow — this tool for this job /
    Auto mode. `requestAuto` and `flip` only arm the grant; the already-pending
    question still needs its own `answer(...)` call, same as tapping Approve.
  */
  async function autoThisJob(jobId: string, permissionId: string) {
    setError(null);
    try {
      const res = await fetch("/api/actions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "auto_mode_request", params: { jobId } }),
      });
      const data = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !data.ok) throw new Error(data.error || `request failed (${res.status})`);
    } catch (err) {
      setError((err as Error).message);
      return;
    }
    await answer(jobId, permissionId, "allow", false);
  }

  async function autoEverywhere(jobId: string, permissionId: string) {
    await flip(true);
    await answer(jobId, permissionId, "allow", false);
  }

  const visibleEvents = (events ?? []).filter((e) => e.type !== "usage");

  // Auto-scroll to the newest event — see the header comment on why this
  // stream matters more than a chat transcript ever did.
  const streamRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = streamRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [visibleEvents.length]);

  return (
    <div className="flex h-full min-h-0 flex-col p-2.5">
      <header className="mb-1.5 flex shrink-0 items-center gap-1.5">
        <ScrollText size={11} className="shrink-0 text-ink-600" />
        <h2 className="min-w-0 flex-1 truncate font-mono text-[10px] uppercase tracking-wide text-ink-500">
          Event stream — {selected ? selected.title || selected.id : "no job"}
        </h2>
      </header>

      {/* job picker — folds "Waiting on you" and "Live jobs" into one strip */}
      {jobList.length > 0 && (
        <div className="mb-1.5 flex shrink-0 items-center gap-1 overflow-x-auto pb-1">
          {jobList.map((j) => {
            const isRunning = runningIds.includes(j.id);
            const isAsking = (j.asking ?? 0) > 0;
            return (
              <button
                key={j.id}
                onClick={() => void select(j.id)}
                title={j.title || j.id}
                className={`flex shrink-0 items-center gap-1 rounded-badge border px-1.5 py-0.5 font-mono text-[10px] transition-colors ${
                  selectedId === j.id
                    ? "border-xp/40 bg-xp/10 text-xp"
                    : isAsking
                      ? "border-vital-down/40 bg-vital-down/10 text-ink-300"
                      : "border-base-600 bg-base-700/40 text-ink-500 hover:text-ink-200"
                }`}
              >
                <span
                  className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                    j.error ? "bg-vital-down" : isRunning ? "bg-xp" : isAsking ? "bg-vital-down" : "bg-ink-700"
                  }`}
                />
                <span className="max-w-[6rem] truncate">{j.title || j.id}</span>
                {isAsking && <span className="text-vital-down">{j.asking}</span>}
              </button>
            );
          })}
        </div>
      )}

      {/* selected-job toolbar — model + stop/retry, folded from the old Live Jobs card */}
      {selected && (
        <div className="mb-1.5 flex shrink-0 items-center gap-1.5">
          {(() => {
            /*
              `models` (the top-level list) is server-side ALWAYS the default
              provider's models (jobs.mjs: `selectWorker(DEFAULT_PROVIDER).worker.models`)
              — never scoped to whichever job is actually selected. `providers`
              already carries each worker's OWN `models` array; use the
              selected job's, not the global default's.
            */
            const jobModels = providers.find((p) => p.id === selected.provider)?.models ?? models;
            return (
              jobModels.length > 0 && (
                <select
                  value={selected.model ?? ""}
                  onChange={(e) => void setModel(selected.id, e.target.value)}
                  className="min-w-0 flex-1 rounded-badge border border-base-600 bg-base-700 px-1.5 py-0.5 font-mono text-[10px] text-ink-300"
                  aria-label={`model for ${selected.id}`}
                >
                  {jobModels.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label}
                    </option>
                  ))}
                </select>
              )
            );
          })()}
          {runningIds.includes(selected.id) ? (
            <button
              onClick={() => void cancel(selected.id)}
              title="Stop the running turn"
              className="shrink-0 rounded-badge border border-base-600 px-1.5 py-0.5 text-ink-500 hover:border-vital-down/40 hover:text-vital-down"
            >
              <Square size={11} />
            </button>
          ) : selected.error ? (
            <button
              onClick={() => void retryJob(selected.id)}
              title="Requeue the last attempt"
              className="shrink-0 rounded-badge border border-base-600 px-1.5 py-0.5 text-ink-500 hover:border-xp/40 hover:text-xp"
            >
              <RotateCcw size={11} />
            </button>
          ) : selected.costUsd > 0 ? (
            <span className="shrink-0 font-mono text-[10px] text-ink-700">${selected.costUsd.toFixed(2)}</span>
          ) : null}
        </div>
      )}

      {error && (
        <p className="mb-1.5 shrink-0 rounded-badge border border-vital-down/30 bg-vital-down/10 px-2 py-1 text-[10px] text-ink-300">
          {error}
        </p>
      )}

      {visibleEvents.length === 0 ? (
        <p className="text-[10px] text-ink-700">No events yet — pick a job.</p>
      ) : (
        <div ref={streamRef} className="min-h-0 flex-1 space-y-1 overflow-y-auto pr-1">
          {visibleEvents.map((e, i) => (
            <div key={i} className="flex gap-1.5 text-[11px] leading-relaxed">
              <span className="shrink-0 font-mono text-[9px] text-ink-700">{timeOf(e.at)}</span>
              <EventIcon e={e} />
              {e.type === "permission_request" && e.auto ? (
                /*
                  Auto-resolved — a record, not a question. Nobody was
                  asked, so this reads as a log line, not the amber card
                  below.
                */
                <p className="min-w-0 flex-1 break-words text-ink-500">
                  <span className="font-mono text-[9px] uppercase tracking-wide text-rank">Auto-allowed</span>{" "}
                  {e.title || e.rule || e.tool}
                </p>
              ) : e.type === "permission_request" ? (
                <div className="min-w-0 flex-1 rounded-badge border border-xp/40 bg-xp/5 px-2 py-1.5">
                  <p className="font-mono text-[9px] uppercase tracking-wide text-xp">Needs your say-so</p>
                  <p className="mt-0.5 break-words text-ink-200">
                    {e.title || e.rule || e.tool || "A tool wants to run."}
                  </p>
                  {e.description && (
                    <p className="mt-0.5 break-words text-[10px] text-ink-500">{e.description}</p>
                  )}
                  {e.id && selectedId ? (
                    /*
                      Five actions, matching the wireframe's owner-corrected
                      semantics (edf1f3b2, 8 Sep):
                        Approve            - answerPermission(allow), once
                        Deny               - answerPermission(deny)
                        Don't ask again    - answerPermission(allow, remember:true) —
                                             genuinely global-until-restart
                        Auto — this job    - auto_mode_request, then approve
                        Auto — everywhere  - the global flip, then approve
                    */
                    <div className="mt-1.5 flex flex-wrap gap-1">
                      <button
                        onClick={() => void answer(selectedId, e.id!, "allow")}
                        className="rounded-badge bg-xp px-2 py-0.5 text-[10px] font-medium text-base-950"
                      >
                        Approve
                      </button>
                      <button
                        onClick={() => void answer(selectedId, e.id!, "deny")}
                        className="rounded-badge border border-base-500 px-2 py-0.5 text-[10px] text-ink-300"
                      >
                        Deny
                      </button>
                      <button
                        onClick={() => void answer(selectedId, e.id!, "allow", true)}
                        className="rounded-badge border border-base-600 px-2 py-0.5 text-[10px] text-ink-500"
                        title="Every job, every question with this exact rule — until the server restarts"
                      >
                        Don&apos;t ask again
                      </button>
                      <button
                        onClick={() => void autoThisJob(selectedId, e.id!)}
                        className="rounded-badge border border-rank/40 bg-rank/5 px-2 py-0.5 text-[10px] text-rank"
                        title="Everything this job asks, from now on — other jobs still ask"
                      >
                        Auto — this job
                      </button>
                      <button
                        onClick={() => void autoEverywhere(selectedId, e.id!)}
                        className="rounded-badge border border-rank/40 bg-rank/5 px-2 py-0.5 text-[10px] text-rank"
                        title="The global switch — every job, until you turn it off"
                      >
                        Auto — everywhere
                      </button>
                    </div>
                  ) : (
                    <p className="mt-1 text-[9px] text-ink-600">
                      No longer answerable — the turn it belonged to has ended.
                    </p>
                  )}
                </div>
              ) : e.type === "permission_answer" ? (
                <p className="min-w-0 flex-1">
                  <span className={e.decision === "allowed" ? "text-xp" : "text-ink-500"}>
                    {e.decision ?? "answered"}
                  </span>
                  {e.by ? <span className="text-ink-600"> by {e.by}</span> : null}
                </p>
              ) : e.type === "routed" ? (
                <p className="min-w-0 flex-1 text-ink-500">
                  <span className="text-ink-300">{e.label}</span>
                  {e.why ? <span className="text-ink-600"> — {e.why}</span> : null}
                </p>
              ) : e.type === "tool_use" ? (
                <p className="min-w-0 flex-1 text-ink-500">
                  <span className="text-ink-300">{e.tool}</span>
                  {e.subject ? <span className="text-ink-600"> {e.subject}</span> : null}
                </p>
              ) : e.type === "tool_result" ? (
                <div className="min-w-0 flex-1">
                  {e.text?.trim() ? (
                    <details className="font-mono text-[10px]">
                      <summary className={`cursor-pointer ${e.ok === false ? "text-vital-down" : "text-ink-500"}`}>
                        {e.ok === false ? "error" : "result"} · {e.text.split("\n").length} lines
                      </summary>
                      <pre className="mt-1 max-h-32 overflow-x-auto overflow-y-auto whitespace-pre-wrap rounded-badge border border-base-600 bg-base-950/60 p-2 text-ink-500">
                        {e.text}
                      </pre>
                    </details>
                  ) : (
                    <span className={`font-mono text-[10px] ${e.ok === false ? "text-vital-down" : "text-ink-600"}`}>
                      {e.ok === false ? "failed" : "done"}
                    </span>
                  )}
                </div>
              ) : e.type === "prompt" ? (
                <p className="min-w-0 flex-1 truncate text-ink-100">
                  <span className="font-mono text-[9px] text-ink-700">sent </span>
                  {truncateLine(e.text, 60)}
                </p>
              ) : e.type === "text" ? (
                <details className="min-w-0 flex-1 text-[10px]">
                  <summary className="cursor-pointer text-ink-500">
                    replied · {wordCount(e.text)} word{wordCount(e.text) === 1 ? "" : "s"}
                  </summary>
                  <p className="mt-1 max-h-32 overflow-y-auto whitespace-pre-wrap rounded-badge border border-base-600 bg-base-950/60 p-2 text-ink-300">
                    {e.text}
                  </p>
                </details>
              ) : (
                <p className="min-w-0 flex-1 break-words text-ink-500">{e.status || e.detail || e.type}</p>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/*
  One icon per event type, matching the wireframe's intent literally rather
  than just structurally: edf1f3b2 draws each stream line with a marker
  ("🔍 Scanning workspace", "🔧 Running git worktree", "🔴 [PERMISSION
  REQUIRED]"). lucide-react, not the wireframe's literal emoji — it's the
  icon set every other panel here already uses. Color mirrors whatever that
  row's own text already uses, so the icon reads as the same signal, not a
  second thing to parse.
*/
function EventIcon({ e }: { e: JobEvent }) {
  const cls = "mt-0.5 shrink-0";
  if (e.type === "permission_request" && e.auto) return <Zap size={12} className={`${cls} text-rank`} />;
  if (e.type === "permission_request") return <ShieldAlert size={12} className={`${cls} text-xp`} />;
  if (e.type === "permission_answer")
    return e.decision === "allowed" ? (
      <ShieldCheck size={12} className={`${cls} text-xp`} />
    ) : (
      <ShieldX size={12} className={`${cls} text-ink-500`} />
    );
  if (e.type === "routed") return <Route size={12} className={`${cls} text-ink-600`} />;
  if (e.type === "tool_use") return <Wrench size={12} className={`${cls} text-ink-600`} />;
  if (e.type === "tool_result")
    return e.ok === false ? (
      <XCircle size={12} className={`${cls} text-vital-down`} />
    ) : (
      <CheckCircle2 size={12} className={`${cls} text-ink-600`} />
    );
  if (e.type === "prompt") return <Send size={12} className={`${cls} text-ink-700`} />;
  if (e.type === "text") return <MessageSquare size={12} className={`${cls} text-ink-600`} />;
  return <Circle size={9} className={`${cls} text-ink-700`} />;
}

/** Local-time HH:MM:SS for an ISO timestamp, or "" when unparseable. */
function timeOf(at: string): string {
  const d = new Date(at);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleTimeString([], { hour12: false });
}

/**
 * One scannable line for a `prompt` event — flatten newlines so a multi-line
 * instruction cannot expand the row, then hard-cut.
 */
function truncateLine(text: string | undefined, max: number): string {
  const flat = (text ?? "").replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** For the collapsed `text` summary — "replied · 34 words" rather than a length in characters, which means nothing at a glance. */
function wordCount(text: string | undefined): number {
  return (text ?? "").trim().split(/\s+/).filter(Boolean).length;
}
