import { useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  Download,
  ExternalLink,
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
  X,
  XCircle,
} from "lucide-react";
import ConfirmButton from "@/components/ui/ConfirmButton";
import { useTerminal } from "@/hooks/useTerminal";
import type { JobSummary } from "@/hooks/useJobs";

/**
 * `fetch` with a real ceiling, distinguishable from every other failure.
 *
 * Nothing in this file had one before — found the hard way: a live report of
 * "renderer" and "loading worktree" states that were watched, then given up
 * on, with no error and no resolution. `worktree.mjs`'s own git calls have a
 * server-side timeout (parallelised and tightened alongside this), but a
 * client with no ceiling of its own still hangs forever if the network drops
 * a response, the server never answers, or anything else goes wrong that
 * server-side timeout doesn't cover. `AbortError` is checked for by name
 * specifically so a genuine timeout reads as "timed out — try again" rather
 * than folding into a generic, less actionable error message.
 */
async function fetchWithTimeout(url: string, init: RequestInit = {}, timeoutMs = 18_000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      throw new Error(`timed out after ${Math.round(timeoutMs / 1000)}s — try again`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

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
    const res = await fetchWithTimeout(
      "/api/actions",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, params: {} }),
      },
      // Generous, deliberately: worktree.mjs's own git calls carry a 15s
      // ceiling each and this may wait on one of them, so this needs enough
      // room for a real (if slow) answer to still count as one, not enough
      // that the UI looks hung in the meantime.
      20_000,
    );
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

interface LastAttempt {
  at: string;
  ok: boolean;
  target?: string;
  error?: string;
}

/**
 * Full-size preview, in place — the actual fix for "images don't open".
 *
 * `<a target="_blank">` was the original approach and it does not do what it
 * looks like it does here: verified live, clicking one navigated the WHOLE
 * Operator tab away to the raw image (same tabId, no second tab) rather than
 * opening anything new — from a small HUD panel that reads as the app
 * breaking, not a picture opening. `position: fixed` + a high z-index
 * escapes the panel's own `overflow: hidden` without needing a portal (this
 * box is positioned with plain `left`/`top`, no `transform` on it or its
 * ancestors, so nothing here creates a containing block that would trap it) —
 * confirmed by actually opening one, not assumed from the CSS.
 */
function Lightbox({ url, name, onClose }: { url: string; name: string; onClose: () => void }) {
  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-base-950/90 p-8"
      onClick={onClose}
      role="dialog"
      aria-label={name}
    >
      <img
        src={url}
        alt={name}
        onClick={(e) => e.stopPropagation()}
        style={{ maxWidth: "90vw", maxHeight: "85vh" }}
        className="rounded-card border border-base-600 object-contain shadow-2xl"
      />
      <div className="absolute right-4 top-4 flex items-center gap-2">
        {/*
          A deliberate escape hatch, not the default path this time: opening
          the raw file in a real new tab/download is still occasionally
          wanted (saving it, say). Kept, but as a second, explicit action from
          INSIDE a lightbox that has already shown the image — not the only
          way to see it.
        */}
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          onClick={(e) => e.stopPropagation()}
          title="Open the raw file in a new tab"
          className="flex items-center gap-1 rounded-badge border border-base-600 bg-base-800 px-2 py-1.5 text-[10px] text-ink-300 hover:text-ink-100"
        >
          <ExternalLink size={12} />
        </a>
        <button
          onClick={onClose}
          aria-label="Close"
          className="rounded-badge border border-base-600 bg-base-800 p-1.5 text-ink-300 hover:text-ink-100"
        >
          <X size={14} />
        </button>
      </div>
    </div>
  );
}

