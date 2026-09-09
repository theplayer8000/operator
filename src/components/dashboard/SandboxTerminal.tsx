import { useEffect, useRef, useState } from "react";
import {
  CheckCircle2,
  Download,
  GitCompare,
  GitMerge,
  Hammer,
  ImageOff,
  Images,
  Play,
  Power,
  RotateCw,
  Square,
  SquareTerminal,
  XCircle,
} from "lucide-react";
import ConfirmButton from "@/components/ui/ConfirmButton";
import { useTerminal } from "@/hooks/useTerminal";
import type { JobSummary } from "@/hooks/useJobs";

/**
 * The Sandbox Terminal / Artifacts quadrant — two top-level tabs sharing one
 * small space, matching the wireframe's own bundled label rather than
 * splitting it into two quadrants that don't fit. Artifacts itself holds
 * three kinds, all asked for together: Renders, Build, Diff.
 *
 * TERMINAL is the same capability as the Dev page's `TerminalPanel`, through
 * the same `useTerminal()` hook, in the ~300x110px this quadrant actually
 * has. Not a second terminal: same `/api/terminal/*` calls, same arm/disarm
 * semantics, same "no shell" constraint. Deliberately dropped for space, not
 * forgotten: the runs history list, the "restart the server" button (a real,
 * distinct capability that deserves the Dev page's surrounding context and
 * confirm-button friction, not a tap-away spot in a draggable corner
 * widget), the build-rules legend.
 *
 * ARTIFACTS > RENDERS is a VIEWER over data/renders/, not a render trigger —
 * nothing here calls renderToPng(); a worker does that through
 * scripts/render.mjs, same as always. `server/render.mjs`'s own header names
 * three measured failure modes (2026-08-26), and the standout one is not
 * transient: a headless Edge killed mid-run can corrupt the isolated browser
 * profile, and every render after that fails silently until the profile
 * directory is deleted by hand — no automatic recovery. That is almost
 * certainly the "hit or miss" history behind this pane, and this viewer
 * cannot fix or even detect it — so every state here is an explicit,
 * distinguishable one: a failed list fetch, a genuinely empty directory, and
 * a broken individual PNG all get their own state rather than a silent gap.
 *
 * ARTIFACTS > BUILD and > DIFF both read `selectedJob.task.verification` —
 * the SAME per-job gate result `server/verify.mjs` already computes and the
 * Event Stream quadrant already has access to, just not previously
 * surfaced. Nothing new is triggered by opening these tabs; they render
 * whatever `runVerification()` already recorded for the selected job. Both
 * are therefore only ever as fresh as the last time that job finished a
 * turn — there is no "run now" here, deliberately: a rebuild-on-demand
 * button would duplicate what CLAUDE.md already requires every job to do
 * before handing back, and getting that duplicate out of sync with the real
 * gate would be worse than not having a button.
 *
 * Building this surfaced a real bug in verify.mjs, fixed alongside it (see
 * that file): every "npx tsc -b" / "npx vite build" check was failing in
 * ~5ms with a Windows spawn error, not a real compile error, because it
 * never adopted terminal.mjs's own `.cmd`-shim fix. A job verified before
 * that fix may still show a false "failed" here — this pane reports
 * whatever was recorded, honestly, and cannot retroactively fix a past
 * job's stored verdict.
 *
 * TERMINAL's header also carries three "make it happen now" buttons —
 * checked against the actual code before adding them, not assumed:
 *
 *   - SYNC / LAND (worktree_sync / worktree_land, via the existing
 *     capability-action layer — no new server code). Neither is on a timer.
 *     `maybeAutoLand()` (jobs.mjs) fires from the tail of `pump()` — called
 *     directly at every job-queue state change (a turn finishing, a permission
 *     answered, a new prompt) — the instant nothing is running or waiting, not
 *     on an interval. `syncWorktree` fires the same way, at the start of a
 *     turn. So these buttons are not "make the timer fire early"; there is no
 *     timer. What they DO give: a way to force a fresh attempt when nothing
 *     has changed the queue's state to re-trigger the check on its own — e.g.
 *     main was dirty a minute ago and is clean now, but no new job has run to
 *     notice. Both actions are already conservative by design (fast-forward
 *     only, refuse on any ambiguity), so single-tap, no confirm.
 *   - RESTART is the plain `/api/restart` the Dev page's own button already
 *     uses (`useTerminal`'s `restartServer`) — not `operator_restart`, a
 *     separate, phrase-gated capability action built for a different,
 *     autonomous-restart use case. Same ConfirmButton component the rest of
 *     the app uses for anything that destroys state (every job's event log,
 *     here), same two-tap friction, gated on `canManage` same as the Dev page.
 */
