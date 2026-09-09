import { useRef, useState } from "react";
import { GripHorizontal, SlidersHorizontal } from "lucide-react";
import { useRemoteStorage } from "@/hooks/useRemoteStorage";
import { retry as reloadStore } from "@/lib/remoteStore";
import { readStorage, writeStorage } from "@/lib/storage";
import { useJobs } from "@/hooks/useJobs";
import SandboxTerminal from "@/components/dashboard/SandboxTerminal";
import WorkersRoutingPanel from "@/components/dashboard/WorkersRoutingPanel";
import CapabilityLocksPanel from "@/components/dashboard/CapabilityLocksPanel";
import EventStreamPanel from "@/components/dashboard/EventStreamPanel";

/*
  OperatorControl — the wireframe (vault edf1f3b2, "The Orchestrator Job
  Dashboard Design") built literally rather than structurally-equivalent: a
  single bordered, TRANSPARENT landscape box in a 2x2 grid — Workers &
  Routing / Capability Locks on the left, Live Job Event Stream / Sandbox
  Terminal on the right, right column split unevenly (55/45 — originally
  70/30, rebalanced once Sandbox Terminal held a real terminal plus three
  Artifacts sub-tabs and 30% read as "tight/cut off on most items") so the
  stream still leads without starving what sits under it.

  As of 2026-09-09, the DESKTOP shell only: the four quadrant bodies
  (Workers & Routing, Capability Locks, Event Stream, and Sandbox Terminal —
  already its own file before this) moved out into standalone components so
  the new mobile Control dock (`OperatorMobile.tsx`) can mount the same four
  instead of a phone-shaped copy of ~500 lines to keep in sync by hand. This
  file now owns only what is genuinely desktop-specific: the draggable
  floating box, the grip bar, the 2x2 grid split, and the Auto Mode toggle
  (the one truly global control, living in the grip bar rather than its own
  quadrant since the grip bar is the one strip outside all four).

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

  const on = Boolean(autoMode);

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

  // --- position + drag -----------------------------------------------------
  const [pos, setPos] = useState<{ x: number; y: number }>(() => {
    /*
      Clamped here too, not only on drag-end. A position saved from a bigger
      screen (desktop) opened later on a smaller one (laptop, a resized
      window) would otherwise render mostly or fully off-screen on load —
      the whole point of clamping is to keep the box reachable, and a stored
      value is exactly as capable of landing outside the viewport as a live
      drag is.
    */
    const stored = readStorage<{ x: number; y: number } | null>("map.controlPos", null);
    return stored ? clampPos(stored.x, stored.y) : defaultPos();
  });
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
      /*
        select-text overrides the page root's own select-none
        (MissionMap.tsx: the graph disables text selection globally so
        dragging a node doesn't also highlight text) — inherited by every
        descendant here that doesn't say otherwise, which is what made every
        event-stream line, job chip title and reply summary uncopyable. The
        grip bar below re-asserts select-none for itself only; dragging IT
        selecting text would be its own small bug.
      */
      className="absolute z-10 flex flex-col overflow-hidden rounded-card border border-base-600 pointer-events-auto select-text"
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
          <div style={{ flex: "38 1 0%" }} className="min-h-0">
            <WorkersRoutingPanel
              providers={providers}
              defaultModel={defaultModel}
              spentUsd={spentUsd}
              budgetUsd={budgetUsd}
            />
          </div>
          <div style={{ flex: "62 1 0%" }} className="min-h-0">
            <CapabilityLocksPanel
              deniedTools={deniedTools}
              allowedTools={allowedTools}
              allowRule={allowRule}
              refreshList={refreshList}
            />
          </div>
        </div>

        {/* RIGHT COLUMN */}
        <div className="flex min-h-0 flex-col divide-y divide-base-700">
          {/*
            LIVE JOB EVENT STREAM — still the larger half, not 70/30 anymore
          */}
          <div style={{ flex: "55 1 0%" }} className="min-h-0">
            <EventStreamPanel
              jobList={jobList}
              runningIds={runningIds}
              selectedId={selectedId}
              selected={selected}
              events={events}
              models={models}
              providers={providers}
              select={select}
              cancel={cancel}
              retryJob={retryJob}
              setModel={setModel}
              answerPermission={answerPermission}
              flip={flip}
            />
          </div>

          {/*
            SANDBOX TERMINAL / ARTIFACTS — 30% was the original placeholder's
            share, sized for an empty box. It now holds a real terminal plus
            three Artifacts sub-tabs (Renders/Build/Diff), and 30% of the
            column read as "tight/cut off on most items" once that landed —
            confirmed live: every overflowing block there DID scroll, none
            were silently clipped, but several were showing ~100px of content
            that ran past 6000px. Rebalanced to 45/55 against the Event
            Stream rather than only shrinking what's inside further.
          */}
          <div style={{ flex: "45 1 0%" }} className="min-h-0 overflow-hidden">
            <SandboxTerminal selectedJob={selected} />
          </div>
        </div>
      </div>
    </div>
  );
}
