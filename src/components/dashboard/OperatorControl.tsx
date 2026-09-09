import { useEffect, useRef, useState } from "react";
import {
  BellRing,
  Cpu,
  Radio,
  RotateCcw,
  ScrollText,
  ShieldCheck,
  SlidersHorizontal,
  Square,
} from "lucide-react";
import { useRemoteStorage } from "@/hooks/useRemoteStorage";
import { retry as reloadStore } from "@/lib/remoteStore";
import { useJobs } from "@/hooks/useJobs";

/**
 * OperatorControl — the Control dashboard wireframe (vault edf1f3b2), mounted
 * on the existing Dashboard page where the mission map and node graph live.
 * Presented as compact stacked `card-base` panels, the same smaller view the
 * Dev page uses (Terminal / Logs / Connected clients) and the app's own
 * glassy material — no invented styling. Every pane speaks to a real endpoint;
 * nothing here is mocked:
 *
 *  - AUTO MODE: the global master switch. Read from the persisted
 *    `operator.autoMode` store key, written through the `auto_mode` action
 *    (/api/actions) — never a direct store set, because the action is what
 *    propagates to the in-memory gate in jobs.mjs. Then the store is reloaded
 *    (`reloadStore`), since the client does not poll.
 *  - WAITING ON YOU: every job with an outstanding permission question.
 *    Selecting one jumps the event stream to it, where the question renders
 *    with the wireframe's buttons: Allow / No / Allow & stop asking.
 *  - LIVE JOBS: per-job controls (Stop on a running turn, Retry on a failed
 *    one) and the per-job model selector (setModel).
 *  - WORKERS & ROUTING: default model, providers.
 *  - CAPABILITY LOCKS: the standing profile for real — deniedTools (locked)
 *    and allowedTools (runs without asking) — plus a grant input that writes
 *    an allow rule through the same endpoint the CLI uses.
 *  - EVENT STREAM: the selected job's log with live permission questions
 *    answerable inline, and tool results as collapsible output (the
 *    wireframe's ARTIFACTS half).
 */
