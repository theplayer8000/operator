import { useEffect, useRef, useState } from "react";
import {
  CheckCircle2,
  Circle,
  Cpu,
  GripHorizontal,
  MessageSquare,
  Route,
  RotateCcw,
  ScrollText,
  Send,
  ShieldAlert,
  ShieldCheck,
  ShieldX,
  SlidersHorizontal,
  Square,
  SquareTerminal,
  Wrench,
  XCircle,
  Zap,
} from "lucide-react";
import { useRemoteStorage } from "@/hooks/useRemoteStorage";
import { retry as reloadStore } from "@/lib/remoteStore";
import { readStorage, writeStorage } from "@/lib/storage";
import { useJobs } from "@/hooks/useJobs";
import type { JobEvent } from "@/hooks/useJobs";

/*
  OperatorControl — the wireframe (vault edf1f3b2, "The Orchestrator Job
  Dashboard Design") built literally rather than structurally-equivalent: a
  single bordered, TRANSPARENT landscape box in a 2x2 grid — Workers &
  Routing / Capability Locks on the left, Live Job Event Stream / Sandbox
  Terminal on the right, right column split unevenly (~70/30) so the stream
  dominates, exactly as drawn. Everything here still speaks to a real
  endpoint; nothing is mocked, only re-housed from the six stacked
  `card-base` cards this replaced:

    - AUTO MODE lives in the grip bar now, not its own zone — it is the one
      truly global switch and the grip bar is the one strip outside all four
      quadrants.
    - WAITING ON YOU and LIVE JOBS (the old separate cards) are folded into a
      compact chip strip + per-job toolbar sitting above the event stream —
      the stream is job-scoped, so it needed a picker regardless of where it
      lived, and the wireframe never drew them as their own zones.
    - WORKERS & ROUTING / CAPABILITY LOCKS are straight moves.
    - SANDBOX TERMINAL / ARTIFACTS is a labelled placeholder. It is not built
      anywhere in this app yet (confirmed against the vault note before
      starting this) — stubbing the quadrant completes the grid without
      pretending a real terminal exists.

  DRAGGABLE AS ONE UNIT, not per-quadrant: the grip bar across the top is the
  only drag surface (dragging from the body would fight the quadrants' own
  scroll and clicks — the grant input, the stream, the permission buttons).
  Position is tracked in a ref during the gesture and written straight to the
  DOM, the same reason the mission graph's own canvas drag
  (src/pages/MissionMap.tsx) never puts pointer coordinates in React state: a
  re-render per pixel of movement is wasted work the DOM does not need.
  `setPointerCapture` wrapped in try/catch, same as the canvas, so the drag
  survives the pointer leaving the element and never throws.

  Default position is the bottom-right corner (owner's explicit correction —
  first cut was top-right, moved on request) and persists per device in
  `map.controlPos`, same mechanism `map.control`'s open/closed flag already
  uses. Double-click the grip resets it — necessary, not decorative: a
  draggable panel with a silently-persisted position and no way back is
  exactly the trap `map.control`'s own history warns about ("persists
  whatever was last set"). Drag-end also clamps so the box can never be
  dragged fully off-screen even before someone finds the reset.
*/

const BOX_W = 640;
const BOX_H = 380;
const HEADER_H = 30;
const MARGIN = 24; // right-6 / bottom-6, in px
const MIN_VISIBLE = 80; // how much of the box must stay on-screen after a drag

function defaultPos(): { x: number; y: number } {
  const w = typeof window !== "undefined" ? window.innerWidth : 1280;
  const h = typeof window !== "undefined" ? window.innerHeight : 800;
  return { x: w - BOX_W - MARGIN, y: h - BOX_H - MARGIN };
}

