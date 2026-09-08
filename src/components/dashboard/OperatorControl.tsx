import { useState } from "react";
import { Activity, Cpu, Radio, SlidersHorizontal } from "lucide-react";
import Card from "@/components/ui/Card";
import { useRemoteStorage } from "@/hooks/useRemoteStorage";
import { retry } from "@/lib/remoteStore";
import { useJobs } from "@/hooks/useJobs";

/**
 * OperatorControl — the first slice of the Control dashboard wireframe
 * (vault note edf1f3b2), rendered on the existing Dashboard page where the
 * mission map and node graph live. This is the UI half of auto mode, and the
 * one home the owner assigned it (refinements 4f157ea0): NOT a Settings page.
 *
 * Built, live:
 *  - AUTO MODE: the global master switch. Read from the persisted
 *    `operator.autoMode` store key; written through the `auto_mode` *action*
 *    (/api/actions) — never a direct store set, because the action is what
 *    propagates to the in-memory gate in server/jobs.mjs. After a flip we
 *    `retry()` the shared store, since the client does not poll.
 *  - WORKERS & ROUTING: default model, providers and the model set, read-only.
 *    The wireframe's real knobs (Switch / A+B / per-job override) are staged.
 *  - LIVE JOBS: everything the engine is doing, running first, with per-run
 *    cost and the spent-vs-budget line.
 *
 * Staged from the wireframe, deliberately not built here: capability locks,
 * the sandbox terminal / artifacts pane, the five-button permission prompt
 * (that is the piece that changes phone approvals), per-job controls
 * (Stop/Pause/Resume/Restart/Recycle), the wake-up summary pane, the model
 * pane. Build order per the wireframe: this surface (A+C) first, then the
 * staged update handler (Part B) rides on top.
 */
export default function OperatorControl() {
  const [autoMode] = useRemoteStorage<boolean>("operator.autoMode", false);
  const {
    jobs,
    models,
    providers,
    defaultModel,
    runningIds,
    spentUsd,
    budgetUsd,
  } = useJobs();

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
      if (!res.ok || !data.ok) {
        throw new Error(data.error || `flip failed (${res.status})`);
      }
      // No client-side polling — re-pull server state so the switch reflects
      // what the server actually decided before it is enabled again.
      await retry();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const running = jobs.filter((j) => runningIds.includes(j.id));
  const resting = jobs.filter((j) => !runningIds.includes(j.id));
  const ordered = [...running, ...resting];

  return (
    <Card
      title="Operator Control"
      icon={<Activity size={15} />}
      action={
        <span className={`font-mono text-[11px] ${on ? "text-xp" : "text-ink-700"}`}>
          auto mode {on ? "on" : "off"}
        </span>
      }
    >
      {/* AUTO MODE — the master switch */}
      <div className="rounded-badge border border-xp/25 bg-xp/5 px-4 py-3">
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0">
            <p className="flex items-center gap-2 text-sm font-semibold text-ink-100">
              <SlidersHorizontal size={15} className="shrink-0 text-xp" />
              Auto mode
            </p>
            <p className="mt-1 text-xs leading-relaxed text-ink-500">
              Global master switch — every job stops asking for permission while
              on. Hard refusals (git push, deletes) are unchanged. Survives a
              restart.
            </p>
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
        </div>
        {error && (
          <p className="mt-2 rounded-badge border border-vital-down/30 bg-vital-down/10 px-3 py-2 text-xs text-ink-300">
            {error}
          </p>
        )}
      </div>

      {/* WORKERS & ROUTING — read-only for now */}
      <div className="mt-4">
        <p className="flex items-center gap-2 text-sm font-medium text-ink-300">
          <Cpu size={14} className="text-ink-500" />
          Workers &amp; routing
        </p>
        <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
          <div>
            <dt className="text-ink-700">Default model</dt>
            <dd className="font-mono text-ink-100">{defaultModel || "—"}</dd>
          </div>
          <div>
            <dt className="text-ink-700">Providers</dt>
            <dd className="font-mono text-ink-300">
              {providers.length > 0 ? providers.map((p) => p.label).join(", ") : "—"}
            </dd>
          </div>
        </dl>
        {models.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {models.map((m) => (
              <span
                key={m.id}
                className={`rounded-badge border px-2 py-0.5 font-mono text-[11px] ${
                  m.id === defaultModel
                    ? "border-xp/40 bg-xp/10 text-xp"
                    : "border-base-600 text-ink-500"
                }`}
              >
                {m.label}
              </span>
            ))}
          </div>
        )}
      </div>

      {/* LIVE JOBS */}
      <div className="mt-4">
        <div className="flex items-center justify-between gap-2">
          <p className="flex items-center gap-2 text-sm font-medium text-ink-300">
            <Radio size={14} className="text-ink-500" />
            Live jobs
            <span className="font-mono text-[11px] text-ink-700">{jobs.length}</span>
          </p>
          {typeof budgetUsd === "number" && budgetUsd > 0 && (
            <span className="font-mono text-[11px] text-ink-700">
              ${spentUsd.toFixed(2)} / ${budgetUsd.toFixed(2)}
            </span>
          )}
        </div>
        {ordered.length === 0 ? (
          <p className="mt-2 text-xs text-ink-700">No jobs — start one from Operator.</p>
        ) : (
          <ul className="mt-2 space-y-1.5">
            {ordered.map((j) => {
              const isRunning = runningIds.includes(j.id);
              return (
                <li
                  key={j.id}
                  className="flex items-center gap-2.5 rounded-badge border border-base-600/60 bg-base-700/40 px-3 py-2"
                >
                  <span
                    className={`h-2 w-2 shrink-0 rounded-full ${
                      j.error ? "bg-vital-down" : isRunning ? "bg-xp" : "bg-ink-700"
                    }`}
                    title={j.error ? "failed" : isRunning ? "running" : "idle"}
                  />
                  <span className="min-w-0 flex-1 truncate text-xs text-ink-100">
                    {j.title}
                  </span>
                  <span className="hidden font-mono text-[10px] text-ink-700 sm:inline">
                    {j.model}
                  </span>
                  {j.costUsd > 0 && (
                    <span className="font-mono text-[10px] text-ink-700">
                      ${j.costUsd.toFixed(2)}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Card>
  );
}
