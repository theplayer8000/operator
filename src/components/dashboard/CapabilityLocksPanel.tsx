import { useState } from "react";
import { ShieldCheck } from "lucide-react";

/**
 * CAPABILITY LOCKS — pulled out of OperatorControl.tsx (2026-09-09), same
 * reason as WorkersRoutingPanel: one component, mounted by both the desktop
 * dock and the new mobile one, instead of two copies to keep in sync.
 *
 * Owns its own grant-input state (`grantRule`/`grantMsg`) — that's UI state
 * nobody outside this panel needs — but takes the actual data and the
 * mutator as props, same as everything else here: the parent's `useJobs()`
 * call is the one source of truth, this only renders it.
 */
export default function CapabilityLocksPanel({
  deniedTools,
  allowedTools,
  allowRule,
  refreshList,
}: {
  deniedTools: string[];
  allowedTools: string[];
  allowRule: (rule: string) => Promise<string | null>;
  refreshList: () => Promise<unknown>;
}) {
  const [grantRule, setGrantRule] = useState("");
  const [grantMsg, setGrantMsg] = useState<string | null>(null);

  async function grant() {
    const rule = grantRule.trim();
    if (!rule) return;
    setGrantMsg(null);
    const msg = await allowRule(rule);
    setGrantMsg(msg);
    await refreshList();
    setGrantRule("");
  }

  return (
    <div className="h-full min-h-0 overflow-y-auto p-2.5">
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
  );
}