function clampPos(x: number, y: number): { x: number; y: number } {
  const w = typeof window !== "undefined" ? window.innerWidth : 1280;
  const h = typeof window !== "undefined" ? window.innerHeight : 800;
  return {
    x: Math.min(Math.max(x, MIN_VISIBLE - BOX_W), w - MIN_VISIBLE),
    y: Math.min(Math.max(y, MIN_VISIBLE - BOX_H), h - MIN_VISIBLE),
  };
}

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

  // Auto-scroll to the newest event — see the header comment on why this
  // stream matters more than a chat transcript ever did.
  const streamRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = streamRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [visibleEvents.length]);

  // --- position + drag -----------------------------------------------------
  const [pos, setPos] = useState<{ x: number; y: number }>(
    () => readStorage<{ x: number; y: number } | null>("map.controlPos", null) ?? defaultPos(),
  );
  const boxRef = useRef<HTMLDivElement>(null);
  const drag = useRef({ active: false, startX: 0, startY: 0, origX: 0, origY: 0 });

  function dragStart(e: React.PointerEvent) {
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* not fatal — the drag still works while the pointer stays inside */
    }
    drag.current = { active: true, startX: e.clientX, startY: e.clientY, origX: pos.x, origY: pos.y };
  }
  function dragMove(e: React.PointerEvent) {
    if (!drag.current.active) return;
    const x = drag.current.origX + (e.clientX - drag.current.startX);
    const y = drag.current.origY + (e.clientY - drag.current.startY);
    const el = boxRef.current;
    if (el) {
      el.style.left = `${x}px`;
      el.style.top = `${y}px`;
    }
  }
  function dragEnd() {
    if (!drag.current.active) return;
    drag.current.active = false;
    const el = boxRef.current;
    const next = clampPos(
      el ? parseFloat(el.style.left) || pos.x : pos.x,
      el ? parseFloat(el.style.top) || pos.y : pos.y,
    );
    setPos(next);
    writeStorage("map.controlPos", next);
  }
  function dragReset() {
    const next = defaultPos();
    setPos(next);
    writeStorage("map.controlPos", next);
  }

  return (
    <div
      ref={boxRef}
      className="absolute z-10 flex flex-col overflow-hidden rounded-card border border-base-600 pointer-events-auto"
      style={{ left: pos.x, top: pos.y, width: BOX_W, height: BOX_H }}
      aria-label="Operator control"
    >
      {/* GRIP — the only drag surface, so a click inside a quadrant never starts a drag */}
      <div
        onPointerDown={dragStart}
        onPointerMove={dragMove}
        onPointerUp={dragEnd}
        onPointerCancel={dragEnd}
        onDoubleClick={dragReset}
        title="Drag to move — double-click to reset position"
        className="flex shrink-0 cursor-grab items-center justify-between gap-3 border-b border-base-600 bg-base-950/40 px-3 py-1.5 select-none active:cursor-grabbing"
        style={{ height: HEADER_H }}
      >
        <span className="flex items-center gap-1.5 text-ink-600">
          <GripHorizontal size={13} />
          <span className="font-mono text-[10px] uppercase tracking-wide">Operator control</span>
        </span>
        <button
          role="switch"
          aria-checked={on}
          aria-label="Auto mode master switch"
          disabled={busy}
          onClick={() => void flip(!on)}
          onPointerDown={(e) => e.stopPropagation()}
          title="Auto mode — every job stops asking while on. Hard refusals (git push, deletes) unchanged."
          className={`flex shrink-0 items-center gap-1.5 rounded-badge border px-2 py-0.5 font-mono text-[10px] transition-colors disabled:opacity-60 ${
            on ? "border-xp/50 bg-xp/15 text-xp" : "border-base-600 text-ink-600 hover:text-ink-300"
          }`}
        >
          <SlidersHorizontal size={11} />
          Auto {on ? "on" : "off"}
        </button>
      </div>
      {error && (
        <p className="shrink-0 border-b border-vital-down/30 bg-vital-down/10 px-3 py-1 text-[10px] text-ink-300">
          {error}
        </p>
      )}

      {/* THE GRID — 2x2, asymmetric, transparent so the graph reads through */}
      <div className="grid min-h-0 flex-1 grid-cols-2 divide-x divide-base-700 bg-base-950/10">
        {/* LEFT COLUMN */}
        <div className="flex min-h-0 flex-col divide-y divide-base-700">
          {/* WORKERS & ROUTING */}
          <div style={{ flex: "38 1 0%" }} className="min-h-0 overflow-y-auto p-2.5">
            <header className="mb-1.5 flex items-center gap-1.5">
              <Cpu size={11} className="shrink-0 text-ink-600" />
              <h2 className="font-mono text-[10px] uppercase tracking-wide text-ink-500">Workers &amp; routing</h2>
            </header>
            <p className="truncate text-[10px] text-ink-700">
              {providers.length > 0 ? providers.map((p) => p.label).join(", ") : "No providers"}
            </p>
            <dl className="mt-1.5 grid grid-cols-2 gap-x-2 gap-y-1 text-[11px]">
              <div>
                <dt className="text-[9px] text-ink-700">Default</dt>
                <dd className="truncate font-mono text-ink-200">{defaultModel || "—"}</dd>
              </div>
              <div>
                <dt className="text-[9px] text-ink-700">Budget</dt>
                <dd className="truncate font-mono text-ink-400">
                  {typeof budgetUsd === "number" && budgetUsd > 0
                    ? `$${spentUsd.toFixed(2)}/$${budgetUsd.toFixed(2)}`
                    : "—"}
                </dd>
              </div>
            </dl>
          </div>

          {/* CAPABILITY LOCKS */}
          <div style={{ flex: "62 1 0%" }} className="min-h-0 overflow-y-auto p-2.5">
            <header className="mb-1.5 flex items-center gap-1.5">
              <ShieldCheck size={11} className="shrink-0 text-ink-600" />
              <h2 className="font-mono text-[10px] uppercase tracking-wide text-ink-500">Capability locks</h2>
            </header>
            <p className="font-mono text-[9px] uppercase tracking-wide text-ink-700">Locked</p>
            {deniedTools.length === 0 ? (
              <p className="text-[10px] text-ink-700">Nothing hard-locked.</p>
            ) : (
              <div className="mt-1 flex flex-wrap gap-1">
                {deniedTools.map((t) => (
                  <span
                    key={t}
                    className="rounded-badge border border-vital-down/30 bg-vital-down/10 px-1.5 py-0.5 font-mono text-[10px] text-vital-down"
                  >
                    {t}
                  </span>
                ))}
              </div>
            )}
            <p className="mt-2 font-mono text-[9px] uppercase tracking-wide text-ink-700">Runs without asking</p>
            {allowedTools.length === 0 ? (
              <p className="text-[10px] text-ink-700">Nothing quiet — everything asks.</p>
            ) : (
              <div className="mt-1 flex flex-wrap gap-1">
                {allowedTools.map((t) => (
                  <span
                    key={t}
                    className="rounded-badge border border-xp/30 bg-xp/10 px-1.5 py-0.5 font-mono text-[10px] text-xp"
                  >
                    {t}
                  </span>
                ))}
              </div>
            )}
            <div className="mt-2 flex items-center gap-1.5">
              <input
                value={grantRule}
                onChange={(e) => setGrantRule(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void grant();
                }}
                placeholder="Bash(git log:*)"
                className="min-w-0 flex-1 rounded-badge border border-base-600 bg-base-700 px-2 py-1 text-[10px] text-ink-100 placeholder:text-ink-700"
              />
              <button
                onClick={() => void grant()}
                disabled={!grantRule.trim()}
                className="shrink-0 rounded-badge bg-xp px-2 py-1 text-[10px] font-medium text-base-950 disabled:opacity-50"
              >
                Grant
              </button>
            </div>
            {grantMsg && <p className="mt-1 text-[9px] text-ink-600">{grantMsg}</p>}
          </div>
        </div>

        {/* RIGHT COLUMN */}
        <div className="flex min-h-0 flex-col divide-y divide-base-700">
          {/* LIVE JOB EVENT STREAM — the dominant quadrant */}
          <div style={{ flex: "70 1 0%" }} className="flex min-h-0 flex-col p-2.5">
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
                {models.length > 0 && (
                  <select
                    value={selected.model ?? ""}
                    onChange={(e) => void setModel(selected.id, e.target.value)}
                    className="min-w-0 flex-1 rounded-badge border border-base-600 bg-base-700 px-1.5 py-0.5 font-mono text-[10px] text-ink-300"
                    aria-label={`model for ${selected.id}`}
                  >
                    {models.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.label}
                      </option>
                    ))}
                  </select>
                )}
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
                            Five actions, matching the wireframe's
                            owner-corrected semantics (edf1f3b2, 8 Sep):
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
                            <summary
                              className={`cursor-pointer ${e.ok === false ? "text-vital-down" : "text-ink-500"}`}
                            >
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
                      <p className="min-w-0 flex-1 break-words text-ink-500">
                        {e.status || e.detail || e.type}
                      </p>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* SANDBOX TERMINAL / ARTIFACTS — not built yet anywhere; stubbed so the grid is complete */}
          <div style={{ flex: "30 1 0%" }} className="flex min-h-0 flex-col items-center justify-center gap-1 p-2.5 text-center">
            <SquareTerminal size={14} className="text-ink-700" />
            <p className="font-mono text-[9px] uppercase tracking-wide text-ink-700">Sandbox terminal</p>
            <p className="text-[9px] text-ink-800">Mirrored terminal + artifacts — not wired yet</p>
          </div>
        </div>
      </div>
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