export default function OperatorControl() {
  const jobs = useJobs();
  const {
    jobs: jobList,
    models,
    providers,
    defaultModel,
    runningIds,
    spentUsd,
    budgetUsd,
    deniedTools,
    allowedTools,
    selected,
    selectedId,
    events,
    select,
    cancel,
    retry: retryJob,
    setModel,
    allowRule,
    answerPermission,
    refreshList,
  } = jobs;

  const [autoMode] = useRemoteStorage<boolean>("operator.autoMode", false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [grantRule, setGrantRule] = useState("");
  const [grantMsg, setGrantMsg] = useState<string | null>(null);

  const on = Boolean(autoMode);
  const askingJobs = jobList.filter((j) => (j.asking ?? 0) > 0);

  // Default the stream to the first job that needs a decision, else the
  // running one, else the first job. Only when nothing is selected yet.
  useEffect(() => {
    if (selectedId || jobList.length === 0) return;
    const asking = jobList.find((j) => (j.asking ?? 0) > 0);
    const running = jobList.find((j) => runningIds.includes(j.id));
    const first = jobList[0];
    if (asking) void select(asking.id);
    else if (running) void select(running.id);
    else if (first) void select(first.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobList.length]);

  async function flip(next: boolean) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/actions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "auto_mode", params: { on: next } }),
      });
      const data = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !data.ok) throw new Error(data.error || `flip failed (${res.status})`);
      await reloadStore();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function answer(jobId: string, permissionId: string, decision: "allow" | "deny", remember = false) {
    setError(null);
    const problem = await answerPermission(jobId, permissionId, decision, remember);
    if (problem) setError(problem);
  }

  /*
    The wireframe's five permission-card semantics (edf1f3b2, owner-corrected
    8 Sep): Approve / Deny / Don't ask again / Allow — this tool for this job /
    Auto mode. Only the last two were ever missing, and both turn out to
    already exist server-side with nothing surfacing them:

    - `requestAuto` (server/jobs.mjs) — a job may ask for its own standing
      auto grant, and the flag only flips on THIS answer. Exposed as the
      `auto_mode_request` capability action; never given a button anywhere.
    - `flip(true)` two functions up — the same global switch the Auto Mode
      card already uses, just never offered from inside a question itself.

    Both request-then-approve: `requestAuto`/`flip` only arm the grant, they
    do not resolve the promise this specific question is suspended on — the
    server checked auto BEFORE creating the question, so the already-pending
    one still needs its own `answer(...)` call, same as tapping Approve.
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

  async function grant() {
    const rule = grantRule.trim();
    if (!rule) return;
    setGrantMsg(null);
    const msg = await allowRule(rule);
    setGrantMsg(msg);
    await refreshList();
    setGrantRule("");
  }

  const visibleEvents = (events ?? []).filter((e) => e.type !== "usage");

  /*
    Auto-scroll to the newest event. Never had it — someone actually watching
    this stream (the owner said it plainly: "the event stream is gold," and it
    is the piece meant to carry a voice-driven interaction) had to keep pulling
    the scrollbar down by hand every time something new arrived, which is the
    opposite of "watch it work." Scrolled on length, not on content, since a
    changed-in-place event (a tool_result stub, a permission_answer replacing
    the question above it) is not a reason to jump — only a genuinely new line
    is.
  */
  const streamRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = streamRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [visibleEvents.length]);

  return (
    <>
      {/* AUTO MODE — the master switch */}
      <section className="card-base p-4 sm:p-5 mb-5 animate-fade-up">
        <header className="flex items-center justify-between gap-3 mb-3">
          <div className="flex items-center gap-2 min-w-0">
            <SlidersHorizontal size={15} className="text-xp shrink-0" />
            <div className="min-w-0">
              <h2 className="font-display text-sm font-medium text-ink-300">Auto mode</h2>
              <p className="text-xs text-ink-700 truncate">
                Global master switch — every job stops asking while on
              </p>
            </div>
          </div>
          <button
            role="switch"
            aria-checked={on}
            aria-label="Auto mode master switch"
            disabled={busy}
            onClick={() => void flip(!on)}
            className={`relative h-8 w-14 shrink-0 rounded-full border transition-colors disabled:opacity-60 ${
              on ? "border-xp/50 bg-xp/25" : "border-ink-700 bg-base-700"
            }`}
          >
            <span
              className={`absolute top-1 h-6 w-6 rounded-full transition-all ${
                on ? "left-7 bg-xp" : "left-1 bg-ink-500"
              }`}
            />
          </button>
        </header>
        <p className="text-xs leading-relaxed text-ink-500">
          Hard refusals (git push, deletes) are unchanged. Survives a restart.
        </p>
        {error && (
          <p className="mt-2 rounded-badge border border-vital-down/30 bg-vital-down/10 px-3 py-2 text-xs text-ink-300">
            {error}
          </p>
        )}
      </section>

      {/* WAITING ON YOU */}
      <section className="card-base p-4 sm:p-5 mb-5 animate-fade-up">
        <header className="flex items-center justify-between gap-3 mb-3">
          <div className="flex items-center gap-2 min-w-0">
            <BellRing size={15} className="text-ink-500 shrink-0" />
            <div className="min-w-0">
              <h2 className="font-display text-sm font-medium text-ink-300">Waiting on you</h2>
              <p className="text-xs text-ink-700 truncate">
                {askingJobs.length === 0
                  ? "Nothing pending — the machine isn&apos;t blocked on you"
                  : `${askingJobs.length} ${askingJobs.length === 1 ? "job" : "jobs"} need a decision`}
              </p>
            </div>
          </div>
          {askingJobs.length > 0 && (
            <span className="shrink-0 rounded-full bg-vital-down/20 px-2 py-0.5 font-mono text-[11px] text-vital-down">
              {askingJobs.length}
            </span>
          )}
        </header>
        {askingJobs.length === 0 ? (
          <p className="text-xs text-ink-700">Nothing pending.</p>
        ) : (
          <ul className="space-y-1.5">
            {askingJobs.map((j) => (
              <li key={j.id}>
                <button
                  onClick={() => void select(j.id)}
                  className={`w-full rounded-badge border px-3 py-2 text-left text-xs transition-colors ${
                    selectedId === j.id
                      ? "border-vital-down/40 bg-vital-down/10"
                      : "border-base-600 bg-base-700/40 text-ink-300 hover:border-ink-600"
                  }`}
                >
                  <span className="flex items-center gap-2">
                    <span className="h-1.5 w-1.5 rounded-full bg-vital-down" />
                    <span className="min-w-0 flex-1 truncate">{j.title || j.id}</span>
                    <span className="font-mono text-[10px] text-ink-700">
                      {j.asking} {j.asking === 1 ? "question" : "questions"}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* LIVE JOBS */}
      <section className="card-base p-4 sm:p-5 mb-5 animate-fade-up">
        <header className="flex items-center justify-between gap-3 mb-3">
          <div className="flex items-center gap-2 min-w-0">
            <Radio size={15} className="text-ink-500 shrink-0" />
            <div className="min-w-0">
              <h2 className="font-display text-sm font-medium text-ink-300">Live jobs</h2>
              <p className="text-xs text-ink-700 truncate">
                {typeof budgetUsd === "number" && budgetUsd > 0
                  ? `${jobList.length} jobs · $${spentUsd.toFixed(2)} / $${budgetUsd.toFixed(2)}`
                  : `${jobList.length} jobs`}
              </p>
            </div>
          </div>
        </header>
        {jobList.length === 0 ? (
          <p className="text-xs text-ink-700">No jobs — start one from Operator.</p>
        ) : (
          <ul className="space-y-1.5">
            {jobList.map((j) => {
              const isRunning = runningIds.includes(j.id);
              return (
                <li
                  key={j.id}
                  className={`rounded-badge border px-3 py-2 ${
                    selectedId === j.id ? "border-xp/40 bg-xp/5" : "border-base-600 bg-base-700/40"
                  }`}
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span
                      className={`h-2 w-2 shrink-0 rounded-full ${
                        j.error ? "bg-vital-down" : isRunning ? "bg-xp" : "bg-ink-700"
                      }`}
                      title={j.error ? "failed" : isRunning ? "running" : "idle"}
                    />
                    <button
                      onClick={() => void select(j.id)}
                      className="min-w-0 flex-1 truncate text-left text-xs text-ink-100 hover:text-xp"
                    >
                      {j.title || j.id}
                    </button>
                    {models.length > 0 && (
                      <select
                        value={j.model ?? ""}
                        onChange={(e) => void setModel(j.id, e.target.value)}
                        className="rounded-badge border border-base-600 bg-base-700 px-1.5 py-0.5 font-mono text-[10px] text-ink-300"
                        aria-label={`model for ${j.id}`}
                      >
                        {models.map((m) => (
                          <option key={m.id} value={m.id}>
                            {m.label}
                          </option>
                        ))}
                      </select>
                    )}
                    {!isRunning && j.costUsd > 0 && (
                      <span className="font-mono text-[10px] text-ink-700">${j.costUsd.toFixed(2)}</span>
                    )}
                    <span className="flex items-center gap-1">
                      {isRunning && (
                        <button
                          onClick={() => void cancel(j.id)}
                          title="Stop the running turn"
                          className="rounded-badge border border-base-600 px-1.5 py-0.5 text-ink-500 hover:border-vital-down/40 hover:text-vital-down"
                        >
                          <Square size={11} />
                        </button>
                      )}
                      {j.error && (
                        <button
                          onClick={() => void retryJob(j.id)}
                          title="Requeue the last attempt"
                          className="rounded-badge border border-base-600 px-1.5 py-0.5 text-ink-500 hover:border-xp/40 hover:text-xp"
                        >
                          <RotateCcw size={11} />
                        </button>
                      )}
                    </span>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {/* WORKERS & ROUTING */}
      <section className="card-base p-4 sm:p-5 mb-5 animate-fade-up">
        <header className="flex items-center gap-2 mb-3">
          <Cpu size={15} className="text-ink-500 shrink-0" />
          <div className="min-w-0">
            <h2 className="font-display text-sm font-medium text-ink-300">Workers &amp; routing</h2>
            <p className="text-xs text-ink-700 truncate">
              {providers.length > 0 ? providers.map((p) => p.label).join(", ") : "No providers"}
            </p>
          </div>
        </header>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
          <div>
            <dt className="text-ink-700">Default model</dt>
            <dd className="font-mono text-ink-100">{defaultModel || "—"}</dd>
          </div>
          <div>
            <dt className="text-ink-700">Budget</dt>
            <dd className="font-mono text-ink-300">
              {typeof budgetUsd === "number" && budgetUsd > 0
                ? `$${spentUsd.toFixed(2)} / $${budgetUsd.toFixed(2)}`
                : "—"}
            </dd>
          </div>
        </dl>
      </section>

      {/* CAPABILITY LOCKS */}
      <section className="card-base p-4 sm:p-5 mb-5 animate-fade-up">
        <header className="flex items-center gap-2 mb-3">
          <ShieldCheck size={15} className="text-ink-500 shrink-0" />
          <div className="min-w-0">
            <h2 className="font-display text-sm font-medium text-ink-300">Capability locks</h2>
            <p className="text-xs text-ink-700 truncate">What runs without asking</p>
          </div>
        </header>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <div className="rounded-badge border border-base-600 bg-base-700/40 px-3 py-2">
            <p className="font-mono text-[10px] uppercase tracking-wide text-ink-700">Locked</p>
            {deniedTools.length === 0 ? (
              <p className="mt-1 text-xs text-ink-700">Nothing hard-locked.</p>
            ) : (
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {deniedTools.map((t) => (
                  <span
                    key={t}
                    className="rounded-badge border border-vital-down/30 bg-vital-down/10 px-2 py-0.5 font-mono text-[11px] text-vital-down"
                  >
                    {t}
                  </span>
                ))}
              </div>
            )}
          </div>
          <div className="rounded-badge border border-base-600 bg-base-700/40 px-3 py-2">
            <p className="font-mono text-[10px] uppercase tracking-wide text-ink-700">Runs without asking</p>
            {allowedTools.length === 0 ? (
              <p className="mt-1 text-xs text-ink-700">Nothing quiet — everything asks.</p>
            ) : (
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {allowedTools.map((t) => (
                  <span
                    key={t}
                    className="rounded-badge border border-xp/30 bg-xp/10 px-2 py-0.5 font-mono text-[11px] text-xp"
                  >
                    {t}
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>
        <div className="mt-2 flex items-center gap-2">
          <input
            value={grantRule}
            onChange={(e) => setGrantRule(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void grant();
            }}
            placeholder="Tool or rule — never ask again (e.g. Bash(git log:*))"
            className="min-w-0 flex-1 rounded-badge border border-base-600 bg-base-700 px-3 py-1.5 text-xs text-ink-100 placeholder:text-ink-700"
          />
          <button
            onClick={() => void grant()}
            disabled={!grantRule.trim()}
            className="shrink-0 rounded-badge bg-xp px-3 py-1.5 text-xs font-medium text-base-950 disabled:opacity-50"
          >
            Grant
          </button>
        </div>
        {grantMsg && <p className="mt-1.5 text-[11px] text-ink-600">{grantMsg}</p>}
      </section>

      {/* EVENT STREAM */}
      <section className="card-base p-4 sm:p-5 mb-5 animate-fade-up">
        <header className="flex items-center justify-between gap-3 mb-3">
          <div className="flex items-center gap-2 min-w-0">
            <ScrollText size={15} className="text-ink-500 shrink-0" />
            <div className="min-w-0">
              <h2 className="font-display text-sm font-medium text-ink-300">Event stream</h2>
              <p className="text-xs text-ink-700 truncate">
                {selected ? selected.title || selected.id : "Pick a job from Waiting on you / Live jobs"}
              </p>
            </div>
          </div>
        </header>
        {visibleEvents.length === 0 ? (
          <p className="text-xs text-ink-700">No events yet — pick a job.</p>
        ) : (
          <div ref={streamRef} className="max-h-[32rem] space-y-1 overflow-y-auto pr-1">
            {visibleEvents.map((e, i) => (
              <div key={i} className="flex gap-2 text-xs leading-relaxed">
                <span className="shrink-0 font-mono text-[10px] text-ink-700">{timeOf(e.at)}</span>
                {e.type === "permission_request" && e.auto ? (
                  /*
                    Auto-resolved — a record, not a question. Nobody was asked,
                    so this reads as a log line rather than the amber card
                    below: same information (what, on which job), no buttons,
                    because there is nothing left to decide. This is the vault
                    requirement (edf1f3b2) that the stream stay honest once
                    auto mode goes quiet on the phone — without it, "auto mode
                    is on" and "nothing is happening" looked identical here.
                  */
                  <p className="min-w-0 flex-1 break-words text-ink-500">
                    <span className="font-mono text-[10px] uppercase tracking-wide text-rank">Auto-allowed</span>{" "}
                    {e.title || e.rule || e.tool}
                  </p>
                ) : e.type === "permission_request" ? (
                  <div className="min-w-0 flex-1 rounded-badge border border-xp/40 bg-xp/5 px-3 py-2">
                    <p className="font-mono text-[10px] uppercase tracking-wide text-xp">Needs your say-so</p>
                    <p className="mt-0.5 break-words text-ink-200">
                      {e.title || e.rule || e.tool || "A tool wants to run."}
                    </p>
                    {e.description && (
                      <p className="mt-0.5 break-words text-[11px] text-ink-500">{e.description}</p>
                    )}
                    {e.id && selectedId ? (
                      /*
                        Five actions, matching the wireframe's owner-corrected
                        semantics (edf1f3b2, 8 Sep) exactly rather than the
                        three this card shipped with. All five map to real,
                        already-scoped server behaviour — nothing here is a
                        relabelled duplicate of something else:
                          Approve            - answerPermission(allow), once
                          Deny               - answerPermission(deny)
                          Don't ask again    - answerPermission(allow, remember:true) —
                                               genuinely global-until-restart
                                               (module-level Set, not per-job),
                                               named accordingly rather than as
                                               "for this job"
                          Auto — this job    - auto_mode_request, then approve
                          Auto — everywhere  - the same global flip the Auto
                                               Mode card uses, then approve
                      */
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        <button
                          onClick={() => void answer(selectedId, e.id!, "allow")}
                          className="rounded-badge bg-xp px-2.5 py-1 text-[11px] font-medium text-base-950"
                        >
                          Approve
                        </button>
                        <button
                          onClick={() => void answer(selectedId, e.id!, "deny")}
                          className="rounded-badge border border-base-500 px-2.5 py-1 text-[11px] text-ink-300"
                        >
                          Deny
                        </button>
                        <button
                          onClick={() => void answer(selectedId, e.id!, "allow", true)}
                          className="rounded-badge border border-base-600 px-2.5 py-1 text-[11px] text-ink-500"
                          title="Every job, every question with this exact rule — until the server restarts"
                        >
                          Don&apos;t ask again
                        </button>
                        <button
                          onClick={() => void autoThisJob(selectedId, e.id!)}
                          className="rounded-badge border border-rank/40 bg-rank/5 px-2.5 py-1 text-[11px] text-rank"
                          title="Everything this job asks, from now on — other jobs still ask"
                        >
                          Auto — this job
                        </button>
                        <button
                          onClick={() => void autoEverywhere(selectedId, e.id!)}
                          className="rounded-badge border border-rank/40 bg-rank/5 px-2.5 py-1 text-[11px] text-rank"
                          title="The global switch — every job, until you turn it off"
                        >
                          Auto — everywhere
                        </button>
                      </div>
                    ) : (
                      <p className="mt-1 text-[10px] text-ink-600">
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
                      <details className="font-mono text-[11px]">
                        <summary
                          className={`cursor-pointer ${e.ok === false ? "text-vital-down" : "text-ink-500"}`}
                        >
                          {e.ok === false ? "error" : "result"} · {e.text.split("\n").length} lines
                        </summary>
                        <pre className="mt-1 max-h-40 overflow-x-auto overflow-y-auto whitespace-pre-wrap rounded-badge border border-base-600 bg-base-950/60 p-2 text-ink-500">
                          {e.text}
                        </pre>
                      </details>
                    ) : (
                      <span className={`font-mono text-[11px] ${e.ok === false ? "text-vital-down" : "text-ink-600"}`}>
                        {e.ok === false ? "failed" : "done"}
                      </span>
                    )}
                  </div>
                ) : e.type === "prompt" ? (
                  <p className="min-w-0 flex-1 whitespace-pre-wrap break-words text-ink-100">{e.text}</p>
                ) : (
                  <p className="min-w-0 flex-1 break-words text-ink-500">
                    {e.text || e.status || e.detail || e.type}
                  </p>
                )}
              </div>
            ))}
          </div>
        )}
      </section>
    </>
  );
}

/** Local-time HH:MM:SS for an ISO timestamp, or "" when unparseable. */
function timeOf(at: string): string {
  const d = new Date(at);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleTimeString([], { hour12: false });
}