export default function SandboxTerminal({ selectedJob }: { selectedJob: JobSummary | null }) {
  const [tab, setTab] = useState<"terminal" | "artifacts">("terminal");
  const [sub, setSub] = useState<"renders" | "build" | "diff">("renders");

  return (
    <div className="flex h-full min-h-0 flex-col p-2.5">
      <header className="mb-1 flex shrink-0 items-center gap-2">
        <button
          onClick={() => setTab("terminal")}
          className={`flex items-center gap-1 font-mono text-[10px] uppercase tracking-wide transition-colors ${
            tab === "terminal" ? "text-ink-300" : "text-ink-700 hover:text-ink-500"
          }`}
        >
          <SquareTerminal size={11} className="shrink-0" />
          Terminal
        </button>
        <button
          onClick={() => setTab("artifacts")}
          className={`flex items-center gap-1 font-mono text-[10px] uppercase tracking-wide transition-colors ${
            tab === "artifacts" ? "text-ink-300" : "text-ink-700 hover:text-ink-500"
          }`}
        >
          <Images size={11} className="shrink-0" />
          Artifacts
        </button>
      </header>

      {tab === "artifacts" && (
        <div className="mb-1 flex shrink-0 items-center gap-1">
          {(
            [
              ["renders", "Renders", Images],
              ["build", "Build", Hammer],
              ["diff", "Diff", GitCompare],
            ] as const
          ).map(([key, label, Icon]) => (
            <button
              key={key}
              onClick={() => setSub(key)}
              className={`flex items-center gap-1 rounded-badge border px-1.5 py-0.5 font-mono text-[9px] transition-colors ${
                sub === key
                  ? "border-xp/40 bg-xp/10 text-xp"
                  : "border-base-600 text-ink-600 hover:text-ink-300"
              }`}
            >
              <Icon size={9} />
              {label}
            </button>
          ))}
        </div>
      )}

      {tab === "terminal" ? (
        <TerminalTab />
      ) : sub === "renders" ? (
        <RendersView />
      ) : sub === "build" ? (
        <BuildView job={selectedJob} />
      ) : (
        <DiffView job={selectedJob} />
      )}
    </div>
  );
}

/** Fire a tier-2 capability action and report what it actually did, not just whether the fetch succeeded. */
async function runWorktreeAction(
  action: "worktree_sync" | "worktree_land",
): Promise<{ ok: true; text: string } | { ok: false; text: string }> {
  try {
    const res = await fetch("/api/actions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action, params: {} }),
    });
    const data = (await res.json()) as { ok?: boolean; error?: string; result?: Record<string, unknown> };
    if (!res.ok || !data.ok) return { ok: false, text: data.error || `failed (${res.status})` };
    const r = data.result ?? {};
    if (action === "worktree_sync") {
      return r.synced
        ? { ok: true, text: `Synced — was ${String(r.behind ?? "?")} behind` }
        : { ok: false, text: String(r.reason ?? "not synced") };
    }
    const commits = Array.isArray(r.commits) ? r.commits.length : 0;
    return r.landed
      ? {
          ok: true,
          text: `Landed ${commits} commit(s)${r.needsBuild ? " — build now" : ""}${r.needsRestart ? " — restart needed" : ""}`,
        }
      : { ok: false, text: String(r.reason ?? "not landed") };
  } catch (err) {
    return { ok: false, text: (err as Error).message };
  }
}