function RendersView() {
  // null = not fetched yet, [] = fetched and genuinely empty — distinct
  // states, so "loading" and "nothing here" never look the same.
  const [renders, setRenders] = useState<RenderFile[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // The known, persistent failure mode: a killed headless Edge can corrupt
  // its isolated profile, after which every render fails SILENTLY until the
  // folder is cleared by hand. A gallery with nothing new in it looks
  // identical whether nobody has rendered anything or every attempt has
  // been quietly failing — this is the one thing that tells them apart, from
  // render.mjs's own on-disk record of what actually happened last.
  const [lastAttempt, setLastAttempt] = useState<LastAttempt | null>(null);
  const [profileDir, setProfileDir] = useState<string | null>(null);
  // Which thumbnails failed to actually load as an image — a 404 (swept
  // between listing and paint), a 0-byte file, or a corrupted PNG all land
  // here rather than showing the browser's own broken-image icon.
  const [broken, setBroken] = useState<Set<string>>(new Set());
  const [lightbox, setLightbox] = useState<RenderFile | null>(null);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    fetchWithTimeout("/api/renders")
      .then((res) => {
        if (!res.ok) throw new Error(`server returned ${res.status}`);
        return res.json() as Promise<{ files: RenderFile[]; lastAttempt: LastAttempt | null; profileDir: string }>;
      })
      .then((body) => {
        if (cancelled) return;
        setRenders(body.files);
        setLastAttempt(body.lastAttempt);
        setProfileDir(body.profileDir);
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

  /*
    Named and actionable, not "render failed": the real error render.mjs
    recorded (which already names the profile path itself when that IS the
    cause — see runBrowser's own message), plus the path again as a standing
    fallback so the fix is never a guess even when the error text is about
    something else entirely (no browser found, a timeout, a bad target).

    The "clear it by hand" line is gone: render.mjs now auto-recovers this
    exact failure signature itself (see its own header), so telling someone
    to go delete a folder that the server already reset would be stale
    advice. The path stays, for the rarer case where even the automatic
    reset failed — render.mjs's own recorded error says so explicitly when
    it happens, and that text is what renders below, unedited.
  */
  const failureBanner = lastAttempt && !lastAttempt.ok && (
    <div className="mb-1 shrink-0 rounded-badge border border-vital-down/30 bg-vital-down/5 p-1.5">
      <p className="flex items-center gap-1 font-mono text-[9px] text-vital-down">
        <AlertTriangle size={10} className="shrink-0" />
        Last render failed — {timeAgo(lastAttempt.at)}
      </p>
      <p className="mt-0.5 break-words text-[9px] leading-relaxed text-ink-400">{lastAttempt.error}</p>
      {profileDir && (
        <p className="mt-0.5 break-words text-[9px] leading-relaxed text-ink-600">
          Render profile: <span className="font-mono text-ink-500">{profileDir}</span>
        </p>
      )}
    </div>
  );

  if (renders.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 flex-col">
        {failureBanner}
        <p className="text-[10px] leading-relaxed text-ink-700">
          No renders yet — a worker makes one with{" "}
          <span className="font-mono text-ink-600">node scripts/render.mjs</span>.
        </p>
      </div>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {failureBanner}
      <div className="flex min-h-0 flex-1 flex-wrap content-start gap-1.5 overflow-y-auto">
        {renders.map((r) => (
          <button
            key={r.name}
            onClick={() => setLightbox(r)}
            title={`${r.name} · ${(r.bytes / 1024).toFixed(0)} KB · ${timeAgo(r.mtime)}`}
            className="relative h-16 w-16 shrink-0 overflow-hidden rounded-badge border border-base-600 bg-base-950/60"
          >
            {broken.has(r.name) ? (
              <span className="flex h-full w-full flex-col items-center justify-center gap-0.5">
                <ImageOff size={13} className="text-ink-700" />
                <span className="text-[8px] text-ink-700">failed</span>
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
          </button>
        ))}
      </div>
      {lightbox && <Lightbox url={lightbox.url} name={lightbox.name} onClose={() => setLightbox(null)} />}
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

/** How long "running" gets to look identical to "stuck" before it stops pretending. Real checks finish in well under a minute (measured: ~11s tsc, ~17s vite build). */
const VERIFICATION_STUCK_AFTER_MS = 3 * 60_000;

/**
 * "Checking the workspace…" on its own reads the same whether it started a
 * second ago or three restarts back — found live, against a real job
 * (job-7) whose verification was abandoned mid-check by an old restart and
 * has shown that exact line, unchanging, ever since. `startedAt` (added
 * alongside this) is the only thing that can tell the two apart, so once
 * enough time has passed this says so plainly instead of continuing to
 * imply an answer is still coming.
 */
function RunningState({ startedAt }: { startedAt?: string }) {
  const elapsedMs = startedAt ? Date.now() - new Date(startedAt).getTime() : 0;
  const stuck = startedAt && Number.isFinite(elapsedMs) && elapsedMs > VERIFICATION_STUCK_AFTER_MS;
  if (!stuck) {
    return <p className="text-[10px] text-ink-700">Checking the workspace…</p>;
  }
  const minutes = Math.round(elapsedMs / 60_000);
  return (
    <p className="flex items-start gap-1 text-[10px] leading-relaxed text-ink-500">
      <Clock size={11} className="mt-0.5 shrink-0" />
      Still &quot;checking&quot; after {minutes}m — likely abandoned by a restart mid-check rather than
      genuinely still running. Nothing re-triggers it; it clears the next time this job completes a turn.
    </p>
  );
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
    return <RunningState startedAt={v.startedAt} />;
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
            <pre className="mt-1 max-h-36 overflow-auto whitespace-pre-wrap break-words rounded-badge border border-base-600 bg-base-950/60 p-1.5 font-mono text-[9px] text-vital-down">
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
    if (status === "running") return <RunningState startedAt={job.task?.verification?.startedAt} />;
    return (
      <p className="text-[10px] leading-relaxed text-ink-700">
        {status === "skipped" || status === "not-run" || !status
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
          <pre className="mt-1 max-h-44 overflow-auto whitespace-pre-wrap break-words rounded-badge border border-base-600 bg-base-950/60 p-1.5 font-mono text-[9px]">
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
