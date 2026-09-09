import { useState } from "react";
import { ChevronUp, Cpu, GripHorizontal, Hammer, ScrollText, ShieldCheck, SlidersHorizontal, X } from "lucide-react";
import { useRemoteStorage } from "@/hooks/useRemoteStorage";
import { retry as reloadStore } from "@/lib/remoteStore";
import { useJobs } from "@/hooks/useJobs";
import WorkersRoutingPanel from "@/components/dashboard/WorkersRoutingPanel";
import CapabilityLocksPanel from "@/components/dashboard/CapabilityLocksPanel";
import EventStreamPanel from "@/components/dashboard/EventStreamPanel";
import SandboxTerminal from "@/components/dashboard/SandboxTerminal";

/**
 * The phone version of OperatorControl — "technically it is a dock lol"
 * (the owner's own words once asked directly), so this adapts the same
 * desktop dock rather than inventing a second design: the same four pieces
 * (Workers & Routing, Capability Locks, Event Stream, Sandbox Terminal —
 * WorkersRoutingPanel/CapabilityLocksPanel/EventStreamPanel/SandboxTerminal,
 * all extracted out of OperatorControl.tsx on 2026-09-09 specifically so
 * this file mounts the real ones rather than a phone-shaped copy), the same
 * Auto Mode master switch, the same `useJobs()` data.
 *
 * What's genuinely different, because a fixed 640x380 landscape box cannot
 * exist on a ~390px phone:
 *
 *   - A BOTTOM SHEET, not a floating draggable box. No drag, no saved
 *     position — there is nowhere else on a phone screen for this to go.
 *   - The four pieces are a TAB STRIP, one visible at a time, not a 2x2
 *     grid — matches the pattern Artifacts already established
 *     (Renders/Build/Diff) rather than inventing a second one.
 *   - Real `.glass` (blur + tint + a visible edge), not the desktop dock's
 *     deliberate full transparency — a phone screen has far less room to
 *     let a busy graph show through AND stay readable; the desktop dock
 *     sits over a graph big enough that transparency reads as intentional,
 *     a phone screen does not have that luxury. Owner-confirmed.
 *   - Touch targets sized for a thumb (44px), not a mouse — this file's OWN
 *     chrome (the handle, the tab strip, the close button) meets that. The
 *     reused panel bodies' OWN internal buttons (Approve/Deny/Grant, the
 *     permission card) do not yet — they were sized for the desktop dock's
 *     cramped quadrants and this pass didn't change them. Flagged, not
 *     silently shipped: a real CLAUDE.md rule this still falls short of,
 *     worth its own pass rather than widening scope here further.
 */

type Tab = "workers" | "locks" | "stream" | "terminal";

export default function MobileControlDock() {
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
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<Tab>("stream");

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

  const TABS: { key: Tab; label: string; Icon: typeof Cpu }[] = [
    { key: "workers", label: "Workers", Icon: Cpu },
    { key: "locks", label: "Locks", Icon: ShieldCheck },
    { key: "stream", label: "Stream", Icon: ScrollText },
    { key: "terminal", label: "Terminal", Icon: Hammer },
  ];

  return (
    <>
      {/*
        The handle — fixed to the bottom edge, where the archived text chat
        used to sit. Always present, whether the sheet is open or not, same
        as an iOS sheet's own grabber always being reachable.
      */}
      <button
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label={open ? "Close Operator control" : "Open Operator control"}
        className="glass fixed inset-x-3 bottom-3 z-40 flex min-h-[44px] items-center justify-center gap-2 rounded-card px-4 py-2.5 text-ink-300"
      >
        <GripHorizontal size={14} className="text-ink-600" />
        <span className="font-mono text-[11px] uppercase tracking-wide">Control</span>
        <ChevronUp size={14} className={`text-ink-600 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>

      {/* Backdrop — tap outside the sheet to close, same convention as the image Lightbox */}
      {open && (
        <div className="fixed inset-0 z-40 bg-base-950/40" onClick={() => setOpen(false)} aria-hidden />
      )}

      {/* THE SHEET */}
      <div
        className="glass fixed inset-x-0 bottom-0 z-40 flex flex-col rounded-t-card transition-transform duration-200"
        style={{ height: "75vh", transform: open ? "translateY(0)" : "translateY(100%)" }}
        aria-hidden={!open}
      >
        <div className="mx-auto mt-2 h-1 w-10 shrink-0 rounded-full bg-white/15" aria-hidden />

        <div className="flex shrink-0 items-center justify-between gap-2 px-3 py-2">
          <button
            role="switch"
            aria-checked={on}
            aria-label="Auto mode master switch"
            disabled={busy}
            onClick={() => void flip(!on)}
            className={`flex min-h-[44px] shrink-0 items-center gap-1.5 rounded-badge border px-3 font-mono text-[11px] transition-colors disabled:opacity-60 ${
              on ? "border-xp/50 bg-xp/15 text-xp" : "border-base-600 text-ink-600"
            }`}
          >
            <SlidersHorizontal size={13} />
            Auto {on ? "on" : "off"}
          </button>
          <button
            onClick={() => setOpen(false)}
            aria-label="Dismiss Operator control"
            className="flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center rounded-badge border border-base-600 text-ink-500"
          >
            <X size={16} />
          </button>
        </div>
        {error && (
          <p className="mx-3 mb-2 shrink-0 rounded-badge border border-vital-down/30 bg-vital-down/10 px-2 py-1 text-[11px] text-ink-300">
            {error}
          </p>
        )}

        {/* TAB STRIP — the 2x2 grid's phone equivalent: one quadrant visible at a time */}
        <div className="flex shrink-0 gap-1 px-3 pb-2">
          {TABS.map(({ key, label, Icon }) => (
            <button
              key={key}
              onClick={() => setTab(key)}
              className={`flex min-h-[44px] flex-1 flex-col items-center justify-center gap-0.5 rounded-badge border font-mono text-[10px] transition-colors ${
                tab === key ? "border-xp/40 bg-xp/10 text-xp" : "border-base-600 text-ink-600"
              }`}
            >
              <Icon size={14} />
              {label}
            </button>
          ))}
        </div>

        {/* CONTENT — one panel, full width, real room (unlike the desktop quadrant it came from) */}
        <div className="min-h-0 flex-1 overflow-hidden border-t border-base-700">
          {tab === "workers" && (
            <WorkersRoutingPanel
              providers={providers}
              defaultModel={defaultModel}
              spentUsd={spentUsd}
              budgetUsd={budgetUsd}
            />
          )}
          {tab === "locks" && (
            <CapabilityLocksPanel
              deniedTools={deniedTools}
              allowedTools={allowedTools}
              allowRule={allowRule}
              refreshList={refreshList}
            />
          )}
          {tab === "stream" && (
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
          )}
          {tab === "terminal" && <SandboxTerminal selectedJob={selected} />}
        </div>
      </div>
    </>
  );
}