function TerminalTab() {
  const {
    info,
    command,
    setCommand,
    output,
    streaming,
    error,
    canManage,
    armed,
    notListed,
    run,
    stop,
    setArmed,
    restartServer,
    restarting,
  } = useTerminal();

  const outputRef = useRef<HTMLPreElement>(null);
  useEffect(() => {
    const el = outputRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [output]);

  const [opBusy, setOpBusy] = useState<"sync" | "land" | null>(null);
  const [opMsg, setOpMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function trigger(action: "worktree_sync" | "worktree_land") {
    setOpBusy(action === "worktree_sync" ? "sync" : "land");
    setOpMsg(null);
    const result = await runWorktreeAction(action);
    setOpMsg(result);
    setOpBusy(null);
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="mb-1 flex shrink-0 items-center gap-1">
        {canManage && (
          <button
            onClick={() => void setArmed(!armed)}
            aria-pressed={armed}
            aria-label={armed ? "Disarm the terminal" : "Arm the terminal"}
            title={armed ? "Disarm — no commands can run until it's switched back on" : "Arm for this session"}
            className={`flex items-center gap-1 rounded-badge border px-1.5 py-0.5 font-mono text-[9px] transition-colors ${
              armed ? "border-xp/40 bg-xp/10 text-xp" : "border-base-600 text-ink-600 hover:text-ink-300"
            }`}
          >
            <Power size={9} />
            {armed ? "armed" : "arm"}
          </button>
        )}
        <button
          onClick={() => void trigger("worktree_sync")}
          disabled={opBusy !== null}
          title="Sync now — fast-forward the agent worktree up to main. Not on a timer already; this forces a fresh attempt."
          className="rounded-badge border border-base-600 p-1 text-ink-500 hover:border-xp/40 hover:text-xp disabled:opacity-50"
        >
          <Download size={10} className={opBusy === "sync" ? "animate-pulse" : ""} />
        </button>
        <button
          onClick={() => void trigger("worktree_land")}
          disabled={opBusy !== null}
          title="Land now — fast-forward main up to the worktree's committed work. Not on a timer already; this forces a fresh attempt."
          className="rounded-badge border border-base-600 p-1 text-ink-500 hover:border-xp/40 hover:text-xp disabled:opacity-50"
        >
          <GitMerge size={10} className={opBusy === "land" ? "animate-pulse" : ""} />
        </button>
        {canManage && (
          <ConfirmButton
            onConfirm={() => void restartServer()}
            label="Restart the server"
            icon={<RotateCw size={10} className={restarting ? "animate-spin" : ""} />}
            compact
          />
        )}
      </div>
      {opMsg && (
        <p className={`mb-1 shrink-0 text-[9px] leading-snug ${opMsg.ok ? "text-xp" : "text-vital-down"}`}>
          {opMsg.text}
        </p>
      )}

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

interface RenderFile {
  name: string;
  url: string;
  bytes: number;
  mtime: string;
}

/** "2m ago" / "3h ago" / "5d ago" — staleness is the only signal a couple of these panes can honestly offer. */
function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "";
  const s = Math.floor(ms / 1000);
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function RendersView() {
  // null = not fetched yet, [] = fetched and genuinely empty — distinct
  // states, so "loading" and "nothing here" never look the same.
  const [renders, setRenders] = useState<RenderFile[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Which thumbnails failed to actually load as an image — a 404 (swept
  // between listing and paint), a 0-byte file, or a corrupted PNG all land
  // here rather than showing the browser's own broken-image icon.
  const [broken, setBroken] = useState<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    setError(null);
    fetch("/api/renders")
      .then((res) => {
        if (!res.ok) throw new Error(`server returned ${res.status}`);
        return res.json() as Promise<{ files: RenderFile[] }>;
      })
      .then((body) => {
        if (!cancelled) setRenders(body.files);
      })
      .catch((err) => {
        if (!cancelled) setError((err as Error).message);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) {
    return <p className="text-[10px] leading-relaxed text-vital-down">Couldn&apos;t load renders — {error}</p>;
  }
  if (renders === null) {
    return <p className="text-[10px] text-ink-700">Loading…</p>;
  }
  if (renders.length === 0) {
    return (
      <p className="text-[10px] leading-relaxed text-ink-700">
        No renders yet — a worker makes one with{" "}
        <span className="font-mono text-ink-600">node scripts/render.mjs</span>.
      </p>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-wrap content-start gap-1 overflow-y-auto">
      {renders.map((r) => (
        <a
          key={r.name}
          href={r.url}
          target="_blank"
          rel="noreferrer"
          title={`${r.name} · ${(r.bytes / 1024).toFixed(0)} KB · ${timeAgo(r.mtime)}`}
          className="relative h-12 w-12 shrink-0 overflow-hidden rounded-badge border border-base-600 bg-base-950/60"
        >
          {broken.has(r.name) ? (
            <span className="flex h-full w-full flex-col items-center justify-center gap-0.5">
              <ImageOff size={11} className="text-ink-700" />
              <span className="text-[7px] text-ink-700">failed</span>
            </span>
          ) : (
            <img
              src={r.url}
              alt={r.name}
              loading="lazy"
              onError={() => setBroken((prev) => new Set(prev).add(r.name))}
              className="h-full w-full object-cover"
            />
          )}
        </a>
      ))}
    </div>
  );
}

/** Bytes as "12.3 KB" / "1.2 MB" — nobody reads a raw byte count at a glance. */
function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

function NoJob() {
  return <p className="text-[10px] text-ink-700">Pick a job from the event stream above.</p>;
}

function BuildView({ job }: { job: JobSummary | null }) {
  if (!job) return <NoJob />;
  const v = job.task?.verification;

  if (!v || v.status === "not-run") {
    return (
      <p className="text-[10px] leading-relaxed text-ink-700">
        {v?.note || "No verification has run for this job."}
      </p>
    );
  }
  if (v.status === "running") {
    return <p className="text-[10px] text-ink-700">Checking the workspace…</p>;
  }
  if (v.status === "skipped" || v.status === "error") {
    return <p className="text-[10px] leading-relaxed text-ink-700">{v.note}</p>;
  }

  const checks = v.checks ?? [];
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto">
      <p
        className={`shrink-0 font-mono text-[10px] font-medium ${
          v.status === "passed" ? "text-xp" : "text-vital-down"
        }`}
      >
        {v.status === "passed" ? "Passed" : "Failed"} · {v.changed ?? 0} file(s) changed
      </p>
      {checks.map((c, i) => (
        <details key={i} className="shrink-0 text-[10px]">
          <summary
            className={`flex cursor-pointer items-center gap-1 ${c.passed ? "text-ink-400" : "text-vital-down"}`}
          >
            {c.passed ? (
              <CheckCircle2 size={10} className="shrink-0" />
            ) : (
              <XCircle size={10} className="shrink-0" />
            )}
            <span className="min-w-0 flex-1 truncate font-mono">{c.name}</span>
            <span className="shrink-0 font-mono text-ink-700">{(c.ms / 1000).toFixed(1)}s</span>
          </summary>
          {!c.passed && c.output && (
            <pre className="mt-1 max-h-20 overflow-auto whitespace-pre-wrap break-words rounded-badge border border-base-600 bg-base-950/60 p-1.5 font-mono text-[9px] text-vital-down">
              {c.output}
            </pre>
          )}
        </details>
      ))}
      {v.bundle && (
        <div className="shrink-0 border-t border-base-600 pt-1">
          <p className="font-mono text-[10px] text-ink-400">
            Bundle · {formatBytes(v.bundle.totalBytes)} total
          </p>
          {v.bundle.files.slice(0, 4).map((f) => (
            <p key={f.name} className="truncate font-mono text-[9px] text-ink-700">
              {f.name} — {formatBytes(f.bytes)}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}

function DiffView({ job }: { job: JobSummary | null }) {
  if (!job) return <NoJob />;
  const diff = job.task?.verification?.diff;
  const status = job.task?.verification?.status;

  if (!diff) {
    return (
      <p className="text-[10px] leading-relaxed text-ink-700">
        {status === "running"
          ? "Checking the workspace…"
          : status === "skipped" || status === "not-run" || !status
            ? "No diff for this job — nothing was changed, or it predates this pane."
            : "No diff was captured for this job."}
      </p>
    );
  }
  if (diff.error) {
    return <p className="text-[10px] leading-relaxed text-vital-down">Couldn&apos;t read the diff — {diff.error}</p>;
  }
  if (!diff.stat) {
    return <p className="text-[10px] leading-relaxed text-ink-700">Nothing tracked changed (new/untracked files don&apos;t show in a diff).</p>;
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto">
      <pre className="shrink-0 whitespace-pre-wrap break-words font-mono text-[9px] text-ink-400">{diff.stat}</pre>
      {diff.text && (
        <details className="shrink-0 text-[10px]">
          <summary className="cursor-pointer text-ink-600">
            full diff{diff.truncated ? " (truncated)" : ""}
          </summary>
          <pre className="mt-1 max-h-24 overflow-auto whitespace-pre-wrap break-words rounded-badge border border-base-600 bg-base-950/60 p-1.5 font-mono text-[9px]">
            {diff.text.split("\n").map((line, i) => (
              <span
                key={i}
                className={
                  line.startsWith("+") && !line.startsWith("+++")
                    ? "block text-vital-up"
                    : line.startsWith("-") && !line.startsWith("---")
                      ? "block text-vital-down"
                      : "block text-ink-600"
                }
              >
                {line}
              </span>
            ))}
          </pre>
        </details>
      )}
    </div>
  );
}
